/**
 * Progress Reporter — emit live progress events from executors.
 *
 * Allows handlers to report step-by-step progress that gets
 * displayed in real-time to the user, even during background execution.
 *
 * Usage in a handler:
 *   reportProgress("Step 1/3: Checking ports...");
 *   reportProgress("Step 2/3: Scanning connections...");
 *   reportProgress("Step 3/3: Generating report...", 100);
 */

import { EventEmitter } from "node:events";

export interface ProgressEvent {
  taskId: number;
  intent: string;
  message: string;
  percent?: number;    // 0-100
  step?: number;
  totalSteps?: number;
  timestamp: number;
}

class ProgressReporterClass extends EventEmitter {
  private currentTaskId = 0;
  private currentIntent = "";

  /** Set the current task context for progress reports. */
  setContext(taskId: number, intent: string): void {
    this.currentTaskId = taskId;
    this.currentIntent = intent;
  }

  /** Report progress from inside a handler. */
  report(message: string, opts?: { percent?: number; step?: number; totalSteps?: number }): void {
    const event: ProgressEvent = {
      taskId: this.currentTaskId,
      intent: this.currentIntent,
      message,
      percent: opts?.percent,
      step: opts?.step,
      totalSteps: opts?.totalSteps,
      timestamp: Date.now(),
    };
    this.emit("progress", event);
  }

  /** Convenience: report a numbered step. */
  step(current: number, total: number, message: string): void {
    this.report(`Step ${current}/${total}: ${message}`, {
      step: current,
      totalSteps: total,
      percent: Math.round((current / total) * 100),
    });
  }

  /** Report completion. */
  done(message?: string): void {
    this.report(message ?? "Done", { percent: 100 });
  }
}

/** Singleton progress reporter. */
export const progressReporter = new ProgressReporterClass();

/**
 * Convenience function for handlers to report progress.
 * Import this in executor.ts handlers.
 */
export function reportProgress(message: string, opts?: { percent?: number; step?: number; totalSteps?: number }): void {
  progressReporter.report(message, opts);
}

export function reportStep(current: number, total: number, message: string): void {
  progressReporter.step(current, total, message);
}
