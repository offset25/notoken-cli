import type { DynamicIntent, IntentDef } from "../types/intent.js";
import { loadIntents, loadRules } from "../utils/config.js";
import { semanticParse, fuzzyMatch, type SemanticParse } from "./semantic.js";
import { parseByRules } from "./ruleParser.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Multi-classifier intent scorer.
 *
 * Instead of picking one parser, this runs multiple classifiers in parallel
 * and merges their scores. Each classifier votes on the likely intent.
 *
 * Classifiers:
 * 1. Synonym matcher — exact/substring synonym matching (fast, deterministic)
 * 2. Semantic classifier — uses compromise POS + dependency parse
 * 3. Context classifier — uses conversation history for likely intent
 * 4. Fuzzy classifier — keyboard-distance matching for typos
 */

export interface ClassifierVote {
  classifier: string;
  intent: string;
  confidence: number;
  reason: string;
}

export interface MultiClassifierResult {
  /** All votes from all classifiers */
  votes: ClassifierVote[];
  /** Final merged scores per intent, sorted by score */
  scores: Array<{ intent: string; score: number; votes: number }>;
  /** The winning intent (highest merged score) */
  best: { intent: string; score: number } | null;
  /** Whether there was a close second (ambiguous) */
  ambiguous: boolean;
}

const CLASSIFIER_WEIGHTS: Record<string, number> = {
  synonym: 1.0,
  semantic: 0.8,
  vector: 0.7,
  context: 0.6,
  fuzzy: 0.5,
};

/**
 * Run all classifiers and merge results.
 */
export function classifyMulti(
  rawText: string,
  recentIntents?: string[]
): MultiClassifierResult {
  const votes: ClassifierVote[] = [];

  // 1. Synonym classifier (existing rule parser)
  votes.push(...classifySynonym(rawText));

  // 2. Semantic classifier (compromise-powered)
  votes.push(...classifySemantic(rawText));

  // 3. Context classifier (recent history)
  if (recentIntents && recentIntents.length > 0) {
    votes.push(...classifyContext(rawText, recentIntents));
  }

  // 4. Fuzzy classifier (keyboard distance)
  votes.push(...classifyFuzzy(rawText));

  // 5. Vector classifier (precomputed TF-IDF cosine similarity)
  votes.push(...classifyVector(rawText));

  // Merge votes: max weighted score + bonus for agreement
  const scoreMap = new Map<string, { maxWeighted: number; totalWeighted: number; count: number }>();

  for (const vote of votes) {
    const weight = CLASSIFIER_WEIGHTS[vote.classifier] ?? 1.0;
    const weighted = vote.confidence * weight;
    const existing = scoreMap.get(vote.intent) ?? { maxWeighted: 0, totalWeighted: 0, count: 0 };
    existing.maxWeighted = Math.max(existing.maxWeighted, weighted);
    existing.totalWeighted += weighted;
    existing.count += 1;
    scoreMap.set(vote.intent, existing);
  }

  const scores = Array.from(scoreMap.entries())
    .map(([intent, { maxWeighted, count }]) => ({
      intent,
      score: maxWeighted + Math.min(0.15, (count - 1) * 0.05),
      votes: count,
    }))
    .sort((a, b) => b.score - a.score);

  const best = scores[0] ?? null;
  const second = scores[1];
  const ambiguous = !!(best && second && best.score - second.score < 0.15);

  return {
    votes,
    scores: scores.map((s) => ({ intent: s.intent, score: Math.round(s.score * 100) / 100, votes: s.votes })),
    best: best ? { intent: best.intent, score: Math.round(best.score * 100) / 100 } : null,
    ambiguous,
  };
}

// ─── Individual Classifiers ──────────────────────────────────────────────────

function classifySynonym(rawText: string): ClassifierVote[] {
  const result = parseByRules(rawText);
  if (!result || result.intent === "unknown") return [];

  return [{
    classifier: "synonym",
    intent: result.intent,
    confidence: result.confidence,
    reason: "Matched synonym in rules",
  }];
}

function classifySemantic(rawText: string): ClassifierVote[] {
  const rules = loadRules();
  const intents = loadIntents();
  const services = Object.keys(rules.serviceAliases);
  const envs = Object.keys(rules.environmentAliases);

  const parse = semanticParse(rawText, services, envs);
  const votes: ClassifierVote[] = [];

  if (!parse.action) return votes;

  // Match action verb to intent
  for (const def of intents) {
    const actionScore = scoreActionMatch(parse.action, def);
    if (actionScore > 0) {
      // Boost if entities also match expected fields
      const entityBoost = scoreEntityMatch(parse, def);
      const confidence = Math.min(0.95, actionScore * 0.6 + entityBoost * 0.4);

      votes.push({
        classifier: "semantic",
        intent: def.name,
        confidence,
        reason: `Verb "${parse.action}" matches ${def.name}`,
      });
    }
  }

  return votes;
}

