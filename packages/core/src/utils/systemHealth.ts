/**
 * Combined system health — Windows + WSL + stats + crashes in one diagnosis.
 */

import { platform, release as osRelease } from "node:os";
import { diagnoseWSL, type WSLDiagnosis, type CrashReport, detectWSLCrashes } from "./wslHealth.js";
import { getWindowsHealth, type WindowsHealth } from "./windowsHealth.js";
import { getSystemStats } from "./systemStats.js";

export interface SystemStats {
  cpu: number;
  ram: { total: number; used: number; pct: number };
  gpu?: { usage: number; memUsed: number; memTotal: number; temp: number; name: string } | null;
}

export interface FullSystemHealth {
  platform: "windows" | "wsl" | "linux" | "macos";
  windows?: WindowsHealth;
  wsl?: WSLDiagnosis;
  stats: SystemStats;
  crashes: CrashReport;
  healthy: boolean;
  summary: string;
  issues: string[];
  recommendations: string[];
}

export async function getFullSystemHealth(): Promise<FullSystemHealth> {
  const plat = platform();
  const isWSL = osRelease().toLowerCase().includes("microsoft");
  const platformName: FullSystemHealth["platform"] = plat === "win32" ? "windows" : isWSL ? "wsl" : plat === "darwin" ? "macos" : "linux";

  const issues: string[] = [];
  const recommendations: string[] = [];

  // Gather all data in parallel where safe
  const [stats, crashes] = await Promise.all([
    getSystemStats().catch((): SystemStats => ({ cpu: 0, ram: { total: 0, used: 0, pct: 0 }, gpu: null })),
    detectWSLCrashes().catch((): CrashReport => ({ hasCrashes: false, totalCrashes: 0, recentCrashes: [], diagnosis: "", recommendations: [] })),
  ]);

  let windowsHealth: WindowsHealth | undefined;
  let wslDiag: WSLDiagnosis | undefined;

  // Windows health (from Windows or WSL)
  if (plat === "win32" || isWSL) {
    try {
      windowsHealth = await getWindowsHealth();
      if (!windowsHealth.healthy) {
        if (windowsHealth.updates.needsReboot) issues.push("Windows reboot pending for updates");
        if (windowsHealth.memory.pressure === "high") {
          issues.push(`High memory pressure (${windowsHealth.memory.usedPct}%)`);
          recommendations.push("Close unused applications to free memory");
        }
        const badDisks = windowsHealth.disks.filter(d => !d.healthy);
        if (badDisks.length > 0) {
          issues.push(`Disk ${badDisks.map(d => `${d.drive} (${d.usedPct}%)`).join(", ")} nearly full`);
          recommendations.push("Free up disk space — run disk cleanup or remove unused files");
        }
      }
    } catch {}
  }

  // WSL health
  if (plat === "win32" || isWSL) {
    try {
      wslDiag = await diagnoseWSL();
      if (!wslDiag.healthy) {
        if (!wslDiag.status.running) {
          issues.push("WSL is not running");
          recommendations.push("Start WSL: wsl");
        }
        if (wslDiag.crashes.recentCrashes.length > 0) {
          issues.push(`${wslDiag.crashes.recentCrashes.length} recent WSL crash(es)`);
          recommendations.push(...wslDiag.crashes.recommendations);
        }
      }
    } catch {}
  }

  // System stats issues
  if (stats.cpu > 90) {
    issues.push(`CPU at ${stats.cpu}%`);
    recommendations.push("Check running processes — something may be consuming excessive CPU");
  }
  if (stats.ram.pct > 90) {
    issues.push(`RAM at ${stats.ram.pct}%`);
    recommendations.push("Close unused applications or increase RAM");
  }
  if (stats.gpu && stats.gpu.temp > 85) {
    issues.push(`GPU temperature ${stats.gpu.temp}°C`);
    recommendations.push("Check GPU cooling — temperature is high");
  }

  // Crash issues
  if (crashes.recentCrashes.length > 0) {
    if (!issues.some(i => i.includes("WSL crash"))) {
      issues.push(`${crashes.recentCrashes.length} crash dump(s) in last 24h`);
    }
    recommendations.push(...crashes.recommendations.filter(r => !recommendations.includes(r)));
  }

  const healthy = issues.length === 0;

  // Build summary
  let summary = `Platform: ${platformName}. `;
  if (stats.cpu > 0) summary += `CPU: ${stats.cpu}%. `;
  if (stats.ram.total > 0) summary += `RAM: ${stats.ram.pct}% (${stats.ram.used}/${stats.ram.total} GB). `;
  if (stats.gpu) summary += `GPU: ${stats.gpu.name} at ${stats.gpu.usage}%, ${stats.gpu.temp}°C. `;
  if (windowsHealth) summary += `Windows uptime: ${windowsHealth.uptime.uptimeFormatted}. `;
  if (wslDiag?.status.running) summary += `WSL uptime: ${wslDiag.status.uptimeFormatted}. `;
  if (issues.length > 0) summary += `${issues.length} issue(s) found.`;
  else summary += "All healthy.";

  return {
    platform: platformName,
    windows: windowsHealth,
    wsl: wslDiag,
    stats,
    crashes,
    healthy,
    summary,
    issues,
    recommendations: [...new Set(recommendations)],
  };
}
