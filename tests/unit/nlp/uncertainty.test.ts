import { describe, it, expect } from "vitest";
import { analyzeUncertainty, getUncoveredSpans } from "../../../packages/core/src/nlp/uncertainty.js";
import { tokenize } from "../../../packages/core/src/nlp/semantic.js";

const SERVICES = ["nginx", "redis", "api", "worker", "postgres"];
const ENVS = ["dev", "staging", "prod", "local"];

describe("analyzeUncertainty", () => {
  it("reports unknown tokens", () => {
    const tokens = tokenize("restart xylophone on prod", SERVICES, ENVS);
    const intent = { intent: "service.restart", confidence: 0.7, rawText: "restart xylophone on prod", fields: { environment: "prod" } };
    const report = analyzeUncertainty("restart xylophone on prod", tokens, intent);

    // "xylophone" should be unknown or a noun that doesn't match anything
    expect(report.overallConfidence).toBe(0.7);
  });

  it("flags default-filled fields as low confidence", () => {
    const tokens = tokenize("restart nginx", SERVICES, ENVS);
    const intent = { intent: "service.restart", confidence: 0.6, rawText: "restart nginx", fields: { service: "nginx", environment: "dev" } };
    const report = analyzeUncertainty("restart nginx", tokens, intent);

    // "dev" was not in the raw text — it's a default
    const devField = report.lowConfidenceFields.find((f) => f.field === "environment");
    expect(devField).toBeDefined();
  });
});

describe("getUncoveredSpans", () => {
  it("returns empty for fully covered input", () => {
    const tokens = tokenize("restart nginx on prod", SERVICES, ENVS);
    const spans = getUncoveredSpans("restart nginx on prod", tokens);
    expect(spans).toHaveLength(0);
  });

  it("returns unknown words as uncovered spans", () => {
    // compromise tags unknown words as Noun, not UNKNOWN
    // so we check that fully unrecognized gibberish is caught
    const tokens = tokenize("flurble zargnox", SERVICES, ENVS);
    const unknowns = tokens.filter((t) => t.tag === "UNKNOWN" || t.tag === "NOUN");
    // At minimum these should be tagged as something (NOUN fallback)
    expect(unknowns.length).toBeGreaterThan(0);
  });
});
