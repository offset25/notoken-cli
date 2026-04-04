/**
 * Timer / Reminders — lightweight in-process countdown timers.
 *
 * When a timer expires it pushes a message to `pendingNotifications`
 * so the next REPL tick can display it.
 */

export interface Timer {
  id: number;
  label: string;
  endsAt: number;          // epoch-ms
  timeout: NodeJS.Timeout;
}

let nextId = 1;
const timers = new Map<number, Timer>();

/** Messages ready for the REPL to display on next tick. */
export const pendingNotifications: string[] = [];

/** Start a countdown timer.  Returns the timer ID. */
export function startTimer(minutes: number, label?: string): number {
  const id = nextId++;
  const tag = label ?? `Timer #${id}`;
  const ms = minutes * 60_000;
  const endsAt = Date.now() + ms;

  const timeout = setTimeout(() => {
    timers.delete(id);
    pendingNotifications.push(`\x1b[33m⏰ ${tag} — ${minutes} min timer finished!\x1b[0m`);
  }, ms);

  // Allow the Node process to exit even if timers are running
  if (timeout.unref) timeout.unref();

  timers.set(id, { id, label: tag, endsAt, timeout });
  return id;
}

/** List active timers with remaining time. */
export function listTimers(): string {
  if (timers.size === 0) return "No active timers.";
  const lines: string[] = [];
  for (const t of timers.values()) {
    const remaining = Math.max(0, Math.ceil((t.endsAt - Date.now()) / 1000));
    const m = Math.floor(remaining / 60);
    const s = remaining % 60;
    lines.push(`  #${t.id}  ${t.label}  — ${m}m ${s}s remaining`);
  }
  return `Active timers:\n${lines.join("\n")}`;
}

/** Cancel a timer by ID. Returns true if found. */
export function cancelTimer(id: number): boolean {
  const t = timers.get(id);
  if (!t) return false;
  clearTimeout(t.timeout);
  timers.delete(id);
  return true;
}

/** Drain all pending notifications (caller should display them). */
export function drainNotifications(): string[] {
  return pendingNotifications.splice(0, pendingNotifications.length);
}
