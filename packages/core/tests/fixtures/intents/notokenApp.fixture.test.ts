import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../src/nlp/parseIntent.js";

describe("notoken.status intent fixtures", () => {
  const phrases = [
    { input: "notoken status", expectedIntent: "notoken.status", minConfidence: 0.7 },
    { input: "notoken info", expectedIntent: "notoken.status", minConfidence: 0.7 },
    { input: "show status", expectedIntent: "notoken.status", minConfidence: 0.7 },
  ];

  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});

describe("notoken.install_app intent fixtures", () => {
  const phrases = [
    { input: "install notoken app", expectedIntent: "notoken.install_app", minConfidence: 0.7 },
    { input: "download notoken app", expectedIntent: "notoken.install_app", minConfidence: 0.7 },
    { input: "install the app", expectedIntent: "notoken.install_app", minConfidence: 0.7 },
    { input: "notoken desktop", expectedIntent: "notoken.install_app", minConfidence: 0.7 },
    { input: "install notoken gui", expectedIntent: "notoken.install_app", minConfidence: 0.7 },
    { input: "get the app", expectedIntent: "notoken.install_app", minConfidence: 0.7 },
  ];

  for (const phrase of phrases) {
    it(`parses: "${phrase.input}" → ${phrase.expectedIntent}`, async () => {
      const result = await parseIntent(phrase.input);
      expect(result.intent.intent).toBe(phrase.expectedIntent);
      expect(result.intent.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }
});
