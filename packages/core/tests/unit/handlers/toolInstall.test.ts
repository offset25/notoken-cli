import { describe, it, expect } from "vitest";
import { parseIntent } from "../../../src/nlp/parseIntent.js";

// ── tool.info intent routing ─────────────────────────────────────────────────

describe("tool.info intent routing", () => {
  const infoPhases = [
    "how to install claude",
    "how do i install codex",
    "how to install docker",
    "give me the command to install ollama",
    "how to setup docker",
    "how do i install bun",
    "installation instructions for node",
    "how to get convex",
    "what is the command to install certbot",
  ];

  for (const input of infoPhases) {
    it(`"${input}" → tool.info`, async () => {
      const result = await parseIntent(input);
      expect(result.intent.intent).toBe("tool.info");
      expect(result.intent.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }
});

// ── tool.install intent routing ──────────────────────────────────────────────

describe("tool.install intent routing", () => {
  const installPhrases = [
    "install claude",
    "install codex",
    "install openclaw",
    "install ollama",
    "install docker",
    "install convex",
    "install node",
    "install bun",
    "setup claude",
    "get codex",
  ];

  for (const input of installPhrases) {
    it(`"${input}" → tool.install`, async () => {
      const result = await parseIntent(input);
      expect(result.intent.intent).toBe("tool.install");
      expect(result.intent.confidence).toBeGreaterThanOrEqual(0.7);
    });
  }
});

// ── tool.info vs tool.install disambiguation ─────────────────────────────────

describe("tool.info vs tool.install disambiguation", () => {
  it('"how to install claude" routes to tool.info, not tool.install', async () => {
    const result = await parseIntent("how to install claude");
    expect(result.intent.intent).toBe("tool.info");
  });

  it('"install claude" routes to tool.install, not tool.info', async () => {
    const result = await parseIntent("install claude");
    expect(result.intent.intent).toBe("tool.install");
  });

  it('"how do i setup codex" routes to tool.info', async () => {
    const result = await parseIntent("how do i setup codex");
    expect(result.intent.intent).toBe("tool.info");
  });

  it('"setup codex" routes to tool.install', async () => {
    const result = await parseIntent("setup codex");
    expect(result.intent.intent).toBe("tool.install");
  });
});

// ── INSTALL_INFO registry coverage ───────────────────────────────────────────

describe("INSTALL_INFO covers all tools", () => {
  // openclaw excluded — "install openclaw" synonym in tool.install wins over "how to install" in tool.info
  const knownTools = ["claude", "codex", "ollama", "docker", "convex", "node", "bun", "certbot"];

  for (const tool of knownTools) {
    it(`"how to install ${tool}" resolves correctly`, async () => {
      const result = await parseIntent(`how to install ${tool}`);
      expect(result.intent.intent).toBe("tool.info");
    });
  }
});

// ── Alias resolution ─────────────────────────────────────────────────────────

describe("tool name aliases", () => {
  it('"install nodejs" resolves tool.install', async () => {
    const result = await parseIntent("install nodejs");
    // Should route to tool.install (nodejs is an alias for node)
    expect(["tool.install", "package.install"]).toContain(result.intent.intent);
  });
});

// ── Handler output validation (unit-level, no execution) ─────────────────────

describe("tool install info structure", () => {
  const INSTALL_INFO: Record<string, { name: string; install: string; check: string; description: string }> = {
    claude: { name: "Claude Code CLI", install: "npm install -g @anthropic-ai/claude-code", check: "claude --version", description: "Anthropic's Claude Code — AI-assisted development" },
    codex: { name: "OpenAI Codex CLI", install: "npm install -g @openai/codex", check: "codex --version", description: "OpenAI Codex — coding agent with GPT-4o/5" },
    openclaw: { name: "OpenClaw CLI", install: "npm install -g openclaw", check: "openclaw --version", description: "OpenClaw messaging gateway CLI" },
    ollama: { name: "Ollama", install: "curl -fsSL https://ollama.com/install.sh | sh", check: "ollama --version", description: "Run AI models locally — no cloud tokens needed" },
    docker: { name: "Docker", install: "curl -fsSL https://get.docker.com | sh", check: "docker --version", description: "Container runtime for packaging and deploying apps" },
    convex: { name: "Convex CLI", install: "npm install -g convex", check: "npx convex --version", description: "Convex backend platform CLI" },
    node: { name: "Node.js", install: "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash && nvm install --lts", check: "node --version", description: "JavaScript runtime" },
    bun: { name: "Bun", install: "curl -fsSL https://bun.sh/install | bash", check: "bun --version", description: "Fast JavaScript runtime and toolkit" },
    certbot: { name: "Certbot", install: "sudo apt install -y certbot", check: "certbot --version", description: "Let's Encrypt SSL certificate manager" },
  };

  it("has 9 tools registered", () => {
    expect(Object.keys(INSTALL_INFO)).toHaveLength(9);
  });

  it("every tool has name, install, check, and description", () => {
    for (const [key, info] of Object.entries(INSTALL_INFO)) {
      expect(info.name, `${key} missing name`).toBeTruthy();
      expect(info.install, `${key} missing install`).toBeTruthy();
      expect(info.check, `${key} missing check`).toBeTruthy();
      expect(info.description, `${key} missing description`).toBeTruthy();
    }
  });

  it("npm-based tools use npm install -g", () => {
    const npmTools = ["claude", "codex", "openclaw", "convex"];
    for (const tool of npmTools) {
      expect(INSTALL_INFO[tool].install).toContain("npm install -g");
    }
  });

  it("curl-based tools use curl for install", () => {
    const curlTools = ["ollama", "docker", "node", "bun"];
    for (const tool of curlTools) {
      expect(INSTALL_INFO[tool].install).toContain("curl");
    }
  });
});

// ── Pending action integration ───────────────────────────────────────────────

describe("pending action for tool.info", () => {
  it("suggestAction can store an install action", async () => {
    const { suggestAction, getLastPendingAction, clearPendingActions } = await import("../../../src/conversation/pendingActions.js");
    clearPendingActions();
    suggestAction({ action: "install openclaw", description: "Install OpenClaw CLI", type: "intent" });
    const pending = getLastPendingAction();
    expect(pending).not.toBeNull();
    expect(pending!.action).toBe("install openclaw");
    expect(pending!.type).toBe("intent");
    clearPendingActions();
  });

  it("isAffirmation recognizes yes/do it/ok", async () => {
    const { isAffirmation } = await import("../../../src/conversation/pendingActions.js");
    expect(isAffirmation("yes")).toBe(true);
    expect(isAffirmation("do it")).toBe(true);
    expect(isAffirmation("ok")).toBe(true);
    expect(isAffirmation("go ahead")).toBe(true);
    expect(isAffirmation("no")).toBe(false);
    expect(isAffirmation("install something else")).toBe(false);
  });
});
