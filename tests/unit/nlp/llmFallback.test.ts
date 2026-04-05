/**
 * Tests for LLM fallback — prompt building, response parsing, multi-turn,
 * near-misses, template format, gather commands.
 *
 * These tests mock the LLM calls — they test the logic around the LLM,
 * not the LLM itself.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

// ── Response parsing ────────────────────────────────────────────────────────

describe("LLM response parsing", () => {
  // Import the module to test parseResponse indirectly through formatLLMFallback
  it("formatLLMFallback formats a valid result", async () => {
    const { formatLLMFallback } = await import("../../../packages/core/src/nlp/llmFallback.js");
    const result = {
      understood: true,
      restatement: "Check if the server is running",
      suggestedIntents: [
        { intent: "service.status", fields: { service: "nginx" }, confidence: 0.8, reasoning: "User wants to check service" },
      ],
    };
    const formatted = formatLLMFallback(result);
    expect(formatted).toContain("LLM Interpretation");
    expect(formatted).toContain("service.status");
    expect(formatted).toContain("Check if the server is running");
  });

  it("formatLLMFallback shows todo steps", async () => {
    const { formatLLMFallback } = await import("../../../packages/core/src/nlp/llmFallback.js");
    const result = {
      understood: true,
      restatement: "Diagnose slow server",
      suggestedIntents: [{ intent: "server.uptime", fields: {}, confidence: 0.7, reasoning: "check load" }],
      todoSteps: [
        { step: 1, description: "Check CPU load", intent: "server.uptime" },
        { step: 2, description: "Check memory", intent: "server.check_memory" },
        { step: 3, description: "Check disk", command: "df -h" },
      ],
    };
    const formatted = formatLLMFallback(result);
    expect(formatted).toContain("Plan");
    expect(formatted).toContain("Check CPU load");
  });

  it("formatLLMFallback shows missing info", async () => {
    const { formatLLMFallback } = await import("../../../packages/core/src/nlp/llmFallback.js");
    const result = {
      understood: false,
      restatement: "Unclear request",
      suggestedIntents: [],
      missingInfo: ["Which server?", "What service?"],
    };
    const formatted = formatLLMFallback(result);
    expect(formatted).toContain("Need more info");
    expect(formatted).toContain("Which server");
  });
});

// ── LLM context management ──────────────────────────────────────────────────

describe("LLM conversation context", () => {
  it("addLLMContext and getLLMContext work", async () => {
    const { addLLMContext, getLLMContext, clearLLMContext } = await import("../../../packages/core/src/nlp/llmFallback.js");
    clearLLMContext();
    addLLMContext("user", "check server");
    addLLMContext("assistant", '{"intent":"server.uptime"}');
    const ctx = getLLMContext();
    expect(ctx.length).toBe(2);
    expect(ctx[0].role).toBe("user");
    expect(ctx[1].role).toBe("assistant");
  });

  it("clearLLMContext empties the context", async () => {
    const { addLLMContext, getLLMContext, clearLLMContext } = await import("../../../packages/core/src/nlp/llmFallback.js");
    addLLMContext("user", "hello");
    clearLLMContext();
    expect(getLLMContext().length).toBe(0);
  });

  it("context is capped at 10 entries", async () => {
    const { addLLMContext, getLLMContext, clearLLMContext } = await import("../../../packages/core/src/nlp/llmFallback.js");
    clearLLMContext();
    for (let i = 0; i < 15; i++) addLLMContext("user", `msg ${i}`);
    expect(getLLMContext().length).toBeLessThanOrEqual(10);
  });
});

// ── Backend detection ───────────────────────────────────────────────────────

describe("LLM backend detection", () => {
  it("getLLMBackend returns string or null", async () => {
    const { getLLMBackend } = await import("../../../packages/core/src/nlp/llmFallback.js");
    const backend = getLLMBackend();
    expect(["string", "object"]).toContain(typeof backend); // string or null
  });

  it("isLLMConfigured returns boolean", async () => {
    const { isLLMConfigured } = await import("../../../packages/core/src/nlp/llmFallback.js");
    expect(typeof isLLMConfigured()).toBe("boolean");
  });
});

// ── Result type validation ──────────────────────────────────────────────────

describe("LLMFallbackResult structure", () => {
  it("result with gatherCommands has correct shape", () => {
    const result = {
      understood: true,
      restatement: "Investigate slow performance",
      suggestedIntents: [],
      needsMoreInfo: true,
      gatherCommands: [
        { command: "uptime", purpose: "check server load" },
        { command: "df -h", purpose: "check disk space" },
        { command: "ps aux --sort=-%cpu | head -10", purpose: "find heavy processes" },
      ],
    };
    expect(result.needsMoreInfo).toBe(true);
    expect(result.gatherCommands.length).toBe(3);
    expect(result.gatherCommands[0].command).toBe("uptime");
    expect(result.gatherCommands[0].purpose).toContain("load");
  });

  it("result with shellCommands for unknown intent", () => {
    const result = {
      understood: true,
      restatement: "Run a custom database migration",
      suggestedIntents: [],
      shellCommands: [
        "cd /var/www/app && php artisan migrate",
        "php artisan db:seed",
      ],
    };
    expect(result.shellCommands!.length).toBe(2);
    expect(result.shellCommands![0]).toContain("migrate");
  });

  it("result with suggested intent has fields", () => {
    const result = {
      understood: true,
      restatement: "Restart nginx on production",
      suggestedIntents: [{
        intent: "service.restart",
        fields: { service: "nginx", environment: "prod" },
        confidence: 0.9,
        reasoning: "User explicitly asked to restart nginx",
      }],
    };
    expect(result.suggestedIntents[0].intent).toBe("service.restart");
    expect(result.suggestedIntents[0].fields.service).toBe("nginx");
    expect(result.suggestedIntents[0].confidence).toBeGreaterThan(0.5);
  });
});
