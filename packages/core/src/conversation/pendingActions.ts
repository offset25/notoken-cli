/**
 * Pending Actions.
 *
 * Tracks suggestions NoToken makes so when the user says
 * "ok", "try that", "do it", "run it", "yes" — it knows what to execute.
 *
 * Examples:
 *   NoToken: "✓ Installed. Start: notoken start stable-diffusion"
 *   User: "ok try it"
 *   → executes "notoken start stable-diffusion"
 *
 *   NoToken: "Update available: 1.5.0 → 1.7.0"
 *   User: "yes do it"
 *   → executes update
 */

export interface PendingAction {
  /** What to execute — either an intent name or a raw command */
  action: string;
  /** Human description */
  description: string;
  /** Type: intent to parse, or command to run directly */
  type: "intent" | "command";
  /** When it was suggested (auto-set by suggestAction) */
  timestamp?: number;
  /** The raw text/fields for the intent */
  fields?: Record<string, unknown>;
}

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const PENDING_FILE = resolve(process.env.NOTOKEN_HOME ?? resolve(homedir(), ".notoken"), "pending-actions.json");

// Persisted to disk so "try it" works across CLI invocations
let pendingActions: PendingAction[] = loadFromDisk();

function loadFromDisk(): PendingAction[] {
  try {
    if (existsSync(PENDING_FILE)) {
      return JSON.parse(readFileSync(PENDING_FILE, "utf-8"));
    }
  } catch {}
  return [];
}

function saveToDisk(): void {
  try {
    const dir = resolve(PENDING_FILE, "..");
    mkdirSync(dir, { recursive: true });
    writeFileSync(PENDING_FILE, JSON.stringify(pendingActions));
  } catch {}
}

/**
 * Store an action that NoToken is suggesting to the user.
 * Most recent is at the end.
 */
export function suggestAction(action: PendingAction): void {
  pendingActions.push({ ...action, timestamp: Date.now() });
  // Keep last 5
  if (pendingActions.length > 5) pendingActions = pendingActions.slice(-5);
  saveToDisk();
}

/**
 * Get the most recent pending action (if any, and if not too old).
 * Actions expire after 5 minutes.
 */
export function getLastPendingAction(): PendingAction | null {
  if (pendingActions.length === 0) return null;
  const last = pendingActions[pendingActions.length - 1];
  // Expire after 5 minutes
  if (Date.now() - (last.timestamp ?? 0) > 5 * 60 * 1000) return null;
  return last;
}

/**
 * Pop (consume) the last pending action.
 */
export function consumePendingAction(): PendingAction | null {
  const action = getLastPendingAction();
  if (action) {
    pendingActions.pop();
    saveToDisk();
  }
  return action;
}

/**
 * Check if user is giving a directive about the pending action.
 * E.g. "put it on F drive", "install it on D:", "no use /mnt/f"
 * Returns the resolved new text if yes, null otherwise.
 */
export function isRedirectingPendingAction(text: string): string | null {
  const pending = getLastPendingAction();
  if (!pending) return null;

  const normalized = text.toLowerCase().trim();

  // "put it on X", "install it on X", "no put it on X", "use X instead"
  const redirectPatterns = [
    /(?:put|install|place|move|set|store)\s+(?:it|that|this)\s+(?:on|in|at|to)\s+(.+)/i,
    /(?:no|nah|nope)\s*,?\s*(?:put|install|place|use|try)\s+(?:it\s+)?(?:on|in|at)?\s*(.+)/i,
    /(?:use|try)\s+(.+?)\s+instead/i,
    /(?:on|in|at)\s+(.+?)\s+(?:drive|folder|directory|instead)/i,
  ];

  for (const pattern of redirectPatterns) {
    const match = normalized.match(pattern);
    if (match) {
      const location = match[1].trim();
      // Re-form the pending action with the new location
      if (pending.action.includes("install") || pending.action.includes("generate")) {
        return `${pending.action} on ${location}`;
      }
      return `install stable diffusion on ${location}`;
    }
  }

  return null;
}

/**
 * Check if user input is an affirmation to execute a pending action.
 */
export function isAffirmation(text: string): boolean {
  const normalized = text.toLowerCase().trim();
  const affirmations = [
    "ok", "okay", "yes", "yeah", "yep", "sure", "go", "go ahead",
    "do it", "run it", "try it", "try that", "run that", "do that",
    "execute it", "execute that", "start it", "start that",
    "ok do it", "ok run it", "ok try it", "yes do it", "yes run it",
    "ok go", "go for it", "let's do it", "lets do it", "lets go",
    "proceed", "continue", "confirm", "approve", "yea",
    "ok try that", "ok run that", "ok do that",
    "sure thing", "sounds good", "go on",
  ];
  return affirmations.includes(normalized);
}

/**
 * Clear all pending actions.
 */
export function clearPendingActions(): void {
  pendingActions = [];
  saveToDisk();
}
