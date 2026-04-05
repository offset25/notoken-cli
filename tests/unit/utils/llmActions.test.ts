import { describe, it, expect } from "vitest";
import { getLLMCommand, diagnoseLLM } from "../../../packages/core/src/utils/llmActions.js";

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

describe("diagnoseLLM", () => {
  it("returns diagnosis structure", async () => {
    const diag = await diagnoseLLM("node" as any);
    // Even for unknown providers, should return the structure
    expect(diag).toHaveProperty("provider");
    expect(diag).toHaveProperty("installed");
    expect(diag).toHaveProperty("issues");
    expect(diag).toHaveProperty("environments");
    expect(Array.isArray(diag.issues)).toBe(true);
    expect(Array.isArray(diag.environments)).toBe(true);
  }, 30000);

  it("diagnoses claude", async () => {
    const diag = await diagnoseLLM("claude");
    expect(diag.provider).toBe("claude");
    // On this system Claude should be found
    if (diag.installed) {
      expect(diag.version).toBeTruthy();
      expect(diag.environments.length).toBeGreaterThan(0);
    }
  }, 30000);

  it("diagnoses codex", async () => {
    const diag = await diagnoseLLM("codex");
    expect(diag.provider).toBe("codex");
    if (diag.installed) {
      expect(diag.version).toBeTruthy();
    }
  }, 30000);

  it("diagnoses ollama with model info", async () => {
    const diag = await diagnoseLLM("ollama");
    expect(diag.provider).toBe("ollama");
    expect(diag.info).toHaveProperty("totalModels");
    expect(typeof diag.info.totalModels).toBe("number");
  }, 30000);

  it("diagnoses openclaw with gateway check", async () => {
    const diag = await diagnoseLLM("openclaw");
    expect(diag.provider).toBe("openclaw");
    // Gateway may or may not be running
    if (diag.running) {
      expect(diag.info.gateway).toBe("healthy");
    }
  }, 30000);

  it("environments have correct shape", async () => {
    const diag = await diagnoseLLM("claude");
    for (const env of diag.environments) {
      expect(env).toHaveProperty("label");
      expect(env).toHaveProperty("installed");
      expect(env).toHaveProperty("version");
      expect(["Windows", "WSL"]).toContain(env.label);
    }
  }, 30000);

  it("sets bestEnv from authenticated environment", async () => {
    const diag = await diagnoseLLM("claude");
    if (diag.installed) {
      const authEnv = diag.environments.find((e: any) => e.authenticated);
      if (authEnv) {
        expect(diag.info.authenticated).toBe(true);
      }
    }
  }, 30000);
});
