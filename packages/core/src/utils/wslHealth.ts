/**
 * WSL health monitoring — uptime, crash detection, process limits.
 * Detects WSL restarts, crash dumps, and prevents process storms.
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { release as osRelease } from "node:os";
import { tryExecAsync } from "./asyncExec.js";

const execAsync = promisify(exec);

// ── WSL Process Semaphore ──
let activeWslCalls = 0;
const MAX_CONCURRENT_WSL = 3;
const wslQueue: Array<{ resolve: (v: any) => void; cmd: string; timeout: number }> = [];

export async function throttledWslExec(cmd: string, timeout = 10000): Promise<string | null> {
  if (activeWslCalls >= MAX_CONCURRENT_WSL) {
    // Wait in queue
    return new Promise((resolve) => {
      wslQueue.push({ resolve, cmd, timeout });
    });
  }
  return runWslCall(cmd, timeout);
}

async function runWslCall(cmd: string, timeout: number): Promise<string | null> {
  activeWslCalls++;
  try {
    return await tryExecAsync(cmd, timeout);
  } finally {
    activeWslCalls--;
    // Process queue
    if (wslQueue.length > 0) {
      const next = wslQueue.shift()!;
      runWslCall(next.cmd, next.timeout).then(next.resolve);
    }
  }
}

export function getActiveWslCalls(): number {
  return activeWslCalls;
}

export function getWslQueueLength(): number {
  return wslQueue.length;
}

// ── WSL Uptime & Status ──

export interface WSLStatus {
  running: boolean;
  uptime: number | null;       // seconds
  uptimeFormatted: string;
  bootTime: string | null;     // ISO string
  distro: string | null;
  version: number | null;      // WSL 1 or 2
  kernel: string | null;
}

export async function getWSLStatus(): Promise<WSLStatus> {
  const status: WSLStatus = {
    running: false, uptime: null, uptimeFormatted: "unknown",
    bootTime: null, distro: null, version: null, kernel: null,
  };

  // Check if WSL is running — different check depending on where we are
  const isInWSL = osRelease().toLowerCase().includes("microsoft");
  if (isInWSL) {
    // We're inside WSL already
    status.running = true;
  } else {
    // We're on Windows — check if WSL is accessible
    const wslCheck = await tryExecAsync("wsl echo ok", 5000);
    if (!wslCheck || !wslCheck.includes("ok")) return status;
    status.running = true;
  }

  // Get uptime
  const wslCmd = isInWSL ? "" : "wsl ";
  const uptimeOut = await tryExecAsync(`${wslCmd}cat /proc/uptime`, 5000);
  if (uptimeOut) {
    const secs = parseFloat(uptimeOut.split(" ")[0]);
    if (!isNaN(secs)) {
      status.uptime = Math.round(secs);
      const days = Math.floor(secs / 86400);
      const hours = Math.floor((secs % 86400) / 3600);
      const mins = Math.floor((secs % 3600) / 60);
      status.uptimeFormatted = days > 0 ? `${days}d ${hours}h ${mins}m` : hours > 0 ? `${hours}h ${mins}m` : `${mins}m`;
    }
  }

  // Get boot time
  const bootOut = await tryExecAsync(`${wslCmd}uptime -s`, 5000);
  if (bootOut) {
    status.bootTime = bootOut.trim();
  }

  // Get distro name
  const distroOut = await tryExecAsync(`${wslCmd}bash -c 'cat /etc/os-release 2>/dev/null | grep PRETTY_NAME'`, 5000);
  if (distroOut) {
    const match = distroOut.match(/PRETTY_NAME="?([^"\n]+)"?/);
    if (match) status.distro = match[1];
  }

  // Get WSL version (only from Windows side)
  if (!isInWSL) {
    const versionOut = await tryExecAsync("wsl --version", 5000);
    if (versionOut) {
      const match = versionOut.match(/WSL version:\s*([\d.]+)/i);
      if (match) status.version = parseInt(match[1]);
    }
  } else {
    status.version = 2; // If we're in WSL with microsoft kernel, it's WSL2
  }

  // Get kernel
  const kernelOut = await tryExecAsync(`${wslCmd}uname -r`, 5000);
  if (kernelOut) status.kernel = kernelOut.trim();

  return status;
}

// ── Crash Detection ──

export interface CrashReport {
  hasCrashes: boolean;
  totalCrashes: number;
  recentCrashes: CrashEntry[];
  diagnosis: string;
  recommendations: string[];
}

export interface CrashEntry {
  file: string;
  process: string;
  time: Date;
  size: number;
}

export async function detectWSLCrashes(): Promise<CrashReport> {
  const report: CrashReport = {
    hasCrashes: false, totalCrashes: 0,
    recentCrashes: [], diagnosis: "", recommendations: [],
  };

  // Find crash dumps
  const userProfile = process.env.USERPROFILE
    || await tryExecAsync("wsl bash -c 'echo /mnt/c/Users/$(/mnt/c/Windows/System32/cmd.exe /c \"echo %USERNAME%\" 2>/dev/null | tr -d \"\\r\\n\")'", 5000)
    || "";
  const crashDir = join(userProfile.trim(), "AppData", "Local", "CrashDumps");

  if (!existsSync(crashDir)) {
    // Try Windows path
    const winCrashDir = await tryExecAsync("echo %USERPROFILE%\\AppData\\Local\\CrashDumps", 3000);
    if (!winCrashDir || !existsSync(winCrashDir.trim())) {
      report.diagnosis = "Could not locate crash dump directory.";
      return report;
    }
  }

  try {
    const files = readdirSync(crashDir).filter(f => f.endsWith(".dmp"));
    report.totalCrashes = files.length;
    report.hasCrashes = files.length > 0;

    // Parse crash entries
    const entries: CrashEntry[] = files.map(f => {
      const fullPath = join(crashDir, f);
      const stat = statSync(fullPath);
      const processMatch = f.match(/^(.+?)\.(\d+)\.dmp$/);
      return {
        file: f,
        process: processMatch ? processMatch[1] : f,
        time: stat.mtime,
        size: stat.size,
      };
    }).sort((a, b) => b.time.getTime() - a.time.getTime());

    // Recent = last 24 hours
    const oneDayAgo = Date.now() - 24 * 60 * 60 * 1000;
    report.recentCrashes = entries.filter(e => e.time.getTime() > oneDayAgo);

    // Diagnosis
    const wslCrashes = entries.filter(e => e.process === "wsl.exe" || e.process === "wslrelay.exe");
    const wmicCrashes = entries.filter(e => e.process === "WMIC.exe");
    const recentWsl = report.recentCrashes.filter(e => e.process === "wsl.exe" || e.process === "wslrelay.exe");

    if (recentWsl.length > 0) {
      report.diagnosis = `${recentWsl.length} WSL crash${recentWsl.length > 1 ? "es" : ""} in the last 24 hours. `;
      report.diagnosis += `Most recent: ${recentWsl[0].time.toLocaleString()}. `;
      report.diagnosis += `WSL stack overflow (0xc00000fd) typically caused by too many concurrent wsl.exe subprocess calls.`;

      report.recommendations.push("Limit concurrent WSL calls (max 3 simultaneous)");
      report.recommendations.push("Avoid running system detection while tests are running");
      report.recommendations.push("Close the NoToken App during heavy testing");
    } else if (wslCrashes.length > 0) {
      report.diagnosis = `${wslCrashes.length} total WSL crashes found (none in last 24h). System is currently stable.`;
    }

    if (wmicCrashes.length > 0) {
      report.diagnosis += ` ${wmicCrashes.length} WMIC crash${wmicCrashes.length > 1 ? "es" : ""} — avoid calling WMIC for system stats, use PowerShell instead.`;
      report.recommendations.push("Use PowerShell Get-CimInstance instead of WMIC");
    }

    if (!report.diagnosis) {
      report.diagnosis = report.hasCrashes
        ? `${report.totalCrashes} crash dump${report.totalCrashes > 1 ? "s" : ""} found, none WSL-related.`
        : "No crash dumps found. System is healthy.";
    }

  } catch (err) {
    report.diagnosis = `Could not read crash dumps: ${(err as Error).message}`;
  }

  return report;
}

// ── Full WSL Diagnosis ──

export interface WSLDiagnosis {
  status: WSLStatus;
  crashes: CrashReport;
  processes: { active: number; queued: number };
  healthy: boolean;
  summary: string;
}

export async function diagnoseWSL(): Promise<WSLDiagnosis> {
  const status = await getWSLStatus();
  const crashes = await detectWSLCrashes();
  const processes = { active: getActiveWslCalls(), queued: getWslQueueLength() };

  const healthy = status.running && crashes.recentCrashes.length === 0;

  let summary = "";
  if (!status.running) {
    summary = "WSL is not running. Start it with: wsl";
  } else if (crashes.recentCrashes.length > 0) {
    summary = `WSL is running (uptime: ${status.uptimeFormatted}) but has ${crashes.recentCrashes.length} recent crash${crashes.recentCrashes.length > 1 ? "es" : ""}. ${crashes.diagnosis}`;
  } else {
    summary = `WSL is healthy. Uptime: ${status.uptimeFormatted}. ${status.distro || "Unknown distro"}. Kernel: ${status.kernel || "unknown"}.`;
    if (crashes.totalCrashes > 0) summary += ` ${crashes.totalCrashes} historical crash dumps found.`;
  }

  return { status, crashes, processes, healthy, summary };
}
