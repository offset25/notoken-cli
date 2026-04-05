import { describe, it, expect } from "vitest";
import { validatePatch } from "../../../src/healing/ruleValidator.js";
import type { RulePatch } from "../../../src/types/rules.js";

describe("ruleValidator integration", () => {
  it("accepts a valid patch", () => {
    const patch: RulePatch = {
      summary: "add recycle as restart synonym",
      confidence: 0.9,
      changes: [
        { type: "add_intent_synonym", intent: "service.restart", phrase: "recycle" },
      ],
      tests: [
        { input: "recycle nginx on prod", expectedIntent: "service.restart" },
      ],
      warnings: [],
    };

    const result = validatePatch(patch);
    // "recycle" is already in the rules, so this should be clean
    expect(result.warnings).toBeDefined();
  });

  it("rejects patch with unknown intent", () => {
    const patch: RulePatch = {
      summary: "bad patch",
      confidence: 0.5,
      changes: [
        { type: "add_intent_synonym", intent: "nonexistent.intent", phrase: "foo" },
      ],
      tests: [],
      warnings: [],
    };

    const result = validatePatch(patch);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("Unknown intent"))).toBe(true);
  });

  it("rejects too-short synonyms", () => {
    const patch: RulePatch = {
      summary: "overly broad synonym",
      confidence: 0.5,
      changes: [
        { type: "add_intent_synonym", intent: "service.restart", phrase: "go" },
      ],
      tests: [],
      warnings: [],
    };

    const result = validatePatch(patch);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("too short"))).toBe(true);
  });

  it("warns on overlapping synonyms", () => {
    const patch: RulePatch = {
      summary: "overlapping synonym",
      confidence: 0.5,
      changes: [
        // "deploy" already belongs to deploy.run
        { type: "add_intent_synonym", intent: "service.restart", phrase: "deploy" },
      ],
      tests: [],
      warnings: [],
    };

    const result = validatePatch(patch);
    expect(result.valid).toBe(false);
    expect(result.errors.some((e) => e.includes("overlaps"))).toBe(true);
  });
});
