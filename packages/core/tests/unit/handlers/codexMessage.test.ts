import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../src/nlp/parseIntent.js";
import { parseByRules } from "../../../src/nlp/ruleParser.js";

describe("codex.message intent — parsing", () => {
  const phrases = [
    { input: "say hello to codex", expectedIntent: "codex.message", minConfidence: 0.7 },
    { input: "tell codex to check the server", expectedIntent: "codex.message", minConfidence: 0.7 },
    { input: "ask codex to explain this code", expectedIntent: "codex.message", minConfidence: 0.7 },
    { input: "message codex hello", expectedIntent: "codex.message", minConfidence: 0.7 },
    { input: "talk to codex about this project", expectedIntent: "codex.message", minConfidence: 0.7 },
    { input: "say hi to codex", expectedIntent: "codex.message", minConfidence: 0.7 },
  ];

  for (const phrase of phrases) {
    it(`parseByRules: "${phrase.input}" → ${phrase.expectedIntent}`, () => {
      const result = parseByRules(phrase.input);
      expect(result).not.toBeNull();
      expect(result!.intent).toBe(phrase.expectedIntent);
      expect(result!.confidence).toBeGreaterThanOrEqual(phrase.minConfidence);
    });
  }

  it("parseIntent returns codex.message for 'say hello to codex'", async () => {
    const result = await parseIntent("say hello to codex");
    expect(result.intent.intent).toBe("codex.message");
    expect(result.intent.confidence).toBeGreaterThanOrEqual(0.7);
  });

  it("does not confuse codex.message with openclaw.message", async () => {
    const result = await parseIntent("tell openclaw hello");
    expect(result.intent.intent).toBe("openclaw.message");
  });

  it("does not confuse codex.message with tool.install", async () => {
    const result = await parseIntent("install codex");
    expect(result.intent.intent).toBe("tool.install");
  });
});

describe("codex.message intent — message extraction", () => {
  it("extracts message from 'say hello to codex'", () => {
    const raw = "say hello to codex";
    const msgMatch = raw.match(/(?:tell|ask|message|say(?:\s+hello)?\s+to|send|talk\s+to)\s+codex\s+(.*)/i);
    // "say hello to codex" — the message part after "codex" would be empty since "hello" is before "to codex"
    // The handler falls back to fields.message or rawText in that case
    expect(msgMatch === null || msgMatch[1]?.trim() === "").toBe(true);
  });

  it("extracts message from 'tell codex to check the server'", () => {
    const raw = "tell codex to check the server";
    const msgMatch = raw.match(/(?:tell|ask|message|say(?:\s+hello)?\s+to|send|talk\s+to)\s+codex\s+(.*)/i);
    expect(msgMatch).not.toBeNull();
    expect(msgMatch![1].trim()).toBe("to check the server");
  });

  it("extracts message from 'ask codex what is docker'", () => {
    const raw = "ask codex what is docker";
    const msgMatch = raw.match(/(?:tell|ask|message|say(?:\s+hello)?\s+to|send|talk\s+to)\s+codex\s+(.*)/i);
    expect(msgMatch).not.toBeNull();
    expect(msgMatch![1].trim()).toBe("what is docker");
  });
});
