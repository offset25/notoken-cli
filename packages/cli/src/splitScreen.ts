/**
 * Split-Screen Terminal — fixed input at bottom, scrolling output above.
 *
 * Output from commands, background tasks, and notifications renders
 * above the input line. The input line stays fixed at the bottom.
 * User can always type without output mangling their input.
 *
 * Uses ANSI escape codes:
 *   - Save/restore cursor position
 *   - Scroll region (sets scrollable area above input)
 *   - Move cursor to input line
 */

const ESC = "\x1b";
const CSI = `${ESC}[`;

// ANSI helpers
const saveCursor = `${CSI}s`;
const restoreCursor = `${CSI}u`;
const clearLine = `${CSI}2K`;
const moveToCol1 = `${CSI}1G`;

function moveTo(row: number, col: number): string { return `${CSI}${row};${col}H`; }
function setScrollRegion(top: number, bottom: number): string { return `${CSI}${top};${bottom}r`; }
function scrollUp(): string { return `${ESC}D`; }

export class SplitScreen {
  private rows: number;
  private cols: number;
  private inputLine: number;
  private outputBuffer: string[] = [];
  private currentPrompt = "";
  private currentInput = "";
  private enabled = false;

  constructor() {
    this.rows = process.stdout.rows ?? 24;
    this.cols = process.stdout.columns ?? 80;
    this.inputLine = this.rows;

    // Track terminal resize
    process.stdout.on("resize", () => {
      this.rows = process.stdout.rows ?? 24;
      this.cols = process.stdout.columns ?? 80;
      if (this.enabled) this.setupRegions();
    });
  }

  /** Initialize split screen — call once at startup. */
  enable(): void {
    if (!process.stdout.isTTY) return; // No split screen in non-TTY
    this.enabled = true;
    this.setupRegions();
  }

  /** Restore normal terminal — call on exit. */
  disable(): void {
    if (!this.enabled) return;
    this.enabled = false;
    // Reset scroll region to full screen
    process.stdout.write(setScrollRegion(1, this.rows));
    process.stdout.write(moveTo(this.rows, 1));
  }

  private statusText = "";

  private setupRegions(): void {
    this.inputLine = this.rows - 1; // Input on second-to-last row
    // Scroll region: rows 1 to (rows-3) for output
    // Row (rows-2): separator
    // Row (rows-1): input
    // Row (rows): status bar
    process.stdout.write(setScrollRegion(1, this.rows - 3));
    this.drawSeparator();
    this.drawInputLine();
    this.drawStatusBar();
  }

  private drawSeparator(): void {
    process.stdout.write(saveCursor);
    process.stdout.write(moveTo(this.rows - 2, 1));
    process.stdout.write(`${CSI}2m${"─".repeat(this.cols)}${CSI}0m`);
    process.stdout.write(restoreCursor);
  }

  private drawInputLine(): void {
    process.stdout.write(saveCursor);
    process.stdout.write(moveTo(this.rows - 1, 1));
    process.stdout.write(clearLine);
    process.stdout.write(this.currentPrompt + this.currentInput);
    process.stdout.write(restoreCursor);
  }

  private drawStatusBar(): void {
    process.stdout.write(saveCursor);
    process.stdout.write(moveTo(this.rows, 1));
    process.stdout.write(clearLine);
    // Reverse video for status bar
    process.stdout.write(`${CSI}7m ${this.statusText.padEnd(this.cols - 1)}${CSI}0m`);
    process.stdout.write(restoreCursor);
  }

  /** Update the status bar at the bottom. */
  setStatus(text: string): void {
    this.statusText = text;
    if (this.enabled) this.drawStatusBar();
  }

  /** Write output to the scrolling area above the input line. */
  writeOutput(text: string): void {
    if (!this.enabled) {
      process.stdout.write(text);
      return;
    }

    // Save cursor, move to output area, write, restore
    const lines = text.split("\n");
    process.stdout.write(saveCursor);

    // Move to the bottom of the scroll region
    process.stdout.write(moveTo(this.rows - 3, 1));

    for (const line of lines) {
      // Scroll up and write each line
      process.stdout.write("\n" + line);
      this.outputBuffer.push(line);
    }

    // Keep buffer manageable
    if (this.outputBuffer.length > 1000) {
      this.outputBuffer = this.outputBuffer.slice(-500);
    }

    // Restore cursor to input line
    process.stdout.write(restoreCursor);
    this.drawInputLine();
  }

  /** Set the prompt text (shown at the input line). */
  setPrompt(prompt: string): void {
    this.currentPrompt = prompt;
    if (this.enabled) this.drawInputLine();
  }

  /** Update current input text (for display). */
  setInput(text: string): void {
    this.currentInput = text;
    if (this.enabled) this.drawInputLine();
  }

  /** Check if split screen is active. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Create a patched console.log that writes to the output area.
   * Original console.log would write to the input line and mangle it.
   */
  patchConsole(): { restore: () => void } {
    if (!this.enabled) return { restore: () => {} };

    const origLog = console.log;
    const origError = console.error;
    const origWarn = console.warn;
    const self = this;

    console.log = (...args: unknown[]) => {
      const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      self.writeOutput(text);
    };
    console.error = (...args: unknown[]) => {
      const text = args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ");
      self.writeOutput(text);
    };
    console.warn = console.error;

    return {
      restore: () => {
        console.log = origLog;
        console.error = origError;
        console.warn = origWarn;
      },
    };
  }
}

/** Singleton split screen instance. */
export const splitScreen = new SplitScreen();
