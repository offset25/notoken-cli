import { describe, it, expect } from "vitest";
import { keyboardDistance, fuzzyMatch } from "../../../packages/core/src/nlp/semantic.js";

describe("keyboardDistance", () => {
  it("returns 0 for identical strings", () => {
    expect(keyboardDistance("nginx", "nginx")).toBe(0);
  });

  it("returns lower cost for adjacent key substitution", () => {
    // 'r' and 't' are adjacent on QWERTY
    const adjacent = keyboardDistance("restart", "testart");
    // 'r' and 'z' are NOT adjacent
    const nonAdjacent = keyboardDistance("restart", "zestart");
    expect(adjacent).toBeLessThan(nonAdjacent);
  });

  it("adjacent key sub costs 0.5", () => {
    // single adjacent sub: s→d
    expect(keyboardDistance("as", "ad")).toBe(0.5);
  });

  it("non-adjacent sub costs 1", () => {
    expect(keyboardDistance("az", "ap")).toBe(1);
  });

  it("handles insertion", () => {
    expect(keyboardDistance("nginx", "nginxx")).toBe(1);
  });

  it("handles deletion", () => {
    expect(keyboardDistance("nginx", "ngix")).toBe(1);
  });

  it("handles empty strings", () => {
    expect(keyboardDistance("", "abc")).toBe(3);
    expect(keyboardDistance("abc", "")).toBe(3);
    expect(keyboardDistance("", "")).toBe(0);
  });
});

describe("fuzzyMatch", () => {
  const services = ["nginx", "redis", "api", "worker", "postgres"];

  it("matches exact word", () => {
    const result = fuzzyMatch("nginx", services);
    expect(result).not.toBeNull();
    expect(result!.match).toBe("nginx");
    expect(result!.distance).toBe(0);
  });

  it("matches adjacent key typo", () => {
    // 'i' and 'o' are adjacent → "ngosx" vs "nginx"? Let's use a real typo
    const result = fuzzyMatch("ngimx", services, 1.5);
    expect(result).not.toBeNull();
    expect(result!.match).toBe("nginx");
  });

  it("matches close misspelling", () => {
    const result = fuzzyMatch("redus", services, 1.5);
    expect(result).not.toBeNull();
    expect(result!.match).toBe("redis");
  });

  it("returns null for distant words", () => {
    const result = fuzzyMatch("banana", services, 2);
    expect(result).toBeNull();
  });

  it("picks closest match among candidates", () => {
    const result = fuzzyMatch("api", ["app", "api", "apt"], 1);
    expect(result!.match).toBe("api");
    expect(result!.distance).toBe(0);
  });
});
