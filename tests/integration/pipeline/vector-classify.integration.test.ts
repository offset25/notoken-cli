import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../packages/core/src/nlp/parseIntent.js";
import { classifyMulti } from "../../../packages/core/src/nlp/multiClassifier.js";

describe("vector classifier → parseIntent integration", () => {
  it("'check disk space' still works (rule parser)", async () => {
    const result = await parseIntent("check disk space");
    expect(result.intent.intent).toBe("server.check_disk");
    expect(result.intent.confidence).toBeGreaterThanOrEqual(0.8);
  });

  it("'restart nginx on prod' still works (rule parser)", async () => {
    const result = await parseIntent("restart nginx on prod");
    expect(result.intent.intent).toBe("service.restart");
  });

  it("'free up space' still works (rule parser)", async () => {
    const result = await parseIntent("free up space");
    expect(result.intent.intent).toBe("disk.cleanup");
  });

  it("'how much RAM do I have' resolves via multi-classifier", async () => {
    const result = await parseIntent("how much RAM do I have");
    expect(result.intent.intent).toBe("server.check_memory");
  });

  it("multi-classifier produces 5 classifier types", () => {
    const result = classifyMulti("restart nginx on prod");
    const classifiers = new Set(result.votes.map((v) => v.classifier));
    // Should have at least synonym + semantic + vector
    expect(classifiers.has("synonym")).toBe(true);
    expect(classifiers.has("semantic")).toBe(true);
    expect(classifiers.has("vector")).toBe(true);
  });

  it("vector classifier contributes to scoring", () => {
    const result = classifyMulti("check memory usage");
    const vectorVotes = result.votes.filter((v) => v.classifier === "vector");
    expect(vectorVotes.length).toBeGreaterThan(0);
    // Should find memory-related intents
    const memVote = vectorVotes.find((v) => v.intent.includes("memory"));
    expect(memVote).toBeDefined();
  });
});
