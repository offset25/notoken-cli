/**
 * Terminal spinner, progress bar, and animation utilities.
 * Zero external dependencies -- uses ANSI escape codes directly.
 * Requires Node 18+.
 */

// ---------------------------------------------------------------------------
// ANSI helpers
// ---------------------------------------------------------------------------

const ESC = "\x1b[";
const HIDE_CURSOR = `${ESC}?25l`;
const SHOW_CURSOR = `${ESC}?25h`;
const ERASE_LINE = `${ESC}2K`;
const MOVE_TO_COL1 = `\r`;
const RESET = `${ESC}0m`;
const CYAN = `${ESC}36m`;
const GREEN = `${ESC}32m`;
const RED = `${ESC}31m`;

// ---------------------------------------------------------------------------
// Spinner
// ---------------------------------------------------------------------------

const FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;
const INTERVAL_MS = 80;

export class Spinner {
  private frameIndex = 0;
  private timer: ReturnType<typeof setInterval> | null = null;
  private message = "";
  private stream: NodeJS.WriteStream = process.stderr;

  /**
   * Start the spinner with an initial message.
   * If the spinner is already running it will be updated in-place.
   */
  start(message: string): this {
    if (this.timer) {
      this.update(message);
      return this;
    }

    this.message = message;
    this.frameIndex = 0;

    this.stream.write(HIDE_CURSOR);
    this.timer = setInterval(() => {
      this.render();
    }, INTERVAL_MS);

    // Render the first frame immediately so there is no 80 ms gap.
    this.render();
    return this;
  }

  /** Change the message while the spinner keeps running. */
  update(message: string): this {
    this.message = message;
    return this;
  }

  /** Stop with a green checkmark and a final message. */
  succeed(message?: string): void {
    this.stopWith(`${GREEN}✔${RESET}`, message ?? this.message);
  }

  /** Stop with a red cross and a final message. */
  fail(message?: string): void {
    this.stopWith(`${RED}✖${RESET}`, message ?? this.message);
  }

  /** Stop the spinner and clear its line. */
  stop(): void {
    this.clearTimer();
    this.clearLine();
    this.stream.write(SHOW_CURSOR);
  }

  // -----------------------------------------------------------------------
  // Private helpers
  // -----------------------------------------------------------------------

  private render(): void {
    const frame = FRAMES[this.frameIndex % FRAMES.length];
    this.frameIndex++;
    this.clearLine();
    this.stream.write(`${CYAN}${frame}${RESET} ${this.message}`);
  }

  private clearLine(): void {
    this.stream.write(`${MOVE_TO_COL1}${ERASE_LINE}`);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }

  private stopWith(symbol: string, message: string): void {
    this.clearTimer();
    this.clearLine();
    this.stream.write(`${symbol} ${message}\n`);
    this.stream.write(SHOW_CURSOR);
  }
}

// ---------------------------------------------------------------------------
// withSpinner wrapper
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper that starts a spinner, awaits an async function, and
 * automatically calls `succeed` or `fail` depending on the outcome.
 *
 * @returns The resolved value of `fn`.
 *
 * ```ts
 * const data = await withSpinner("Fetching data…", async (spinner) => {
 *   const res = await fetch(url);
 *   spinner.update("Parsing response…");
 *   return res.json();
 * });
 * ```
 */
export async function withSpinner<T>(
  message: string,
  fn: (spinner: Spinner) => Promise<T>,
): Promise<T> {
  const spinner = new Spinner();
  spinner.start(message);
  try {
    const result = await fn(spinner);
    spinner.succeed();
    return result;
  } catch (error) {
    const errMsg =
      error instanceof Error ? error.message : String(error);
    spinner.fail(`${message} — ${errMsg}`);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Progress bar
// ---------------------------------------------------------------------------

/**
 * Returns a string representing a progress bar, e.g.:
 *
 *     [████████░░░░░░░░░░░░] 40%
 *
 * @param current  Current progress value (0 … total).
 * @param total    Value that represents 100%.
 * @param width    Character width of the bar (default 30).
 */
export function progressBar(
  current: number,
  total: number,
  width = 30,
): string {
  const ratio = total === 0 ? 0 : Math.min(Math.max(current / total, 0), 1);
  const filled = Math.round(ratio * width);
  const empty = width - filled;
  const pct = Math.round(ratio * 100);

  return `[${GREEN}${"█".repeat(filled)}${RESET}${"░".repeat(empty)}] ${pct}%`;
}
