/**
 * Session summary generator.
 *
 * Reads conversation turns from ~/.notoken/conversations/ and generates
 * summaries of what was done in each session.
 *
 * Used by:
 * - Desktop app dashboard session card
 * - :sessions command in CLI
 * - Exit summary
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const CONVERSATIONS_ROOT = resolve(homedir(), ".notoken", "conversations");

export interface SessionSummary {
  id: string;
  folder: string;
  startedAt: string;
  endedAt: string;
  turns: number;
  commands: string[];
  intents: string[];
  entities: string[];
  errors: number;
  highlights: string[];
}

/**
 * Get summaries for recent sessions across all folders.
 */
export function getRecentSessions(limit = 20): SessionSummary[] {
  const sessions: SessionSummary[] = [];

  if (!existsSync(CONVERSATIONS_ROOT)) return sessions;

  // Walk all folder subdirectories
  try {
    const walkDir = (dir: string) => {
      const entries = readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = resolve(dir, entry.name);
        if (entry.isDirectory()) {
          walkDir(full);
        } else if (entry.name.endsWith(".json")) {
          try {
            const conv = JSON.parse(readFileSync(full, "utf-8"));
            if (conv.turns && conv.turns.length > 0) {
              sessions.push(summarizeConversation(conv, dir));
            }
          } catch {}
        }
      }
    };
    walkDir(CONVERSATIONS_ROOT);
  } catch {}

  // Sort by most recent first
  sessions.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  return sessions.slice(0, limit);
}

/**
 * Get sessions for a specific folder.
 */
export function getSessionsForFolder(folder: string, limit = 10): SessionSummary[] {
  const safePath = folder.replace(/[^a-zA-Z0-9_\-\/]/g, "_").replace(/^\/+/, "");
  const dir = resolve(CONVERSATIONS_ROOT, safePath || "default");

  if (!existsSync(dir)) return [];

  const sessions: SessionSummary[] = [];
  const files = readdirSync(dir).filter(f => f.endsWith(".json")).sort().reverse();

  for (const file of files.slice(0, limit)) {
    try {
      const conv = JSON.parse(readFileSync(resolve(dir, file), "utf-8"));
      if (conv.turns && conv.turns.length > 0) {
        sessions.push(summarizeConversation(conv, folder));
      }
    } catch {}
  }

  return sessions;
}

function summarizeConversation(conv: Record<string, unknown>, folder: string): SessionSummary {
  const turns = conv.turns as Array<Record<string, unknown>> ?? [];
  const userTurns = turns.filter(t => t.role === "user");
  const systemTurns = turns.filter(t => t.role === "system");

  // Extract unique intents
  const intents = [...new Set(userTurns.map(t => t.intent as string).filter(Boolean))];

  // Extract commands (raw text of user turns)
  const commands = userTurns.map(t => t.rawText as string).filter(Boolean);

  // Extract entities from knowledge tree
  const knowledgeTree = conv.knowledgeTree as Array<Record<string, unknown>> ?? [];
  const entities = knowledgeTree.map(e => `${e.entity} (${e.type})`);

  // Count errors
  const errors = systemTurns.filter(t => t.error).length;

  // Generate highlights — most interesting things that happened
  const highlights: string[] = [];

  if (intents.includes("service.restart")) highlights.push("Restarted services");
  if (intents.includes("deploy.run")) highlights.push("Deployed");
  if (intents.includes("deploy.rollback")) highlights.push("Rolled back deploy");
  if (intents.some(i => i.startsWith("docker."))) highlights.push("Docker operations");
  if (intents.some(i => i.startsWith("git."))) highlights.push("Git operations");
  if (intents.some(i => i.startsWith("security."))) highlights.push("Security checks");
  if (intents.includes("server.check_disk")) highlights.push("Disk check");
  if (intents.includes("server.check_memory")) highlights.push("Memory check");
  if (intents.some(i => i.startsWith("logs."))) highlights.push("Log inspection");
  if (intents.some(i => i.startsWith("file."))) highlights.push("File operations");
  if (intents.some(i => i.startsWith("db."))) highlights.push("Database operations");
  if (intents.some(i => i.startsWith("backup."))) highlights.push("Backup operations");
  if (errors > 0) highlights.push(`${errors} error(s)`);

  // If no specific highlights, summarize by count
  if (highlights.length === 0 && intents.length > 0) {
    highlights.push(`${intents.length} different operations`);
  }

  return {
    id: conv.id as string ?? "unknown",
    folder,
    startedAt: conv.createdAt as string ?? "",
    endedAt: conv.updatedAt as string ?? "",
    turns: turns.length,
    commands: commands.slice(0, 10),
    intents,
    entities: entities.slice(0, 10),
    errors,
    highlights,
  };
}

/**
 * Format a session summary for display.
 */
export function formatSessionSummary(session: SessionSummary): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m" };

  const ago = timeAgo(session.startedAt);
  const duration = timeBetween(session.startedAt, session.endedAt);
  const errorTag = session.errors > 0 ? ` ${c.red}(${session.errors} errors)${c.reset}` : "";

  const lines: string[] = [];
  lines.push(`${c.bold}${ago}${c.reset} — ${duration}${errorTag}`);
  lines.push(`${c.dim}${session.folder} | ${session.turns} turns | ${session.id}${c.reset}`);

  if (session.highlights.length > 0) {
    lines.push(`${c.cyan}${session.highlights.join(" · ")}${c.reset}`);
  }

  if (session.commands.length > 0) {
    lines.push(`${c.dim}Commands: ${session.commands.slice(0, 5).join(", ")}${session.commands.length > 5 ? "..." : ""}${c.reset}`);
  }

  return lines.join("\n");
}

/**
 * Format multiple sessions as a list.
 */
export function formatSessionList(sessions: SessionSummary[]): string {
  if (sessions.length === 0) return "\x1b[2mNo sessions found.\x1b[0m";

  return sessions.map((s, i) => {
    const sep = i < sessions.length - 1 ? "\n" : "";
    return `  ${formatSessionSummary(s)}${sep}`;
  }).join("\n");
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "Just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 7) return `${days}d ago`;
  return new Date(dateStr).toLocaleDateString();
}

function timeBetween(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "<1m";
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  return `${Math.floor(hours / 24)}d`;
}
