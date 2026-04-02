/**
 * Multi-environment execution.
 *
 * Detects phrases like "on all servers", "everywhere", "on prod and staging"
 * and executes the resolved command on each target environment sequentially.
 */

import type { DynamicIntent } from "../types/intent.js";
import { loadHosts, getIntentDef } from "./config.js";
import { runRemoteCommand } from "../execution/ssh.js";

// ─── Detection ──────────────────────────────────────────────────────────────

/** Phrases that mean "all configured environments". */
const ALL_PATTERNS = [
  /\bon all servers\b/i,
  /\bon all environments\b/i,
  /\ball servers\b/i,
  /\ball environments\b/i,
  /\beverywhere\b/i,
  /\bon all\b/i,
];

/**
 * "on X and Y" / "on X, Y, and Z" — extract specific environment names.
 * Must come after a preposition like "on" or "across".
 */
const SPECIFIC_PATTERN = /\b(?:on|across|for)\s+([\w]+(?:\s*(?:,\s*|\band\b\s*)[\w]+)+)/i;

/**
 * Detect whether the user's raw text targets multiple environments.
 *
 * Returns an array of environment names, or `null` if the text does not
 * indicate multi-environment execution.
 */
export function detectMultiTarget(rawText: string): string[] | null {
  const hosts = loadHosts();
  const knownEnvs = Object.keys(hosts);

  // 1. Check for "all" patterns
  for (const pattern of ALL_PATTERNS) {
    if (pattern.test(rawText)) {
      return knownEnvs.length > 0 ? knownEnvs : null;
    }
  }

  // 2. Check for "on X and Y" with specific names
  const match = SPECIFIC_PATTERN.exec(rawText);
  if (match) {
    const envList = match[1]
      .split(/\s*(?:,\s*|\band\b\s*)+/)
      .map((e) => e.trim().toLowerCase())
      .filter(Boolean);

    // Only count environments that are actually configured
    const valid = envList.filter((e) => knownEnvs.includes(e));
    if (valid.length > 1) {
      return valid;
    }
  }

  return null;
}

// ─── Execution ──────────────────────────────────────────────────────────────

interface EnvResult {
  environment: string;
  success: boolean;
  output: string;
  durationMs: number;
}

/**
 * Execute an intent's command on each of the given environments sequentially,
 * printing progress along the way.
 *
 * Returns a formatted summary string.
 */
export async function executeMulti(
  intent: DynamicIntent,
  environments: string[],
): Promise<string> {
  const def = getIntentDef(intent.intent);
  if (!def) {
    throw new Error(`No intent definition found for: ${intent.intent}`);
  }

  const cc = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
  };

  const command = interpolateFields(def.command, intent.fields);

  console.log(
    `\n${cc.bold}${cc.cyan}── Multi-environment: ${environments.join(", ")} ──${cc.reset}`,
  );
  console.log(`${cc.dim}Command: ${command}${cc.reset}\n`);

  const results: EnvResult[] = [];

  for (let i = 0; i < environments.length; i++) {
    const env = environments[i];
    const label = `[${i + 1}/${environments.length}] ${env}`;
    process.stderr.write(`  ${cc.cyan}${label}${cc.reset} ... `);

    const start = Date.now();
    let output: string;
    let success: boolean;

    try {
      output = await runRemoteCommand(env, command);
      success = true;
      process.stderr.write(`${cc.green}OK${cc.reset} (${Date.now() - start}ms)\n`);
    } catch (err) {
      output = err instanceof Error ? err.message : String(err);
      success = false;
      process.stderr.write(`${cc.red}FAIL${cc.reset} (${Date.now() - start}ms)\n`);
    }

    results.push({
      environment: env,
      success,
      output: output.trim(),
      durationMs: Date.now() - start,
    });
  }

  // ── Summary ──
  return formatSummary(results, cc);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function interpolateFields(
  template: string,
  fields: Record<string, unknown>,
): string {
  let cmd = template;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      cmd = cmd.replaceAll(`{{${key}}}`, String(value));
    }
  }

  // Remove any remaining placeholders
  cmd = cmd.replace(/\{\{[a-zA-Z_]+\}\}/g, "");
  return cmd.trim();
}

function formatSummary(
  results: EnvResult[],
  cc: Record<string, string>,
): string {
  const lines: string[] = [];
  const passed = results.filter((r) => r.success).length;
  const failed = results.length - passed;

  lines.push(
    `\n${cc.bold}── Summary ──${cc.reset}  ${cc.green}${passed} passed${cc.reset}` +
      (failed > 0 ? `  ${cc.red}${failed} failed${cc.reset}` : ""),
  );
  lines.push("");

  for (const r of results) {
    const icon = r.success
      ? `${cc.green}✓${cc.reset}`
      : `${cc.red}✗${cc.reset}`;
    const dur = `${cc.dim}(${r.durationMs}ms)${cc.reset}`;
    lines.push(`  ${icon} ${cc.bold}${r.environment}${cc.reset} ${dur}`);

    // Show first few lines of output (truncated)
    const outputLines = r.output.split("\n").filter(Boolean);
    const preview = outputLines.slice(0, 3);
    for (const line of preview) {
      lines.push(`    ${cc.dim}${line}${cc.reset}`);
    }
    if (outputLines.length > 3) {
      lines.push(`    ${cc.dim}... (${outputLines.length - 3} more lines)${cc.reset}`);
    }
  }

  return lines.join("\n");
}
