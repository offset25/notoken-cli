import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";

const phrases = [
  // Model switching — codex variants
  { input: "switch openclaw to codex", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "switch openclaw to gpt-4o", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "switch openclaw to gpt-5", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "set openclaw model to chatgpt", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "set openclaw model to opus", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "switch openclaw to sonnet", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "change openclaw to haiku", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  // Notoken model
  { input: "use ollama", expectedIntent: "notoken.model", minConfidence: 0.8 },
  { input: "which llm am i using", expectedIntent: "notoken.model", minConfidence: 0.8 },
  { input: "current model", expectedIntent: "notoken.model", minConfidence: 0.8 },
  // LLM message
  { input: "tell claude explain docker", expectedIntent: "llm.message", minConfidence: 0.8 },
  { input: "talk to claude about kubernetes", expectedIntent: "llm.message", minConfidence: 0.8 },
  // Openclaw message
  { input: "tell openclaw hello", expectedIntent: "openclaw.message", minConfidence: 0.8 },
  { input: "ask openclaw what can you do", expectedIntent: "openclaw.message", minConfidence: 0.8 },
  // Codex CLI intents
  { input: "codex status", expectedIntent: "codex.status", minConfidence: 0.8 },
  { input: "is codex installed", expectedIntent: "codex.status", minConfidence: 0.7 },
  { input: "check codex", expectedIntent: "codex.status", minConfidence: 0.7 },
  { input: "install codex", expectedIntent: "codex.install", minConfidence: 0.8 },
  { input: "setup codex", expectedIntent: "codex.install", minConfidence: 0.7 },
  { input: "use codex for refactoring", expectedIntent: "codex.run", minConfidence: 0.7 },
  // Convex
  { input: "convex projects", expectedIntent: "convex.projects", minConfidence: 0.8 },
  { input: "talk to convex hello", expectedIntent: "convex.message", minConfidence: 0.8 },
];

describe("codex + model + llm intent fixtures", () => {
  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, () => {
      const result = parseByRules(phrase.input);
      expect(result).not.toBeNull();
      expect(result!.intent).toBe(phrase.expectedIntent);
      expect(result!.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
