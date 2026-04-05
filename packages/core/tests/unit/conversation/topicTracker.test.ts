import { describe, it, expect } from "vitest";
import { getCurrentTopic, suggestFollowups, getTopicDefault } from "../../../src/conversation/topicTracker.js";
import type { Conversation, ConversationTurn } from "../../../src/conversation/store.js";

function makeTurn(intent: string): ConversationTurn {
  return {
    id: Math.random(),
    timestamp: new Date().toISOString(),
    role: "user",
    rawText: intent,
    intent,
  };
}

function makeConversation(turns: ConversationTurn[]): Conversation {
  return {
    id: "test",
    folderPath: "/tmp",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns,
    knowledgeTree: [],
  };
}

describe("topicTracker — getCurrentTopic", () => {
  it("returns null for empty conversation", () => {
    const conv = makeConversation([]);
    const ctx = getCurrentTopic(conv);
    expect(ctx.topic).toBeNull();
    expect(ctx.confidence).toBe(0);
  });

  it("detects docker topic from docker.* intents", () => {
    const conv = makeConversation([
      makeTurn("docker.list"),
      makeTurn("docker.restart"),
    ]);
    const ctx = getCurrentTopic(conv);
    expect(ctx.topic).toBe("docker");
    expect(ctx.confidence).toBeGreaterThan(0);
  });

  it("returns higher confidence for consecutive same-topic turns", () => {
    const single = makeConversation([makeTurn("docker.list")]);
    const multi = makeConversation([
      makeTurn("docker.list"),
      makeTurn("docker.restart"),
      makeTurn("docker.logs"),
    ]);
    const c1 = getCurrentTopic(single);
    const c2 = getCurrentTopic(multi);
    expect(c2.confidence).toBeGreaterThanOrEqual(c1.confidence);
    expect(c2.depth).toBeGreaterThanOrEqual(c1.depth);
  });
});

describe("topicTracker — suggestFollowups", () => {
  it("returns suggestions for service.restart", () => {
    const suggestions = suggestFollowups("service.restart");
    expect(suggestions.length).toBeGreaterThan(0);
  });

  it("returns empty for unknown intent", () => {
    const suggestions = suggestFollowups("totally.unknown.intent");
    expect(suggestions).toEqual([]);
  });
});

describe("topicTracker — getTopicDefault", () => {
  it('returns docker.restart for "restart" during docker topic', () => {
    const topic = { topic: "docker", depth: 3, confidence: 0.8, recentTopics: [{ topic: "docker", count: 3 }] };
    const result = getTopicDefault("restart", topic);
    expect(result).toBe("docker.restart");
  });

  it("returns null when confidence is low", () => {
    const topic = { topic: "docker", depth: 1, confidence: 0.2, recentTopics: [{ topic: "docker", count: 1 }] };
    const result = getTopicDefault("restart", topic);
    expect(result).toBeNull();
  });
});
