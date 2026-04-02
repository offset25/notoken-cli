import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../packages/core/src/nlp/parseIntent.js";

const infoPhases = [
  { input: "how to install claude", expectedIntent: "tool.info", minConfidence: 0.7 },
  { input: "how do i install codex", expectedIntent: "tool.info", minConfidence: 0.7 },
  { input: "give me the command to install ollama", expectedIntent: "tool.info", minConfidence: 0.7 },
  { input: "install command for docker", expectedIntent: "tool.info", minConfidence: 0.7 },
  { input: "how to setup convex", expectedIntent: "tool.info", minConfidence: 0.7 },
  { input: "installation instructions for node", expectedIntent: "tool.info", minConfidence: 0.7 },
];

const installPhrases = [
  { input: "install claude", expectedIntent: "tool.install", minConfidence: 0.7 },
  { input: "install codex", expectedIntent: "tool.install", minConfidence: 0.7 },
  { input: "install openclaw", expectedIntent: "tool.install", minConfidence: 0.7 },
  { input: "install ollama", expectedIntent: "tool.install", minConfidence: 0.7 },
  { input: "setup claude", expectedIntent: "tool.install", minConfidence: 0.7 },
  { input: "install docker", expectedIntent: "tool.install", minConfidence: 0.7 },
  { input: "install bun", expectedIntent: "tool.install", minConfidence: 0.7 },
];

describe("tool.info intent fixtures", () => {
  for (const phrase of infoPhases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});

describe("tool.install intent fixtures", () => {
  for (const phrase of installPhrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
