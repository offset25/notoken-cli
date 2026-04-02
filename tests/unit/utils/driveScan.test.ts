import { describe, it, expect } from "vitest";
import { formatDriveScan, type DriveInfo } from "../../../packages/core/src/utils/diskCleanup.js";

function makeDrive(overrides: Partial<DriveInfo> = {}): DriveInfo {
  return {
    device: "/dev/sda1",
    label: "",
    filesystem: "ext4",
    sizeGB: 100,
    usedGB: 45,
    freeGB: 55,
    usePct: 45,
    mount: "/",
    ...overrides,
  };
}

describe("formatDriveScan", () => {
  it("shows all drives with usage bars", async () => {
    const drives = [
      makeDrive({ device: "C:", label: "", filesystem: "NTFS", sizeGB: 447, usedGB: 431, freeGB: 16, usePct: 96, mount: "C:\\" }),
      makeDrive({ device: "D:", label: "Data", filesystem: "NTFS", sizeGB: 894, usedGB: 180, freeGB: 714, usePct: 20, mount: "D:\\" }),
    ];
    const result = await formatDriveScan(drives);
    expect(result).toContain("Drive Analysis");
    expect(result).toContain("C:");
    expect(result).toContain("D:");
    expect(result).toContain("█");
    expect(result).toContain("96%");
  });

  it("flags critical drives", async () => {
    const drives = [
      makeDrive({ device: "C:", usePct: 97, mount: "C:\\" }),
    ];
    const result = await formatDriveScan(drives);
    expect(result).toContain("CRITICAL");
    expect(result).toContain("critically full");
  });

  it("flags warning drives", async () => {
    const drives = [
      makeDrive({ device: "D:", usePct: 89, mount: "D:\\" }),
    ];
    const result = await formatDriveScan(drives);
    expect(result).toContain("WARNING");
    expect(result).toContain("approaching full");
  });

  it("shows healthy when all OK", async () => {
    const drives = [
      makeDrive({ device: "/dev/sda1", usePct: 30, mount: "/" }),
    ];
    const result = await formatDriveScan(drives);
    expect(result).toContain("OK");
    expect(result).toContain("All drives healthy");
  });

  it("shows drive labels", async () => {
    const drives = [
      makeDrive({ device: "E:", label: "BackupHDD", filesystem: "exFAT", usePct: 50, mount: "E:\\" }),
    ];
    const result = await formatDriveScan(drives);
    expect(result).toContain("BackupHDD");
    expect(result).toContain("exFAT");
  });

  it("sorts by usage descending", async () => {
    const drives = [
      makeDrive({ device: "F:", usePct: 10, mount: "F:\\" }),
      makeDrive({ device: "C:", usePct: 97, mount: "C:\\" }),
      makeDrive({ device: "D:", usePct: 50, mount: "D:\\" }),
    ];
    const result = await formatDriveScan(drives);
    const cPos = result.indexOf("C:");
    const dPos = result.indexOf("D:");
    const fPos = result.indexOf("F:");
    expect(cPos).toBeLessThan(dPos);
    expect(dPos).toBeLessThan(fPos);
  });

  it("suggests cleanup for critical drives", async () => {
    const drives = [
      makeDrive({ device: "C:", usePct: 98, mount: "C:\\" }),
    ];
    const result = await formatDriveScan(drives);
    expect(result).toContain("free up space");
  });
});

describe("DriveInfo structure", () => {
  it("has all required fields", () => {
    const drive = makeDrive();
    expect(drive.device).toBeDefined();
    expect(drive.sizeGB).toBeGreaterThan(0);
    expect(drive.usePct).toBeGreaterThanOrEqual(0);
    expect(drive.usePct).toBeLessThanOrEqual(100);
    expect(drive.mount).toBeDefined();
  });

  it("math is consistent", () => {
    const drive = makeDrive({ sizeGB: 100, usedGB: 60, freeGB: 40, usePct: 60 });
    expect(drive.usedGB + drive.freeGB).toBe(drive.sizeGB);
  });
});
