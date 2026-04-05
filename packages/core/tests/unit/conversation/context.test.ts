import { describe, it, expect } from "vitest";
import { resolveCoreferences } from "../../../src/conversation/coreference.js";
import {
  createConversation, addUserTurn, getLastEntity, getRecentEntities,
  type Conversation,
} from "../../../src/conversation/store.js";

// Build a mock conversation with history
function buildConversation(): Conversation {
  const conv: Conversation = {
    id: "test-conv",
    folderPath: "/tmp/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [],
    knowledgeTree: [],
  };
  // Simulate: user said "restart nginx on prod"
  addUserTurn(conv, "restart nginx on prod", "service.restart", 0.9, {
    service: "nginx",
    environment: "prod",
  }, [
    { text: "nginx", type: "service" },
    { text: "prod", type: "environment" },
  ]);
  return conv;
}

describe("coreference resolution", () => {
  it("'do it again' resolves to last command", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("do it again", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent).toBeDefined();
    expect(result.resolvedIntent!.intent).toBe("service.restart");
  });

  it("'try again' resolves to last command", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("try again", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent!.intent).toBe("service.restart");
  });

  it("'try it again' resolves to last command", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("try it again", conv);
    expect(result.isReference).toBe(true);
  });

  it("'retry' resolves to last command", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("retry", conv);
    expect(result.isReference).toBe(true);
  });

  it("'try it now' resolves to last command", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("try it now", conv);
    expect(result.isReference).toBe(true);
  });

  it("'one more time' resolves to last command", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("one more time", conv);
    expect(result.isReference).toBe(true);
  });

  it("'same but on staging' overrides environment", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("same but on staging", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent!.fields.environment).toBe("staging");
    expect(result.resolvedIntent!.fields.service).toBe("nginx");
  });

  it("'restart it' resolves 'it' to last service", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("restart it", conv);
    expect(result.resolvedText).toContain("nginx");
  });

  it("'that service' resolves to last service", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("check that service", conv);
    expect(result.resolvedText).toContain("nginx");
  });

  it("new command is not a reference", () => {
    const conv = buildConversation();
    const result = resolveCoreferences("check disk space", conv);
    expect(result.isReference).toBe(false);
  });
});

describe("'the other' coreference — alternate entity", () => {
  function buildMultiEntityConv(): Conversation {
    const conv: Conversation = {
      id: "test-multi",
      folderPath: "/tmp/test",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      turns: [],
      knowledgeTree: [],
    };
    // Turn 1: check disk on prod
    addUserTurn(conv, "check disk on prod", "server.check_disk", 0.9, {
      environment: "prod",
    }, [
      { text: "prod", type: "environment" },
    ]);
    // Turn 2: restart nginx on staging
    addUserTurn(conv, "restart nginx on staging", "service.restart", 0.9, {
      service: "nginx",
      environment: "staging",
    }, [
      { text: "nginx", type: "service" },
      { text: "staging", type: "environment" },
    ]);
    return conv;
  }

  it("'the other thing' resolves to second-to-last command", () => {
    const conv = buildMultiEntityConv();
    const result = resolveCoreferences("try the other thing", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent!.intent).toBe("server.check_disk");
  });

  it("'the other one' resolves to second-to-last command", () => {
    const conv = buildMultiEntityConv();
    const result = resolveCoreferences("do the other one", conv);
    expect(result.isReference).toBe(true);
    expect(result.resolvedIntent!.intent).toBe("server.check_disk");
  });

  it("'check the other one' resolves to second-most-recent entity", () => {
    const conv = buildMultiEntityConv();
    // Knowledge tree sorted by recency: nginx(2), staging(2), prod(1)
    // "the other" with offset 1 picks the second entity overall
    const result = resolveCoreferences("check the other one", conv);
    expect(result.resolutions.length).toBeGreaterThan(0);
    // Should resolve to something other than the most recent (nginx)
    expect(result.resolvedText).not.toContain("the other");
  });

  it("'not that one' refers to alternate entity", () => {
    const conv = buildMultiEntityConv();
    const result = resolveCoreferences("restart not that one", conv);
    expect(result.resolutions.length).toBeGreaterThan(0);
  });

  it("'no not this one the other one' resolves to alternate", () => {
    const conv = buildMultiEntityConv();
    const result = resolveCoreferences("no not this one the other one", conv);
    expect(result.resolutions.length).toBeGreaterThan(0);
    expect(result.resolvedText).not.toContain("not this one");
  });

  it("'not this one' resolves to alternate entity", () => {
    const conv = buildMultiEntityConv();
    const result = resolveCoreferences("restart not this one", conv);
    expect(result.resolutions.length).toBeGreaterThan(0);
  });
});

describe("knowledge tree", () => {
  it("tracks entities from turns", () => {
    const conv = buildConversation();
    const entities = getRecentEntities(conv, 10);
    expect(entities.length).toBeGreaterThan(0);
    expect(entities.some(e => e.entity === "nginx")).toBe(true);
    expect(entities.some(e => e.entity === "prod")).toBe(true);
  });

  it("getLastEntity returns most recent service", () => {
    const conv = buildConversation();
    const last = getLastEntity(conv, "service");
    expect(last).toBeDefined();
    expect(last!.entity).toBe("nginx");
  });

  it("getLastEntity returns most recent environment", () => {
    const conv = buildConversation();
    const last = getLastEntity(conv, "environment");
    expect(last).toBeDefined();
    expect(last!.entity).toBe("prod");
  });

  it("tracks entity frequency", () => {
    const conv = buildConversation();
    // Add another turn mentioning nginx
    addUserTurn(conv, "stop nginx on prod", "systemd.stop", 0.9, {
      service: "nginx",
      environment: "prod",
    }, [
      { text: "nginx", type: "service" },
      { text: "prod", type: "environment" },
    ]);
    const nginx = conv.knowledgeTree.find(n => n.entity === "nginx");
    expect(nginx!.frequency).toBe(2);
  });

  it("tracks co-occurrences", () => {
    const conv = buildConversation();
    const nginx = conv.knowledgeTree.find(n => n.entity === "nginx");
    expect(nginx!.coOccurrences).toContain("prod");
  });
});
