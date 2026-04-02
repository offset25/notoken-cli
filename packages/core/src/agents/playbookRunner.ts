/**
 * Playbook runner.
 *
 * Loads playbooks from config/playbooks.json and executes them
 * step by step, locally or remotely.
 */

import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { runRemoteCommand, runLocalCommand } from "../execution/ssh.js";
import { CONFIG_DIR } from "../utils/paths.js";

const PLAYBOOKS_FILE = resolve(CONFIG_DIR, "playbooks.json");

export interface PlaybookStep {
  command: string;
  label: string;
}

export interface Playbook {
  name: string;
  description: string;
  steps: PlaybookStep[];
}

export interface PlaybookResult {
  name: string;
  environment: string;
  steps: Array<{
    label: string;
    command: string;
    output: string;
    success: boolean;
    durationMs: number;
  }>;
  totalDurationMs: number;
}

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

/**
 * Load all playbooks from config.
 */
export function loadPlaybooks(): Playbook[] {
  if (!existsSync(PLAYBOOKS_FILE)) return [];
  const raw = JSON.parse(readFileSync(PLAYBOOKS_FILE, "utf-8"));
  return raw.playbooks ?? [];
}

/**
 * Get a playbook by name.
 */
export function getPlaybook(name: string): Playbook | undefined {
  return loadPlaybooks().find((p) => p.name === name || p.name.includes(name));
}

/**
 * List all available playbooks.
 */
export function formatPlaybookList(): string {
  const playbooks = loadPlaybooks();
  if (playbooks.length === 0) return `${c.dim}No playbooks configured.${c.reset}`;

  const lines = [`${c.bold}Available playbooks:${c.reset}\n`];
  for (const pb of playbooks) {
    lines.push(`  ${c.cyan}${pb.name}${c.reset} — ${pb.description} (${pb.steps.length} steps)`);
  }
  lines.push(`\n  ${c.dim}Run: :play <name> [environment]${c.reset}`);
  return lines.join("\n");
}

/**
 * Execute a playbook step by step.
 */
export async function runPlaybook(
  playbook: Playbook,
  environment?: string,
  options: { dryRun?: boolean } = {}
): Promise<PlaybookResult> {
  const env = environment ?? "dev";
  const isRemote = env !== "local";

  console.log(`\n${c.bold}${c.cyan}Playbook: ${playbook.name}${c.reset}`);
  console.log(`${c.dim}${playbook.description}${c.reset}`);
  console.log(`${c.dim}Target: ${env} | ${playbook.steps.length} steps${c.reset}\n`);

  const result: PlaybookResult = {
    name: playbook.name,
    environment: env,
    steps: [],
    totalDurationMs: 0,
  };

  const totalStart = Date.now();

  for (let i = 0; i < playbook.steps.length; i++) {
    const step = playbook.steps[i];
    const stepNum = `[${i + 1}/${playbook.steps.length}]`;

    console.log(`${c.cyan}${stepNum}${c.reset} ${step.label}...`);

    if (options.dryRun) {
      console.log(`  ${c.dim}$ ${step.command}${c.reset}\n`);
      result.steps.push({
        label: step.label,
        command: step.command,
        output: "[dry-run]",
        success: true,
        durationMs: 0,
      });
      continue;
    }

    const start = Date.now();
    try {
      const output = isRemote
        ? await runRemoteCommand(env, step.command)
        : await runLocalCommand(step.command);

      const duration = Date.now() - start;

      // Indent output
      const indented = output.trim().split("\n").map((l) => `  ${l}`).join("\n");
      console.log(`${indented}`);
      console.log(`  ${c.green}✓${c.reset} ${c.dim}(${duration}ms)${c.reset}\n`);

      result.steps.push({
        label: step.label,
        command: step.command,
        output: output.trim(),
        success: true,
        durationMs: duration,
      });
    } catch (err) {
      const duration = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);

      console.log(`  ${c.red}✗ ${msg.split("\n")[0]}${c.reset}`);
      console.log(`  ${c.dim}(${duration}ms)${c.reset}\n`);

      result.steps.push({
        label: step.label,
        command: step.command,
        output: msg,
        success: false,
        durationMs: duration,
      });
    }
  }

  result.totalDurationMs = Date.now() - totalStart;

  // Summary
  const passed = result.steps.filter((s) => s.success).length;
  const failed = result.steps.filter((s) => !s.success).length;
  const icon = failed === 0 ? `${c.green}✓${c.reset}` : `${c.yellow}⚠${c.reset}`;
  console.log(`${icon} ${c.bold}Playbook complete:${c.reset} ${passed} passed, ${failed} failed (${(result.totalDurationMs / 1000).toFixed(1)}s)`);

  return result;
}
