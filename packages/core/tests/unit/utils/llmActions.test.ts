import { describe, it, expect } from "vitest";
import { getLLMCommand, diagnoseLLM } from "../../../src/utils/llmActions.js";

describe("getLLMCommand", () => {
  it("returns auth command for Claude on Windows", () => {
    const cmd = getLLMCommand("auth", "claude", "Windows");
    expect(cmd).toContain("claude");
    expect(cmd).toContain("login");
  });

  it("returns auth command for Claude on WSL", () => {
    const cmd = getLLMCommand("auth", "claude", "WSL");
    expect(cmd).toContain("claude");
    expect(cmd).toContain("login");
    expect(cmd).toContain("wsl");
  });

  it("returns auth command for Codex on Windows", () => {
    const cmd = getLLMCommand("auth", "codex", "Windows");
    expect(cmd).toContain("codex");
    expect(cmd).toContain("login");
  });

  it("returns install command for Claude on Windows", () => {
    const cmd = getLLMCommand("install", "claude", "Windows");
    expect(cmd).toContain("npm install");
    expect(cmd).toContain("claude");
  });

  it("returns install command for Ollama on WSL", () => {
    const cmd = getLLMCommand("install", "ollama", "WSL");
    expect(cmd).toContain("ollama");
  });

  it("returns install command for OpenClaw", () => {
    const cmd = getLLMCommand("install", "openclaw", "Windows");
    expect(cmd).toContain("openclaw");
  });

  it("returns null for unknown action/provider", () => {
    const cmd = getLLMCommand("unknown" as any, "unknown", "Windows");
    expect(cmd).toBeNull();
  });
});

// diagnoseLLM spawns many wsl child processes — run sequentially with delays
// to avoid WSL stack overflow (0xc00000fd crash)
describe("diagnoseLLM", () => {
  it("returns diagnosis structure for unknown provider", async () => {
    const diag = await diagnoseLLM("nonexistent_xyz" as any);
    expect(diag).toHaveProperty("provider");
    expect(diag).toHaveProperty("installed");
    expect(diag).toHaveProperty("issues");
    expect(diag).toHaveProperty("environments");
    expect(Array.isArray(diag.issues)).toBe(true);
    expect(Array.isArray(diag.environments)).toBe(true);
    expect(diag.installed).toBe(false);
  }, 30000);

  // Only test ONE real provider to avoid WSL process storm
  it("diagnoses claude (single provider test)", async () => {
    const diag = await diagnoseLLM("claude");
    expect(diag.provider).toBe("claude");
    if (diag.installed) {
      expect(diag.version).toBeTruthy();
      expect(diag.environments.length).toBeGreaterThan(0);
      for (const env of diag.environments) {
        expect(env).toHaveProperty("label");
        expect(env).toHaveProperty("installed");
        expect(["Windows", "WSL"]).toContain(env.label);
      }
    }
    // Check bestEnv logic
    if (diag.installed) {
      const authEnv = diag.environments.find((e: any) => e.authenticated);
      if (authEnv) {
        expect(diag.info.authenticated).toBe(true);
      }
    }
  }, 30000);
});
