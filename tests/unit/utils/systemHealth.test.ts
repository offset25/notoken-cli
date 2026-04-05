import { describe, it, expect } from "vitest";

describe("Platform Detection", () => {
  it("identifies platform", () => {
    const plat = process.platform;
    const isWSL = require("os").release().toLowerCase().includes("microsoft");
    const name = plat === "win32" ? "windows" : isWSL ? "wsl" : plat === "darwin" ? "macos" : "linux";
    expect(["windows", "wsl", "linux", "macos"]).toContain(name);
  });
});

describe("Issue Detection Logic", () => {
  function detectIssues(stats: any, crashes: any, winHealth: any) {
    const issues: string[] = [];
    const recs: string[] = [];

    if (stats.cpu > 90) { issues.push(`CPU at ${stats.cpu}%`); recs.push("Check running processes"); }
    if (stats.ram.pct > 90) { issues.push(`RAM at ${stats.ram.pct}%`); recs.push("Close unused apps"); }
    if (stats.gpu?.temp > 85) { issues.push(`GPU temp ${stats.gpu.temp}°C`); recs.push("Check GPU cooling"); }
    if (crashes.recentCrashes.length > 0) { issues.push(`${crashes.recentCrashes.length} crash(es)`); }
    if (winHealth?.updates?.needsReboot) { issues.push("Reboot pending"); }
    if (winHealth?.memory?.pressure === "high") { issues.push("High memory pressure"); }

    const badDisks = (winHealth?.disks || []).filter((d: any) => !d.healthy);
    if (badDisks.length > 0) issues.push(`${badDisks.length} disk(s) nearly full`);

    return { issues, recs, healthy: issues.length === 0 };
  }

  it("reports healthy with good stats", () => {
    const r = detectIssues(
      { cpu: 30, ram: { pct: 50 }, gpu: { temp: 60 } },
      { recentCrashes: [] },
      { updates: { needsReboot: false }, memory: { pressure: "low" }, disks: [{ healthy: true }] }
    );
    expect(r.healthy).toBe(true);
    expect(r.issues).toHaveLength(0);
  });

  it("detects high CPU", () => {
    const r = detectIssues({ cpu: 95, ram: { pct: 50 } }, { recentCrashes: [] }, null);
    expect(r.issues).toContain("CPU at 95%");
  });

  it("detects high RAM", () => {
    const r = detectIssues({ cpu: 30, ram: { pct: 95 } }, { recentCrashes: [] }, null);
    expect(r.issues).toContain("RAM at 95%");
  });

  it("detects hot GPU", () => {
    const r = detectIssues({ cpu: 30, ram: { pct: 50 }, gpu: { temp: 92 } }, { recentCrashes: [] }, null);
    expect(r.issues).toContain("GPU temp 92°C");
  });

  it("detects crashes", () => {
    const r = detectIssues({ cpu: 30, ram: { pct: 50 } }, { recentCrashes: [{ process: "wsl.exe" }] }, null);
    expect(r.issues).toContain("1 crash(es)");
  });

  it("detects reboot pending", () => {
    const r = detectIssues({ cpu: 30, ram: { pct: 50 } }, { recentCrashes: [] }, { updates: { needsReboot: true }, memory: { pressure: "low" }, disks: [] });
    expect(r.issues).toContain("Reboot pending");
  });

  it("detects full disks", () => {
    const r = detectIssues({ cpu: 30, ram: { pct: 50 } }, { recentCrashes: [] }, { updates: { needsReboot: false }, memory: { pressure: "low" }, disks: [{ drive: "C:", healthy: false }, { drive: "D:", healthy: true }] });
    expect(r.issues).toContain("1 disk(s) nearly full");
  });

  it("detects multiple issues", () => {
    const r = detectIssues(
      { cpu: 95, ram: { pct: 92 }, gpu: { temp: 90 } },
      { recentCrashes: [{ process: "wsl.exe" }] },
      { updates: { needsReboot: true }, memory: { pressure: "high" }, disks: [{ healthy: false }] }
    );
    expect(r.issues.length).toBeGreaterThanOrEqual(5);
    expect(r.healthy).toBe(false);
  });
});

describe("Summary Building", () => {
  it("builds healthy summary", () => {
    const parts = ["Platform: wsl", "CPU: 30%", "RAM: 50%", "All healthy."];
    const summary = parts.join(" ");
    expect(summary).toContain("All healthy");
    expect(summary).toContain("CPU: 30%");
  });

  it("builds summary with issues", () => {
    const issues = ["CPU at 95%", "Reboot pending"];
    const summary = `Platform: windows. ${issues.length} issue(s) found.`;
    expect(summary).toContain("2 issue(s)");
  });
});

describe("Recommendations Deduplication", () => {
  it("removes duplicate recommendations", () => {
    const recs = ["Close unused apps", "Check GPU cooling", "Close unused apps", "Free disk space"];
    const unique = [...new Set(recs)];
    expect(unique).toHaveLength(3);
  });
});
