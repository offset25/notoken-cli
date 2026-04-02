import { describe, it, expect } from "vitest";
import { resolveCoreferences, extractEntitiesFromFields } from "../../../src/conversation/coreference.js";
import type { Conversation } from "../../../src/conversation/store.js";

function makeConv(turns: Array<{ rawText: string; intent?: string; fields?: Record<string, unknown> }>): Conversation {
  const conv: Conversation = {
    id: "test",
    folderPath: "/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: turns.map((t, i) => ({
      id: i + 1,
      timestamp: new Date().toISOString(),
      role: "user" as const,
      rawText: t.rawText,
      intent: t.intent,
      fields: t.fields,
      entities: t.fields ? extractEntitiesFromFields(t.fields) : [],
    })),
    knowledgeTree: [],
  };

  // Build knowledge tree from turns
  for (const turn of conv.turns) {
    for (const entity of turn.entities) {
      const key = entity.text;
      let node = conv.knowledgeTree.find((n) => n.entity === key);
      if (!node) {
        node = { entity: key, type: entity.type, firstMentioned: turn.id, lastMentioned: turn.id, frequency: 0, coOccurrences: [] };
        conv.knowledgeTree.push(node);
      }
      node.lastMentioned = turn.id;
      node.frequency++;
    }
  }

  return conv;
}

describe("resolveCoreferences", () => {
  it("resolves 'do it again' to repeat last command", () => {
    const conv = makeConv([
      { rawText: "restart nginx on prod", intent: "service.restart", fields: { service: "nginx", environment: "prod" } },
    ]);

    const result = resolveCoreferences("do it again", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent).toBeDefined();
    expect(result.resolvedIntent!.intent).toBe("service.restart");
    expect(result.resolvedIntent!.fields.service).toBe("nginx");
  });

  it("resolves 'same but on staging' to last command with env override", () => {
    const conv = makeConv([
      { rawText: "restart nginx on prod", intent: "service.restart", fields: { service: "nginx", environment: "prod" } },
    ]);

    const result = resolveCoreferences("same but on staging", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent!.fields.environment).toBe("staging");
    expect(result.resolvedIntent!.fields.service).toBe("nginx");
  });

  it("resolves 'it' to most recent service", () => {
    const conv = makeConv([
      { rawText: "restart nginx on prod", intent: "service.restart", fields: { service: "nginx", environment: "prod" } },
    ]);

    const result = resolveCoreferences("restart it on staging", conv);
    expect(result.resolvedText).toContain("nginx");
  });

  it("returns original text when no references found", () => {
    const conv = makeConv([]);
    const result = resolveCoreferences("restart nginx on prod", conv);
    expect(result.isReference).toBe(false);
    expect(result.resolvedText).toBe("restart nginx on prod");
  });
});

describe("extractEntitiesFromFields", () => {
  it("extracts service and environment entities", () => {
    const entities = extractEntitiesFromFields({ service: "nginx", environment: "prod" });
    expect(entities).toContainEqual({ text: "nginx", type: "service" });
    expect(entities).toContainEqual({ text: "prod", type: "environment" });
  });

  it("extracts path entities", () => {
    const entities = extractEntitiesFromFields({ source: "/etc/nginx.conf", destination: "/root" });
    expect(entities).toContainEqual({ text: "/etc/nginx.conf", type: "path" });
    expect(entities).toContainEqual({ text: "/root", type: "path" });
  });
});
