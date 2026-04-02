import { EventEmitter } from "node:events";
import type { DynamicIntent } from "../types/intent.js";

export type TaskStatus = "pending" | "running" | "completed" | "failed" | "cancelled";

export interface BackgroundTask {
  id: number;
  rawText: string;
  intent: DynamicIntent;
  status: TaskStatus;
  startedAt: Date;
  completedAt?: Date;
  result?: string;
  error?: string;
  /** If true, the user has seen the completion notification */
  acknowledged: boolean;
}

/**
 * TaskRunner — manages background execution of CLI commands.
 *
 * Emits events:
 *   "task:started"   (task)
 *   "task:completed"  (task)
 *   "task:failed"     (task)
 *
 * The interactive REPL listens to these events and prints
 * notifications between prompts.
 */
export class TaskRunner extends EventEmitter {
  private tasks: Map<number, BackgroundTask> = new Map();
  private nextId = 1;
  private maxConcurrent: number;
  private runningCount = 0;
  private queue: Array<{ task: BackgroundTask; executor: () => Promise<string> }> = [];

  constructor(maxConcurrent = 5) {
    super();
    this.maxConcurrent = maxConcurrent;
  }

  /**
   * Submit a task for background execution.
   * Returns the task ID immediately.
   */
  submit(
    rawText: string,
    intent: DynamicIntent,
    executor: () => Promise<string>
  ): BackgroundTask {
    const task: BackgroundTask = {
      id: this.nextId++,
      rawText,
      intent,
      status: "pending",
      startedAt: new Date(),
      acknowledged: false,
    };

    this.tasks.set(task.id, task);

    if (this.runningCount < this.maxConcurrent) {
      this.run(task, executor);
    } else {
      this.queue.push({ task, executor });
      this.emit("task:queued", task);
    }

    return task;
  }

  private async run(task: BackgroundTask, executor: () => Promise<string>): Promise<void> {
    task.status = "running";
    this.runningCount++;
    this.emit("task:started", task);

    try {
      const result = await executor();
      task.status = "completed";
      task.result = result;
      task.completedAt = new Date();
      this.emit("task:completed", task);
    } catch (err) {
      task.status = "failed";
      task.error = err instanceof Error ? err.message : String(err);
      task.completedAt = new Date();
      this.emit("task:failed", task);
    } finally {
      this.runningCount--;
      this.drainQueue();
    }
  }

  private drainQueue(): void {
    while (this.queue.length > 0 && this.runningCount < this.maxConcurrent) {
      const next = this.queue.shift()!;
      this.run(next.task, next.executor);
    }
  }

  /** Cancel a pending or running task (best-effort). */
  cancel(id: number): boolean {
    const task = this.tasks.get(id);
    if (!task) return false;

    if (task.status === "pending") {
      task.status = "cancelled";
      task.completedAt = new Date();
      this.queue = this.queue.filter((q) => q.task.id !== id);
      return true;
    }

    // Running tasks can't truly be cancelled without AbortController,
    // but we mark them so the user knows.
    if (task.status === "running") {
      task.status = "cancelled";
      task.completedAt = new Date();
      return true;
    }

    return false;
  }

  /** Get a task by ID. */
  get(id: number): BackgroundTask | undefined {
    return this.tasks.get(id);
  }

  /** List all tasks, optionally filtered by status. */
  list(filter?: TaskStatus): BackgroundTask[] {
    const all = Array.from(this.tasks.values());
    return filter ? all.filter((t) => t.status === filter) : all;
  }

  /** Get tasks that completed since the user last checked. */
  getUnacknowledged(): BackgroundTask[] {
    return Array.from(this.tasks.values()).filter(
      (t) => !t.acknowledged && (t.status === "completed" || t.status === "failed")
    );
  }

  /** Mark a task as seen by the user. */
  acknowledge(id: number): void {
    const task = this.tasks.get(id);
    if (task) task.acknowledged = true;
  }

  /** Acknowledge all completed tasks. */
  acknowledgeAll(): void {
    for (const task of this.tasks.values()) {
      if (task.status === "completed" || task.status === "failed") {
        task.acknowledged = true;
      }
    }
  }

  /** Clear completed/failed/cancelled tasks from the list. */
  prune(): number {
    let pruned = 0;
    for (const [id, task] of this.tasks.entries()) {
      if (task.status === "completed" || task.status === "failed" || task.status === "cancelled") {
        this.tasks.delete(id);
        pruned++;
      }
    }
    return pruned;
  }

  /** How many tasks are currently running? */
  get active(): number {
    return this.runningCount;
  }

  /** How many tasks are in the queue? */
  get queued(): number {
    return this.queue.length;
  }
}

/** Singleton instance used by the interactive CLI. */
export const taskRunner = new TaskRunner();
