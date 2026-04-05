import { describe, it, expect, vi } from "vitest";
import { parseIntent } from "../../../src/nlp/parseIntent.js";
import { analyzeDisk, analyzeOutput } from "../../../src/utils/analysis.js";
import { formatCleanupTable, formatDriveScan, type CleanupTarget, type DriveInfo } from "../../../src/utils/diskCleanup.js";

// ─── Parse → Disambiguate pipeline for disk intents ─────────────────────────

describe("disk cleanup: parse pipeline", () => {
  it("routes 'free up space' to disk.cleanup", async () => {
    const result = await parseIntent("free up space");
    expect(result.intent.intent).toBe("disk.cleanup");
    expect(result.needsClarification).toBe(false);
  });

  it("routes 'disk full' to disk.cleanup", async () => {
    const result = await parseIntent("disk full");
    expect(result.intent.intent).toBe("disk.cleanup");
  });

  it("routes 'check disk' to server.check_disk (not cleanup)", async () => {
    const result = await parseIntent("check disk space");
    expect(result.intent.intent).toBe("server.check_disk");
  });

  it("routes 'find claude' to llm.find_claude", async () => {
    const result = await parseIntent("find claude");
    expect(result.intent.intent).toBe("llm.find_claude");
  });

  it("routes 'scan drives' to disk.scan", async () => {
    const result = await parseIntent("scan drives");
    expect(result.intent.intent).toBe("disk.scan");
  });

  it("routes 'what is eating space' to disk.scan", async () => {
    const result = await parseIntent("what is eating space");
    expect(result.intent.intent).toBe("disk.scan");
  });
});

// ─── Analysis pipeline: Linux df output ─────────────────────────────────────

describe("disk analysis: Linux df format", () => {
  const LINUX_DF = `Filesystem  Size  Used Avail Use% Mounted on
/dev/sda1   100G   45G   55G  45% /
/dev/sdb1   500G  497G   3G   99% /data
tmpfs       16G     0   16G   0% /tmp`;

  it("analyzeOutput routes to analyzeDisk for server.check_disk", () => {
    const result = analyzeOutput("server.check_disk", LINUX_DF, {});
    expect(result).toContain("Analysis");
    expect(result).toContain("CRITICAL");
    expect(result).toContain("/data");
  });

  it("suggests cleanup on critical disk (<5GB free)", () => {
    const result = analyzeDisk(LINUX_DF);
    expect(result).toContain("free up space");
  });

  it("finds partition for specific path", () => {
    const result = analyzeDisk(LINUX_DF, "/data/backups");
    expect(result).toContain("/data");
    expect(result).toContain("CRITICAL");
  });
});

// ─── Analysis pipeline: Windows df-compatible format ────────────────────────

describe("disk analysis: Windows df-compatible format", () => {
  const WINDOWS_DF = `Filesystem      Size  Used Avail Use% Mounted on
C:              446.6G 443.4G 3.2G  99% C:\\
D:              894.2G 880.7G 13.6G 98% D:\\
E:              1863G 1860.6G 2.4G  99% E:\\
F:              1863G 75.5G 1787.5G 4% F:\\`;

  it("parses all Windows drives", () => {
    const result = analyzeDisk(WINDOWS_DF);
    expect(result).toContain("C:\\");
    expect(result).toContain("E:\\");
  });

  it("flags C: and E: as critical (<5GB free)", () => {
    const result = analyzeDisk(WINDOWS_DF);
    expect(result).toContain("CRITICAL");
    expect(result).toContain("C:\\");
    expect(result).toContain("E:\\");
  });

  it("flags D: as warning (<20GB free + >90%)", () => {
    const result = analyzeDisk(WINDOWS_DF);
    expect(result).toContain("WARNING");
  });

  it("does not flag F: (healthy)", () => {
    const result = analyzeDisk(WINDOWS_DF);
    expect(result).not.toContain("F:\\ is");
  });

  it("resolves 'c drive' alias to C:\\ mount", () => {
    const result = analyzeDisk(WINDOWS_DF, "c drive");
    expect(result).toContain("C:\\");
    expect(result).toContain("CRITICAL");
  });
});

// ─── Cleanup table formatting: cross-platform ───────────────────────────────

