import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../src/nlp/parseIntent.js";

describe("llm.shell intent fixtures", () => {
  const phrases = [
    { input: "open codex", expectedIntent: "llm.shell", minConfidence: 0.7 },
    { input: "launch codex", expectedIntent: "llm.shell", minConfidence: 0.7 },
    { input: "switch to claude", expectedIntent: "llm.shell", minConfidence: 0.7 },
    { input: "enter claude", expectedIntent: "llm.shell", minConfidence: 0.7 },
    { input: "go to codex", expectedIntent: "llm.shell", minConfidence: 0.7 },
    { input: "open ollama", expectedIntent: "llm.shell", minConfidence: 0.7 },
    { input: "launch ollama", expectedIntent: "llm.shell", minConfidence: 0.7 },
  ];

  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});

describe("llm.claude_cli without prompt routes to shell", () => {
  it('"run claude" routes to llm.claude_cli (interactive)', async () => {
    const result = await parseIntent("run claude");
    // llm.claude_cli with no prompt triggers shell handler
    expect(result.intent.intent).toBe("llm.claude_cli");
  });
});
