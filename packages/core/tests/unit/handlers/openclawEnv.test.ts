import { describe, it, expect } from "vitest";

// ── parseOcTarget logic tests ────────────────────────────────────────────────
// Replicates the parseOcTarget function from executor.ts

type OcEnv = "wsl" | "windows" | "both";

let lastOcEnv: OcEnv | null = null;

function parseOcTarget(rawText: string): OcEnv | null {
  const t = rawText.toLowerCase();
  if (/\bboth\b/.test(t)) return "both";
  if (/\b(on\s+)?windows\b|\b(on\s+)?win\b|\bhost\b/.test(t)) return "windows";
  if (/\b(on\s+|in\s+)?wsl\b|\b(on\s+)?linux\b/.test(t)) return "wsl";
  if (/\bthe\s+other\s+(one|side|env|environment)\b|\bnot\s+this\s+one\b|\bthe\s+other\b/.test(t)) {
    if (lastOcEnv === "wsl") return "windows";
    if (lastOcEnv === "windows") return "wsl";
    return null;
  }
  return null;
}

describe("parseOcTarget — environment targeting", () => {
  it("returns null for plain openclaw commands", () => {
    expect(parseOcTarget("restart openclaw")).toBeNull();
    expect(parseOcTarget("check openclaw status")).toBeNull();
  });

  it("detects 'on windows'", () => {
    expect(parseOcTarget("restart openclaw on windows")).toBe("windows");
    expect(parseOcTarget("switch openclaw to sonnet on windows")).toBe("windows");
  });

  it("detects 'on wsl'", () => {
    expect(parseOcTarget("restart openclaw on wsl")).toBe("wsl");
    expect(parseOcTarget("check openclaw in wsl")).toBe("wsl");
  });

  it("detects 'on linux'", () => {
    expect(parseOcTarget("restart openclaw on linux")).toBe("wsl");
  });

  it("detects 'host'", () => {
    expect(parseOcTarget("restart openclaw on host")).toBe("windows");
  });

  it("detects 'both'", () => {
    expect(parseOcTarget("restart openclaw on both")).toBe("both");
    expect(parseOcTarget("switch both")).toBe("both");
    expect(parseOcTarget("modify both")).toBe("both");
  });

  it("detects 'the other one' — flips from wsl to windows", () => {
    lastOcEnv = "wsl";
    expect(parseOcTarget("modify the other one")).toBe("windows");
  });

  it("detects 'the other one' — flips from windows to wsl", () => {
    lastOcEnv = "windows";
    expect(parseOcTarget("modify the other one")).toBe("wsl");
  });

  it("detects 'the other side'", () => {
    lastOcEnv = "wsl";
    expect(parseOcTarget("do it on the other side")).toBe("windows");
  });

  it("detects 'not this one'", () => {
    lastOcEnv = "windows";
    expect(parseOcTarget("not this one")).toBe("wsl");
  });

  it("returns null for 'the other one' when no previous env", () => {
    lastOcEnv = null;
    expect(parseOcTarget("the other one")).toBeNull();
  });

  it("'on win' shorthand works", () => {
    expect(parseOcTarget("restart on win")).toBe("windows");
  });
});

// ── skipWords filtering for model extraction ─────────────────────────────────

describe("openclaw.model skip words filter", () => {
  const skipWords = new Set(["openclaw", "model", "llm", "to", "the", "set", "switch", "change", "use", "using", "which", "what", "is", "on", "windows", "wsl", "linux", "host", "both", "other", "one", "side"]);

  function extractModel(rawText: string): string | undefined {
    const words = rawText.toLowerCase().split(/\s+/).filter((w: string) => !skipWords.has(w) && w.length > 1);
    return words[words.length - 1];
  }

  it("extracts 'sonnet' from 'switch openclaw to sonnet on windows'", () => {
    expect(extractModel("switch openclaw to sonnet on windows")).toBe("sonnet");
  });

  it("extracts 'opus' from 'set openclaw model to opus on both'", () => {
    expect(extractModel("set openclaw model to opus on both")).toBe("opus");
  });

  it("extracts 'codex' from 'switch openclaw to codex on wsl'", () => {
    expect(extractModel("switch openclaw to codex on wsl")).toBe("codex");
  });

  it("doesn't extract 'windows' or 'wsl' as model name", () => {
    const result = extractModel("switch openclaw on windows");
    expect(result).not.toBe("windows");
  });

  it("doesn't extract 'both' as model name", () => {
    const result = extractModel("switch openclaw on both");
    expect(result).not.toBe("both");
  });
});

// ── Intent routing with environment qualifiers ──────────────────────────────

describe("openclaw intent routing with env qualifiers", () => {
  // These should still route to openclaw intents even with env qualifiers
  it("'switch openclaw to sonnet on windows' still parses as openclaw.model", async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("switch openclaw to sonnet on windows");
    expect(result.intent.intent).toBe("openclaw.model");
  });

  it("'check openclaw status on wsl' still parses as openclaw.status", async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("is openclaw running on wsl");
    expect(result.intent.intent).toBe("openclaw.status");
  });
});
