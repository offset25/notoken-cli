/**
 * LLM Manager.
 *
 * Manages which LLMs are connected, enabled/disabled, and offline mode.
 * Also tracks estimated tokens saved by using deterministic mode.
 *
 * Commands:
 *   :status    — show which LLMs are connected
 *   :offline   — go fully offline (disable all LLMs)
 *   :online    — re-enable LLMs
 *   :disable <llm>  — disable a specific LLM
 *   :enable <llm>   — enable a specific LLM
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { USER_HOME } from "./paths.js";

const STATE_FILE = resolve(USER_HOME, "llm-state.json");

export interface LLMProvider {
  name: string;
  type: "cli" | "api" | "local";
  available: boolean;
  enabled: boolean;
  version?: string;
  model?: string;
}

export interface LLMState {
  offlineMode: boolean;
  disabled: string[];
  tokensSaved: number;
  commandsHandledOffline: number;
  lastSaved: string;
}

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

// ─── State Persistence ──────────────────────────────────────────────────────

function loadState(): LLMState {
  try {
    if (existsSync(STATE_FILE)) {
      return JSON.parse(readFileSync(STATE_FILE, "utf-8"));
    }
  } catch {}
  return { offlineMode: false, disabled: [], tokensSaved: 0, commandsHandledOffline: 0, lastSaved: new Date().toISOString() };
}

function saveState(state: LLMState): void {
  try {
    mkdirSync(USER_HOME, { recursive: true });
    state.lastSaved = new Date().toISOString();
    writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
  } catch {}
}

let state = loadState();

// ─── Provider Detection ─────────────────────────────────────────────────────

export function detectProviders(): LLMProvider[] {
  const providers: LLMProvider[] = [];

  // Claude CLI
  const claudeVersion = tryExec("claude --version");
  providers.push({
    name: "claude",
    type: "cli",
    available: !!claudeVersion,
    enabled: !state.offlineMode && !state.disabled.includes("claude"),
    version: claudeVersion ?? undefined,
  });

  // Ollama
  const ollamaVersion = tryExec("ollama --version");
  let ollamaRunning = false;
  let ollamaModel: string | undefined;
  if (ollamaVersion) {
    try {
      const tags = tryExec("curl -sf --max-time 1 http://localhost:11434/api/tags");
      if (tags) {
        ollamaRunning = true;
        const parsed = JSON.parse(tags);
        ollamaModel = parsed.models?.[0]?.name;
      }
    } catch {}
  }
  providers.push({
    name: "ollama",
    type: "local",
    available: ollamaRunning,
    enabled: !state.offlineMode && !state.disabled.includes("ollama"),
    version: ollamaVersion ?? undefined,
    model: ollamaModel,
  });

  // API endpoint
  const apiEndpoint = process.env.NOTOKEN_LLM_ENDPOINT;
  providers.push({
    name: "api",
    type: "api",
    available: !!apiEndpoint,
    enabled: !state.offlineMode && !state.disabled.includes("api") && !!apiEndpoint,
    version: apiEndpoint ? "configured" : undefined,
    model: process.env.NOTOKEN_LLM_MODEL,
  });

  return providers;
}

// ─── Status ─────────────────────────────────────────────────────────────────

export function formatStatus(): string {
  const providers = detectProviders();
  const lines: string[] = [];

  lines.push(`${c.bold}LLM Status${c.reset}${state.offlineMode ? ` ${c.yellow}[OFFLINE MODE]${c.reset}` : ""}\n`);

  for (const p of providers) {
    const icon = p.available && p.enabled ? `${c.green}⬤${c.reset}` :
                 p.available && !p.enabled ? `${c.yellow}⬤${c.reset}` :
                 `${c.dim}○${c.reset}`;
    const status = p.available && p.enabled ? `${c.green}active${c.reset}` :
                   p.available && !p.enabled ? `${c.yellow}disabled${c.reset}` :
                   `${c.dim}not available${c.reset}`;
    const detail = [p.version, p.model].filter(Boolean).join(" / ");

    lines.push(`  ${icon} ${c.bold}${p.name}${c.reset} (${p.type}) — ${status}${detail ? ` ${c.dim}${detail}${c.reset}` : ""}`);
  }

  const active = providers.filter(p => p.available && p.enabled);
  lines.push("");
  if (active.length > 0) {
    lines.push(`  ${c.dim}Active chain: ${active.map(p => p.name).join(" → ")}${c.reset}`);
  } else {
    lines.push(`  ${c.dim}Running in deterministic mode (no LLM)${c.reset}`);
  }

  // Token savings
  lines.push("");
  lines.push(`  ${c.cyan}Tokens saved:${c.reset} ~${formatTokens(state.tokensSaved)} (${state.commandsHandledOffline} commands handled offline)`);

  return lines.join("\n");
}

// ─── Controls ───────────────────────────────────────────────────────────────

export function goOffline(): string {
  state.offlineMode = true;
  saveState(state);
  return `${c.yellow}Offline mode enabled.${c.reset} All LLM providers disabled. Deterministic engine only.`;
}

export function goOnline(): string {
  state.offlineMode = false;
  saveState(state);
  const providers = detectProviders().filter(p => p.available && p.enabled);
  return `${c.green}Online mode.${c.reset} Active: ${providers.map(p => p.name).join(", ") || "none detected"}`;
}

export function disableLLM(name: string): string {
  if (!state.disabled.includes(name)) {
    state.disabled.push(name);
    saveState(state);
  }
  return `${c.yellow}${name} disabled.${c.reset}`;
}

export function enableLLM(name: string): string {
  state.disabled = state.disabled.filter(n => n !== name);
  saveState(state);
  return `${c.green}${name} enabled.${c.reset}`;
}

export function isOfflineMode(): boolean {
  return state.offlineMode;
}

export function isLLMDisabled(name: string): boolean {
  return state.offlineMode || state.disabled.includes(name);
}

// ─── Token Savings Tracker ──────────────────────────────────────────────────

// Rough estimate: average LLM call uses ~500 tokens input + ~200 output
const AVG_TOKENS_PER_CALL = 700;

export function recordOfflineCommand(): void {
  state.commandsHandledOffline++;
  state.tokensSaved += AVG_TOKENS_PER_CALL;
  // Save periodically (every 10 commands)
  if (state.commandsHandledOffline % 10 === 0) saveState(state);
}

export function getTokensSaved(): { tokens: number; commands: number } {
  return { tokens: state.tokensSaved, commands: state.commandsHandledOffline };
}

export function formatTokensSaved(): string {
  const { tokens, commands } = getTokensSaved();
  if (commands === 0) return "";
  return `${c.dim}~${formatTokens(tokens)} tokens saved (${commands} commands handled offline)${c.reset}`;
}

export function formatTokensSavedBrief(): string {
  const { tokens, commands } = getTokensSaved();
  if (commands === 0) return "";
  return `${c.dim}Tokens saved: ~${formatTokens(tokens)}${c.reset}`;
}

// Save state on exit
export function saveOnExit(): void {
  saveState(state);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 5000 }).trim() || null;
  } catch {
    return null;
  }
}
