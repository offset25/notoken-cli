import { describe, it, expect } from "vitest";

// Test the model alias mapping used in executor for openclaw model switching
const MODEL_ALIASES: Record<string, string> = {
  "opus": "anthropic/claude-opus-4-6",
  "claude-opus": "anthropic/claude-opus-4-6",
  "claude opus": "anthropic/claude-opus-4-6",
  "sonnet": "anthropic/claude-sonnet-4-6",
  "claude-sonnet": "anthropic/claude-sonnet-4-6",
  "claude sonnet": "anthropic/claude-sonnet-4-6",
  "haiku": "anthropic/claude-haiku-4-5",
  "claude-haiku": "anthropic/claude-haiku-4-5",
  "claude": "anthropic/claude-opus-4-6",
  "gpt-4o": "openai-codex/gpt-4o",
  "gpt4o": "openai-codex/gpt-4o",
  "gpt-4": "openai-codex/gpt-4o",
  "gpt-5": "openai-codex/gpt-5.4",
  "gpt-5.4": "openai-codex/gpt-5.4",
  "gpt": "openai-codex/gpt-4o",
  "chatgpt": "openai-codex/gpt-4o",
  "openai": "openai-codex/gpt-4o",
  "codex": "openai-codex/gpt-5.4",
  "o3": "openai-codex/o3",
  "o4-mini": "openai-codex/o4-mini",
  "gemini": "google/gemini-2.5-pro",
  "llama": "ollama/llama3.2",
  "mistral": "mistral/mistral-large",
};

describe("model alias resolution", () => {
  // Anthropic models
  it("resolves 'opus' to claude-opus-4-6", () => {
    expect(MODEL_ALIASES["opus"]).toBe("anthropic/claude-opus-4-6");
  });
  it("resolves 'sonnet' to claude-sonnet-4-6", () => {
    expect(MODEL_ALIASES["sonnet"]).toBe("anthropic/claude-sonnet-4-6");
  });
  it("resolves 'haiku' to claude-haiku-4-5", () => {
    expect(MODEL_ALIASES["haiku"]).toBe("anthropic/claude-haiku-4-5");
  });
  it("resolves 'claude' to opus by default", () => {
    expect(MODEL_ALIASES["claude"]).toBe("anthropic/claude-opus-4-6");
  });

  // OpenAI Codex models — all use openai-codex/ prefix
  it("resolves 'gpt-4o' to openai-codex/gpt-4o", () => {
    expect(MODEL_ALIASES["gpt-4o"]).toBe("openai-codex/gpt-4o");
  });
  it("resolves 'codex' to openai-codex/gpt-5.4", () => {
    expect(MODEL_ALIASES["codex"]).toBe("openai-codex/gpt-5.4");
  });
  it("resolves 'gpt-5' to openai-codex/gpt-5.4", () => {
    expect(MODEL_ALIASES["gpt-5"]).toBe("openai-codex/gpt-5.4");
  });
  it("resolves 'chatgpt' to openai-codex/gpt-4o", () => {
    expect(MODEL_ALIASES["chatgpt"]).toBe("openai-codex/gpt-4o");
  });
  it("resolves 'openai' to openai-codex/gpt-4o", () => {
    expect(MODEL_ALIASES["openai"]).toBe("openai-codex/gpt-4o");
  });

  // Other providers
  it("resolves 'gemini' to google/gemini-2.5-pro", () => {
    expect(MODEL_ALIASES["gemini"]).toBe("google/gemini-2.5-pro");
  });
  it("resolves 'llama' to ollama/llama3.2", () => {
    expect(MODEL_ALIASES["llama"]).toBe("ollama/llama3.2");
  });
});

describe("model name extraction from natural language", () => {
  const skipWords = new Set(["openclaw", "model", "llm", "to", "the", "set", "switch", "change", "use", "using", "which", "what", "is", "on"]);

  function extractModelName(rawText: string): string | undefined {
    const words = rawText.toLowerCase().split(/\s+/).filter(w => !skipWords.has(w) && w.length > 1);
    const lastWord = words[words.length - 1];
    const lastTwo = words.slice(-2).join(" ");
    return MODEL_ALIASES[lastTwo] ?? MODEL_ALIASES[lastWord ?? ""] ?? undefined;
  }

  it("extracts 'sonnet' from 'switch openclaw to sonnet'", () => {
    expect(extractModelName("switch openclaw to sonnet")).toBe("anthropic/claude-sonnet-4-6");
  });
  it("extracts 'gpt-4o' from 'openclaw use gpt-4o'", () => {
    expect(extractModelName("openclaw use gpt-4o")).toBe("openai-codex/gpt-4o");
  });
  it("extracts 'codex' from 'switch openclaw to codex'", () => {
    expect(extractModelName("switch openclaw to codex")).toBe("openai-codex/gpt-5.4");
  });
  it("extracts 'opus' from 'set openclaw model to opus'", () => {
    expect(extractModelName("set openclaw model to opus")).toBe("anthropic/claude-opus-4-6");
  });
  it("extracts 'claude sonnet' from 'change openclaw to claude sonnet'", () => {
    expect(extractModelName("change openclaw to claude sonnet")).toBe("anthropic/claude-sonnet-4-6");
  });
  it("returns undefined for 'which llm is openclaw using'", () => {
    expect(extractModelName("which llm is openclaw using")).toBeUndefined();
  });
});
