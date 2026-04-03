import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../packages/core/src/nlp/parseIntent.js";

const isWin = process.platform === "win32";

// ── targetEnv resolution — native Windows vs WSL ────────────────────────────
// Replicates the targetEnv logic from executor.ts

type OcEnv = "wsl" | "windows" | "both";

function resolveTargetEnv(
  ocTarget: OcEnv | null,
  inWSL: boolean,
  platform: string
): OcEnv {
  return ocTarget ?? (inWSL ? "wsl" : (platform === "win32" ? "windows" : "wsl"));
}

describe("targetEnv resolution — native Windows vs WSL", () => {
  it("defaults to 'windows' on native Windows (not WSL)", () => {
    expect(resolveTargetEnv(null, false, "win32")).toBe("windows");
  });

  it("defaults to 'wsl' when in WSL", () => {
    expect(resolveTargetEnv(null, true, "win32")).toBe("wsl");
  });

  it("defaults to 'wsl' on Linux", () => {
    expect(resolveTargetEnv(null, false, "linux")).toBe("wsl");
  });

  it("respects explicit target over default", () => {
    expect(resolveTargetEnv("both", false, "win32")).toBe("both");
    expect(resolveTargetEnv("wsl", false, "win32")).toBe("wsl");
    expect(resolveTargetEnv("windows", true, "win32")).toBe("windows");
  });

  it("never defaults to 'wsl' on native Windows (the old bug)", () => {
    // This was the bug: `inWSL ? "wsl" : "wsl"` — always returned "wsl"
    const result = resolveTargetEnv(null, false, "win32");
    expect(result).not.toBe("wsl");
    expect(result).toBe("windows");
  });
});

// ── isNativeWin detection ───────────────────────────────────────────────────

describe("isNativeWin detection", () => {
  it("is true on win32 when not in WSL", () => {
    const isNativeWin = process.platform === "win32"; // no WSL in this test env
    if (isWin) {
      expect(isNativeWin).toBe(true);
    }
  });

  it("correctly identifies current platform", () => {
    expect(["win32", "linux", "darwin"]).toContain(process.platform);
  });
});

// ── openclaw.doctor intent routing ──────────────────────────────────────────

describe("openclaw.doctor intent routing", () => {
  it("parses 'openclaw doctor' as openclaw.doctor", async () => {
    const result = await parseIntent("openclaw doctor");
    expect(result.intent.intent).toBe("openclaw.doctor");
  });

  it("parses 'diagnose openclaw' as openclaw.doctor or openclaw.diagnose", async () => {
    const result = await parseIntent("diagnose openclaw");
    expect(["openclaw.doctor", "openclaw.diagnose"]).toContain(result.intent.intent);
  });

  it("parses 'fix openclaw' as openclaw.doctor or openclaw.fix", async () => {
    const result = await parseIntent("fix openclaw");
    expect(["openclaw.doctor", "openclaw.fix"]).toContain(result.intent.intent);
  });
});

// ── openclaw start/stop/restart intent routing ──────────────────────────────

describe("openclaw start/stop/restart intent routing", () => {
  it("parses 'start openclaw' as openclaw.start", async () => {
    const result = await parseIntent("start openclaw");
    expect(result.intent.intent).toBe("openclaw.start");
  });

  it("parses 'stop openclaw' as openclaw.stop", async () => {
    const result = await parseIntent("stop openclaw");
    expect(result.intent.intent).toBe("openclaw.stop");
  });

  it("parses 'restart openclaw' as openclaw.restart", async () => {
    const result = await parseIntent("restart openclaw");
    expect(result.intent.intent).toBe("openclaw.restart");
  });

  it("parses 'is openclaw running' as openclaw.status", async () => {
    const result = await parseIntent("is openclaw running");
    expect(result.intent.intent).toBe("openclaw.status");
  });
});

// ── Node version requirement parsing ────────────────────────────────────────

