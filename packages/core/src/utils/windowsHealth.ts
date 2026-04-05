/**
 * Windows health monitoring — uptime, updates, disk, memory.
 * Uses PowerShell via temp .ps1 files to avoid bash $ stripping.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { tryExecAsync } from "./asyncExec.js";

function runPS1(script: string, timeout = 10000): Promise<string | null> {
  const tmp = join(tmpdir(), `notoken-winhealth-${Date.now()}.ps1`);
  writeFileSync(tmp, script);
  const isInWSL = require("os").release().toLowerCase().includes("microsoft");
  const psExe = isInWSL
    ? "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe"
    : "powershell";
  const winPath = isInWSL
    ? tmp.replace(/^\/mnt\/([a-z])\//, (_: string, d: string) => `${d.toUpperCase()}:\\`).replace(/\//g, "\\")
    : tmp;
  return tryExecAsync(`${psExe} -ExecutionPolicy Bypass -File "${winPath}"`, timeout)
    .finally(() => { try { unlinkSync(tmp); } catch {} });
}

// ── Uptime ──

export interface WindowsUptime {
  uptime: number;
  uptimeFormatted: string;
  bootTime: string;
}

export async function getWindowsUptime(): Promise<WindowsUptime> {
  const result: WindowsUptime = { uptime: 0, uptimeFormatted: "unknown", bootTime: "unknown" };
  const out = await runPS1(`
$os = Get-CimInstance Win32_OperatingSystem
$boot = $os.LastBootUpTime
$up = (Get-Date) - $boot
Write-Host "$($up.TotalSeconds)|$boot"
`);
  if (out) {
    const parts = out.trim().split("|");
    const secs = parseFloat(parts[0]);
    if (!isNaN(secs)) {
      result.uptime = Math.round(secs);
      const d = Math.floor(secs / 86400), h = Math.floor((secs % 86400) / 3600), m = Math.floor((secs % 3600) / 60);
      result.uptimeFormatted = d > 0 ? `${d}d ${h}h ${m}m` : h > 0 ? `${h}h ${m}m` : `${m}m`;
    }
    if (parts[1]) result.bootTime = parts[1].trim();
  }
  return result;
}

// ── Updates ──

export interface WindowsUpdates {
  pendingCount: number;
  needsReboot: boolean;
  lastInstalled: string | null;
}

export async function getWindowsUpdates(): Promise<WindowsUpdates> {
  const result: WindowsUpdates = { pendingCount: 0, needsReboot: false, lastInstalled: null };
  const out = await runPS1(`
$reboot = Test-Path 'HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\WindowsUpdate\\Auto Update\\RebootRequired'
$last = (Get-HotFix | Sort-Object InstalledOn -Descending -ErrorAction SilentlyContinue | Select-Object -First 1).InstalledOn
Write-Host "$reboot|$last"
`, 15000);
  if (out) {
    const parts = out.trim().split("|");
    result.needsReboot = parts[0]?.trim().toLowerCase() === "true";
    if (parts[1] && parts[1].trim() !== "") result.lastInstalled = parts[1].trim();
  }
  return result;
}

// ── Disk Health ──

export interface DiskInfo {
  drive: string;
  totalGB: number;
  freeGB: number;
  usedPct: number;
  healthy: boolean;
}

export async function getDiskHealth(): Promise<DiskInfo[]> {
  const out = await runPS1(`
Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object {
  $pct = if($_.Size -gt 0){[math]::Round(($_.Size-$_.FreeSpace)/$_.Size*100)}else{0}
  Write-Host "$($_.DeviceID)|$([math]::Round($_.Size/1GB,1))|$([math]::Round($_.FreeSpace/1GB,1))|$pct"
}
`);
  if (!out) return [];
  return out.trim().split("\n").filter(Boolean).map(line => {
    const [drive, total, free, pct] = line.split("|");
    const usedPct = parseInt(pct) || 0;
    return {
      drive: drive?.trim() || "?",
      totalGB: parseFloat(total) || 0,
      freeGB: parseFloat(free) || 0,
      usedPct,
      healthy: usedPct < 90,
    };
  });
}

// ── Memory Pressure ──

export interface MemoryPressure {
  totalGB: number;
  availableGB: number;
  usedPct: number;
  commitGB: number;
  commitLimitGB: number;
  pressure: "low" | "medium" | "high";
}

export async function getMemoryPressure(): Promise<MemoryPressure> {
  const result: MemoryPressure = { totalGB: 0, availableGB: 0, usedPct: 0, commitGB: 0, commitLimitGB: 0, pressure: "low" };
  const out = await runPS1(`
$os = Get-CimInstance Win32_OperatingSystem
$totalKB = $os.TotalVisibleMemorySize
$freeKB = $os.FreePhysicalMemory
$pf = Get-CimInstance Win32_PageFileUsage -ErrorAction SilentlyContinue | Select-Object -First 1
$commit = if($pf){$pf.CurrentUsage}else{0}
$commitLimit = if($pf){$pf.AllocatedBaseSize}else{0}
Write-Host "$totalKB|$freeKB|$commit|$commitLimit"
`);
  if (out) {
    const [totalKB, freeKB, commitMB, commitLimitMB] = out.trim().split("|").map(s => parseFloat(s) || 0);
    result.totalGB = Math.round(totalKB / 1024 / 1024 * 10) / 10;
    result.availableGB = Math.round(freeKB / 1024 / 1024 * 10) / 10;
    result.usedPct = totalKB > 0 ? Math.round((totalKB - freeKB) / totalKB * 100) : 0;
    result.commitGB = Math.round(commitMB / 1024 * 10) / 10;
    result.commitLimitGB = Math.round(commitLimitMB / 1024 * 10) / 10;
    result.pressure = result.usedPct >= 90 ? "high" : result.usedPct >= 70 ? "medium" : "low";
  }
  return result;
}

// ── Combined Windows Health ──

export interface WindowsHealth {
  uptime: WindowsUptime;
  updates: WindowsUpdates;
  disks: DiskInfo[];
  memory: MemoryPressure;
  healthy: boolean;
  summary: string;
}

export async function getWindowsHealth(): Promise<WindowsHealth> {
  const [uptime, updates, disks, memory] = await Promise.all([
    getWindowsUptime(), getWindowsUpdates(), getDiskHealth(), getMemoryPressure(),
  ]);

  const issues: string[] = [];
  if (updates.needsReboot) issues.push("Reboot pending for Windows Update");
  if (memory.pressure === "high") issues.push(`Memory pressure high (${memory.usedPct}% used)`);
  const badDisks = disks.filter(d => !d.healthy);
  if (badDisks.length > 0) issues.push(`Disk ${badDisks.map(d => d.drive).join(", ")} above 90% usage`);

  const healthy = issues.length === 0;
  let summary = `Windows uptime: ${uptime.uptimeFormatted}. `;
  summary += `RAM: ${memory.usedPct}% used (${memory.availableGB}GB free of ${memory.totalGB}GB). `;
  summary += `${disks.length} disk${disks.length !== 1 ? "s" : ""}. `;
  if (issues.length > 0) summary += `Issues: ${issues.join("; ")}.`;
  else summary += "All healthy.";

  return { uptime, updates, disks, memory, healthy, summary };
}
