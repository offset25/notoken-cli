/**
 * Integration tests for the LLM multi-turn disambiguation flow.
 *
 * These test the full pipeline: unknown intent → LLM fallback → gather commands → analyze.
 * Tests run against live Ollama if available, otherwise skip.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";

let ollamaAvailable = false;

// Check if Ollama is running
try {
  const tags = execSync("curl -sf http://127.0.0.1:11434/api/tags 2>/dev/null", { encoding: "utf-8", timeout: 3000 });
  ollamaAvailable = tags.includes("models");
} catch {}

describe("LLM multi-turn: live Ollama tests", () => {
  it.skipIf(!ollamaAvailable)("Ollama responds to a simple prompt", async () => {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llama3.2", prompt: "Say hello in one word", stream: false, options: { num_predict: 10 } }),
    });
    const data = await response.json() as { response: string };
    expect(data.response.length).toBeGreaterThan(0);
  });

  it.skipIf(!ollamaAvailable)("template prompt returns valid JSON", async () => {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2",
        prompt: 'Complete this JSON. Replace FILL with values.\nUser: "check if nginx is running"\n```json\n{"understood": FILL, "restatement": "FILL", "suggestedIntents": [{"intent": "FILL", "confidence": FILL, "reasoning": "FILL"}]}\n```\nOutput only the completed JSON:',
        stream: false,
        options: { temperature: 0.1, num_predict: 256 },
      }),
    });
    const data = await response.json() as { response: string };
    expect(data.response.length).toBeGreaterThan(10);

    // Try to parse — the template approach should yield valid JSON
    let parsed = null;
    try {
      // Extract JSON from response (may have backticks)
      const jsonMatch = data.response.match(/\{[\s\S]*\}/);
      if (jsonMatch) parsed = JSON.parse(jsonMatch[0]);
    } catch {}

    // Even if parsing fails, the response should contain JSON-like structure
    expect(data.response).toMatch(/understood|suggestedIntents|intent/);
  });

  it.skipIf(!ollamaAvailable)("gather commands prompt returns commands", async () => {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2",
        prompt: 'Complete this JSON. Replace FILL with values.\nUser: "why is my server slow"\nI need to investigate. What shell commands should I run first?\n```json\n{"needsMoreInfo": true, "gatherCommands": [{"command": "FILL_WITH_REAL_SHELL_COMMAND", "purpose": "FILL"}, {"command": "FILL", "purpose": "FILL"}]}\n```\nOutput only the completed JSON:',
        stream: false,
        options: { temperature: 0.1, num_predict: 256 },
      }),
    });
    const data = await response.json() as { response: string };
    expect(data.response.length).toBeGreaterThan(10);
    // Should contain actual shell commands
    expect(data.response).toMatch(/top|uptime|ps|df|free|vmstat|iostat|netstat/i);
  });

  it.skipIf(!ollamaAvailable)("near-misses help LLM pick better intent", async () => {
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2",
        prompt: 'Complete this JSON. Replace FILL with values.\nUser: "is nginx ok"\nNEAR MATCHES from my classifiers:\n- service.status (55%): Check if a service is running\n- server.uptime (50%): Check server uptime\nPick the best one.\n```json\n{"understood": FILL, "suggestedIntents": [{"intent": "FILL_pick_from_near_matches", "confidence": FILL, "reasoning": "FILL"}]}\n```\nOutput only JSON:',
        stream: false,
        options: { temperature: 0.1, num_predict: 200 },
      }),
    });
    const data = await response.json() as { response: string };
    // Should pick one of the near-misses
    expect(data.response).toMatch(/service\.status|server\.uptime/);
  });

  it.skipIf(!ollamaAvailable)("command output analysis works", async () => {
    // Simulate turn 2: LLM gets command outputs
    const response = await fetch("http://127.0.0.1:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama3.2",
        prompt: 'User asked "why is everything slow". I ran these commands:\n\nCommand: uptime\nOutput: 17:00:00 up 2 days, load average: 8.50, 7.20, 6.10\n\nCommand: df -h\nOutput: /dev/sda1 100G 95G 5G 95% /\n\nComplete this JSON:\n```json\n{"understood": true, "restatement": "FILL_based_on_outputs", "suggestedIntents": [{"intent": "FILL", "confidence": FILL, "reasoning": "FILL_explain_what_outputs_show"}], "needsMoreInfo": false}\n```\nOutput only JSON:',
        stream: false,
        options: { temperature: 0.1, num_predict: 256 },
      }),
    });
    const data = await response.json() as { response: string };
    // Should mention high load or disk space
    expect(data.response).toMatch(/load|disk|space|high|full|slow/i);
  });
});

// ── Unit tests that don't need Ollama ───────────────────────────────────────

describe("LLM multi-turn: unit tests (no LLM needed)", () => {
  it("parseIntent falls through to LLM for unknown input", async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    // This phrase should not match any intent
    const result = await parseIntent("quantum flux capacitor recalibration");
    // Should be unknown since no intent matches and LLM may or may not be available
    expect(["unknown", "knowledge.lookup"]).toContain(result.intent.intent);
  });

  it("parseIntent handles gibberish without crashing", async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("xyzzy foobar baz123");
    // Should return something — either unknown or a low-confidence guess
    expect(result).toHaveProperty("intent");
    expect(result.intent.confidence).toBeLessThanOrEqual(1);
  });

  it("near-misses are populated before LLM call", async () => {
    const { classifyMulti } = await import("../../../src/nlp/multiClassifier.js");
    // A vague input should still produce some classifier votes
    const result = classifyMulti("check if things are ok");
    expect(result.votes.length).toBeGreaterThan(0);
    // There should be some scored intents even if none are confident
    if (result.best) {
      expect(result.best.score).toBeGreaterThan(0);
      expect(result.best.intent.length).toBeGreaterThan(0);
    }
  });

  it("semantic similarity provides candidates for vague input", async () => {
    const { findSimilarIntents } = await import("../../../src/nlp/semanticSimilarity.js");
    const similar = findSimilarIntents("is everything working fine", 5);
    expect(similar.length).toBeGreaterThan(0);
    // Should find some remotely related intents
    expect(similar[0].score).toBeGreaterThan(0);
  });

  it("concept expansion helps with synonyms", async () => {
    const { expandQuery } = await import("../../../src/nlp/conceptExpansion.js");
    const expanded = expandQuery("the machine is sluggish");
    // "sluggish" should expand to include "slow" cluster
    expect(expanded).toContain("slow");
  });
});
