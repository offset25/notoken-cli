import type { ParsedCommand, IntentDef } from "../types/intent.js";
import { getIntentDef } from "./config.js";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
  white: "\x1b[37m",
};

const RISK_COLOR: Record<string, string> = {
  low: c.green,
  medium: c.yellow,
  high: c.red,
};

/**
 * Generate a verbose, human-friendly restatement of the parsed command.
 *
 * Example output:
 *
 *   I understand you want to:
 *     Action:      restart nginx
 *     Environment: prod
 *     Risk:        high — confirmation required
 *     Command:     sudo systemctl restart nginx && ...
 */
export function formatVerbose(parsed: ParsedCommand): string {
  const { intent } = parsed;
  const def = getIntentDef(intent.intent);

  const lines: string[] = [];

  lines.push(`${c.bold}I understand you want to:${c.reset}`);
  lines.push("");

  // Action description
  if (def) {
    lines.push(`  ${c.cyan}Action:${c.reset}      ${def.description}`);
  }
  lines.push(`  ${c.cyan}Intent:${c.reset}      ${c.bold}${intent.intent}${c.reset}`);
  lines.push(`  ${c.cyan}Confidence:${c.reset}  ${formatConfidence(intent.confidence)}`);

  // Fields
  // Fields — show explicit values, skip internal/empty ones
  const fields = Object.entries(intent.fields).filter(
    ([k, v]) => v !== undefined && v !== "" && k !== "logPath"
  );
  if (fields.length > 0) {
    lines.push("");
    for (const [key, value] of fields) {
      const label = key.charAt(0).toUpperCase() + key.slice(1);
      lines.push(`  ${c.cyan}${label}:${c.reset}${" ".repeat(Math.max(1, 12 - label.length))}${c.bold}${value}${c.reset}`);
    }
  }

  // Risk + confirmation
  if (def) {
    const riskColor = RISK_COLOR[def.riskLevel] ?? c.white;
    const confirm = def.requiresConfirmation ? " — confirmation required" : "";
    lines.push("");
    lines.push(`  ${c.cyan}Risk:${c.reset}        ${riskColor}${def.riskLevel}${confirm}${c.reset}`);
  }

  // Show the resolved command template
  if (def) {
    const command = previewCommand(def, intent.fields);
    if (command.length < 120) {
      lines.push(`  ${c.cyan}Command:${c.reset}     ${c.dim}${command}${c.reset}`);
    } else {
      lines.push(`  ${c.cyan}Command:${c.reset}     ${c.dim}${command.slice(0, 117)}...${c.reset}`);
    }
  }

  // Warnings
  if (parsed.needsClarification) {
    lines.push("");
    lines.push(`  ${c.yellow}⚠ Clarification needed${c.reset}`);
    if (parsed.missingFields.length > 0) {
      lines.push(`    Missing: ${parsed.missingFields.join(", ")}`);
    }
    for (const a of parsed.ambiguousFields) {
      lines.push(`    ${a.field}: did you mean ${a.candidates.join(" or ")}?`);
    }
  }

  return lines.join("\n");
}

function formatConfidence(conf: number): string {
  const pct = (conf * 100).toFixed(0);
  if (conf >= 0.8) return `${c.green}${pct}%${c.reset}`;
  if (conf >= 0.6) return `${c.yellow}${pct}%${c.reset}`;
  return `${c.red}${pct}%${c.reset}`;
}

function previewCommand(def: IntentDef, fields: Record<string, unknown>): string {
  let cmd = def.command;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      cmd = cmd.replaceAll(`{{${key}}}`, String(value));
    }
  }
  for (const [name, fieldDef] of Object.entries(def.fields)) {
    if (fieldDef.default !== undefined) {
      cmd = cmd.replaceAll(`{{${name}}}`, String(fieldDef.default));
    }
  }
  cmd = cmd.replace(/\{\{[a-zA-Z_]+\}\}/g, "").trim();
  return cmd;
}

/**
 * Format a background task notification.
 */
export function formatTaskNotification(
  id: number,
  name: string,
  status: "completed" | "failed",
  duration?: number
): string {
  const icon = status === "completed" ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`;
  const dur = duration ? ` (${(duration / 1000).toFixed(1)}s)` : "";
  return `\n${icon} ${c.dim}[bg #${id}]${c.reset} ${name} ${status}${dur}`;
}

/**
 * Format the background jobs list.
 */
export function formatJobsList(
  tasks: Array<{ id: number; rawText: string; status: string; startedAt: Date; completedAt?: Date }>
): string {
  if (tasks.length === 0) return `${c.dim}No background tasks.${c.reset}`;

  const lines: string[] = [];
  lines.push(`${c.bold}Background tasks:${c.reset}`);

  for (const t of tasks) {
    const statusColor =
      t.status === "running" ? c.cyan :
      t.status === "completed" ? c.green :
      t.status === "failed" ? c.red :
      c.yellow;

    const duration = t.completedAt
      ? `${((t.completedAt.getTime() - t.startedAt.getTime()) / 1000).toFixed(1)}s`
      : `${((Date.now() - t.startedAt.getTime()) / 1000).toFixed(0)}s...`;

    lines.push(
      `  ${c.dim}#${t.id}${c.reset} ${statusColor}${t.status.padEnd(10)}${c.reset} ${t.rawText} ${c.dim}(${duration})${c.reset}`
    );
  }

  return lines.join("\n");
}
