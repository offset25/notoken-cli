import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock dependencies so buildCompletions doesn't need real config files
vi.mock("../../../packages/core/src/utils/config.js", () => ({
  loadIntents: () => [],
  loadRules: () => ({ serviceAliases: {} }),
}));
vi.mock("../../../packages/core/src/context/history.js", () => ({
  getRecentHistory: () => [],
}));

import { buildCompletions, completeInput } from "../../../packages/core/src/utils/completer.js";

describe("completer", () => {
  beforeEach(() => {
    // Force rebuild by calling buildCompletions directly
    buildCompletions();
  });

  it("buildCompletions returns a non-empty array", () => {
    const list = buildCompletions();
    expect(list.length).toBeGreaterThan(0);
  });

  it("buildCompletions includes meta commands", () => {
    const list = buildCompletions();
    expect(list).toContain("/jobs");
    expect(list).toContain("/help");
    expect(list).toContain("/quit");
  });

  it("buildCompletions includes common verbs", () => {
    const list = buildCompletions();
    expect(list).toContain("restart");
    expect(list).toContain("check");
    expect(list).toContain("show");
  });

  it('completeInput("rest") returns matches starting with "rest"', () => {
    const [matches] = completeInput("rest");
    expect(matches.length).toBeGreaterThan(0);
    for (const m of matches) {
      expect(m.toLowerCase().startsWith("rest")).toBe(true);
    }
  });

  it('completeInput("") returns the full list', () => {
    const full = buildCompletions();
    const [matches] = completeInput("");
    expect(matches).toEqual(full);
  });

  it('completeInput("xyznonexistent") returns empty matches (falls back to full list)', () => {
    const full = buildCompletions();
    const [matches] = completeInput("xyznonexistent");
    // When no matches, completer returns the full cached list as fallback
    expect(matches).toEqual(full);
  });
});
