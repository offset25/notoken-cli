import { describe, it, expect } from "vitest";
import { searchWikidata } from "../../../packages/core/src/nlp/wikidata.js";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const CACHE_FILE = resolve(process.env.NOTOKEN_HOME ?? resolve(homedir(), ".notoken"), "wikidata-cache.json");

describe("wikidata integration", () => {
  it("looks up a known entity", async () => {
    const result = await searchWikidata("nginx");
    expect(result.found).toBe(true);
    expect(result.entity).toBeDefined();
    expect(result.entity!.label.toLowerCase()).toContain("nginx");
    expect(result.entity!.description.length).toBeGreaterThan(0);
  });

  it("returns instanceOf for a software entity", async () => {
    const result = await searchWikidata("kubernetes");
    expect(result.found).toBe(true);
    expect(result.entity!.instanceOf.length).toBeGreaterThan(0);
  });

  it("looks up a person", async () => {
    const result = await searchWikidata("linus torvalds");
    expect(result.found).toBe(true);
    expect(result.entity!.instanceOf).toContain("human");
  });

  it("returns not found for gibberish", async () => {
    const result = await searchWikidata("xyzzyqwertasdf");
    expect(result.found).toBe(false);
  });

  it("caches results to disk", async () => {
    // First lookup populates cache
    await searchWikidata("docker");
    expect(existsSync(CACHE_FILE)).toBe(true);

    const cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    expect(cache["docker"]).toBeDefined();
    expect(cache["docker"].entity.label).toBeDefined();
  });

  it("returns cached result on second lookup", async () => {
    // First call
    const r1 = await searchWikidata("python");
    expect(r1.found).toBe(true);

    // Second call should be from cache (faster)
    const start = Date.now();
    const r2 = await searchWikidata("python");
    const elapsed = Date.now() - start;
    expect(r2.found).toBe(true);
    expect(r2.entity!.label).toBe(r1.entity!.label);
    // Cached should be < 50ms (no network)
    expect(elapsed).toBeLessThan(100);
  });
});
