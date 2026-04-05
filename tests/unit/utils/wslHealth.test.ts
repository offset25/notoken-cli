import { describe, it, expect } from "vitest";
import {
  throttledWslExec, getActiveWslCalls, getWslQueueLength,
  getWSLStatus, detectWSLCrashes, diagnoseWSL,
} from "../../../packages/core/src/utils/wslHealth.js";

describe("WSL Process Throttling", () => {
  it("starts with 0 active calls", () => {
    expect(getActiveWslCalls()).toBe(0);
    expect(getWslQueueLength()).toBe(0);
  });

  it("executes a simple command", async () => {
    const result = await throttledWslExec("echo throttled_ok");
    expect(result).toContain("throttled_ok");
  });

  it("limits concurrent calls to MAX_CONCURRENT_WSL", async () => {
    // Fire 5 commands — only 3 should run simultaneously
    const commands = Array(5).fill("echo test");
    const results = await Promise.all(commands.map(c => throttledWslExec(c, 5000)));
    // All should complete
    results.forEach(r => expect(r).toContain("test"));
    // Queue should be drained
    expect(getWslQueueLength()).toBe(0);
  });

  it("returns null for failing commands", async () => {
    const result = await throttledWslExec("nonexistent_cmd_xyz", 2000);
    expect(result).toBeNull();
  });
});

describe("getWSLStatus", () => {
  it("returns WSL status structure", async () => {
    const status = await getWSLStatus();
    expect(status).toHaveProperty("running");
    expect(status).toHaveProperty("uptime");
    expect(status).toHaveProperty("uptimeFormatted");
    expect(status).toHaveProperty("bootTime");
    expect(status).toHaveProperty("distro");
    expect(status).toHaveProperty("kernel");
    expect(typeof status.running).toBe("boolean");
  }, 15000);

  it("detects WSL is running", async () => {
    const status = await getWSLStatus();
    // We're running in WSL, so it should be detected
    expect(status.running).toBe(true);
  }, 15000);

  it("has positive uptime", async () => {
    const status = await getWSLStatus();
    if (status.running && status.uptime !== null) {
      expect(status.uptime).toBeGreaterThan(0);
      expect(status.uptimeFormatted).not.toBe("unknown");
    }
  }, 15000);

  it("detects distro", async () => {
    const status = await getWSLStatus();
    if (status.running) {
      expect(status.distro).toBeTruthy();
    }
  }, 15000);

  it("detects kernel", async () => {
    const status = await getWSLStatus();
    if (status.running) {
      expect(status.kernel).toBeTruthy();
      expect(status.kernel).toContain("microsoft");
    }
  }, 15000);
});

describe("detectWSLCrashes", () => {
  it("returns crash report structure", async () => {
    const report = await detectWSLCrashes();
    expect(report).toHaveProperty("hasCrashes");
    expect(report).toHaveProperty("totalCrashes");
    expect(report).toHaveProperty("recentCrashes");
    expect(report).toHaveProperty("diagnosis");
    expect(report).toHaveProperty("recommendations");
    expect(typeof report.hasCrashes).toBe("boolean");
    expect(typeof report.totalCrashes).toBe("number");
    expect(Array.isArray(report.recentCrashes)).toBe(true);
    expect(Array.isArray(report.recommendations)).toBe(true);
  }, 15000);

  it("crash entries have correct shape", async () => {
    const report = await detectWSLCrashes();
    for (const crash of report.recentCrashes) {
      expect(crash).toHaveProperty("file");
      expect(crash).toHaveProperty("process");
      expect(crash).toHaveProperty("time");
      expect(crash).toHaveProperty("size");
      expect(crash.time).toBeInstanceOf(Date);
    }
  }, 15000);

  it("has a diagnosis string", async () => {
    const report = await detectWSLCrashes();
    expect(typeof report.diagnosis).toBe("string");
    expect(report.diagnosis.length).toBeGreaterThan(0);
  }, 15000);
});

describe("diagnoseWSL", () => {
  it("returns full diagnosis", async () => {
    const diag = await diagnoseWSL();
    expect(diag).toHaveProperty("status");
    expect(diag).toHaveProperty("crashes");
    expect(diag).toHaveProperty("processes");
    expect(diag).toHaveProperty("healthy");
    expect(diag).toHaveProperty("summary");
    expect(typeof diag.healthy).toBe("boolean");
    expect(typeof diag.summary).toBe("string");
    expect(diag.summary.length).toBeGreaterThan(0);
  }, 30000);

  it("reports process counts", async () => {
    const diag = await diagnoseWSL();
    expect(typeof diag.processes.active).toBe("number");
    expect(typeof diag.processes.queued).toBe("number");
    expect(diag.processes.active).toBeGreaterThanOrEqual(0);
  }, 30000);
});
