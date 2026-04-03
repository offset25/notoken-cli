import { describe, it, expect, beforeEach } from "vitest";
import type { Conversation } from "../../../packages/core/src/conversation/store.js";
import {
  setEntityFocus,
  getEntityFocus,
  getPreviousFocus,
  resolveFocusReference,
} from "../../../packages/core/src/conversation/store.js";

function makeConv(): Conversation {
  return {
    id: "test",
    folderPath: "/tmp/test",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [
      { id: 1, timestamp: new Date().toISOString(), role: "user", rawText: "check openclaw", entities: [] },
      { id: 2, timestamp: new Date().toISOString(), role: "user", rawText: "start the windows one", entities: [] },
      { id: 3, timestamp: new Date().toISOString(), role: "user", rawText: "restart it", entities: [] },
    ],
    knowledgeTree: [],
  };
}

describe("setEntityFocus", () => {
  it("sets focus on first call", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    expect(conv.focus).toBeDefined();
    expect(conv.focus!.entityId).toBe("openclaw-wsl");
    expect(conv.focus!.entityType).toBe("installation");
    expect(conv.focus!.focusedAtTurn).toBe(1);
  });

  it("pushes previous focus to history when switching", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    setEntityFocus(conv, "openclaw-windows", "installation", 2);
    expect(conv.focus!.entityId).toBe("openclaw-windows");
    expect(conv.focus!.history[0].entityId).toBe("openclaw-wsl");
  });

  it("doesn't duplicate history when setting same entity", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    setEntityFocus(conv, "openclaw-wsl", "installation", 2);
    expect(conv.focus!.history).toHaveLength(0);
  });

  it("keeps history limited to 10", () => {
    const conv = makeConv();
    for (let i = 0; i < 15; i++) {
      setEntityFocus(conv, `entity-${i}`, "installation", i);
    }
    expect(conv.focus!.history.length).toBeLessThanOrEqual(10);
  });
});

describe("getEntityFocus", () => {
  it("returns null when no focus set", () => {
    const conv = makeConv();
    expect(getEntityFocus(conv)).toBeNull();
  });

  it("returns focus when set", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    const focus = getEntityFocus(conv);
    expect(focus).not.toBeNull();
    expect(focus!.entityId).toBe("openclaw-wsl");
  });

  it("returns null when focus is stale (too many turns passed)", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    // Add 10 more turns without mentioning the entity
    for (let i = 0; i < 10; i++) {
      conv.turns.push({ id: conv.turns.length + 1, timestamp: new Date().toISOString(), role: "user", rawText: "unrelated stuff", entities: [] });
    }
    expect(getEntityFocus(conv)).toBeNull();
  });

  it("retains focus even after long idle time if few turns", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    // Backdate the focus 30 minutes — should still be valid (only 2 turns since)
    conv.focus!.focusedAt = new Date(Date.now() - 30 * 60 * 1000).toISOString();
    expect(getEntityFocus(conv)).not.toBeNull();
  });
});

describe("getPreviousFocus", () => {
  it("returns null when no history", () => {
    const conv = makeConv();
    expect(getPreviousFocus(conv)).toBeNull();
  });

  it("returns null when no focus set", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    // Only one entity focused, no history
    expect(getPreviousFocus(conv)).toBeNull();
  });

  it("returns previous entity after switch", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    setEntityFocus(conv, "openclaw-windows", "installation", 2);
    const prev = getPreviousFocus(conv);
    expect(prev).not.toBeNull();
    expect(prev!.entityId).toBe("openclaw-wsl");
  });
});

describe("resolveFocusReference", () => {
  it("resolves 'restart it' to current focus", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-windows", "installation", 1);
    const result = resolveFocusReference(conv, "restart it");
    expect(result).not.toBeNull();
    expect(result!.entityId).toBe("openclaw-windows");
  });

  it("resolves 'stop that' to current focus", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    const result = resolveFocusReference(conv, "stop that");
    expect(result).not.toBeNull();
    expect(result!.entityId).toBe("openclaw-wsl");
  });

  it("resolves 'check this one' to current focus", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    const result = resolveFocusReference(conv, "check this one");
    expect(result).not.toBeNull();
    expect(result!.entityId).toBe("openclaw-wsl");
  });

  it("resolves 'the other one' to previous focus", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    setEntityFocus(conv, "openclaw-windows", "installation", 2);
    const result = resolveFocusReference(conv, "restart the other one");
    expect(result).not.toBeNull();
    expect(result!.entityId).toBe("openclaw-wsl");
  });

  it("resolves 'the previous one' to previous focus", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    setEntityFocus(conv, "openclaw-windows", "installation", 2);
    const result = resolveFocusReference(conv, "check the previous one");
    expect(result).not.toBeNull();
    expect(result!.entityId).toBe("openclaw-wsl");
  });

  it("resolves 'not this one' to previous focus", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    setEntityFocus(conv, "openclaw-windows", "installation", 2);
    const result = resolveFocusReference(conv, "not this one");
    expect(result).not.toBeNull();
    expect(result!.entityId).toBe("openclaw-wsl");
  });

  it("returns null for unrelated text", () => {
    const conv = makeConv();
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    const result = resolveFocusReference(conv, "what time is it");
    expect(result).toBeNull();
  });

  it("returns null when no focus set", () => {
    const conv = makeConv();
    const result = resolveFocusReference(conv, "restart it");
    expect(result).toBeNull();
  });
});

describe("focus history tracking", () => {
  it("tracks full conversation flow", () => {
    const conv = makeConv();

    // User talks about WSL openclaw
    setEntityFocus(conv, "openclaw-wsl", "installation", 1);
    expect(getEntityFocus(conv)!.entityId).toBe("openclaw-wsl");

    // User switches to Windows openclaw
    setEntityFocus(conv, "openclaw-windows", "installation", 2);
    expect(getEntityFocus(conv)!.entityId).toBe("openclaw-windows");

    // "restart it" → Windows (current)
    expect(resolveFocusReference(conv, "restart it")!.entityId).toBe("openclaw-windows");

    // "the other one" → WSL (previous)
    expect(resolveFocusReference(conv, "the other one")!.entityId).toBe("openclaw-wsl");

    // User talks about ollama
    setEntityFocus(conv, "ollama-wsl", "installation", 3);
    expect(getEntityFocus(conv)!.entityId).toBe("ollama-wsl");

    // "the other one" now → Windows openclaw (previous was windows)
    expect(resolveFocusReference(conv, "the other one")!.entityId).toBe("openclaw-windows");
  });
});