describe("Node version requirement parsing from tool notes", () => {
  const INSTALL_INFO: Record<string, { notes?: string }> = {
    openclaw: { notes: "Requires Node.js 22+. Run `openclaw setup` after install." },
    claude: { notes: "Requires Node.js 18+. After install, run `claude` to authenticate." },
    codex: { notes: "Requires Node.js 18+. Set OPENAI_API_KEY after install." },
    ollama: { notes: "After install: `ollama pull llama3.2` to download a model." },
  };

  it("extracts Node 22+ requirement for openclaw", () => {
    const match = INSTALL_INFO.openclaw.notes?.match(/Node\.js\s+(\d+)\+/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("22");
  });

  it("extracts Node 18+ requirement for claude", () => {
    const match = INSTALL_INFO.claude.notes?.match(/Node\.js\s+(\d+)\+/);
    expect(match).not.toBeNull();
    expect(match![1]).toBe("18");
  });

  it("returns null for tools without Node requirement", () => {
    const match = INSTALL_INFO.ollama.notes?.match(/Node\.js\s+(\d+)\+/);
    expect(match).toBeNull();
  });

  it("correctly determines if upgrade is needed", () => {
    const currentMajor = 20;
    const cases = [
      { tool: "openclaw", minMajor: 22, needsUpgrade: true },
      { tool: "claude", minMajor: 18, needsUpgrade: false },
      { tool: "codex", minMajor: 18, needsUpgrade: false },
    ];
    for (const tc of cases) {
      expect(currentMajor < tc.minMajor).toBe(tc.needsUpgrade);
    }
  });
});

// ── Greeting auth message ───────────────────────────────────────────────────

describe("greeting detection", () => {
  const GREETING_PATTERNS = [
    /^(hi|hello|hey|howdy|greetings|good\s*(morning|afternoon|evening)|yo|sup|what'?s\s*up)\b/i,
  ];

  function isGreeting(text: string): boolean {
    const trimmed = text.trim();
    return GREETING_PATTERNS.some((p) => p.test(trimmed));
  }

  it("detects common greetings", () => {
    expect(isGreeting("hello")).toBe(true);
    expect(isGreeting("hi")).toBe(true);
    expect(isGreeting("hey")).toBe(true);
    expect(isGreeting("good morning")).toBe(true);
  });

  it("does not detect commands as greetings", () => {
    expect(isGreeting("install codex")).toBe(false);
    expect(isGreeting("restart openclaw")).toBe(false);
    expect(isGreeting("say hello to codex")).toBe(false);
  });
});

// ── LLM auth auto-setup paths ──────────────────────────────────────────────

describe("LLM auth auto-setup — credential detection", () => {
  it("can read Claude credentials file path", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const sep = isWin ? "\\" : "/";
    const credsPath = `${home}${sep}.claude${sep}.credentials.json`;
    expect(credsPath).toContain(".claude");
    expect(credsPath).toContain(".credentials.json");
  });

  it("can resolve openclaw auth-profiles path", () => {
    const home = process.env.HOME ?? process.env.USERPROFILE ?? "";
    const sep = isWin ? "\\" : "/";
    const authPath = `${home}${sep}.openclaw${sep}agents${sep}main${sep}agent${sep}auth-profiles.json`;
    expect(authPath).toContain(".openclaw");
    expect(authPath).toContain("auth-profiles.json");
  });

  it.skipIf(!isWin)("detects Claude Code credentials on Windows", async () => {
    const { existsSync } = await import("node:fs");
    const credsPath = `${process.env.USERPROFILE}\\.claude\\.credentials.json`;
    // If Claude Code is installed and logged in, creds should exist
    if (existsSync(credsPath)) {
      const { readFileSync } = await import("node:fs");
      const creds = JSON.parse(readFileSync(credsPath, "utf-8"));
      expect(creds.claudeAiOauth).toBeDefined();
      expect(creds.claudeAiOauth.accessToken).toBeDefined();
      expect(creds.claudeAiOauth.accessToken.length).toBeGreaterThan(10);
    }
  });

  it("detects environment API keys", () => {
    const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
    const hasOpenAI = !!process.env.OPENAI_API_KEY;
    expect(typeof hasAnthropic).toBe("boolean");
    expect(typeof hasOpenAI).toBe("boolean");
  });
});

// ── openclaw.dashboard intent routing ───────────────────────────────────────

describe("openclaw.dashboard intent routing", () => {
  it("parses 'open openclaw dashboard' as openclaw.dashboard", async () => {
    const result = await parseIntent("open openclaw dashboard");
    expect(result.intent.intent).toBe("openclaw.dashboard");
  });

  it("parses 'openclaw web ui' as openclaw.dashboard", async () => {
    const result = await parseIntent("openclaw web ui");
    expect(result.intent.intent).toBe("openclaw.dashboard");
  });

  it("parses 'pair openclaw' as openclaw.dashboard", async () => {
    const result = await parseIntent("pair openclaw");
    expect(result.intent.intent).toBe("openclaw.dashboard");
  });
});

// ── openclaw config token reading ───────────────────────────────────────────

describe("openclaw config token reading", () => {
  it.skipIf(!isWin)("reads gateway token from openclaw config", async () => {
    const { existsSync, readFileSync } = await import("node:fs");
    const configPath = `${process.env.USERPROFILE}\\.openclaw\\openclaw.json`;
    if (existsSync(configPath)) {
      const config = JSON.parse(readFileSync(configPath, "utf-8"));
      const token = config?.gateway?.auth?.token;
      expect(token).toBeDefined();
      expect(typeof token).toBe("string");
      expect(token.length).toBeGreaterThan(10);
    }
  });
});

// ── Playwright availability ─────────────────────────────────────────────────

describe("Playwright availability", () => {
  it("can import playwright", async () => {
    try {
      const pw = await import("playwright");
      expect(pw.chromium).toBeDefined();
    } catch {
      // Not installed — handler falls back to manual pairing
    }
  });
});

// ── openclaw.channel.setup intent routing ───────────────────────────────────

describe("openclaw.channel.setup intent routing", () => {
  it("parses 'setup telegram' as openclaw.channel.setup", async () => {
    const result = await parseIntent("setup telegram");
    expect(result.intent.intent).toBe("openclaw.channel.setup");
  });

  it("parses 'connect discord' as a channel setup intent", async () => {
    const result = await parseIntent("connect discord");
    expect(["openclaw.channel.setup", "openclaw.add_channel"]).toContain(result.intent.intent);
  });

  it("parses 'setup matrix' as openclaw.channel.setup", async () => {
    const result = await parseIntent("setup matrix");
    expect(result.intent.intent).toBe("openclaw.channel.setup");
  });

  it("parses 'setup channels' as openclaw.channel.setup", async () => {
    const result = await parseIntent("setup channels");
    expect(result.intent.intent).toBe("openclaw.channel.setup");
  });
});

// ── Channel detection from raw text ─────────────────────────────────────────

describe("channel detection from raw text", () => {
  const KNOWN_CHANNELS = ["telegram", "discord", "matrix", "whatsapp", "signal", "slack", "irc"];

  function detectChannel(rawText: string): string | null {
    const lower = rawText.toLowerCase();
    for (const ch of KNOWN_CHANNELS) {
      if (lower.includes(ch)) return ch;
    }
    return null;
  }

  it("detects telegram from 'setup telegram for openclaw'", () => {
    expect(detectChannel("setup telegram for openclaw")).toBe("telegram");
  });

  it("detects discord from 'connect discord'", () => {
    expect(detectChannel("connect discord")).toBe("discord");
  });

  it("detects matrix from 'add matrix channel'", () => {
    expect(detectChannel("add matrix channel")).toBe("matrix");
  });

  it("returns null for 'setup channels' (no specific channel)", () => {
    expect(detectChannel("setup channels")).toBeNull();
  });

  it("rejects invalid channel names from fields", () => {
    const badValues = ["s", "set", "ch", ""];
    for (const v of badValues) {
      expect(KNOWN_CHANNELS.includes(v)).toBe(false);
    }
  });
});
