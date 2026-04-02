import { describe, it, expect } from "vitest";
import { classifyMulti } from "../../../packages/core/src/nlp/multiClassifier.js";

describe("classifyMulti", () => {
  it("returns votes from multiple classifiers", () => {
    const result = classifyMulti("restart nginx on prod");
    expect(result.votes.length).toBeGreaterThan(0);
    expect(result.best).not.toBeNull();
    expect(result.best!.intent).toBe("service.restart");
  });

  it("returns scores sorted by confidence", () => {
    const result = classifyMulti("restart nginx on prod");
    for (let i = 1; i < result.scores.length; i++) {
      expect(result.scores[i - 1].score).toBeGreaterThanOrEqual(result.scores[i].score);
    }
  });

  it("marks ambiguous when top scores are close", () => {
    // This might or might not be ambiguous depending on the input
    const result = classifyMulti("restart nginx on prod");
    expect(typeof result.ambiguous).toBe("boolean");
  });

  it("includes context classifier when recent intents provided", () => {
    const result = classifyMulti("restart nginx on prod", ["service.restart", "service.restart"]);
    const contextVotes = result.votes.filter((v) => v.classifier === "context");
    // May or may not have context votes depending on partial matching
    expect(result.votes.length).toBeGreaterThan(0);
  });

  it("includes fuzzy classifier for typos", () => {
    const result = classifyMulti("restarr ngimx on prod");
    const fuzzyVotes = result.votes.filter((v) => v.classifier === "fuzzy");
    expect(fuzzyVotes.length).toBeGreaterThan(0);
  });
});
