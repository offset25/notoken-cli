import { describe, it, expect } from "vitest";
import { classifyMulti } from "../../../packages/core/src/nlp/multiClassifier.js";
import { existsSync } from "node:fs";
import { resolve } from "node:path";

describe("vector classifier — precomputed TF-IDF", () => {
  it("intent-vectors.json exists", () => {
    const vectorPath = resolve(process.cwd(), "config/intent-vectors.json");
    expect(existsSync(vectorPath)).toBe(true);
  });

  it("produces vector votes for relevant input", () => {
    const result = classifyMulti("check disk space on prod");
    const vectorVotes = result.votes.filter((v) => v.classifier === "vector");
    expect(vectorVotes.length).toBeGreaterThan(0);
  });

  it("vector classifier finds server.check_disk for storage query", () => {
    const result = classifyMulti("how much storage is left");
    const vectorVotes = result.votes.filter((v) => v.classifier === "vector");
    const diskVote = vectorVotes.find((v) => v.intent === "server.check_disk");
    expect(diskVote).toBeDefined();
  });

  it("vector classifier finds server.check_memory for RAM query", () => {
    const result = classifyMulti("how much RAM do I have");
    const vectorVotes = result.votes.filter((v) => v.classifier === "vector");
    const memVote = vectorVotes.find((v) => v.intent === "server.check_memory");
    expect(memVote).toBeDefined();
  });

  it("vector classifier finds git.pull for update code query", () => {
    const result = classifyMulti("get the latest code from remote");
    const vectorVotes = result.votes.filter((v) => v.classifier === "vector");
    const pullVote = vectorVotes.find((v) => v.intent === "git.pull");
    expect(pullVote).toBeDefined();
  });

  it("does not produce vector votes for gibberish", () => {
    const result = classifyMulti("xyzzy foobar baz");
    const vectorVotes = result.votes.filter((v) => v.classifier === "vector");
    expect(vectorVotes.length).toBe(0);
  });
});

describe("multi-classifier merge formula", () => {
  it("synonym match wins even with other low-confidence votes", () => {
    const result = classifyMulti("restart nginx on prod");
    expect(result.best!.intent).toBe("service.restart");
  });

  it("multi-classifier agreement boosts score", () => {
    const result = classifyMulti("restart nginx on prod");
    const restartScore = result.scores.find((s) => s.intent === "service.restart");
    // Should have multiple votes (synonym + semantic + vector)
    expect(restartScore!.votes).toBeGreaterThanOrEqual(2);
  });

  it("single-vote intents don't beat multi-vote with higher max", () => {
    const result = classifyMulti("restart nginx on prod");
    // service.restart should beat system.reboot
    const restartIdx = result.scores.findIndex((s) => s.intent === "service.restart");
    const rebootIdx = result.scores.findIndex((s) => s.intent === "system.reboot");
    if (rebootIdx >= 0) {
      expect(restartIdx).toBeLessThan(rebootIdx);
    }
  });
});

describe("parseIntent with vector fallback", () => {
  it("resolves 'how much RAM' via multi-classifier when rules miss", async () => {
    const { parseIntent } = await import("../../../packages/core/src/nlp/parseIntent.js");
    const result = await parseIntent("how much RAM do I have");
    expect(result.intent.intent).toBe("server.check_memory");
  });
});
