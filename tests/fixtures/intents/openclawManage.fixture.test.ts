import { describe, it, expect } from "vitest";
import { parseByRules } from "../../../packages/core/src/nlp/ruleParser.js";

const phrases = [
  // openclaw.configure
  { input: "configure openclaw", expectedIntent: "openclaw.configure", minConfidence: 0.8 },
  { input: "openclaw configure", expectedIntent: "openclaw.configure", minConfidence: 0.8 },
  { input: "configure openclaw channels", expectedIntent: "openclaw.configure", minConfidence: 0.8 },
  { input: "configure openclaw model", expectedIntent: "openclaw.configure", minConfidence: 0.8 },
  // openclaw.auth
  { input: "openclaw auth", expectedIntent: "openclaw.auth", minConfidence: 0.8 },
  { input: "openclaw api key", expectedIntent: "openclaw.auth", minConfidence: 0.8 },
  { input: "openclaw auth providers", expectedIntent: "openclaw.auth", minConfidence: 0.8 },
  { input: "add api key to openclaw", expectedIntent: "openclaw.auth", minConfidence: 0.8 },
  { input: "list openclaw keys", expectedIntent: "openclaw.auth", minConfidence: 0.8 },
  // openclaw.add_channel
  { input: "add telegram to openclaw", expectedIntent: "openclaw.add_channel", minConfidence: 0.8 },
  { input: "add discord to openclaw", expectedIntent: "openclaw.add_channel", minConfidence: 0.8 },
  { input: "connect telegram", expectedIntent: "openclaw.add_channel", minConfidence: 0.8 },
  { input: "connect discord", expectedIntent: "openclaw.add_channel", minConfidence: 0.8 },
  { input: "add matrix to openclaw", expectedIntent: "openclaw.add_channel", minConfidence: 0.8 },
  { input: "openclaw add channel", expectedIntent: "openclaw.add_channel", minConfidence: 0.8 },
  // openclaw.model
  { input: "which llm is openclaw using", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "switch openclaw to sonnet", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  { input: "openclaw use gpt-4o", expectedIntent: "openclaw.model", minConfidence: 0.8 },
  // openclaw.status
  { input: "openclaw status", expectedIntent: "openclaw.status", minConfidence: 0.8 },
  { input: "can you talk to openclaw", expectedIntent: "openclaw.status", minConfidence: 0.8 },
  // openclaw.diagnose
  { input: "diagnose openclaw", expectedIntent: "openclaw.diagnose", minConfidence: 0.8 },
  { input: "troubleshoot openclaw", expectedIntent: "openclaw.diagnose", minConfidence: 0.8 },
  // openclaw.message
  { input: "tell openclaw hello", expectedIntent: "openclaw.message", minConfidence: 0.8 },
  { input: "ask openclaw how are you", expectedIntent: "openclaw.message", minConfidence: 0.8 },
];

describe("openclaw management intent fixtures", () => {
  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, () => {
      const result = parseByRules(phrase.input);
      expect(result).not.toBeNull();
      expect(result!.intent).toBe(phrase.expectedIntent);
      expect(result!.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
