import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import type { Token } from "./semantic.js";
import type { DynamicIntent } from "../types/intent.js";
import type { UncertaintyReport } from "../conversation/store.js";
import { LOG_DIR } from "../utils/paths.js";

const UNCERTAINTY_LOG = resolve(LOG_DIR, "uncertainty.json");

export interface UncertaintyEntry {
  timestamp: string;
  rawText: string;
  intent: string;
  overallConfidence: number;
  unknownTokens: string[];
  lowConfidenceFields: Array<{ field: string; value: string; confidence: number }>;
  /** Which parts of the sentence had no coverage */
  uncoveredSpans: string[];
}

/**
 * Analyze a parse result for uncertainty.
 *
 * Returns a report of:
 * - Tokens that weren't classified (UNKNOWN tag)
 * - Fields that were filled with low confidence
 * - Parts of the sentence that weren't used by any field
 */
export function analyzeUncertainty(
  rawText: string,
  tokens: Token[],
  intent: DynamicIntent
): UncertaintyReport {
  const unknownTokens = tokens
    .filter((t) => t.tag === "UNKNOWN")
    .map((t) => t.text);

  // Find tokens that weren't consumed by any field
  const usedWords = new Set<string>();
  for (const value of Object.values(intent.fields)) {
    if (typeof value === "string") {
      for (const word of value.toLowerCase().split(/\s+/)) {
        usedWords.add(word);
      }
    }
  }

  const uncoveredTokens = tokens.filter(
    (t) =>
      t.tag !== "DET" &&
      t.tag !== "PREP" &&
      t.tag !== "CONJ" &&
      !usedWords.has(t.text) &&
      t.text !== intent.intent.split(".")[0] // Don't count the intent verb as uncovered
  );

  // Estimate field confidence based on extraction method
  const lowConfidenceFields: Array<{ field: string; value: string; confidence: number }> = [];
  for (const [field, value] of Object.entries(intent.fields)) {
    if (typeof value !== "string" || !value) continue;

    // Fields filled by defaults are lower confidence
    const wasExplicit = rawText.toLowerCase().includes(value.toLowerCase());
    if (!wasExplicit) {
      lowConfidenceFields.push({ field, value, confidence: 0.4 });
    }
  }

  return {
    unknownTokens,
    lowConfidenceFields,
    overallConfidence: intent.confidence,
  };
}

/**
 * Get the uncovered spans — parts of the sentence we didn't understand.
 */
export function getUncoveredSpans(rawText: string, tokens: Token[]): string[] {
  const spans: string[] = [];
  let currentSpan: string[] = [];

  for (const token of tokens) {
    if (token.tag === "UNKNOWN") {
      currentSpan.push(token.text);
    } else {
      if (currentSpan.length > 0) {
        spans.push(currentSpan.join(" "));
        currentSpan = [];
      }
    }
  }

  if (currentSpan.length > 0) {
    spans.push(currentSpan.join(" "));
  }

  return spans;
}

/**
 * Log uncertainty for later analysis by the auto-learning system.
 */
export function logUncertainty(entry: UncertaintyEntry): void {
  if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

  const existing = loadUncertaintyLog();
  existing.push(entry);

  // Keep last 500 entries
  if (existing.length > 500) existing.splice(0, existing.length - 500);

  writeFileSync(UNCERTAINTY_LOG, JSON.stringify(existing, null, 2));
}

export function loadUncertaintyLog(): UncertaintyEntry[] {
  if (!existsSync(UNCERTAINTY_LOG)) return [];
  return JSON.parse(readFileSync(UNCERTAINTY_LOG, "utf-8"));
}

/**
 * Get a summary of most common uncertain tokens across all logged entries.
 */
export function getUncertaintySummary(): Array<{ token: string; count: number }> {
  const log = loadUncertaintyLog();
  const counts = new Map<string, number>();

  for (const entry of log) {
    for (const token of entry.unknownTokens) {
      counts.set(token, (counts.get(token) ?? 0) + 1);
    }
  }

  return Array.from(counts.entries())
    .map(([token, count]) => ({ token, count }))
    .sort((a, b) => b.count - a.count);
}
