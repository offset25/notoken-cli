/**
 * Audit test: human-reviewed gold-standard phrase set.
 *
 * Per TESTS.md:
 * - Compares against human-reviewed correct answers
 * - Parser must match at least 85% correctly
 * - Any regression from previous run is flagged
 *
 * This test file loads a manually curated set of 50 phrases
 * with their expected intents and minimum confidence levels.
 * It runs the full parseIntent pipeline and reports accuracy.
 */

import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../packages/core/src/nlp/parseIntent.js";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

interface GoldPhrase {
  input: string;
  intent: string;
  minConfidence: number;
}

const goldset: GoldPhrase[] = JSON.parse(
  readFileSync(resolve(__dirname, "../../data/goldsets/common-phrases.json"), "utf-8")
);

// ─── Individual phrase tests ─────────────────────────────────────────────────

describe("audit: gold-standard phrase set", () => {
  for (const phrase of goldset) {
    it(`"${phrase.input}" → ${phrase.intent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.intent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});

// ─── Aggregate accuracy test ─────────────────────────────────────────────────

describe("audit: overall accuracy", () => {
  it("achieves at least 85% accuracy on gold set", async () => {
    let correct = 0;
    let total = goldset.length;
    const failures: Array<{ input: string; expected: string; got: string; confidence: number }> = [];

    for (const phrase of goldset) {
      const result = await parseIntent(phrase.input);
      if (result.intent.intent === phrase.intent && result.intent.confidence >= phrase.minConfidence) {
        correct++;
      } else {
        failures.push({
          input: phrase.input,
          expected: phrase.intent,
          got: result.intent.intent,
          confidence: result.intent.confidence,
        });
      }
    }

    const accuracy = correct / total;
    console.log(`\n  Audit accuracy: ${correct}/${total} (${(accuracy * 100).toFixed(1)}%)`);

    if (failures.length > 0) {
      console.log(`  Failures (${failures.length}):`);
      for (const f of failures) {
        console.log(`    "${f.input}" — expected ${f.expected}, got ${f.got} (${f.confidence.toFixed(2)})`);
      }
    }

    expect(accuracy).toBeGreaterThanOrEqual(0.85);
  });
});
