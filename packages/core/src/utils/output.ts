import type { ParsedCommand } from "../types/intent.js";

export function formatParsedCommand(cmd: ParsedCommand): string {
  const lines: string[] = [];
  const { intent } = cmd;

  lines.push(`Intent:      ${intent.intent}`);
  lines.push(`Confidence:  ${(intent.confidence * 100).toFixed(0)}%`);

  // Show Computer: Local/Remote so user knows where the command runs
  const env = (intent.fields.environment as string) ?? "local";
  const isLocal = env === "local" || env === "localhost" || env === "dev";
  lines.push(`Computer:    ${isLocal ? "\x1b[32mLocal\x1b[0m" : `\x1b[36mRemote (${env})\x1b[0m`}`);

  const entries = Object.entries(intent.fields).filter(([, v]) => v !== undefined);
  if (entries.length > 0) {
    lines.push("Fields:");
    for (const [k, v] of entries) {
      lines.push(`  ${k}: ${v}`);
    }
  }

  if (cmd.missingFields.length > 0) {
    lines.push(`Missing:     ${cmd.missingFields.join(", ")}`);
  }

  if (cmd.ambiguousFields.length > 0) {
    lines.push("Ambiguous:");
    for (const a of cmd.ambiguousFields) {
      lines.push(`  ${a.field}: ${a.candidates.join(" | ")}`);
    }
  }

  if (cmd.needsClarification) {
    lines.push("=> Clarification needed before execution.");
  }

  return lines.join("\n");
}