describe("cleanup table: cross-platform", () => {
  function makeLinuxTargets(): CleanupTarget[] {
    return [
      { name: "npm cache", path: "/home/user/.npm", sizeGB: 2.5, safe: true, description: "Cached package downloads — re-downloaded as needed", cleanCommand: "npm cache clean --force" },
      { name: "apt cache", path: "/var/cache/apt/archives", sizeGB: 0.6, safe: true, description: "Downloaded .deb packages", cleanCommand: "sudo apt-get clean" },
    ];
  }

  function makeWindowsTargets(): CleanupTarget[] {
    return [
      { name: "npm cache", path: "C:\\Users\\User\\AppData\\Local\\npm-cache", sizeGB: 5.5, safe: true, description: "Cached package downloads — re-downloaded as needed", cleanCommand: "npm cache clean --force" },
      { name: "Temp files", path: "C:\\Users\\User\\AppData\\Local\\Temp", sizeGB: 2.0, safe: true, description: "Temporary files from apps and system", cleanCommand: "powershell ..." },
    ];
  }

  function makeWSLTargets(): CleanupTarget[] {
    return [
      ...makeLinuxTargets(),
      { name: "npm cache (Win)", path: "/mnt/c/Users/User/AppData/Local/npm-cache", sizeGB: 5.5, safe: true, description: "Windows npm cache — re-downloaded as needed", cleanCommand: "rm -rf ..." },
    ];
  }

  it("formats Linux targets", () => {
    const result = formatCleanupTable(makeLinuxTargets());
    expect(result).toContain("npm cache");
    expect(result).toContain("apt cache");
    expect(result).toContain("Nothing has been deleted yet");
    expect(result).toContain("None of your code, projects, documents");
  });

  it("formats Windows targets", () => {
    const result = formatCleanupTable(makeWindowsTargets());
    expect(result).toContain("npm cache");
    expect(result).toContain("Temp files");
    expect(result).toContain("5.50 GB");
    expect(result).toContain("confirm each item individually");
  });

  it("formats WSL targets with both Linux and Windows", () => {
    const result = formatCleanupTable(makeWSLTargets());
    expect(result).toContain("npm cache");
    expect(result).toContain("npm cache (Win)");
    expect(result).toContain("apt cache");
  });

  it("shows empty message when nothing to clean", () => {
    const result = formatCleanupTable([]);
    expect(result).toContain("No significant reclaimable space");
  });

  it("shows safety messages in table", () => {
    const result = formatCleanupTable(makeLinuxTargets());
    expect(result).toContain("Nothing has been deleted yet");
    expect(result).toContain("None of your code, projects, documents, or settings");
    expect(result).toContain("confirm each item individually");
  });
});

// ─── Drive scan: cross-platform formatting ──────────────────────────────────

describe("drive scan: cross-platform formatting", () => {
  function makeWindowsDrives(): DriveInfo[] {
    return [
      { device: "C:", label: "", filesystem: "NTFS", sizeGB: 447, usedGB: 431, freeGB: 16, usePct: 96, mount: "C:\\" },
      { device: "D:", label: "Data", filesystem: "NTFS", sizeGB: 894, usedGB: 798, freeGB: 96, usePct: 89, mount: "D:\\" },
      { device: "F:", label: "Backup", filesystem: "NTFS", sizeGB: 1863, usedGB: 76, freeGB: 1787, usePct: 4, mount: "F:\\" },
    ];
  }

  function makeLinuxDrives(): DriveInfo[] {
    return [
      { device: "/dev/sda1", label: "", filesystem: "ext4", sizeGB: 100, usedGB: 98, freeGB: 2, usePct: 98, mount: "/" },
      { device: "/dev/sdb1", label: "", filesystem: "ext4", sizeGB: 500, usedGB: 200, freeGB: 300, usePct: 40, mount: "/data" },
    ];
  }

  it("formats Windows drives with labels and filesystem", async () => {
    const result = await formatDriveScan(makeWindowsDrives());
    expect(result).toContain("C:");
    expect(result).toContain("D:");
    expect(result).toContain("Data");
    expect(result).toContain("NTFS");
    expect(result).toContain("CRITICAL");
    expect(result).toContain("WARNING");
    expect(result).toContain("OK");
  });

  it("formats Linux drives", async () => {
    const result = await formatDriveScan(makeLinuxDrives());
    expect(result).toContain("/dev/sda1");
    expect(result).toContain("/data");
    expect(result).toContain("CRITICAL");
  });

  it("counts critical and warning drives correctly", async () => {
    const result = await formatDriveScan(makeWindowsDrives());
    expect(result).toContain("1 drive(s) critically full");
    expect(result).toContain("1 drive(s) approaching full");
  });
});
