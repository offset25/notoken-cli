import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";

const phrases = [
  // openclaw.model — check
  { input: "which llm is openclaw using", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "what model is openclaw using", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "openclaw model status", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  // openclaw.model — switch
  { input: "set openclaw model to sonnet", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "openclaw use gpt-4o", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "change openclaw model to opus", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  // notoken.model — check
  { input: "which llm am i using", expectedIntent: "notoken.model", minConfidence: 0.8 },
  { input: "notoken model", expectedIntent: "notoken.model", minConfidence: 0.8 },
  { input: "current model", expectedIntent: "notoken.model", minConfidence: 0.8 },
  // notoken.model — switch
  { input: "use ollama", expectedIntent: "notoken.model", minConfidence: 0.8 },
  { input: "switch model to claude", expectedIntent: "notoken.model", minConfidence: 0.7 },
  // convex.projects
  { input: "what projects do i have on convex", expectedIntent: "convex.projects", minConfidence: 0.8 },
  { input: "convex projects", expectedIntent: "convex.projects", minConfidence: 0.8 },
  { input: "convex functions", expectedIntent: "convex.projects", minConfidence: 0.8 },
  { input: "convex tables", expectedIntent: "convex.projects", minConfidence: 0.8 },
];

describe("model + convex intent fixtures", () => {
  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, () => {
      const result = parseByRules(phrase.input);
      expect(result).not.toBeNull();
      expect(result!.intent).toBe(phrase.expectedIntent);
      expect(result!.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
