import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../packages/core/src/nlp/parseIntent.js";

const phrases = [
  // ollama.models
  { input: "ollama models", expectedIntent: "ollama.models", minConfidence: 0.7 },
  { input: "ollama list", expectedIntent: "ollama.models", minConfidence: 0.7 },
  { input: "list ollama models", expectedIntent: "ollama.models", minConfidence: 0.7 },
  { input: "show ollama models", expectedIntent: "ollama.models", minConfidence: 0.7 },
  { input: "what ollama models", expectedIntent: "ollama.models", minConfidence: 0.7 },
  // ollama.pull
  { input: "ollama pull llama3.2", expectedIntent: "ollama.pull", minConfidence: 0.7 },
  { input: "pull ollama model", expectedIntent: "ollama.pull", minConfidence: 0.7 },
  { input: "install ollama model", expectedIntent: "ollama.pull", minConfidence: 0.7 },
  { input: "ollama download codellama", expectedIntent: "ollama.pull", minConfidence: 0.7 },
  // ollama.storage
  { input: "ollama storage", expectedIntent: "ollama.storage", minConfidence: 0.7 },
  { input: "where are ollama models", expectedIntent: "ollama.storage", minConfidence: 0.7 },
  { input: "ollama disk usage", expectedIntent: "ollama.storage", minConfidence: 0.7 },
  // ollama.remove
  { input: "ollama remove llama3.2", expectedIntent: "ollama.remove", minConfidence: 0.7 },
  { input: "delete ollama model", expectedIntent: "ollama.remove", minConfidence: 0.7 },
  // ollama.start/stop/restart
  { input: "start ollama", expectedIntent: "ollama.start", minConfidence: 0.7 },
  { input: "stop ollama", expectedIntent: "ollama.stop", minConfidence: 0.7 },
  { input: "restart ollama", expectedIntent: "ollama.restart", minConfidence: 0.7 },
];

describe("ollama intent fixtures", () => {
  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
