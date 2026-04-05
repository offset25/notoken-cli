/**
 * GPU Safety Guard — checks if nvidia-smi is safe to call in the current environment.
 *
 * WSL2 + older NVIDIA drivers can crash when nvidia-smi is called repeatedly.
 * This module runs a one-time probe at startup and gates all future GPU queries.
 *
 * Safe: Driver ≥ 535, VRAM < 90%, not rapid-polling
 * Unsafe: Old drivers, high VRAM, WSL1, or nvidia-smi hangs
 */

import { tryExecAsync } from "./asyncExec.js";
import { release } from "os";

export interface GpuSafetyResult {
  safe: boolean;
  available: boolean;
  driver: string | null;
  driverMajor: number;
  gpu: string | null;
  vramTotal: number;
  vramUsed: number;
  vramPct: number;
  isWSL: boolean;
  isWSL2: boolean;
  reason: string | null;
}

let cachedResult: GpuSafetyResult | null = null;
let probeRunning = false;

/**
 * One-time GPU safety probe. Caches the result.
 * Uses a single lightweight nvidia-smi call (not the heavy polling query).
 */
export async function checkGpuSafety(): Promise<GpuSafetyResult> {
  if (cachedResult) return cachedResult;
  if (probeRunning) {
    // Wait for in-flight probe
    await new Promise(r => setTimeout(r, 1000));
    return cachedResult || makeUnsafe("Probe timed out");
  }

  probeRunning = true;
  const result: GpuSafetyResult = {
    safe: false, available: false, driver: null, driverMajor: 0,
    gpu: null, vramTotal: 0, vramUsed: 0, vramPct: 0,
    isWSL: false, isWSL2: false, reason: null,
  };

  try {
    // Detect WSL
    const rel = release().toLowerCase();
    result.isWSL = rel.includes("microsoft");
    result.isWSL2 = rel.includes("wsl2") || rel.includes("microsoft-standard-wsl2");

    // Check if nvidia-smi exists (without running a query)
    const smiPath = await tryExecAsync("which nvidia-smi") || await tryExecAsync("where nvidia-smi");
    if (!smiPath) {
      result.reason = "nvidia-smi not found — no NVIDIA GPU or drivers not installed";
      cachedResult = result;
      probeRunning = false;
      return result;
    }

    result.available = true;

    // Single lightweight query — driver version, GPU name, VRAM
    const info = await tryExecAsync(
      "nvidia-smi --query-gpu=driver_version,name,memory.total,memory.used --format=csv,noheader,nounits",
      5000
    );

    if (!info) {
      result.reason = "nvidia-smi query timed out or failed — driver may be unstable";
      cachedResult = result;
      probeRunning = false;
      return result;
    }

    const parts = info.split(",").map(s => s.trim());
    result.driver = parts[0] || null;
    result.driverMajor = parseInt(parts[0]) || 0;
    result.gpu = parts[1] || null;
    result.vramTotal = parseInt(parts[2]) || 0;
    result.vramUsed = parseInt(parts[3]) || 0;
    result.vramPct = result.vramTotal > 0 ? Math.round(result.vramUsed / result.vramTotal * 100) : 0;

    // Safety checks
    if (result.isWSL && !result.isWSL2) {
      result.reason = "WSL1 does not support GPU passthrough — nvidia-smi calls will fail";
    } else if (result.driverMajor > 0 && result.driverMajor < 510) {
      result.reason = `Driver ${result.driver} is too old for WSL2 GPU — crashes likely. Update to 535+`;
    } else if (result.driverMajor >= 510 && result.driverMajor < 535 && result.isWSL) {
      result.reason = `Driver ${result.driver} is borderline for WSL2 — may cause instability under load. Update to 535+ recommended`;
      result.safe = true; // Allow but warn
    } else if (result.vramPct > 90) {
      result.reason = `VRAM at ${result.vramPct}% (${result.vramUsed}/${result.vramTotal} MB) — polling may trigger OOM`;
    } else {
      result.safe = true;
      result.reason = null;
    }
  } catch (err) {
    result.reason = `GPU probe failed: ${(err as Error).message}`;
  }

  cachedResult = result;
  probeRunning = false;
  return result;
}

function makeUnsafe(reason: string): GpuSafetyResult {
  return {
    safe: false, available: false, driver: null, driverMajor: 0,
    gpu: null, vramTotal: 0, vramUsed: 0, vramPct: 0,
    isWSL: false, isWSL2: false, reason,
  };
}

/**
 * Check if nvidia-smi is safe to call right now.
 * Uses cached result from checkGpuSafety().
 * If not yet probed, returns false (safe default).
 */
export function isGpuSafe(): boolean {
  return cachedResult?.safe ?? false;
}

/**
 * Get cached GPU info without re-probing.
 */
export function getGpuInfo(): GpuSafetyResult | null {
  return cachedResult;
}

/**
 * Reset the cache (e.g., after driver update).
 */
export function resetGpuCache(): void {
  cachedResult = null;
}
