/**
 * LLM fallback for unrecognized prompts.
 *
 * ONLY fires when an LLM is actually configured:
 * - MYCLI_LLM_ENDPOINT env var is set (for API), OR
 * - MYCLI_LLM_CLI=claude|chatgpt is set (for CLI tools)
 *
 * Otherwise returns null immediately — no noise, no "trying fallback" messages.
 */

import { execSync, execFileSync } from "node:child_process";
import { loadIntents } from "../utils/config.js";
import { detectLocalPlatform } from "../utils/platform.js";

export interface LLMFallbackResult {
  understood: boolean;
  restatement: string;
  suggestedIntents: Array<{
    intent: string;
    fields: Record<string, unknown>;
    confidence: number;
    reasoning: string;
  }>;
  todoSteps?: Array<{
    step: number;
    description: string;
    intent?: string;
    command?: string;
  }>;
  missingInfo?: string[];
}

/**
 * Check if any LLM is configured.
 */
/**
 * Check if any LLM is available.
 * Order: explicit config → auto-detect Ollama → nothing.
 */
export function isLLMConfigured(): boolean {
  return !!(process.env.MYCLI_LLM_ENDPOINT || process.env.MYCLI_LLM_CLI || detectOllama());
}

/** Which LLM backend is active? */
export function getLLMBackend(): string | null {
  if (process.env.MYCLI_LLM_CLI) return process.env.MYCLI_LLM_CLI;
  if (process.env.MYCLI_LLM_ENDPOINT) return "api";
  if (detectOllama()) return "ollama";
  return null;
}

let ollamaChecked = false;
let ollamaAvailable = false;

function detectOllama(): boolean {
  if (ollamaChecked) return ollamaAvailable;
  ollamaChecked = true;
  try {
    execSync("command -v ollama", { timeout: 1000, stdio: "pipe" });
    execSync("curl -sf --max-time 1 http://localhost:11434/api/tags >/dev/null 2>&1", { timeout: 2000, stdio: "pipe" });
    ollamaAvailable = true;
  } catch {
    ollamaAvailable = false;
  }
  return ollamaAvailable;
}

/**
 * Ask the LLM to interpret an unrecognized prompt.
 * Returns null immediately if no LLM is available.
 *
 * Priority: CLI (claude/chatgpt) → API endpoint → Ollama (local) → null
 */
export async function llmFallback(
  rawText: string,
  context: {
    recentIntents?: string[];
    knownEntities?: Array<{ entity: string; type: string }>;
    uncertainTokens?: string[];
  }
): Promise<LLMFallbackResult | null> {
  if (!isLLMConfigured()) return null;

  // Try CLI tool if configured
  if (process.env.MYCLI_LLM_CLI) {
    const cliResult = await tryLLMCli(rawText, context);
    if (cliResult) return cliResult;
  }

  // Try API endpoint if configured
  if (process.env.MYCLI_LLM_ENDPOINT) {
    const apiResult = await tryApiEndpoint(rawText, context);
    if (apiResult) return apiResult;
  }

  // Try Ollama (auto-detected local)
  if (detectOllama()) {
    const ollamaResult = await tryOllama(rawText, context);
    if (ollamaResult) return ollamaResult;
  }

  return null;
}

async function tryLLMCli(
  rawText: string,
  context: Record<string, unknown>
): Promise<LLMFallbackResult | null> {
  const cli = process.env.MYCLI_LLM_CLI;
  if (!cli) return null;

  try {
    const { execSync } = await import("node:child_process");
    const prompt = buildPrompt(rawText, context);

    let cmd: string;
    if (cli === "claude") {
      execSync("command -v claude", { stdio: "pipe" });
      cmd = `claude -p ${JSON.stringify(prompt)} --output-format json --max-turns 1 --no-session-persistence`;
    } else if (cli === "chatgpt") {
      execSync("command -v chatgpt", { stdio: "pipe" });
      cmd = `chatgpt ${JSON.stringify(prompt)}`;
    } else {
      return null;
    }

    const rawResult = execSync(cmd, {
      encoding: "utf-8",
      timeout: 60_000,
      stdio: ["pipe", "pipe", "pipe"],
    });

    // Claude CLI --output-format json wraps the response; extract the text content
    let result = rawResult;
    try {
      const parsed = JSON.parse(rawResult);
      // Claude CLI json format: { result: "...", ... } or { content: [{text: "..."}] }
      if (parsed.result && typeof parsed.result === "string") {
        result = parsed.result;
      } else if (Array.isArray(parsed)) {
        // Array of messages — find the assistant message
        const assistant = parsed.find((m: Record<string, unknown>) => m.role === "assistant");
        if (assistant?.content) {
          if (typeof assistant.content === "string") result = assistant.content;
          else if (Array.isArray(assistant.content)) {
            const textBlock = assistant.content.find((b: Record<string, unknown>) => b.type === "text");
            if (textBlock?.text) result = textBlock.text;
          }
        }
      }
    } catch {
      // Not JSON — use as-is (text mode fallback)
    }

    return parseResponse(result);
  } catch {
    return null;
  }
}

async function tryApiEndpoint(
  rawText: string,
  context: Record<string, unknown>
): Promise<LLMFallbackResult | null> {
  const endpoint = process.env.MYCLI_LLM_ENDPOINT;
  if (!endpoint) return null;

  const apiKey = process.env.MYCLI_LLM_API_KEY ?? "";
  const model = process.env.MYCLI_LLM_MODEL ?? "claude-sonnet-4-20250514";
  const prompt = buildPrompt(rawText, context);

  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(apiKey ? { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey } : {}),
      },
      body: JSON.stringify({
        model,
        max_tokens: 1024,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    if (!response.ok) return null;
    const data = (await response.json()) as Record<string, unknown>;
    const content = extractContent(data);
    if (!content) return null;

    return parseResponse(content);
  } catch {
    return null;
  }
}

