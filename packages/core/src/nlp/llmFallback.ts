/**
 * LLM fallback for unrecognized prompts.
 *
 * ONLY fires when an LLM is actually configured:
 * - NOTOKEN_LLM_ENDPOINT env var is set (for API), OR
 * - NOTOKEN_LLM_CLI=claude|chatgpt is set (for CLI tools)
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
  /** Raw shell commands to run if no intent matches */
  shellCommands?: string[];
  /** Questions to ask the user for clarification */
  missingInfo?: string[];
  /** Commands to run first to gather info before answering (multi-turn) */
  gatherCommands?: Array<{
    command: string;
    purpose: string;
  }>;
  /** Whether the LLM needs more info from command outputs before it can answer */
  needsMoreInfo?: boolean;
}

/** Conversation history for multi-turn LLM disambiguation */
const _llmConversation: Array<{ role: "user" | "assistant"; content: string }> = [];

/** Add a turn to the LLM conversation for multi-turn context */
export function addLLMContext(role: "user" | "assistant", content: string): void {
  _llmConversation.push({ role, content });
  if (_llmConversation.length > 10) _llmConversation.splice(0, _llmConversation.length - 10);
}

/** Clear LLM conversation when topic changes */
export function clearLLMContext(): void { _llmConversation.length = 0; }

/** Get conversation for context in multi-turn */
export function getLLMContext(): Array<{ role: "user" | "assistant"; content: string }> { return [..._llmConversation]; }

/**
 * Check if any LLM is configured.
 */
/**
 * Check if any LLM is available.
 * Order: explicit config → auto-detect Ollama → nothing.
 */
export function isLLMConfigured(): boolean {
  return !!(process.env.NOTOKEN_LLM_ENDPOINT || process.env.NOTOKEN_LLM_CLI || detectOllama() || detectCodex());
}

/** Which LLM backend is active? */
export function getLLMBackend(): string | null {
  if (process.env.NOTOKEN_LLM_CLI) return process.env.NOTOKEN_LLM_CLI;
  if (process.env.NOTOKEN_LLM_ENDPOINT) return "api";
  if (detectOllama()) return "ollama";
  if (detectCodex()) return "codex";
  return null;
}

let codexChecked = false;
let codexAvailable = false;

