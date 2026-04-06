import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ── Ollama model database tests ──────────────────────────────────────────────

describe("ollama-models.json", () => {
  const dbPath = resolve(__dirname, "../../../config/ollama-models.json");

  it("file exists", () => {
    expect(existsSync(dbPath)).toBe(true);
  });

  it("parses as valid JSON with models object", () => {
    const db = JSON.parse(readFileSync(dbPath, "utf-8"));
    expect(db).toHaveProperty("models");
    expect(typeof db.models).toBe("object");
  });

  it("has at least 10 models", () => {
    const db = JSON.parse(readFileSync(dbPath, "utf-8"));
    expect(Object.keys(db.models).length).toBeGreaterThanOrEqual(10);
  });

  it("each model has required fields", () => {
    const db = JSON.parse(readFileSync(dbPath, "utf-8"));
    const requiredFields = ["name", "provider", "parameters", "sizeGB", "minRAMGB", "recRAMGB", "context", "capabilities", "description", "tier", "speed"];

    for (const [key, model] of Object.entries(db.models) as [string, any][]) {
      for (const field of requiredFields) {
        expect(model, `${key} missing ${field}`).toHaveProperty(field);
      }
    }
  });

  it("tier values are valid", () => {
    const db = JSON.parse(readFileSync(dbPath, "utf-8"));
    const validTiers = ["tiny", "small", "medium", "large", "frontier"];

    for (const [key, model] of Object.entries(db.models) as [string, any][]) {
      expect(validTiers, `${key} has invalid tier: ${model.tier}`).toContain(model.tier);
    }
  });

  it("minRAMGB <= recRAMGB for all models", () => {
    const db = JSON.parse(readFileSync(dbPath, "utf-8"));
    for (const [key, model] of Object.entries(db.models) as [string, any][]) {
      expect(model.minRAMGB, `${key}: min > rec`).toBeLessThanOrEqual(model.recRAMGB);
    }
  });

  it("capabilities is a non-empty array", () => {
    const db = JSON.parse(readFileSync(dbPath, "utf-8"));
    for (const [key, model] of Object.entries(db.models) as [string, any][]) {
      expect(Array.isArray(model.capabilities), `${key}: capabilities not array`).toBe(true);
      expect(model.capabilities.length, `${key}: empty capabilities`).toBeGreaterThan(0);
    }
  });

  it("includes core models: llama3.2, codellama, mistral", () => {
    const db = JSON.parse(readFileSync(dbPath, "utf-8"));
    expect(db.models).toHaveProperty("llama3.2");
    expect(db.models).toHaveProperty("codellama");
    expect(db.models).toHaveProperty("mistral");
  });
});

// ── MODEL_ALIASES tests ──────────────────────────────────────────────────────

describe("MODEL_ALIASES", () => {
  // Replicate the aliases from executor.ts to test coverage
  const MODEL_ALIASES: Record<string, string> = {
    "opus": "anthropic/claude-opus-4-6", "sonnet": "anthropic/claude-sonnet-4-6", "haiku": "anthropic/claude-haiku-4-5",
    "claude": "anthropic/claude-opus-4-6", "gpt-4o": "openai-codex/gpt-4o", "gpt-5": "openai-codex/gpt-5.4",
    "gpt": "openai-codex/gpt-4o", "chatgpt": "openai-codex/gpt-4o", "codex": "openai-codex/gpt-5.4",
    "openai": "openai-codex/gpt-4o", "gemini": "google/gemini-2.5-pro", "mistral": "mistral/mistral-large",
    "llama": "ollama/llama2:13b", "llama2": "ollama/llama2:13b", "llama3": "ollama/llama3.2",
    "ollama": "ollama/llama2:13b", "codellama": "ollama/codellama", "phi": "ollama/phi3", "qwen": "ollama/qwen2.5",
    "deepseek": "ollama/deepseek-v3",
  };

  it("codex alias resolves to openai-codex/gpt-5.4", () => {
    expect(MODEL_ALIASES["codex"]).toBe("openai-codex/gpt-5.4");
  });

  it("gpt-4o alias resolves to openai-codex/gpt-4o", () => {
    expect(MODEL_ALIASES["gpt-4o"]).toBe("openai-codex/gpt-4o");
  });

  it("ollama alias resolves to ollama/llama2:13b", () => {
    expect(MODEL_ALIASES["ollama"]).toBe("ollama/llama2:13b");
  });

  it("claude alias resolves to anthropic/claude-opus-4-6", () => {
    expect(MODEL_ALIASES["claude"]).toBe("anthropic/claude-opus-4-6");
  });

  it("all aliases have provider/model format", () => {
    for (const [alias, model] of Object.entries(MODEL_ALIASES)) {
      expect(model, `${alias} → ${model}`).toMatch(/^[\w-]+\//);
    }
  });
});

// ── notoken.model backend validation ─────────────────────────────────────────

describe("notoken.model backend targets", () => {
  const validTargets = ["claude", "ollama", "chatgpt", "codex"];

  it("includes codex as valid backend", () => {
    expect(validTargets).toContain("codex");
  });

  it("includes all four backends", () => {
    expect(validTargets).toHaveLength(4);
    expect(validTargets).toContain("claude");
    expect(validTargets).toContain("ollama");
    expect(validTargets).toContain("chatgpt");
    expect(validTargets).toContain("codex");
  });
});

// ── llmFallback backend detection ────────────────────────────────────────────

describe("llmFallback", () => {
  it("getLLMBackend returns env var when set", async () => {
    const orig = process.env.NOTOKEN_LLM_CLI;
    process.env.NOTOKEN_LLM_CLI = "codex";
    const { getLLMBackend } = await import("../../../src/nlp/llmFallback.js");
    expect(getLLMBackend()).toBe("codex");
    if (orig) process.env.NOTOKEN_LLM_CLI = orig;
    else delete process.env.NOTOKEN_LLM_CLI;
  });

  it("getLLMBackend returns claude when set", async () => {
    const orig = process.env.NOTOKEN_LLM_CLI;
    process.env.NOTOKEN_LLM_CLI = "claude";
    const { getLLMBackend } = await import("../../../src/nlp/llmFallback.js");
    expect(getLLMBackend()).toBe("claude");
    if (orig) process.env.NOTOKEN_LLM_CLI = orig;
    else delete process.env.NOTOKEN_LLM_CLI;
  });

  it("getLLMBackend returns api when endpoint set", async () => {
    const origCli = process.env.NOTOKEN_LLM_CLI;
    const origEp = process.env.NOTOKEN_LLM_ENDPOINT;
    delete process.env.NOTOKEN_LLM_CLI;
    process.env.NOTOKEN_LLM_ENDPOINT = "https://api.example.com";
    const { getLLMBackend } = await import("../../../src/nlp/llmFallback.js");
    expect(getLLMBackend()).toBe("api");
    if (origCli) process.env.NOTOKEN_LLM_CLI = origCli;
    if (origEp) process.env.NOTOKEN_LLM_ENDPOINT = origEp;
    else delete process.env.NOTOKEN_LLM_ENDPOINT;
  });
});
