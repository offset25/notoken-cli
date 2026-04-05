import { describe, it, expect } from "vitest";
import { findSimilarIntents, phraseSimilarity, expandWithCooccurrences } from "../../../src/nlp/semanticSimilarity.js";

describe("phraseSimilarity", () => {
  it("identical phrases score 1.0", () => {
    expect(phraseSimilarity("restart nginx", "restart nginx")).toBeCloseTo(1.0, 1);
  });

  it("similar phrases score higher than different ones", () => {
    const similar = phraseSimilarity("restart the web server", "restart nginx on prod");
    const different = phraseSimilarity("restart the web server", "check disk space");
    expect(similar).toBeGreaterThan(different);
  });

  it("synonym paraphrases have reasonable similarity", () => {
    const score = phraseSimilarity("reboot the machine", "restart the server");
    expect(score).toBeGreaterThan(0.1);
  });
});

describe("findSimilarIntents", () => {
  it("returns results for valid input", () => {
    const results = findSimilarIntents("restart the web server");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]).toHaveProperty("intent");
    expect(results[0]).toHaveProperty("score");
  });

  it("top result for 'restart nginx' should be service.restart", () => {
    const results = findSimilarIntents("restart nginx");
    expect(results[0].intent).toBe("service.restart");
  });

  it("top result for 'check disk space' should be server.check_disk", () => {
    const results = findSimilarIntents("check disk space");
    expect(results[0].intent).toBe("server.check_disk");
  });

  it("top result for 'show docker containers' should be docker-related", () => {
    const results = findSimilarIntents("show docker containers");
    expect(results[0].intent).toMatch(/docker/);
  });

  it("returns multiple results sorted by score", () => {
    const results = findSimilarIntents("check something", 5);
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });
});

describe("expandWithCooccurrences", () => {
  it("returns related words for 'restart'", () => {
    const expanded = expandWithCooccurrences("restart");
    expect(expanded.length).toBeGreaterThan(0);
  });

  it("returns related words for 'docker'", () => {
    const expanded = expandWithCooccurrences("docker");
    expect(expanded.length).toBeGreaterThan(0);
  });
});
