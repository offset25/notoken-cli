import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock fs and os so tests don't touch real filesystem
vi.mock("node:fs", () => ({
  existsSync: () => false,
  readFileSync: () => "",
  appendFileSync: () => {},
  mkdirSync: () => {},
}));
vi.mock("node:os", () => ({
  homedir: () => "/tmp/test-notoken-home",
}));

// We need to reset the module-level _history cache between tests
let addToHistory: typeof import("../../../src/utils/commandHistory.js").addToHistory;
let searchHistory: typeof import("../../../src/utils/commandHistory.js").searchHistory;
let getRecentCommands: typeof import("../../../src/utils/commandHistory.js").getRecentCommands;
let getReadlineHistory: typeof import("../../../src/utils/commandHistory.js").getReadlineHistory;

describe("commandHistory", () => {
  beforeEach(async () => {
    vi.resetModules();
    const mod = await import("../../../src/utils/commandHistory.js");
    addToHistory = mod.addToHistory;
    searchHistory = mod.searchHistory;
    getRecentCommands = mod.getRecentCommands;
    getReadlineHistory = mod.getReadlineHistory;
  });

  it("addToHistory stores a command", () => {
    addToHistory("restart nginx");
    const recent = getRecentCommands();
    expect(recent).toContain("restart nginx");
  });

  it("addToHistory deduplicates consecutive identical commands", () => {
    addToHistory("check disk");
    addToHistory("check disk");
    addToHistory("check disk");
    const recent = getRecentCommands();
    expect(recent.filter((c) => c === "check disk").length).toBe(1);
  });

  it("addToHistory skips meta commands starting with : or /", () => {
    addToHistory("/help");
    addToHistory(":quit");
    addToHistory("restart nginx");
    const recent = getRecentCommands();
    expect(recent).not.toContain("/help");
    expect(recent).not.toContain(":quit");
    expect(recent).toContain("restart nginx");
  });

  it("searchHistory finds commands by substring", () => {
    addToHistory("restart nginx");
    addToHistory("check disk space");
    addToHistory("restart redis");
    const results = searchHistory("restart");
    expect(results.length).toBeGreaterThanOrEqual(2);
    for (const r of results) {
      expect(r.toLowerCase()).toContain("restart");
    }
  });

  it("searchHistory finds commands by word overlap", () => {
    addToHistory("show docker containers");
    addToHistory("list running services");
    addToHistory("docker logs nginx");
    const results = searchHistory("docker");
    expect(results.length).toBeGreaterThanOrEqual(2);
  });

  it("getRecentCommands returns unique recent entries", () => {
    addToHistory("cmd a");
    addToHistory("cmd b");
    addToHistory("cmd a"); // not consecutive, so added
    const recent = getRecentCommands();
    // Should deduplicate in output
    const unique = new Set(recent);
    expect(unique.size).toBe(recent.length);
  });

  it("getReadlineHistory returns reversed array", () => {
    addToHistory("first");
    addToHistory("second");
    addToHistory("third");
    const rlHistory = getReadlineHistory();
    expect(rlHistory[0]).toBe("third");
    expect(rlHistory[rlHistory.length - 1]).toBe("first");
  });
});
