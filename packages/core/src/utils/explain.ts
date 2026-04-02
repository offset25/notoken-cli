/**
 * Explain mode.
 *
 * Shows WHY a command was chosen, what alternatives exist,
 * what could go wrong, and the full decision chain.
 */

import type { ParsedCommand } from "../types/intent.js";
import { getIntentDef } from "./config.js";
import { classifyMulti } from "../nlp/multiClassifier.js";
import { detectLocalPlatform } from "./platform.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};

export function formatExplain(parsed: ParsedCommand, rawText: string): string {
  const { intent } = parsed;
  const def = getIntentDef(intent.intent);
  const lines: string[] = [];

  lines.push(`${c.bold}${c.magenta}── Explain ──${c.reset}\n`);

  // 1. What was understood
  lines.push(`${c.bold}What I understood:${c.reset}`);
  lines.push(`  Input: "${rawText}"`);
  lines.push(`  Intent: ${c.cyan}${intent.intent}${c.reset} (${(intent.confidence * 100).toFixed(0)}% confidence)`);
  if (def) {
    lines.push(`  Description: ${def.description}`);
  }

  // 2. Why this intent was chosen
  lines.push(`\n${c.bold}Why this intent:${c.reset}`);
  const multi = classifyMulti(rawText);

  if (multi.votes.length > 0) {
    // Group by classifier
    const byClassifier = new Map<string, typeof multi.votes>();
    for (const v of multi.votes) {
      const list = byClassifier.get(v.classifier) ?? [];
      list.push(v);
      byClassifier.set(v.classifier, list);
    }

    for (const [classifier, votes] of byClassifier) {
      const top = votes.sort((a, b) => b.confidence - a.confidence)[0];
      const weight = { synonym: "1.0x", semantic: "0.8x", context: "0.6x", fuzzy: "0.5x" }[classifier] ?? "?";
      lines.push(`  ${c.cyan}${classifier}${c.reset} (${weight}): ${top.intent} — ${top.reason}`);
    }
  }

  if (multi.ambiguous) {
    lines.push(`  ${c.yellow}⚠ Ambiguous — top intents scored similarly. May benefit from rephrasing.${c.reset}`);
  }

  // 3. Alternatives considered
  if (multi.scores.length > 1) {
    lines.push(`\n${c.bold}Alternatives considered:${c.reset}`);
    for (const s of multi.scores.slice(1, 4)) {
      const altDef = getIntentDef(s.intent);
      lines.push(`  ${c.dim}${s.intent}${c.reset} (${(s.score * 100).toFixed(0)}%) — ${altDef?.description ?? "unknown"}`);
    }
  }

  // 4. Fields extracted
  const fields = Object.entries(intent.fields).filter(([, v]) => v !== undefined && v !== "");
  if (fields.length > 0) {
    lines.push(`\n${c.bold}Fields extracted:${c.reset}`);
    for (const [key, value] of fields) {
      const fieldDef = def?.fields[key];
      const src = wasExplicit(rawText, String(value)) ? "from input" : "default";
      lines.push(`  ${key}: ${c.bold}${value}${c.reset} ${c.dim}(${fieldDef?.type ?? "?"}, ${src})${c.reset}`);
    }
  }

  if (parsed.missingFields.length > 0) {
    lines.push(`  ${c.yellow}Missing: ${parsed.missingFields.join(", ")}${c.reset}`);
  }

  // 5. What will happen
  if (def) {
    lines.push(`\n${c.bold}What will happen:${c.reset}`);
    lines.push(`  Execution: ${def.execution === "local" ? "runs locally" : "runs via SSH"}`);
    lines.push(`  Risk: ${formatRisk(def.riskLevel)}`);
    lines.push(`  Confirmation: ${def.requiresConfirmation ? "yes (will ask)" : "no"}`);

    // Command preview
    let cmd = def.command;
    for (const [k, v] of fields) {
      if (v !== undefined) cmd = cmd.replaceAll(`{{${k}}}`, String(v));
    }
    cmd = cmd.replace(/\{\{[a-zA-Z_]+\}\}/g, "").trim();
    if (cmd.length <= 120) {
      lines.push(`  Command: ${c.dim}${cmd}${c.reset}`);
    } else {
      lines.push(`  Command: ${c.dim}${cmd.slice(0, 117)}...${c.reset}`);
    }

    if (def.allowlist && def.allowlist.length > 0) {
      lines.push(`  Allowlist: ${def.allowlist.join(", ")}`);
    }
  }

  // 6. What could go wrong
  lines.push(`\n${c.bold}What could go wrong:${c.reset}`);
  const risks = getKnownRisks(intent.intent, intent.fields);
  if (risks.length > 0) {
    for (const risk of risks) {
      lines.push(`  ${c.yellow}⚠${c.reset} ${risk}`);
    }
  } else {
    lines.push(`  ${c.green}Low risk — read-only or safe operation.${c.reset}`);
  }

  // 7. Platform context
  const platform = detectLocalPlatform();
  lines.push(`\n${c.bold}Platform:${c.reset}`);
  lines.push(`  ${platform.distro}${platform.isWSL ? " (WSL)" : ""} | ${platform.packageManager} | ${platform.initSystem}`);

  return lines.join("\n");
}

function wasExplicit(rawText: string, value: string): boolean {
  return rawText.toLowerCase().includes(value.toLowerCase());
}

function formatRisk(level: string): string {
  if (level === "high") return `${c.red}HIGH${c.reset} — destructive, requires confirmation`;
  if (level === "medium") return `${c.yellow}MEDIUM${c.reset} — modifies state`;
  return `${c.green}LOW${c.reset} — read-only or safe`;
}

function getKnownRisks(intentName: string, fields: Record<string, unknown>): string[] {
  const risks: string[] = [];
  const env = fields.environment as string;

  if (env === "prod") {
    risks.push("Running on PRODUCTION — ensure this is intentional.");
  }

  if (intentName.includes("restart") || intentName.includes("stop")) {
    risks.push("Service will be temporarily unavailable during restart.");
  }
  if (intentName.includes("remove") || intentName.includes("delete") || intentName.includes("prune")) {
    risks.push("Data will be permanently deleted. Auto-backup runs first if enabled.");
  }
  if (intentName.includes("deploy")) {
    risks.push("Deployment may affect live users. Rollback available if it fails.");
  }
  if (intentName.includes("chmod") || intentName.includes("chown")) {
    risks.push("Permission changes can lock you out if applied incorrectly.");
  }
  if (intentName.includes("reboot") || intentName.includes("shutdown")) {
    risks.push("Server will be unreachable during reboot. Ensure you have console access.");
  }
  if (intentName === "docker.prune") {
    risks.push("Removes ALL unused containers, images, and volumes. Data in unnamed volumes is lost.");
  }
  if (intentName === "git.reset") {
    risks.push("May discard uncommitted changes. Ensure work is saved.");
  }

  return risks;
}
