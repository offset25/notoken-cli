import { describe, it, expect, vi, beforeEach } from "vitest";
import { progressReporter, reportProgress, reportStep } from "../../../packages/core/src/utils/progressReporter.js";
import type { ProgressEvent } from "../../../packages/core/src/utils/progressReporter.js";

describe("progressReporter", () => {
  beforeEach(() => {
    progressReporter.removeAllListeners();
  });

  it('emits "progress" events', () => {
    const handler = vi.fn();
    progressReporter.on("progress", handler);
    progressReporter.report("Testing...");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("reportProgress sends correct event data", () => {
    const events: ProgressEvent[] = [];
    progressReporter.on("progress", (e: ProgressEvent) => events.push(e));
    reportProgress("Checking ports", { percent: 50 });
    expect(events.length).toBe(1);
    expect(events[0].message).toBe("Checking ports");
    expect(events[0].percent).toBe(50);
    expect(events[0].timestamp).toBeGreaterThan(0);
  });

  it("reportStep calculates percent correctly", () => {
    const events: ProgressEvent[] = [];
    progressReporter.on("progress", (e: ProgressEvent) => events.push(e));
    reportStep(2, 4, "Halfway there");
    expect(events[0].percent).toBe(50);
    expect(events[0].step).toBe(2);
    expect(events[0].totalSteps).toBe(4);
    expect(events[0].message).toContain("Step 2/4");
  });

  it("setContext sets taskId and intent", () => {
    const events: ProgressEvent[] = [];
    progressReporter.on("progress", (e: ProgressEvent) => events.push(e));
    progressReporter.setContext(42, "docker.restart");
    progressReporter.report("Restarting...");
    expect(events[0].taskId).toBe(42);
    expect(events[0].intent).toBe("docker.restart");
  });

  it("done() emits percent: 100", () => {
    const events: ProgressEvent[] = [];
    progressReporter.on("progress", (e: ProgressEvent) => events.push(e));
    progressReporter.done();
    expect(events[0].percent).toBe(100);
  });
});
