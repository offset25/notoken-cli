/**
 * Semantic Similarity — lightweight sentence-level matching.
 *
 * Uses character n-gram overlap + word-level Jaccard + IDF weighting
 * to compute similarity between user input and intent descriptions/synonyms.
 * No external API needed — runs entirely local.
 *
 * This catches paraphrases that exact synonym matching misses:
 *   "what's hogging my CPU" ≈ "show me what processes are eating resources"
 *   "is my site live" ≈ "check if website is up"
 */

import { loadIntents } from "../utils/config.js";
import type { IntentDef } from "../types/intent.js";

// ─── N-gram extraction ─────────────────────────────────────────────────────

function charNgrams(text: string, n: number): Set<string> {
  const grams = new Set<string>();
  const cleaned = text.toLowerCase().replace(/[^a-z0-9 ]/g, "");
  for (let i = 0; i <= cleaned.length - n; i++) {
    grams.add(cleaned.substring(i, i + n));
  }
  return grams;
}

function wordSet(text: string): Set<string> {
  return new Set(text.toLowerCase().replace(/[^a-z0-9 ]/g, "").split(/\s+/).filter(w => w.length > 1));
}

// ─── Similarity metrics ─────────────────────────────────────────────────────

function jaccardSimilarity(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection++;
  return intersection / (a.size + b.size - intersection);
}

function ngramSimilarity(text1: string, text2: string): number {
  // Combine bigram + trigram overlap
  const bi1 = charNgrams(text1, 2);
  const bi2 = charNgrams(text2, 2);
  const tri1 = charNgrams(text1, 3);
  const tri2 = charNgrams(text2, 3);
  return (jaccardSimilarity(bi1, bi2) * 0.4 + jaccardSimilarity(tri1, tri2) * 0.6);
}

function wordOverlap(text1: string, text2: string): number {
  return jaccardSimilarity(wordSet(text1), wordSet(text2));
}

// ─── Stopword filtering ─────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "a", "an", "the", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "could",
  "should", "may", "might", "can", "shall", "to", "of", "in", "for",
  "on", "with", "at", "by", "from", "it", "its", "this", "that",
  "i", "me", "my", "we", "us", "our", "you", "your", "he", "she",
  "they", "them", "what", "which", "who", "when", "where", "how",
  "not", "no", "nor", "or", "and", "but", "if", "then", "so",
  "just", "also", "very", "too", "some", "any", "all", "more",
  "please", "can", "could", "would",
]);

function contentWords(text: string): string[] {
  return text.toLowerCase().split(/\s+/).filter(w => w.length > 2 && !STOPWORDS.has(w));
}

// ─── IDF weighting ──────────────────────────────────────────────────────────
// Words that appear in many intents are less discriminative.

let idfCache: Map<string, number> | null = null;

function buildIDF(): Map<string, number> {
  if (idfCache) return idfCache;
  const intents = loadIntents();
  const docCount = new Map<string, number>();
  const totalDocs = intents.length;

  for (const intent of intents) {
    const wordsInDoc = new Set<string>();
    for (const syn of intent.synonyms) {
      for (const w of contentWords(syn)) wordsInDoc.add(w);
    }
    for (const w of contentWords(intent.description)) wordsInDoc.add(w);
    for (const w of wordsInDoc) docCount.set(w, (docCount.get(w) ?? 0) + 1);
  }

  idfCache = new Map();
  for (const [word, count] of docCount) {
    idfCache.set(word, Math.log(totalDocs / (1 + count)));
  }
  return idfCache;
}

function weightedOverlap(text1: string, text2: string): number {
  const idf = buildIDF();
  const words1 = contentWords(text1);
  const words2 = new Set(contentWords(text2));

  let weightedIntersection = 0;
  let totalWeight = 0;

  for (const w of words1) {
    const weight = idf.get(w) ?? 2.0; // Unknown words get high weight (rare = discriminative)
    totalWeight += weight;
    if (words2.has(w)) weightedIntersection += weight;
  }

  return totalWeight > 0 ? weightedIntersection / totalWeight : 0;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface SimilarityMatch {
  intent: string;
  score: number;
  matchedPhrase: string;
}

/**
 * Find the most similar intents to the input text.
 * Combines character n-gram, word overlap, and IDF-weighted scoring.
 */
export function findSimilarIntents(rawText: string, topN = 5): SimilarityMatch[] {
  const intents = loadIntents();
  const results: SimilarityMatch[] = [];
  const text = rawText.toLowerCase();

  for (const intent of intents) {
    let bestScore = 0;
    let bestPhrase = "";

    // Score against synonyms
    for (const syn of intent.synonyms) {
      const ngram = ngramSimilarity(text, syn);
      const word = wordOverlap(text, syn);
      const weighted = weightedOverlap(text, syn);
      const score = ngram * 0.3 + word * 0.3 + weighted * 0.4;
      if (score > bestScore) { bestScore = score; bestPhrase = syn; }
    }

    // Score against description
    const descNgram = ngramSimilarity(text, intent.description);
    const descWord = wordOverlap(text, intent.description);
    const descWeighted = weightedOverlap(text, intent.description);
    const descScore = (descNgram * 0.3 + descWord * 0.3 + descWeighted * 0.4) * 0.8; // Slight penalty for description match
    if (descScore > bestScore) { bestScore = descScore; bestPhrase = intent.description; }

    if (bestScore > 0.15) {
      results.push({ intent: intent.name, score: bestScore, matchedPhrase: bestPhrase });
    }
  }

  return results.sort((a, b) => b.score - a.score).slice(0, topN);
}

/**
 * Score how similar two phrases are (0-1).
 */
export function phraseSimilarity(text1: string, text2: string): number {
  const ngram = ngramSimilarity(text1, text2);
  const word = wordOverlap(text1, text2);
  const weighted = weightedOverlap(text1, text2);
  return ngram * 0.3 + word * 0.3 + weighted * 0.4;
}

/**
 * Expand a query with similar words found across all intent synonyms.
 * Returns words that co-occur with the input words in intent synonyms.
 */
export function expandWithCooccurrences(rawText: string): string[] {
  const intents = loadIntents();
  const inputWords = new Set(contentWords(rawText));
  const cooccur = new Map<string, number>();

  for (const intent of intents) {
    for (const syn of intent.synonyms) {
      const synWords = contentWords(syn);
      const hasOverlap = synWords.some(w => inputWords.has(w));
      if (hasOverlap) {
        for (const w of synWords) {
          if (!inputWords.has(w)) {
            cooccur.set(w, (cooccur.get(w) ?? 0) + 1);
          }
        }
      }
    }
  }

  // Return words that co-occur with input words in at least 2 synonyms
  return [...cooccur.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([word]) => word);
}
