/**
 * Correction Learner — learns from user corrections after misrouted intents.
 *
 * When the user says "no I meant X" or "not that, I want Y", this module
 * records the correction and uses it to improve future classifications.
 * Uses fuzzy matching so similar phrases benefit from past corrections.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

// ─── Types ──────────────────────────────────────────────────────────────────

export interface LearnedCorrection {
  input: string;
  wrongIntent: string;
  correctIntent: string;
  count: number;
  lastSeen: string;
}

interface CorrectionMatch {
  intent: string;
  confidence: number;
}

// ─── Constants ──────────────────────────────────────────────────────────────

const CORRECTIONS_DIR = resolve(homedir(), ".notoken");
const CORRECTIONS_FILE = resolve(CORRECTIONS_DIR, "learned-corrections.json");
const MAX_ENTRIES = 500;

// ─── Persistence ────────────────────────────────────────────────────────────

function loadCorrections(): LearnedCorrection[] {
  if (!existsSync(CORRECTIONS_FILE)) return [];
  try {
    const data = JSON.parse(readFileSync(CORRECTIONS_FILE, "utf-8"));
    return Array.isArray(data) ? data : [];
  } catch {
    return [];
  }
}

function saveCorrections(corrections: LearnedCorrection[]): void {
  if (!existsSync(CORRECTIONS_DIR)) {
    mkdirSync(CORRECTIONS_DIR, { recursive: true });
  }
  // Prune to MAX_ENTRIES, keeping most recently seen
  if (corrections.length > MAX_ENTRIES) {
    corrections.sort((a, b) => b.lastSeen.localeCompare(a.lastSeen));
    corrections = corrections.slice(0, MAX_ENTRIES);
  }
  writeFileSync(CORRECTIONS_FILE, JSON.stringify(corrections, null, 2));
}

// ─── Fuzzy Matching ─────────────────────────────────────────────────────────

/** Tokenize and normalize text for comparison. */
function tokenize(text: string): string[] {
  return text.toLowerCase().replace(/[^\w\s]/g, "").split(/\s+/).filter(w => w.length > 1);
}

/**
 * Jaccard similarity between two token sets — measures overlap.
 * Returns 0..1 where 1 = identical token sets.
 */
function jaccardSimilarity(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  const setA = new Set(a);
  const setB = new Set(b);
  let intersection = 0;
  for (const token of setA) {
    if (setB.has(token)) intersection++;
  }
  const union = setA.size + setB.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/**
 * Edit distance between two words (Levenshtein).
 */
function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

/**
 * Fuzzy token similarity — allows minor spelling differences between words.
 * Each token in A is matched to the closest token in B (edit distance <= 2).
 */
function fuzzyTokenOverlap(a: string[], b: string[]): number {
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  let matches = 0;
  for (const tokA of a) {
    for (const tokB of b) {
      const maxDist = tokA.length <= 4 ? 1 : 2;
      if (tokA === tokB || editDistance(tokA, tokB) <= maxDist) {
        matches++;
        break;
      }
    }
  }
  return matches / Math.max(a.length, b.length);
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Record a user correction. Merges with existing entry if the same
 * input+wrongIntent+correctIntent triple already exists.
 */
export function recordCorrection(
  input: string,
  wrongIntent: string,
  correctIntent: string,
): void {
  const corrections = loadCorrections();
  const normalized = input.trim().toLowerCase();

  const existing = corrections.find(
    c => c.input === normalized && c.wrongIntent === wrongIntent && c.correctIntent === correctIntent,
  );

  if (existing) {
    existing.count++;
    existing.lastSeen = new Date().toISOString();
  } else {
    corrections.push({
      input: normalized,
      wrongIntent,
      correctIntent,
      count: 1,
      lastSeen: new Date().toISOString(),
    });
  }

  saveCorrections(corrections);
}

/**
 * Check if a user input matches a previously corrected pattern.
 * Uses fuzzy matching so synonymous phrases benefit from past corrections.
 *
 * Returns the corrected intent with a confidence score, or null if no match.
 */
export function checkCorrections(rawText: string): CorrectionMatch | null {
  const corrections = loadCorrections();
  if (corrections.length === 0) return null;

  const inputTokens = tokenize(rawText);
  if (inputTokens.length === 0) return null;

  let bestMatch: LearnedCorrection | null = null;
  let bestScore = 0;

  for (const correction of corrections) {
    const corrTokens = tokenize(correction.input);

    // Combine Jaccard (exact) and fuzzy overlap for robustness
    const jaccard = jaccardSimilarity(inputTokens, corrTokens);
    const fuzzy = fuzzyTokenOverlap(inputTokens, corrTokens);
    const score = Math.max(jaccard, fuzzy * 0.9);

    // Boost score for corrections with high count (proven patterns)
    const boosted = score + Math.min(correction.count * 0.02, 0.1);

    if (boosted > bestScore && boosted >= 0.55) {
      bestScore = boosted;
      bestMatch = correction;
    }
  }

  if (!bestMatch) return null;

  // Confidence: base from similarity, capped at 0.92
  const confidence = Math.min(0.92, 0.6 + (bestScore - 0.55) * 0.8);
  return { intent: bestMatch.correctIntent, confidence };
}

/**
 * Detect if the user is issuing a correction to a previous misroute.
 *
 * Patterns detected:
 *   "no I meant restart the service"
 *   "not that, I want to check disk"
 *   "wrong, I wanted to see logs"
 *   "no, show me the containers"
 *   "I said restart not status"
 *
 * Returns the corrected intent text (the part after the correction marker)
 * or null if this is not a correction.
 */
export function detectCorrection(rawText: string, lastIntent: string | null): string | null {
  if (!lastIntent) return null;

  const text = rawText.trim();

  // Pattern list: correction prefix → capture the intended action
  const patterns: RegExp[] = [
    /^no[,.]?\s+(?:i\s+)?meant?\s+(?:to\s+)?(.+)/i,
    /^no[,.]?\s+i\s+want(?:ed)?\s+(?:to\s+)?(.+)/i,
    /^not\s+that[,.]?\s+(?:i\s+)?want(?:ed)?\s+(?:to\s+)?(.+)/i,
    /^not\s+that[,.]?\s+(.+)/i,
    /^wrong[,.]?\s+(?:i\s+)?want(?:ed)?\s+(?:to\s+)?(.+)/i,
    /^wrong[,.]?\s+(.+)/i,
    /^no[,.]?\s+(?:do|run|show|check|list|start|stop|restart|open|get)\s+(.+)/i,
    /^no[,.]?\s+(show|check|list|start|stop|restart|open|get)\s+(.+)/i,
    /^i\s+said\s+(.+?)(?:\s+not\s+.+)?$/i,
    /^i\s+meant?\s+(?:to\s+)?(.+)/i,
    /^that'?s?\s+(?:not\s+)?(?:what\s+i\s+)?(?:meant|wanted)[,.]?\s+(?:i\s+want(?:ed)?\s+(?:to\s+)?)?(.+)/i,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match) {
      // Use the last capture group (some patterns have 2 groups)
      const captured = match[match.length > 2 ? 2 : 1]?.trim();
      if (captured && captured.length >= 2) {
        return captured;
      }
    }
  }

  // Simple "no" followed by a complete new command on next line or after punctuation
  // Only bare "no" / "nope" / "wrong" without further text — caller handles next input
  if (/^(no|nope|wrong|that'?s\s+wrong|not\s+what\s+i\s+(meant|wanted))\.?$/i.test(text)) {
    return ""; // Signal: user rejected, but correction text is in the next input
  }

  return null;
}
