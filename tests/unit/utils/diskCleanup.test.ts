import { describe, it, expect, vi } from "vitest";
import { formatCleanupTable, type CleanupTarget } from "../../../packages/core/src/utils/diskCleanup.js";

function makeTarget(overrides: Partial<CleanupTarget> = {}): CleanupTarget {
  return {
    name: "npm cache",
    path: "/home/user/.npm",
    sizeGB: 2.5,
    safe: true,
    description: "Cached package downloads",
    cleanCommand: "npm cache clean --force",
    ...overrides,
  };
}

describe("formatCleanupTable", () => {
  it("returns no-space message for empty targets", () => {
    const result = formatCleanupTable([]);
    expect(result).toContain("No significant reclaimable space");
  });

  it("renders table with targets", () => {
    const targets = [
      makeTarget({ name: "npm cache", sizeGB: 5.58 }),
      makeTarget({ name: "Temp files", sizeGB: 2.06, description: "Temporary files" }),
    ];
    const result = formatCleanupTable(targets);
    expect(result).toContain("Disk Cleanup Scan");
    expect(result).toContain("npm cache");
    expect(result).toContain("Temp files");
    expect(result).toContain("5.58 GB");
    expect(result).toContain("2.06 GB");
  });

  it("shows total reclaimable space", () => {
    const targets = [
      makeTarget({ sizeGB: 3.0 }),
      makeTarget({ name: "Temp", sizeGB: 1.5 }),
    ];
    const result = formatCleanupTable(targets);
    expect(result).toContain("4.50 GB");
  });

  it("shows MB for small targets", () => {
    const targets = [makeTarget({ sizeGB: 0.15 })];
    const result = formatCleanupTable(targets);
    expect(result).toContain("154 MB");
  });

  it("highlights large targets in yellow", () => {
    const targets = [makeTarget({ sizeGB: 5.0 })];
    const result = formatCleanupTable(targets);
    // Yellow ANSI code is \x1b[33m
    expect(result).toContain("\x1b[33m");
  });
});

describe("CleanupTarget structure", () => {
  it("has required fields", () => {
    const target = makeTarget();
    expect(target.name).toBeDefined();
    expect(target.path).toBeDefined();
    expect(target.sizeGB).toBeGreaterThanOrEqual(0);
    expect(target.cleanCommand).toBeDefined();
    expect(target.description).toBeDefined();
    expect(typeof target.safe).toBe("boolean");
  });
});