async function tryOllama(
  rawText: string,
  context: Record<string, unknown>
): Promise<LLMFallbackResult | null> {
  const prompt = buildPrompt(rawText, context);
  const model = process.env.MYCLI_OLLAMA_MODEL ?? "llama3.2";

  try {
    const response = await fetch("http://localhost:11434/api/generate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        prompt,
        stream: false,
        options: { temperature: 0.1, num_predict: 1024 },
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as Record<string, unknown>;
    const text = data.response as string;
    if (!text) return null;

    return parseResponse(text);
  } catch {
    return null;
  }
}

/**
 * Check if Ollama is installed (not just running).
 * Used by doctor and interactive mode to offer installation.
 */
export function isOllamaInstalled(): boolean {
  try {
    const { execSync } = require("node:child_process") as typeof import("node:child_process");
    execSync("command -v ollama", { stdio: "pipe" });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if Ollama has any models pulled.
 */
export async function getOllamaModels(): Promise<string[]> {
  try {
    const response = await fetch("http://localhost:11434/api/tags");
    if (!response.ok) return [];
    const data = (await response.json()) as { models?: Array<{ name: string }> };
    return (data.models ?? []).map((m) => m.name);
  } catch {
    return [];
  }
}

function buildPrompt(rawText: string, context: Record<string, unknown>): string {
  const intents = loadIntents();
  const intentSummary = intents.map((i) => {
    const fields = Object.entries(i.fields)
      .map(([k, v]) => `${k}:${v.type}${v.required ? "*" : ""}`)
      .join(", ");
    return `  ${i.name}: ${i.description} [${fields}]`;
  }).join("\n");

  const platform = detectLocalPlatform();

  return `You are a server operations CLI assistant. The user said something I couldn't parse with my rule-based system.

ENVIRONMENT:
  OS: ${platform.distro}${platform.isWSL ? " (WSL)" : ""}
  Kernel: ${platform.kernel}
  Arch: ${platform.arch}
  Shell: ${platform.shell}
  Package manager: ${platform.packageManager}
  Init system: ${platform.initSystem}

USER INPUT: "${rawText}"

CONTEXT:
${JSON.stringify(context, null, 2)}

AVAILABLE INTENTS (these are the tools I can execute):
${intentSummary}

Respond with ONLY a JSON object:
{
  "understood": true/false,
  "restatement": "In plain English, what the user wants to do",
  "suggestedIntents": [
    {
      "intent": "intent.name from list above",
      "fields": { "field": "value" },
      "confidence": 0.0-1.0,
      "reasoning": "why this intent"
    }
  ],
  "todoSteps": [
    { "step": 1, "description": "what to do first", "intent": "optional intent name" }
  ],
  "missingInfo": ["things I'd need to ask the user"]
}

Return ONLY JSON.`;
}

function parseResponse(raw: string): LLMFallbackResult | null {
  try { const json = JSON.parse(raw.trim()); if (json.understood !== undefined) return json; } catch {}
  const match = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (match) { try { return JSON.parse(match[1].trim()); } catch {} }
  const jsonMatch = raw.match(/\{[\s\S]*"understood"[\s\S]*\}/);
  if (jsonMatch) { try { return JSON.parse(jsonMatch[0]); } catch {} }
  return null;
}

function extractContent(data: Record<string, unknown>): string | null {
  if (data.choices && Array.isArray(data.choices)) {
    const msg = (data.choices as Array<Record<string, unknown>>)[0]?.message as Record<string, unknown> | undefined;
    if (msg?.content && typeof msg.content === "string") return msg.content;
  }
  if (data.content && Array.isArray(data.content)) {
    const block = (data.content as Array<Record<string, unknown>>)[0];
    if (block?.text && typeof block.text === "string") return block.text;
  }
  if (typeof data.result === "string") return data.result;
  return null;
}

/**
 * Format an LLM fallback result for display.
 */
export function formatLLMFallback(result: LLMFallbackResult): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m" };
  const lines: string[] = [];

  lines.push(`${c.bold}${c.cyan}LLM Interpretation:${c.reset}`);
  lines.push(`  ${result.restatement}`);

  if (result.suggestedIntents.length > 0) {
    lines.push(`\n${c.bold}Suggested actions:${c.reset}`);
    for (const s of result.suggestedIntents) {
      const conf = (s.confidence * 100).toFixed(0);
      lines.push(`  ${c.green}${s.intent}${c.reset} (${conf}%) — ${s.reasoning}`);
      const fields = Object.entries(s.fields);
      if (fields.length > 0) {
        lines.push(`    ${fields.map(([k, v]) => `${k}=${v}`).join(", ")}`);
      }
    }
  }

  if (result.todoSteps && result.todoSteps.length > 0) {
    lines.push(`\n${c.bold}Plan:${c.reset}`);
    for (const step of result.todoSteps) {
      const intent = step.intent ? ` ${c.dim}[${step.intent}]${c.reset}` : "";
      lines.push(`  ${c.cyan}${step.step}.${c.reset} ${step.description}${intent}`);
    }
  }

  if (result.missingInfo && result.missingInfo.length > 0) {
    lines.push(`\n${c.yellow}Need more info:${c.reset}`);
    for (const q of result.missingInfo) {
      lines.push(`  ? ${q}`);
    }
  }

  return lines.join("\n");
}
