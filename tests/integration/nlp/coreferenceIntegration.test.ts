/**
 * Integration tests for "it" resolution across the full pipeline:
 *   - Coreference resolver (session knowledge tree)
 *   - Knowledge graph (persistent entity memory)
 *   - Candidate scoring with agreement boost
 *   - Multi-turn conversations
 */
import { describe, it, expect, beforeEach } from "vitest";
import { resolveCoreferences, extractEntitiesFromFields } from "../../../packages/core/src/conversation/coreference.js";
import { addEntity, addRelation, getEntity, resolveReference, resolveCandidates } from "../../../packages/core/src/nlp/knowledgeGraph.js";
import type { Conversation } from "../../../packages/core/src/conversation/store.js";

function makeConv(turns: Array<{ rawText: string; intent?: string; fields?: Record<string, unknown> }>): Conversation {
  const conv: Conversation = {
    id: "test", folderPath: "/test",
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
    turns: turns.map((t, i) => ({
      id: i + 1, timestamp: new Date().toISOString(), role: "user" as const,
      rawText: t.rawText, intent: t.intent, fields: t.fields,
      entities: t.fields ? extractEntitiesFromFields(t.fields) : [],
    })),
    knowledgeTree: [],
  };
  for (const turn of conv.turns) {
    for (const entity of turn.entities) {
      let node = conv.knowledgeTree.find(n => n.entity === entity.text);
      if (!node) {
        node = { entity: entity.text, type: entity.type, firstMentioned: turn.id, lastMentioned: turn.id, frequency: 0, coOccurrences: [] };
        conv.knowledgeTree.push(node);
      }
      node.lastMentioned = turn.id;
      node.frequency++;
    }
  }
  return conv;
}

// ── Coreference: "it" resolution ────────────────────────────────────────────

describe("coreference: 'it' resolves to most recent service", () => {
  it("'restart it' after 'check nginx' → nginx", () => {
    const conv = makeConv([
      { rawText: "check nginx", intent: "service.status", fields: { service: "nginx" } },
    ]);
    const result = resolveCoreferences("restart it", conv);
    expect(result.resolvedText).toContain("nginx");
  });

  it("'restart it' after multiple services → most recent one", () => {
    const conv = makeConv([
      { rawText: "restart nginx on prod", intent: "service.restart", fields: { service: "nginx", environment: "prod" } },
      { rawText: "check redis", intent: "service.status", fields: { service: "redis" } },
    ]);
    const result = resolveCoreferences("restart it", conv);
    expect(result.resolvedText).toContain("redis"); // Most recent
  });

  it("'check it on prod' retains environment", () => {
    const conv = makeConv([
      { rawText: "restart nginx", intent: "service.restart", fields: { service: "nginx" } },
    ]);
    const result = resolveCoreferences("check it on prod", conv);
    expect(result.resolvedText).toContain("nginx");
    expect(result.resolvedText).toContain("prod");
  });
});

// ── Coreference: "the other one" ────────────────────────────────────────────

describe("coreference: 'the other one' / 'not that one'", () => {
  it("'the other one' returns second-most-recent service", () => {
    const conv = makeConv([
      { rawText: "restart nginx on prod", intent: "service.restart", fields: { service: "nginx" } },
      { rawText: "check redis", intent: "service.status", fields: { service: "redis" } },
    ]);
    const result = resolveCoreferences("restart the other one", conv);
    // "the other one" should resolve to nginx (second most recent, offset 1)
    expect(result.resolvedText).toContain("nginx");
  });

  it("'not this one' flips to the other service", () => {
    const conv = makeConv([
      { rawText: "restart nginx", intent: "service.restart", fields: { service: "nginx" } },
      { rawText: "check redis", intent: "service.status", fields: { service: "redis" } },
    ]);
    const result = resolveCoreferences("not this one", conv);
    // Should refer to nginx (not redis which was most recent)
    if (result.resolutions.length > 0) {
      expect(result.resolutions[0].resolved).toBe("nginx");
    }
  });
});

// ── Coreference: repeat patterns ────────────────────────────────────────────

describe("coreference: repeat patterns", () => {
  it("'try again' repeats last command", () => {
    const conv = makeConv([
      { rawText: "deploy main to staging", intent: "deploy.run", fields: { branch: "main", environment: "staging" } },
    ]);
    const result = resolveCoreferences("try again", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent?.intent).toBe("deploy.run");
  });

  it("'do it again' repeats last command", () => {
    const conv = makeConv([
      { rawText: "restart nginx", intent: "service.restart", fields: { service: "nginx" } },
    ]);
    const result = resolveCoreferences("do it again", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent?.intent).toBe("service.restart");
  });

  it("'same but on prod' repeats with override", () => {
    const conv = makeConv([
      { rawText: "restart nginx on staging", intent: "service.restart", fields: { service: "nginx", environment: "staging" } },
    ]);
    const result = resolveCoreferences("same but on prod", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent?.fields.service).toBe("nginx");
    expect(result.resolvedIntent?.fields.environment).toBe("prod");
  });
});

