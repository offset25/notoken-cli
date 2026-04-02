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

// In-memory store — per session, no persistence needed
let pendingActions: PendingAction[] = [];

/**
 * Store an action that NoToken is suggesting to the user.
 * Most recent is at the end.
 */
export function suggestAction(action: PendingAction): void {
  pendingActions.push({ ...action, timestamp: Date.now() });
  // Keep last 5
  if (pendingActions.length > 5) pendingActions = pendingActions.slice(-5);
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
  if (action) pendingActions.pop();
  return action;
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
}
