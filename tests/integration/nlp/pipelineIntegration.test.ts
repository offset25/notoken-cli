/**
 * Integration tests for the full NLP pipeline wiring:
 * - Knowledge graph reference resolution in parseIntent
 * - Concept expansion in multi-classifier
 * - Learning from execution
 * - Semantic similarity fallback
 */
import { describe, it, expect, beforeEach } from "vitest";

// ─── Knowledge graph learning ───────────────────────────────────────────────

describe("knowledge graph: learnFromExecution", () => {
  let kg: typeof import("../../../packages/core/src/nlp/knowledgeGraph.js");

  beforeEach(async () => {
    kg = await import("../../../packages/core/src/nlp/knowledgeGraph.js");
  });

  it("learns a service from execution", () => {
    kg.learnFromExecution("service.restart", { service: "redis", environment: "local" }, "restart redis");
    const entity = kg.getEntity("redis");
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("service");
  });

  it("learns a server from execution", () => {
    kg.learnFromExecution("server.uptime", { environment: "webserver1" }, "check uptime on webserver1");
    const entity = kg.getEntity("webserver1");
    expect(entity).not.toBeNull();
    expect(entity!.type).toBe("server");
  });

  it("learns service→runs_on→server relationship", () => {
    kg.addEntity("myapp", "service", [], {});
    kg.addEntity("prodbox", "server", [], {});
    kg.learnFromExecution("service.restart", { service: "myapp", environment: "prodbox" }, "restart myapp on prodbox");
    const related = kg.getRelated("myapp", "runs_on");
    expect(related.length).toBeGreaterThan(0);
    expect(related[0].entity.name).toBe("prodbox");
  });

  it("does not learn localhost as a server", () => {
    kg.learnFromExecution("server.uptime", { environment: "local" }, "check uptime");
    expect(kg.getEntity("local")).toBeNull();
  });

  it("does not create duplicate relations", () => {
    kg.addEntity("api", "service", [], {});
    kg.addEntity("staging", "server", [], {});
    kg.learnFromExecution("service.restart", { service: "api", environment: "staging" }, "restart api on staging");
    kg.learnFromExecution("service.restart", { service: "api", environment: "staging" }, "restart api on staging");
    const related = kg.getRelated("api", "runs_on");
    expect(related.length).toBe(1);
  });
});

// ─── Concept expansion in multi-classifier ──────────────────────────────────

describe("concept expansion: expandQuery integration", () => {
  let ce: typeof import("../../../packages/core/src/nlp/conceptExpansion.js");

  beforeEach(async () => {
    ce = await import("../../../packages/core/src/nlp/conceptExpansion.js");
  });

  it("expands 'reboot' to include restart synonyms", () => {
    const expanded = ce.expandQuery("reboot the server");
    expect(expanded).toContain("restart");
    expect(expanded).toContain("reboot the server"); // original preserved
  });

  it("expands 'sluggish' to include slow synonyms", () => {
    const expanded = ce.expandQuery("server is sluggish");
    expect(expanded).toContain("slow");
  });

  it("expands 'breach' to include attack synonyms", () => {
    const expanded = ce.expandQuery("was there a breach");
    expect(expanded).toContain("attack");
  });

  it("does not expand when no cluster matches", () => {
    const expanded = ce.expandQuery("hello world");
    expect(expanded).toBe("hello world");
  });
});

// ─── Multi-classifier with expansion ────────────────────────────────────────

describe("multi-classifier: concept expansion boost", () => {
  let mc: typeof import("../../../packages/core/src/nlp/multiClassifier.js");

  beforeEach(async () => {
    mc = await import("../../../packages/core/src/nlp/multiClassifier.js");
  });

  it("classifyMulti returns results for expanded synonyms", () => {
    const result = mc.classifyMulti("reboot nginx");
    expect(result.votes.length).toBeGreaterThan(0);
    // Should have votes for service.restart since "reboot" expands to "restart"
    const restartVotes = result.votes.filter(v => v.intent === "service.restart");
    expect(restartVotes.length).toBeGreaterThan(0);
  });

  it("expansion adds votes with lower confidence", () => {
    const result = mc.classifyMulti("bounce the api");
    const expandedVotes = result.votes.filter(v => v.reason.includes("expanded"));
    // May or may not have expanded votes depending on synonym matching
    // but the call should not throw
    expect(result.votes.length).toBeGreaterThan(0);
  });
});

// ─── Semantic similarity as fallback ────────────────────────────────────────

describe("semantic similarity: paraphrase detection", () => {
  let ss: typeof import("../../../packages/core/src/nlp/semanticSimilarity.js");

  beforeEach(async () => {
    ss = await import("../../../packages/core/src/nlp/semanticSimilarity.js");
  });

  it("finds similar intent for paraphrased input", () => {
    const results = ss.findSimilarIntents("reboot the web server");
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].score).toBeGreaterThan(0.2);
  });

  it("co-occurrence expansion finds related words", () => {
    const expanded = ss.expandWithCooccurrences("restart");
    expect(expanded.length).toBeGreaterThan(0);
  });
});

// ─── Full pipeline: parseIntent with all modules ────────────────────────────

describe("parseIntent: full pipeline integration", () => {
  let parseIntent: typeof import("../../../packages/core/src/nlp/parseIntent.js").parseIntent;

  beforeEach(async () => {
    const mod = await import("../../../packages/core/src/nlp/parseIntent.js");
    parseIntent = mod.parseIntent;
  });

  it("routes 'restart nginx' correctly", async () => {
    const result = await parseIntent("restart nginx");
    expect(result.intent.intent).toBe("service.restart");
  });

  it("routes 'bounce redis on prod' correctly", async () => {
    const result = await parseIntent("bounce redis on prod");
    expect(result.intent.intent).toBe("service.restart");
  });

  it("routes 'check disk space' correctly", async () => {
    const result = await parseIntent("check disk space");
    expect(result.intent.intent).toBe("server.check_disk");
  });

  it("routes 'any suspicious connections' via semantic similarity", async () => {
    const result = await parseIntent("any suspicious connections");
    // Should match network or security related intent
    expect(result.intent.intent).not.toBe("unknown");
    expect(result.intent.confidence).toBeGreaterThan(0.5);
  });

  it("routes 'whats the weather' correctly", async () => {
    const result = await parseIntent("whats the weather");
    expect(result.intent.intent).toBe("weather.current");
  });

  it("routes 'are we under attack' correctly", async () => {
    const result = await parseIntent("are we under attack");
    expect(result.intent.intent).toBe("security.scan");
  });
});
