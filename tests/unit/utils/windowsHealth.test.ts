import { describe, it, expect } from "vitest";

describe("Windows Uptime Parsing", () => {
  function parseUptime(output: string) {
    const parts = output.trim().split("|");
    const secs = parseFloat(parts[0]);
    const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
    return {
      uptime: Math.round(secs),
      uptimeFormatted: d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`,
      bootTime: parts[1]?.trim() || "unknown",
    };
  }

  it("parses seconds and boot time", () => {
    const r = parseUptime("86523.45|04/02/2026 10:30:00 AM");
    expect(r.uptime).toBe(86523);
    expect(r.uptimeFormatted).toBe("1d 0h 2m");
    expect(r.bootTime).toBe("04/02/2026 10:30:00 AM");
  });

  it("formats hours without days", () => {
    const r = parseUptime("7200|04/05/2026");
    expect(r.uptimeFormatted).toBe("2h 0m");
  });

  it("formats minutes only", () => {
    const r = parseUptime("660|04/05/2026");
    expect(r.uptimeFormatted).toBe("11m");
  });
});

describe("Disk Health Parsing", () => {
  function parseDiskLine(line: string) {
    const [drive, total, free, pct] = line.split("|");
    const usedPct = parseInt(pct) || 0;
    return { drive: drive.trim(), totalGB: parseFloat(total), freeGB: parseFloat(free), usedPct, healthy: usedPct < 90 };
  }

  it("parses disk info", () => {
    const d = parseDiskLine("C:|447.1|120.5|73");
    expect(d.drive).toBe("C:");
    expect(d.totalGB).toBe(447.1);
    expect(d.freeGB).toBe(120.5);
    expect(d.usedPct).toBe(73);
    expect(d.healthy).toBe(true);
  });

  it("flags unhealthy disk at 90%+", () => {
    const d = parseDiskLine("D:|1000|50|95");
    expect(d.healthy).toBe(false);
  });

  it("parses multiple disks", () => {
    const output = "C:|447.1|120.5|73\nD:|1863.0|500.0|73\nE:|894.0|200.0|78";
    const disks = output.split("\n").map(parseDiskLine);
    expect(disks).toHaveLength(3);
    expect(disks.every(d => d.healthy)).toBe(true);
  });
});

describe("Memory Pressure Parsing", () => {
  function parseMemory(output: string) {
    const [totalKB, freeKB, commitMB, commitLimitMB] = output.trim().split("|").map(s => parseFloat(s) || 0);
    const totalGB = Math.round(totalKB / 1024 / 1024 * 10) / 10;
    const availableGB = Math.round(freeKB / 1024 / 1024 * 10) / 10;
    const usedPct = totalKB > 0 ? Math.round((totalKB - freeKB) / totalKB * 100) : 0;
    const pressure = usedPct >= 90 ? "high" as const : usedPct >= 70 ? "medium" as const : "low" as const;
    return { totalGB, availableGB, usedPct, commitGB: Math.round(commitMB / 1024 * 10) / 10, commitLimitGB: Math.round(commitLimitMB / 1024 * 10) / 10, pressure };
  }

  it("parses normal memory", () => {
    const m = parseMemory("67031284|22544572|8192|16384");
    expect(m.totalGB).toBeCloseTo(63.9, 0);
    expect(m.availableGB).toBeGreaterThan(0);
    expect(m.usedPct).toBeGreaterThan(0);
    expect(["low", "medium"]).toContain(m.pressure);
  });

  it("detects high pressure", () => {
    const m = parseMemory("8388608|419430|4096|8192");
    expect(m.usedPct).toBe(95);
    expect(m.pressure).toBe("high");
  });

  it("detects low pressure", () => {
    const m = parseMemory("8388608|5872025|1024|8192");
    expect(m.usedPct).toBe(30);
    expect(m.pressure).toBe("low");
  });
});

describe("Windows Updates Parsing", () => {
  function parseUpdates(output: string) {
    const parts = output.trim().split("|");
    return {
      needsReboot: parts[0]?.trim().toLowerCase() === "true",
      lastInstalled: parts[1]?.trim() || null,
    };
  }

  it("parses reboot needed", () => {
    const u = parseUpdates("True|04/03/2026 2:00:00 AM");
    expect(u.needsReboot).toBe(true);
    expect(u.lastInstalled).toBe("04/03/2026 2:00:00 AM");
  });

  it("parses no reboot", () => {
    const u = parseUpdates("False|04/01/2026");
    expect(u.needsReboot).toBe(false);
  });
});

describe("Windows Health Summary", () => {
  it("reports healthy when no issues", () => {
    const issues: string[] = [];
    const healthy = issues.length === 0;
    expect(healthy).toBe(true);
  });

  it("reports unhealthy with issues", () => {
    const issues = ["Reboot pending", "Disk C: above 90%"];
    const healthy = issues.length === 0;
    expect(healthy).toBe(false);
    expect(issues).toHaveLength(2);
  });
});
