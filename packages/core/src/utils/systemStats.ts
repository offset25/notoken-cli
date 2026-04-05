/**
 * System statistics — CPU, RAM, GPU.
 *
 * Uses a PowerShell temp-file strategy to avoid `$` stripping when the
 * command crosses shell boundaries (Electron → cmd.exe → PowerShell).
 * Falls back to Linux `/proc` when PowerShell is unavailable.
 */

import { writeFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { tryExecAsync } from "./asyncExec.js";

/* ── types ── */

export interface RamStats {
  total: number;
  used: number;
  pct: number;
}

export interface GpuStats {
  usage: number;
  memUsage?: number;
  memUsed: number;
  memTotal: number;
  temp: number;
  name: string;
}

export interface SystemStats {
  cpu: number;
  ram: RamStats;
  gpu: GpuStats | null;
}

/**
 * Collect CPU, RAM, and (optionally) GPU usage.
 *
 * On Windows / WSL-with-Windows-host the CPU and RAM numbers come from
 * PowerShell via a temp `.ps1` file.  GPU data comes from `nvidia-smi`.
 */
export async function getSystemStats(): Promise<SystemStats> {
  const stats: SystemStats = {
    cpu: 0,
    ram: { total: 0, used: 0, pct: 0 },
    gpu: null,
  };

  // ── CPU + RAM via PowerShell temp file ──
  const psTmp = join(tmpdir(), `notoken-stats-${Date.now()}.ps1`);
  writeFileSync(
    psTmp,
    `$cpu = (Get-CimInstance Win32_Processor).LoadPercentage; $os = Get-CimInstance Win32_OperatingSystem; Write-Host "$cpu|$($os.TotalVisibleMemorySize)|$($os.FreePhysicalMemory)"`,
  );

  // Convert the temp path for both native-Windows and WSL contexts
  const winPsPath = psTmp
    .replace(/\\/g, "/")
    .replace(/^([A-Z]):/i, (_, d: string) => `${d.toUpperCase()}:\\`)
    .replace(/\//g, "\\");

  const psOut =
    (await tryExecAsync(
      `powershell -ExecutionPolicy Bypass -File "${winPsPath}"`,
      8000,
    )) ??
    (await tryExecAsync(
      `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -ExecutionPolicy Bypass -File "${winPsPath}"`,
      8000,
    )) ??
    (await tryExecAsync(
      `wsl bash -c 'echo $(top -bn1 | grep "Cpu(s)" | awk "{print \\$2}")|$(grep MemTotal /proc/meminfo | awk "{print \\$2}")|$(grep MemAvailable /proc/meminfo | awk "{print \\$2}")'`,
      5000,
    ));

  try {
    unlinkSync(psTmp);
  } catch {
    /* ignore */
  }

  if (psOut) {
    const parts = psOut.trim().split("|");
    stats.cpu = parseInt(parts[0], 10) || 0;
    const totalKB = parseInt(parts[1], 10) || 0;
    const freeKB = parseInt(parts[2], 10) || 0;
    stats.ram.total = Math.round((totalKB / 1024 / 1024) * 10) / 10;
    stats.ram.used = Math.round(((totalKB - freeKB) / 1024 / 1024) * 10) / 10;
    stats.ram.pct =
      totalKB > 0 ? Math.round(((totalKB - freeKB) / totalKB) * 100) : 0;
  }

  // ── GPU via nvidia-smi ──
  const nvidiaQuery =
    "nvidia-smi --query-gpu=utilization.gpu,utilization.memory,memory.used,memory.total,temperature.gpu,name --format=csv,noheader,nounits";
  const gpuOut =
    (await tryExecAsync(nvidiaQuery, 5000)) ??
    (await tryExecAsync(`wsl ${nvidiaQuery} 2>/dev/null`, 5000));

  if (gpuOut) {
    const parts = gpuOut.trim().split(",").map((s) => s.trim());
    stats.gpu = {
      usage: parseInt(parts[0], 10) || 0,
      memUsage: parseInt(parts[1], 10) || 0,
      memUsed: parseInt(parts[2], 10) || 0,
      memTotal: parseInt(parts[3], 10) || 0,
      temp: parseInt(parts[4], 10) || 0,
      name: parts[5] || "GPU",
    };
  }

  return stats;
}
