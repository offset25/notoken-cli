import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";
import phrases from "../../data/fixtures/phrases/browser-phrases.json";

describe("browser intent fixtures", () => {
  for (const phrase of phrases) {
    it(`parses: "${phrase.input}"`, () => {
      const result = parseByRules(phrase.input);
      expect(result).not.toBeNull();
      expect(result!.intent).toBe(phrase.expectedIntent);
      expect(result!.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