function detectCodex(): boolean {
  if (codexChecked) return codexAvailable;
  codexChecked = true;
  try {
    execSync("command -v codex", { timeout: 1000, stdio: "pipe" });
    codexAvailable = true;
  } catch {
    codexAvailable = false;
  }
  return codexAvailable;
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
    nearMisses?: Array<{ intent: string; score: number; source: string }>;
  }
): Promise<LLMFallbackResult | null> {
  if (!isLLMConfigured()) return null;

  // Try CLI tool if configured
  if (process.env.NOTOKEN_LLM_CLI) {
    const cliResult = await tryLLMCli(rawText, context);
    if (cliResult) return cliResult;
  }

  // Try API endpoint if configured
  if (process.env.NOTOKEN_LLM_ENDPOINT) {
    const apiResult = await tryApiEndpoint(rawText, context);
    if (apiResult) return apiResult;
  }

  // Try Codex (auto-detected local)
  if (detectCodex()) {
    const codexResult = await tryLLMCli(rawText, { ...context, _cli: "codex" });
    if (codexResult) return codexResult;
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
  const cli = process.env.NOTOKEN_LLM_CLI;
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
    } else if (cli === "codex") {
      execSync("command -v codex", { stdio: "pipe" });
      cmd = `codex ${JSON.stringify(prompt)}`;
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
  const endpoint = process.env.NOTOKEN_LLM_ENDPOINT;
  if (!endpoint) return null;

  const apiKey = process.env.NOTOKEN_LLM_API_KEY ?? "";
  const model = process.env.NOTOKEN_LLM_MODEL ?? "claude-sonnet-4-20250514";
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
  const model = process.env.NOTOKEN_OLLAMA_MODEL ?? "llama3.2";

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
  const platform = detectLocalPlatform();

  // Group intents by domain — much shorter than listing all 298
  const domains = new Map<string, string[]>();
  for (const i of intents) {
    const domain = i.name.split(".")[0];
    if (!domains.has(domain)) domains.set(domain, []);
    domains.get(domain)!.push(`${i.name}: ${i.description}`);
  }

  // Only include top-level summary + relevant domains based on user input
  const relevantDomains: string[] = [];
  const inputLower = rawText.toLowerCase();
  for (const [domain, items] of domains) {
    // Include domains that might be relevant to the query
    const domainKeywords: Record<string, string[]> = {
      service: ["service", "restart", "start", "stop", "status", "running"],
      server: ["server", "cpu", "memory", "disk", "load", "uptime"],
      docker: ["docker", "container", "image", "compose"],
      network: ["network", "ip", "port", "ping", "dns", "curl", "speed"],
      git: ["git", "commit", "push", "pull", "branch", "merge"],
      deploy: ["deploy", "release", "rollback"],
      logs: ["log", "error", "tail", "search"],
      security: ["security", "attack", "firewall", "scan", "block"],
      disk: ["disk", "space", "cleanup", "scan", "drive"],
      db: ["database", "mysql", "postgres", "query", "sql"],
      openclaw: ["openclaw", "claw", "gateway", "discord"],
      ollama: ["ollama", "llm", "model"],
      ai: ["image", "generate", "stable diffusion"],
      files: ["file", "find", "copy", "move", "delete"],
      process: ["process", "kill", "pid"],
      user: ["user", "who", "login"],
      backup: ["backup", "restore", "snapshot"],
      notoken: ["notoken", "status", "version", "update", "help"],
    };

    const keywords = domainKeywords[domain] ?? [domain];
    if (keywords.some(k => inputLower.includes(k)) || items.length <= 5) {
      relevantDomains.push(`\n  [${domain}] (${items.length} commands)\n${items.slice(0, 8).map(i => `    ${i}`).join("\n")}`);
    }
  }

  // If no relevant domains found, include a general summary
  if (relevantDomains.length === 0) {
    for (const [domain, items] of [...domains].slice(0, 10)) {
      relevantDomains.push(`  [${domain}]: ${items.slice(0, 3).map(i => i.split(":")[0]).join(", ")}...`);
    }
  }

  // Recent conversation context
  const recentIntents = (context.recentIntents as string[]) ?? [];
  const recentContext = recentIntents.length > 0
    ? `\nRECENT COMMANDS (what the user has been doing):\n  ${recentIntents.slice(0, 5).join(", ")}\n`
    : "";

  // Known entities
  const entities = (context.knownEntities as Array<{ entity: string; type: string }>) ?? [];
  const entityContext = entities.length > 0
    ? `\nKNOWN ENTITIES:\n  ${entities.slice(0, 10).map(e => `${e.entity} (${e.type})`).join(", ")}\n`
    : "";

  return `You are NoToken, a server operations CLI assistant. The user said something my NLP couldn't parse. Help me understand what they want.

ENVIRONMENT:
  OS: ${platform.distro}${platform.isWSL ? " (WSL)" : ""} | Shell: ${platform.shell}
  Package manager: ${platform.packageManager} | Init: ${platform.initSystem}
${recentContext}${entityContext}
USER INPUT: "${rawText}"

AVAILABLE COMMANDS (grouped by domain — ${intents.length} total):
${relevantDomains.join("\n")}

INSTRUCTIONS:
1. Map the user's request to one or more of my available commands above.
2. If the request is ambiguous, suggest the most likely interpretation.
3. If no command fits, suggest what shell commands I should run to address it.
4. If you need to run commands first to gather information (e.g. check system state before answering), list them in "gatherCommands".
5. Extract field values (service names, paths, environments) from the input.
6. If the user is chatting casually (hello, thanks, joke), use chat.* intents.

Respond with ONLY valid JSON:
{
  "understood": true,
  "restatement": "What the user wants in plain English",
  "suggestedIntents": [
    {"intent": "domain.command", "fields": {"field": "value"}, "confidence": 0.8, "reasoning": "why"}
  ],
  "shellCommands": ["raw shell commands if no intent fits"],
  "todoSteps": [{"step": 1, "description": "what to do", "intent": "optional", "command": "optional shell cmd"}],
  "gatherCommands": [{"command": "uptime", "purpose": "check server load"}, {"command": "df -h", "purpose": "check disk"}],
  "needsMoreInfo": false,
  "missingInfo": ["questions if unclear"]
}

IMPORTANT:
- If you can answer with a single intent, just return suggestedIntents.
- If you need to run commands first to investigate, set needsMoreInfo=true and list gatherCommands.
- I will run those commands and send you the output so you can make a better decision.
- Always return valid JSON. No markdown, no explanation outside JSON.`;
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