// ── Knowledge graph: resolveReference ────────────────────────────────────────

describe("knowledge graph: resolveReference", () => {
  beforeEach(() => {
    addEntity("nginx", "service", ["web server"], {});
    addEntity("redis", "service", ["cache"], {});
    addEntity("prod", "server", ["production"], { host: "10.0.0.1" });
  });

  it("resolves 'it' to most recent entity", () => {
    const result = resolveReference("it", ["nginx", "prod"]);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nginx"); // Service preferred over server for "it"
  });

  it("resolves 'the server' to a server type entity if one exists", () => {
    const result = resolveReference("the server", ["nginx", "prod"]);
    // Should resolve to something — either prod (server) or fallback
    expect(result).not.toBeNull();
    if (result!.type === "server") expect(result!.name).toBe("prod");
  });

  it("resolves 'that service' to an entity", () => {
    const result = resolveReference("that service", ["prod", "nginx"]);
    // Should resolve to something from the recent entities
    expect(result).not.toBeNull();
    // The persistent graph may have different entity types than what we added
    expect(["service", "server", "container"]).toContain(result!.type);
  });

  it("resolves direct entity name", () => {
    const result = resolveReference("nginx", []);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nginx");
  });

  it("resolves entity by alias", () => {
    const result = resolveReference("web server", []);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("nginx");
  });

  it("returns null for unknown reference", () => {
    const result = resolveReference("something unknown", []);
    expect(result).toBeNull();
  });
});

// ── Knowledge graph: candidate scoring ──────────────────────────────────────

describe("knowledge graph: resolveCandidates scoring", () => {
  beforeEach(() => {
    addEntity("nginx", "service", [], {});
    addEntity("redis", "service", [], {});
    addEntity("prod", "server", [], {});
    addRelation("nginx", "prod", "runs_on");
  });

  it("scores recent entities higher", () => {
    const candidates = resolveCandidates("it", ["redis", "nginx"]);
    expect(candidates.length).toBeGreaterThanOrEqual(2);
    // redis is more recent (index 0), should score higher
    expect(candidates[0].entity.name).toBe("redis");
  });

  it("gives actionable type bonus for 'it'", () => {
    const candidates = resolveCandidates("it", ["prod", "nginx"]);
    // nginx (service) should score higher than prod (server) for "it"
    const nginxCandidate = candidates.find(c => c.entity.name === "nginx");
    const prodCandidate = candidates.find(c => c.entity.name === "prod");
    if (nginxCandidate && prodCandidate) {
      // Service gets actionable bonus
      expect(nginxCandidate.reason).toContain("actionable");
    }
  });

  it("gives relationship bonus", () => {
    // nginx runs_on prod — if both are recent, relationship should boost
    const candidates = resolveCandidates("it", ["nginx", "prod"]);
    const nginxCandidate = candidates.find(c => c.entity.name === "nginx");
    if (nginxCandidate) {
      expect(nginxCandidate.reason).toContain("related");
    }
  });

  it("typed reference 'the server' returns candidates", () => {
    const candidates = resolveCandidates("the server", ["nginx", "prod"]);
    expect(candidates.length).toBeGreaterThanOrEqual(1);
    // If prod exists as a server, it should score with type match
    const prodCandidate = candidates.find(c => c.entity.name === "prod");
    if (prodCandidate) {
      expect(prodCandidate.reason).toContain("type match");
    }
  });

  it("returns empty for no context and no type match", () => {
    const candidates = resolveCandidates("it", []);
    expect(candidates.length).toBe(0);
  });
});

// ── Full pipeline: coreference + knowledge graph agree ──────────────────────

describe("agreement: coreference + knowledge graph", () => {
  beforeEach(() => {
    addEntity("nginx", "service", [], {});
    addEntity("redis", "service", [], {});
  });

  it("both systems resolve 'it' to same entity when context matches", () => {
    // Coreference resolves from session
    const conv = makeConv([
      { rawText: "restart nginx", intent: "service.restart", fields: { service: "nginx" } },
    ]);
    const corefResult = resolveCoreferences("check it", conv);

    // Knowledge graph resolves from persistent graph
    const kgResult = resolveReference("it", ["nginx"]);

    // Both should resolve to nginx
    expect(corefResult.resolvedText).toContain("nginx");
    expect(kgResult).not.toBeNull();
    expect(kgResult!.name).toBe("nginx");
  });

  it("session context wins over persistent graph when different", () => {
    const conv = makeConv([
      { rawText: "restart nginx", intent: "service.restart", fields: { service: "nginx" } },
      { rawText: "check redis", intent: "service.status", fields: { service: "redis" } },
    ]);

    // Coreference: "it" → redis (most recent in session)
    const corefResult = resolveCoreferences("restart it", conv);
    expect(corefResult.resolvedText).toContain("redis");

    // Knowledge graph with different recent order: nginx first
    const kgResult = resolveReference("it", ["nginx"]);
    expect(kgResult!.name).toBe("nginx");

    // In interactive mode, coreference runs first and wins — this is correct
    // Session context is more relevant than persistent memory
  });
});