function classifyContext(rawText: string, recentIntents: string[]): ClassifierVote[] {
  const votes: ClassifierVote[] = [];

  // If recent intents are heavily weighted toward one area, boost it slightly
  const intentCounts = new Map<string, number>();
  for (const i of recentIntents) {
    intentCounts.set(i, (intentCounts.get(i) ?? 0) + 1);
  }

  // Get the domain prefix of recent intents (e.g., "service", "git", "logs")
  const domainCounts = new Map<string, number>();
  for (const [intent, count] of intentCounts) {
    const domain = intent.split(".")[0];
    domainCounts.set(domain, (domainCounts.get(domain) ?? 0) + count);
  }

  // If the raw text matches a recent domain, give a small boost
  const intents = loadIntents();
  for (const def of intents) {
    const domain = def.name.split(".")[0];
    const domainFreq = domainCounts.get(domain) ?? 0;
    if (domainFreq > 0) {
      // Check if any synonym partially matches
      const hasPartialMatch = def.synonyms.some((s) =>
        rawText.toLowerCase().includes(s.split(" ")[0])
      );
      if (hasPartialMatch) {
        votes.push({
          classifier: "context",
          intent: def.name,
          confidence: Math.min(0.7, 0.3 + domainFreq * 0.1),
          reason: `Recent context favors ${domain} domain`,
        });
      }
    }
  }

  return votes;
}

function classifyFuzzy(rawText: string): ClassifierVote[] {
  const intents = loadIntents();
  const votes: ClassifierVote[] = [];
  const words = rawText.toLowerCase().split(/\s+/);

  for (const def of intents) {
    for (const word of words) {
      for (const synonym of def.synonyms) {
        const synonymWords = synonym.split(" ");
        for (const sw of synonymWords) {
          if (sw.length < 3) continue;
          const match = fuzzyMatch(word, [sw], 1.5);
          if (match && match.distance > 0 && match.distance <= 1.5) {
            votes.push({
              classifier: "fuzzy",
              intent: def.name,
              confidence: Math.max(0.3, 0.7 - match.distance * 0.3),
              reason: `Fuzzy: "${word}" ≈ "${sw}" (dist: ${match.distance})`,
            });
            break;
          }
        }
      }
    }
  }

  return votes;
}

// ─── Scoring Helpers ─────────────────────────────────────────────────────────

function scoreActionMatch(action: string, def: IntentDef): number {
  const actionLower = action.toLowerCase();

  // Direct synonym match
  if (def.synonyms.some((s) => s.includes(actionLower))) return 0.9;

  // Check if action is part of the intent name
  if (def.name.includes(actionLower)) return 0.7;

  // Check examples
  if (def.examples.some((e) => e.toLowerCase().includes(actionLower))) return 0.5;

  return 0;
}

function scoreEntityMatch(parse: SemanticParse, def: IntentDef): number {
  let matches = 0;
  let total = Object.keys(def.fields).length;
  if (total === 0) return 0.5;

  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    if (fieldDef.type === "environment" && parse.location) matches++;
    if (fieldDef.type === "service" && parse.entities.some((e) => e.type === "SERVICE")) matches++;
    if (fieldDef.type === "number" && parse.quantity !== undefined) matches++;
    if (fieldName === "destination" && parse.destination) matches++;
    if (fieldName === "source" && parse.source) matches++;
  }

  return matches / total;
}

// ─── Vector Classifier (precomputed TF-IDF) ─────────────────────────────────

interface VectorData { vocab: string[]; vectors: Record<string, Record<string, number>>; }
let _vectorData: VectorData | null = null;

function loadVectors(): VectorData | null {
  if (_vectorData) return _vectorData;
  const paths = [
    resolve(dirname(fileURLToPath(import.meta.url)), "../../config/intent-vectors.json"),
    resolve(process.cwd(), "config/intent-vectors.json"),
  ];
  for (const p of paths) {
    if (existsSync(p)) {
      try { _vectorData = JSON.parse(readFileSync(p, "utf-8")); return _vectorData; } catch { /* skip */ }
    }
  }
  return null;
}

const VECTOR_STOP = new Set(["a","an","the","is","it","in","on","to","for","of","and","or","my","me","i","we","you","do","does","did","be","am","are","was","were","have","has","had","this","that","what","which","who","how","where","when","why","not","no","but","if","so","at","by","with","from","up","out","can","could","would","should","will","may","might","just","about","all","please"]);

function classifyVector(rawText: string): ClassifierVote[] {
  const data = loadVectors();
  if (!data) return [];
  const tokens = rawText.toLowerCase().replace(/[^a-z0-9_.\-\/]/g, " ").split(/\s+/).filter((w) => w.length > 1 && !VECTOR_STOP.has(w));
  if (tokens.length === 0) return [];

  const vocabIndex = new Map(data.vocab.map((v, i) => [v, i]));
  const inputVec: Record<number, number> = {};
  let magnitude = 0;
  const tf = new Map<string, number>();
  for (const t of tokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  for (const [term, count] of tf) {
    const idx = vocabIndex.get(term);
    if (idx !== undefined) { inputVec[idx] = count; magnitude += count * count; }
  }
  magnitude = Math.sqrt(magnitude);
  if (magnitude === 0) return [];
  for (const idx of Object.keys(inputVec)) inputVec[Number(idx)] /= magnitude;

  const votes: ClassifierVote[] = [];
  for (const [intentName, intentVec] of Object.entries(data.vectors)) {
    let dot = 0;
    for (const [idx, val] of Object.entries(inputVec)) {
      const iv = intentVec[idx];
      if (iv) dot += val * iv;
    }
    if (dot > 0.1) {
      votes.push({ classifier: "vector", intent: intentName, confidence: Math.min(0.95, dot), reason: `TF-IDF cosine: ${dot.toFixed(3)}` });
    }
  }
  votes.sort((a, b) => b.confidence - a.confidence);
  return votes.slice(0, 3);
}
