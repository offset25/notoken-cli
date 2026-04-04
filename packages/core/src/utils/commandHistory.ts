/**
 * Command History — persistent history with search.
 *
 * Stores every command typed in interactive mode.
 * Supports:
 *   - History file (~/.notoken/command-history.txt)
 *   - Search (Ctrl+R style fuzzy search)
 *   - Recent commands for suggestions
 *   - Dedup consecutive duplicates
 */

import { existsSync, readFileSync, appendFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const HISTORY_DIR = resolve(homedir(), ".notoken");
const HISTORY_FILE = resolve(HISTORY_DIR, "command-history.txt");
const MAX_HISTORY = 2000;

let _history: string[] | null = null;

/** Load history from disk. */
export function loadHistory(): string[] {
  if (_history) return _history;
  if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
  if (existsSync(HISTORY_FILE)) {
    _history = readFileSync(HISTORY_FILE, "utf-8")
      .split("\n")
      .filter(l => l.trim())
      .slice(-MAX_HISTORY);
  } else {
    _history = [];
  }
  return _history;
}

/** Add a command to history (dedup consecutive). */
export function addToHistory(command: string): void {
  const history = loadHistory();
  const trimmed = command.trim();
  if (!trimmed) return;
  // Don't add if it's the same as the last command
  if (history.length > 0 && history[history.length - 1] === trimmed) return;
  // Don't add meta commands
  if (trimmed.startsWith(":") || trimmed.startsWith("/")) return;

  history.push(trimmed);

  // Append to file
  try {
    appendFileSync(HISTORY_FILE, trimmed + "\n");
  } catch {}

  // Trim in memory if too long
  if (history.length > MAX_HISTORY) {
    _history = history.slice(-MAX_HISTORY);
  }
}

/** Search history with fuzzy matching. */
export function searchHistory(query: string, limit = 10): string[] {
  const history = loadHistory();
  const lower = query.toLowerCase();
  const matches: Array<{ cmd: string; score: number }> = [];

  for (let i = history.length - 1; i >= 0; i--) {
    const cmd = history[i];
    const cmdLower = cmd.toLowerCase();

    if (cmdLower.includes(lower)) {
      // Exact substring match — higher score for more recent
      const recency = (i / history.length) * 0.3; // 0-0.3
      const relevance = lower.length / cmdLower.length; // longer match = better
      matches.push({ cmd, score: 0.5 + recency + relevance * 0.2 });
    } else {
      // Check word overlap
      const queryWords = lower.split(/\s+/);
      const cmdWords = new Set(cmdLower.split(/\s+/));
      const overlap = queryWords.filter(w => cmdWords.has(w)).length;
      if (overlap > 0) {
        const score = (overlap / queryWords.length) * 0.4 + (i / history.length) * 0.2;
        matches.push({ cmd, score });
      }
    }
  }

  // Dedup and sort by score
  const seen = new Set<string>();
  return matches
    .sort((a, b) => b.score - a.score)
    .filter(m => { if (seen.has(m.cmd)) return false; seen.add(m.cmd); return true; })
    .slice(0, limit)
    .map(m => m.cmd);
}

/** Get the N most recent unique commands. */
export function getRecentCommands(limit = 10): string[] {
  const history = loadHistory();
  const seen = new Set<string>();
  const recent: string[] = [];

  for (let i = history.length - 1; i >= 0 && recent.length < limit; i--) {
    if (!seen.has(history[i])) {
      seen.add(history[i]);
      recent.push(history[i]);
    }
  }
  return recent;
}

/** Get history for readline (returns copy of array for rl.history). */
export function getReadlineHistory(): string[] {
  return [...loadHistory()].reverse();
}
