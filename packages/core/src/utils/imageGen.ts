/**
 * AI Image Generation.
 *
 * Detects, installs, and interfaces with local image generation engines.
 * Falls back to informing users about online services.
 *
 * Supported local engines:
 *   1. AUTOMATIC1111 (Stable Diffusion Web UI) — API at :7860
 *   2. ComfyUI — API at :8188
 *   3. Fooocus — simplest UI
 *   4. Docker (stable-diffusion-webui container)
 *
 * Online services (info only):
 *   - OpenAI DALL-E API
 *   - Midjourney (Discord-based)
 *   - Leonardo.ai
 *   - Stability AI API
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, platform } from "node:os";
import { USER_HOME } from "./paths.js";
import { trackInstall } from "./installTracker.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
};

// Install paths — dynamically chosen based on available disk space

export interface DriveInfo {
  path: string;
  freeGB: number;
  totalGB: number;
  usedPct: number;
  mount: string;
}

export function getDriveInfo(path: string): DriveInfo | null {
  const isWSL = (() => { try { return !!execSync("grep -qi microsoft /proc/version && echo wsl", { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 2000 }).trim(); } catch { return false; } })();

  // Walk up to find an existing parent directory for df
  let checkPath = path;
  for (let i = 0; i < 5; i++) {
    try {
      const output = execSync(`df -BG "${checkPath}" 2>/dev/null | tail -1`, { encoding: "utf-8", timeout: 3000 });
      const parts = output.trim().split(/\s+/);
      if (parts.length < 6) { checkPath = resolve(checkPath, ".."); continue; }
      const total = parseInt(parts[1]) || 0;
      let free = parseInt(parts[3]) || 0;
      const pct = parseInt(parts[4]) || 0;
      const mount = parts[parts.length - 1];

      // WSL fix: paths on the WSL virtual disk (/dev/sdd, /dev/sdc) report
      // the VHD max size, not actual free space on the host drive.
      // Real free space = C: drive free space (where the VHD lives)
      if (isWSL && !mount.startsWith("/mnt/") && mount !== "/mnt/wsl") {
        try {
          const cDrive = execSync('df -BG /mnt/c 2>/dev/null | tail -1', { encoding: "utf-8", timeout: 3000 });
          const cParts = cDrive.trim().split(/\s+/);
          if (cParts.length >= 6) {
            const cFree = parseInt(cParts[3]) || 0;
            free = cFree; // Use C: drive free space as the real limit
          }
        } catch {}
      }

      return { path, freeGB: free, totalGB: total, usedPct: pct, mount };
    } catch {
      checkPath = resolve(checkPath, "..");
    }
  }
  return null;
}

function getDriveFreeGB(path: string): number {
  return getDriveInfo(path)?.freeGB ?? 0;
}

export interface InstallDirChoice {
  dir: string;
  freeGB: number;
  reasoning: string;
  candidates: Array<{ path: string; freeGB: number; rejected?: string }>;
}

function chooseBestInstallDir(): InstallDirChoice {
  const os = platform();
  const isWSL = (() => { try { return !!execSync("grep -qi microsoft /proc/version && echo wsl", { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 2000 }).trim(); } catch { return false; } })();

  const candidates: Array<{ path: string; freeGB: number; rejected?: string }> = [];
  const MIN_GB = 15;

  if (isWSL) {
    // Check mounted Windows drives (skip C:)
    for (const drive of ["/mnt/d", "/mnt/e", "/mnt/f", "/mnt/g", "/mnt/h", "/mnt/i"]) {
      const free = getDriveFreeGB(drive);
      if (free > 0) {
        candidates.push({ path: resolve(drive, "notoken", "ai"), freeGB: free, rejected: free < MIN_GB ? `only ${free}GB free` : undefined });
      }
    }
    // Also check C: but mark it
    const cFree = getDriveFreeGB("/mnt/c");
    if (cFree > 0) candidates.push({ path: "/mnt/c/notoken/ai", freeGB: cFree, rejected: cFree < MIN_GB ? `only ${cFree}GB free (system drive)` : "system drive — avoid" });
    // Linux root
    const rootFree = getDriveFreeGB("/");
    candidates.push({ path: resolve(homedir(), "notoken", "ai"), freeGB: rootFree, rejected: rootFree < MIN_GB ? `only ${rootFree}GB free` : undefined });
  } else if (os === "win32") {
    for (const letter of ["D", "E", "F", "G", "H", "I"]) {
      const drive = `${letter}:\\`;
      const free = getDriveFreeGB(drive);
      if (free > 0) candidates.push({ path: resolve(drive, "notoken", "ai"), freeGB: free, rejected: free < MIN_GB ? `only ${free}GB free` : undefined });
    }
    const cFree = getDriveFreeGB("C:\\");
    if (cFree > 0) candidates.push({ path: resolve("C:\\notoken\\ai"), freeGB: cFree, rejected: "system drive — avoid" });
    candidates.push({ path: resolve(homedir(), "notoken", "ai"), freeGB: cFree, rejected: cFree < MIN_GB ? `only ${cFree}GB free` : undefined });
  } else {
    // Linux/macOS
    const homeFree = getDriveFreeGB(homedir());
    candidates.push({ path: resolve(homedir(), "notoken", "ai"), freeGB: homeFree, rejected: homeFree < MIN_GB ? `only ${homeFree}GB free` : undefined });
    // Check /opt if available
    const optFree = getDriveFreeGB("/opt");
    if (optFree > 0) candidates.push({ path: "/opt/notoken/ai", freeGB: optFree, rejected: optFree < MIN_GB ? `only ${optFree}GB free` : undefined });
  }

  // Pick best: most free space that's not rejected
  const viable = candidates.filter(c => !c.rejected).sort((a, b) => b.freeGB - a.freeGB);
  if (viable.length > 0) {
    const best = viable[0];
    const rejected = candidates.filter(c => c.rejected);
    let reasoning = `Chose ${best.path} (${best.freeGB}GB free)`;
    if (rejected.length > 0) {
      reasoning += `. Skipped: ${rejected.map(r => `${r.path} (${r.rejected})`).join(", ")}`;
    }
    return { dir: best.path, freeGB: best.freeGB, reasoning, candidates };
  }

  // No viable option — pick least bad
  const sorted = candidates.sort((a, b) => b.freeGB - a.freeGB);
  const best = sorted[0] ?? { path: homedir(), freeGB: 0 };
  return {
    dir: best.path,
    freeGB: best.freeGB,
    reasoning: `No drive with ${MIN_GB}GB+ free. Best available: ${best.path} (${best.freeGB}GB free)`,
    candidates,
  };
}

/** Resolve a user-specified path like "D drive", "F:", "/mnt/f", "/opt/mydir" */
export function resolveUserPath(input: string): string | null {
  const normalized = input.trim().toLowerCase();

  // "D drive", "d:", "D:\\"
  const driveMatch = normalized.match(/^([a-z])\s*(?:drive|:|\s|$)/i);
  if (driveMatch) {
    const letter = driveMatch[1].toUpperCase();
    const os = platform();
    const isWSL = (() => { try { return !!execSync("grep -qi microsoft /proc/version && echo wsl", { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 2000 }).trim(); } catch { return false; } })();
    if (isWSL) return `/mnt/${letter.toLowerCase()}/notoken/ai`;
    if (os === "win32") return `${letter}:\\notoken\\ai`;
  }

  // Absolute path
  if (input.startsWith("/") || input.match(/^[A-Z]:\\/)) return input;

  // "/mnt/d", "/mnt/f/mydir"
  if (normalized.startsWith("/mnt/")) return input;

  return null;
}

function getInstallBase(): string {
  return process.env.NOTOKEN_INSTALL_DIR ?? chooseBestInstallDir().dir;
}
function getSDDir(): string { return resolve(getInstallBase(), "stable-diffusion-webui"); }
function getComfyDir(): string { return resolve(getInstallBase(), "ComfyUI"); }
function getFooocusDir(): string { return resolve(getInstallBase(), "Fooocus"); }

// Scan all possible install locations — includes all mounted drives
function getAllKnownDirs(engineName: string): string[] {
  const dirs: string[] = [];
  // Current install base
  dirs.push(resolve(getInstallBase(), engineName));
  // Home directory
  dirs.push(resolve(homedir(), engineName));
  dirs.push(resolve(homedir(), "notoken", "ai", engineName));
  // All mounted Windows drives (WSL)
  for (const letter of ["c", "d", "e", "f", "g", "h", "i"]) {
    dirs.push(resolve(`/mnt/${letter}`, "notoken", "ai", engineName));
    dirs.push(resolve(`/mnt/${letter}`, "apps", engineName));
  }
  // Windows paths
  for (const letter of ["C", "D", "E", "F", "G"]) {
    dirs.push(resolve(`${letter}:\\notoken\\ai`, engineName));
  }
  // Linux common
  dirs.push(resolve("/opt/notoken/ai", engineName));
  return dirs;
}
const STABILITY_MATRIX_DIR = resolve(homedir(), "StabilityMatrix");
const EASY_DIFFUSION_DIR = resolve(homedir(), "easy-diffusion");
const OUTPUT_DIR = resolve(USER_HOME, "generated-images");
const USAGE_FILE = resolve(USER_HOME, "image-gen-usage.json");

// ─── Usage Tracking ────────────────────────────────────────────────────────

interface UsageStats {
  cloudGenerations: number;
  localGenerations: number;
  totalGenerations: number;
  lastGenerated: string;
  apiKey?: { provider: string; configured: boolean };
}

function loadUsage(): UsageStats {
  try {
    if (existsSync(USAGE_FILE)) return JSON.parse(readFileSync(USAGE_FILE, "utf-8"));
  } catch {}
  return { cloudGenerations: 0, localGenerations: 0, totalGenerations: 0, lastGenerated: "" };
}

function saveUsage(stats: UsageStats): void {
  try {
    mkdirSync(USER_HOME, { recursive: true });
    writeFileSync(USAGE_FILE, JSON.stringify(stats, null, 2));
  } catch {}
}

function recordGeneration(isLocal: boolean): UsageStats {
  const stats = loadUsage();
  if (isLocal) stats.localGenerations++; else stats.cloudGenerations++;
  stats.totalGenerations++;
  stats.lastGenerated = new Date().toISOString();
  // Check for API keys
  if (process.env.HF_TOKEN || process.env.HUGGINGFACE_TOKEN) {
    stats.apiKey = { provider: "huggingface", configured: true };
  } else if (process.env.STABILITY_API_KEY) {
    stats.apiKey = { provider: "stability-ai", configured: true };
  }
  saveUsage(stats);
  return stats;
}

// ─── Types ─────────────────────────────────────────────────────────────────

export type ImageEngine = "auto1111" | "comfyui" | "fooocus" | "docker" | "stability-matrix" | "easy-diffusion" | "none";

export interface ImageEngineStatus {
  engine: ImageEngine;
  installed: boolean;
  running: boolean;
  path?: string;
  url?: string;
  version?: string;
  platform?: "wsl" | "windows" | "linux" | "macos";
  pid?: number;
  port?: number;
  portConflict?: boolean;
}

export interface GpuInfo {
  hasNvidia: boolean;
  hasAmd: boolean;
  gpuName?: string;
  vram?: string;
  vramFree?: string;
  gpuTemp?: string;
  gpuUtil?: string;
  driverVersion?: string;
  maxCudaVersion?: string;
  gpuError?: string;
  wslCuda?: boolean;
  recommendedTorch?: string;
  cudaVersion?: string;
  cpuOnly: boolean;
}

export interface GenerateResult {
  success: boolean;
  engine?: ImageEngine;
  imagePath?: string;
  prompt?: string;
  error?: string;
  message?: string;
}

// ─── Detection ─────────────────────────────────────────────────────────────

function tryExec(cmd: string, timeout = 5000): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout }).trim() || null;
  } catch { return null; }
}

export function detectGpu(): GpuInfo {
  // Find nvidia-smi — check PATH first, then known locations
  const nvidiaSmiPaths = [
    "nvidia-smi",                                           // in PATH
    "/usr/lib/wsl/lib/nvidia-smi",                         // WSL2
    "/usr/lib/wsl/drivers/*/nvidia-smi",                   // WSL2 driver dir
    "/mnt/c/Windows/System32/nvidia-smi.exe",              // Windows side
    "nvidia-smi.exe",                                       // Windows in PATH
    "/usr/bin/nvidia-smi",                                  // Linux standard
    "/usr/local/bin/nvidia-smi",                            // Linux local
  ];

  let nvidiaSmi: string | null = null;
  for (const smiPath of nvidiaSmiPaths) {
    if (smiPath.includes("*")) {
      // Glob — try to find it
      const found = tryExec(`ls ${smiPath} 2>/dev/null | head -1`);
      if (found) { nvidiaSmi = found; break; }
    } else {
      const test = tryExec(`${smiPath} --query-gpu=name --format=csv,noheader 2>/dev/null`);
      if (test) { nvidiaSmi = smiPath; break; }
    }
  }

  // If found but not in PATH, add it
  if (nvidiaSmi && nvidiaSmi !== "nvidia-smi" && !tryExec("nvidia-smi --version 2>/dev/null")) {
    const smiDir = nvidiaSmi.replace(/\/nvidia-smi.*$/, "");
    if (smiDir && !process.env.PATH?.includes(smiDir)) {
      process.env.PATH = `${smiDir}:${process.env.PATH}`;
    }
  }

  // Query GPU info
  let gpuName: string | undefined;
  let vram: string | undefined;
  let vramFree: string | undefined;
  let gpuTemp: string | undefined;
  let gpuUtil: string | undefined;
  let driverVersion: string | undefined;
  let gpuError: string | undefined;

  if (nvidiaSmi) {
    try {
      const info = tryExec(`${nvidiaSmi} --query-gpu=name,memory.total,memory.free,temperature.gpu,utilization.gpu,driver_version --format=csv,noheader,nounits 2>/dev/null`);
      if (info) {
        const parts = info.split(",").map(s => s.trim());
        gpuName = parts[0];
        vram = parts[1] ? `${parts[1]} MB` : undefined;
        vramFree = parts[2] ? `${parts[2]} MB` : undefined;
        gpuTemp = parts[3] ? `${parts[3]}°C` : undefined;
        gpuUtil = parts[4] ? `${parts[4]}%` : undefined;
        driverVersion = parts[5];
      }
    } catch (err) {
      gpuError = `nvidia-smi found but failed: ${err instanceof Error ? err.message : err}`;
    }

    // Check for GPU errors from nvidia-smi
    const errCheck = tryExec(`${nvidiaSmi} --query-gpu=gpu_bus_id,ecc.errors.corrected.aggregate.total --format=csv,noheader 2>/dev/null`);
    if (errCheck?.includes("ERR") || errCheck?.includes("Unknown Error")) {
      gpuError = "GPU reporting ECC errors — may be unstable";
    }

    // Check kernel log for GPU crashes (WSL dxg errors, Xid errors)
    const dmesgErrors = tryExec("dmesg 2>/dev/null | grep -ci 'dxgkio_reserve_gpu_va\\|xid.*error\\|nvrm.*error\\|gpu.*fault' 2>/dev/null");
    const crashCount = parseInt(dmesgErrors ?? "0") || 0;
    if (crashCount > 0) {
      // Get when the last error happened
      const lastError = tryExec("dmesg 2>/dev/null | grep -i 'dxgkio_reserve_gpu_va\\|xid.*error\\|nvrm.*error\\|gpu.*fault' | tail -1 | awk '{print $1}' | tr -d '[]'");
      const uptime = tryExec("cat /proc/uptime 2>/dev/null | awk '{print $1}'");
      let agoStr = "";
      if (lastError && uptime) {
        const errorSec = parseFloat(lastError);
        const uptimeSec = parseFloat(uptime);
        const agoSec = uptimeSec - errorSec;
        if (agoSec < 60) agoStr = `${Math.round(agoSec)}s ago`;
        else if (agoSec < 3600) agoStr = `${Math.round(agoSec / 60)} min ago`;
        else agoStr = `${(agoSec / 3600).toFixed(1)} hours ago`;
      }
      gpuError = (gpuError ? gpuError + ". " : "") +
        `${crashCount} GPU passthrough error(s) in WSL kernel log${agoStr ? ` (last: ${agoStr})` : ""}. GPU compute may crash — CPU mode recommended.`;
    }
  }

  // Check for WSL CUDA libs
  const wslCuda = existsSync("/usr/lib/wsl/lib/libcuda.so");

  // CUDA toolkit version
  const cuda = tryExec("nvcc --version 2>/dev/null");
  const cudaMatch = cuda?.match(/release ([\d.]+)/);
  // Also check nvidia-smi CUDA version
  const smiCuda = nvidiaSmi ? tryExec(`${nvidiaSmi} --query-gpu=driver_version --format=csv,noheader 2>/dev/null`) : null;

  const amd = tryExec("rocm-smi --showproductname 2>/dev/null");

  return {
    hasNvidia: !!nvidiaSmi,
    hasAmd: !!amd,
    gpuName,
    vram,
    vramFree,
    gpuTemp,
    gpuUtil,
    driverVersion,
    gpuError,
    wslCuda,
    cudaVersion: cudaMatch?.[1],
    maxCudaVersion: driverVersion ? getMaxCudaForDriver(parseFloat(driverVersion)) : undefined,
    recommendedTorch: driverVersion ? getRecommendedTorch(parseFloat(driverVersion)) : undefined,
    cpuOnly: !nvidiaSmi && !amd,
  };
}

function getMaxCudaForDriver(driverVer: number): string {
  // NVIDIA driver → max CUDA version mapping
  if (driverVer >= 570) return "13.0";
  if (driverVer >= 560) return "12.6";
  if (driverVer >= 550) return "12.4";
  if (driverVer >= 545) return "12.3";
  if (driverVer >= 535) return "12.2";
  if (driverVer >= 525) return "12.0";
  if (driverVer >= 520) return "11.8";
  if (driverVer >= 510) return "11.6";
  return "11.4";
}

function getRecommendedTorch(driverVer: number): string {
  // Recommend the right PyTorch CUDA version for this driver
  if (driverVer >= 570) return "cu130";
  if (driverVer >= 550) return "cu124";
  if (driverVer >= 535) return "cu121";
  if (driverVer >= 520) return "cu118";
  return "cpu";
}

export function detectImageEngines(): ImageEngineStatus[] {
  const engines: ImageEngineStatus[] = [];
  const isWSLEnv = (() => { try { return !!execSync("grep -qi microsoft /proc/version && echo wsl", { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 2000 }).trim(); } catch { return false; } })();
  const os = platform();

  // Check which ports are active
  const port7860Up = !!tryExec("curl -sf --max-time 2 http://localhost:7860/sdapi/v1/sd-models 2>/dev/null");
  const port8188Up = !!tryExec("curl -sf --max-time 2 http://localhost:8188/system_stats 2>/dev/null");
  const port9000Up = !!tryExec("curl -sf --max-time 2 http://localhost:9000/ping 2>/dev/null");

  // Detect what process owns port 7860
  const port7860Pid = tryExec("ss -tlnp 2>/dev/null | grep ':7860' | grep -oP 'pid=\\K[0-9]+'") ?? tryExec("lsof -ti:7860 2>/dev/null");
  const port7860Process = port7860Pid ? tryExec(`ps -p ${port7860Pid} -o comm= 2>/dev/null`) : null;
  const port7860IsWSL = port7860Pid ? !tryExec(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Get-Process -Id ${port7860Pid}" 2>/dev/null`) : true;

  // AUTOMATIC1111 / Forge (WSL installs)
  const SD_DIR = getAllKnownDirs("stable-diffusion-webui").find(d => existsSync(d) && existsSync(resolve(d, "webui.py"))) ?? getSDDir();
  const a1Installed = existsSync(SD_DIR) && existsSync(resolve(SD_DIR, "webui.py"));
  // Also check Forge
  const FORGE_DIR = getAllKnownDirs("sd-forge").find(d => existsSync(d) && existsSync(resolve(d, "launch.py"))) ?? resolve(getInstallBase(), "sd-forge");
  const forgeInstalled = existsSync(FORGE_DIR) && existsSync(resolve(FORGE_DIR, "launch.py"));
  const sdDir = forgeInstalled ? FORGE_DIR : (a1Installed ? SD_DIR : undefined);
  const sdPlatform = sdDir?.startsWith("/mnt/") ? "wsl" as const : (os === "win32" ? "windows" as const : "linux" as const);

  engines.push({
    engine: "auto1111",
    installed: !!(sdDir),
    running: port7860Up,
    path: sdDir,
    url: port7860Up ? "http://localhost:7860" : undefined,
    platform: sdPlatform,
    pid: port7860Pid ? parseInt(port7860Pid) : undefined,
    port: 7860,
  });

  // ComfyUI
  const COMFY_DIR = getAllKnownDirs("ComfyUI").find(d => existsSync(d) && existsSync(resolve(d, "main.py"))) ?? getComfyDir();
  const comfyInstalled = existsSync(COMFY_DIR) && existsSync(resolve(COMFY_DIR, "main.py"));
  engines.push({
    engine: "comfyui",
    installed: comfyInstalled,
    running: port8188Up,
    path: comfyInstalled ? COMFY_DIR : undefined,
    url: port8188Up ? "http://localhost:8188" : undefined,
    port: 8188,
  });

  // Fooocus
  const FOOOCUS_DIR = getAllKnownDirs("Fooocus").find(d => existsSync(d) && existsSync(resolve(d, "entry_with_update.py"))) ?? getFooocusDir();
  const fooocusInstalled = existsSync(FOOOCUS_DIR) && existsSync(resolve(FOOOCUS_DIR, "entry_with_update.py"));
  engines.push({
    engine: "fooocus",
    installed: fooocusInstalled,
    running: false,
    path: fooocusInstalled ? FOOOCUS_DIR : undefined,
  });

  // Stability Matrix — check both WSL-accessible and Windows paths
  const smDirs = [
    STABILITY_MATRIX_DIR,
    resolve(homedir(), "AppData", "Local", "StabilityMatrix"),
    resolve(homedir(), ".local", "share", "StabilityMatrix"),
    ...getAllKnownDirs("StabilityMatrix"),
  ];
  const smDir = smDirs.find(d => existsSync(d));
  const smPlatform = smDir?.startsWith("/mnt/") ? "windows" as const : (os === "win32" ? "windows" as const : "linux" as const);
  engines.push({
    engine: "stability-matrix",
    installed: !!smDir,
    running: port7860Up || port8188Up, // SM launches standard engines
    path: smDir,
    url: port7860Up ? "http://localhost:7860" : port8188Up ? "http://localhost:8188" : undefined,
    platform: smPlatform,
  });

  // Easy Diffusion
  const edDir = [
    EASY_DIFFUSION_DIR,
    resolve(homedir(), "EasyDiffusion"),
    resolve(homedir(), "easy_diffusion"),
  ].find(d => existsSync(d));
  engines.push({
    engine: "easy-diffusion",
    installed: !!edDir,
    running: port9000Up,
    path: edDir,
    url: port9000Up ? "http://localhost:9000" : undefined,
    port: 9000,
  });

  // Detect port conflicts — multiple engines trying to use same port
  const runningOn7860 = engines.filter(e => e.running && e.port === 7860);
  if (runningOn7860.length > 1) {
    for (const e of runningOn7860) e.portConflict = true;
  }

  // Docker
  const dockerSd = tryExec("docker ps --format '{{.Image}}' 2>/dev/null | grep -i 'stable-diffusion\\|automatic1111\\|comfyui'");
  engines.push({
    engine: "docker",
    installed: !!tryExec("docker --version"),
    running: !!dockerSd,
    url: dockerSd ? "http://localhost:7860" : undefined,
  });

  return engines;
}

export function getBestImageEngine(): ImageEngineStatus | null {
  const engines = detectImageEngines();
  // Prefer running engine first
  const running = engines.find(e => e.running);
  if (running) return running;
  // Then an SD engine that's actually installed (not just Docker being available)
  const installed = engines.find(e => e.installed && e.engine !== "docker");
  if (installed) return installed;
  // Docker only if it has the SD image already pulled
  const docker = engines.find(e => e.engine === "docker" && e.running);
  if (docker) return docker;
  // Don't return Docker just because Docker daemon exists — that's not an SD install
  return null;
}

// ─── Generation ────────────────────────────────────────────────────────────

export async function generateImage(prompt: string): Promise<GenerateResult> {
  const engine = getBestImageEngine();

  if (!engine || (!engine.running && !engine.installed)) {
    // No local engine — try cloud API (zero-install, free)
    console.error(`${c.cyan}Step 1/${c.reset} Checking for local image generators...`);
    console.error(`${c.dim}  No local engine found (AUTOMATIC1111, ComfyUI, Easy Diffusion, etc.)${c.reset}`);
    console.error(`${c.cyan}Step 2/${c.reset} Using cloud API — free, no setup required`);
    console.error(`${c.dim}  Sending prompt to Pollinations.ai (Stable Diffusion)...${c.reset}`);

    const cloudResult = await generateViaCloud(prompt);
    if (cloudResult.success) {
      console.error(`${c.cyan}Step 3/${c.reset} ${c.green}Image received — saving to disk${c.reset}`);
      return cloudResult;
    }

    console.error(`${c.yellow}Step 3/${c.reset} Cloud API unavailable — showing alternatives`);
    return {
      success: false,
      prompt,
      message: (cloudResult.error ? `${c.yellow}Cloud API:${c.reset} ${cloudResult.error}\n\n` : "") + formatNoEngineMessage(prompt),
    };
  }

  // If installed but not running — auto-start it, wait, then generate
  if (engine.installed && !engine.running) {
    console.error(`${c.cyan}Step 1/${c.reset} Found ${c.bold}${engine.engine}${c.reset} installed at ${engine.path}`);
    console.error(`${c.cyan}Step 2/${c.reset} Engine is not running — starting it automatically...`);
    const started = await autoStartEngine(engine);
    if (!started) {
      console.error(`${c.yellow}Step 3/${c.reset} Could not auto-start — trying cloud API as fallback`);
      const cloudFallback = await generateViaCloud(prompt);
      if (cloudFallback.success) return cloudFallback;
      return {
        success: false,
        engine: engine.engine,
        prompt,
        message: formatStartMessage(engine),
      };
    }
    console.error(`${c.cyan}Step 3/${c.reset} ${c.green}Engine started — generating image...${c.reset}`);
    // Re-detect to get the URL
    const refreshed = detectImageEngines().find(e => e.engine === engine.engine);
    if (refreshed?.running) {
      engine.running = true;
      engine.url = refreshed.url;
    }
  } else {
    console.error(`${c.cyan}Step 1/${c.reset} Using ${c.bold}${engine.engine}${c.reset} at ${engine.url}`);
    console.error(`${c.cyan}Step 2/${c.reset} Sending prompt to local engine...`);
  }

  // Engine is running — generate via API
  let genResult: GenerateResult | null = null;

  if (engine.engine === "auto1111" || (engine.engine === "docker" && engine.url?.includes("7860"))) {
    genResult = await generateViaAuto1111(prompt, engine.url ?? "http://localhost:7860");
  } else if (engine.engine === "comfyui") {
    genResult = await generateViaAuto1111(prompt, engine.url ?? "http://localhost:8188");
  } else if (engine.engine === "easy-diffusion") {
    genResult = await generateViaEasyDiffusion(prompt, engine.url ?? "http://localhost:9000");
  } else if (engine.engine === "stability-matrix") {
    if (engine.url?.includes("7860")) genResult = await generateViaAuto1111(prompt, engine.url);
    else if (engine.url?.includes("8188")) genResult = await generateViaAuto1111(prompt, engine.url);
  }

  if (genResult) {
    if (genResult.success) {
      console.error(`${c.cyan}Step 3/${c.reset} ${c.green}Image saved successfully${c.reset}`);
    }
    return genResult;
  }

  return { success: false, prompt, message: formatNoEngineMessage(prompt) };
}

// ─── Auto-Start ────────────────────────────────────────────────────────────

async function autoStartEngine(engine: ImageEngineStatus): Promise<boolean> {
  try {
    if (engine.engine === "auto1111" && engine.path) {
      // Check if model exists — if not, startup will take much longer
      const modelsDir = resolve(engine.path, "models", "Stable-diffusion");
      let hasModel = false;
      try {
        const files = readdirSync(modelsDir);
        hasModel = files.some(f => f.endsWith(".safetensors") || f.endsWith(".ckpt"));
      } catch {}

      // Health check: fix corrupted packages from interrupted installs
      try {
        const spDir = resolve(engine.path, "venv", "lib");
        const pyDirs = readdirSync(spDir).filter(d => d.startsWith("python"));
        for (const pyDir of pyDirs) {
          const pkgDir = resolve(spDir, pyDir, "site-packages");
          try {
            const corrupted = readdirSync(pkgDir).filter(e => e.startsWith("~"));
            if (corrupted.length > 0) {
              console.error(`${c.yellow}Fixing ${corrupted.length} corrupted package(s)...${c.reset}`);
              const { rmSync } = await import("node:fs");
              for (const dir of corrupted) {
                try { rmSync(resolve(pkgDir, dir), { recursive: true }); } catch {}
              }
            }
          } catch {}
        }
      } catch {}

      const timeout = hasModel ? 180 : 600; // 3 min with model, 10 min without
      console.error(`${c.dim}Starting Stable Diffusion...${hasModel ? "" : " (first launch — downloading model, this takes several minutes)"}${c.reset}`);

      const { spawn } = await import("node:child_process");
      const venvPython = resolve(engine.path, "venv", "bin", "python");
      const winVenvPython = resolve(engine.path, "venv", "Scripts", "python.exe");
      const pythonCmd = existsSync(venvPython) ? venvPython : existsSync(winVenvPython) ? winVenvPython : "python3";

      // Force CPU mode — disable CUDA completely to avoid DXG GPU errors on WSL
      const cpuEnv = {
        ...process.env,
        CUDA_VISIBLE_DEVICES: "",           // hide all GPUs
        TORCH_CUDA_ARCH_LIST: "",           // no CUDA architectures
        COMMANDLINE_ARGS: "--api --listen --skip-torch-cuda-test --use-cpu all --no-half",
      };

      const child = spawn(pythonCmd, ["launch.py", "--api", "--listen", "--skip-torch-cuda-test", "--use-cpu", "all", "--no-half"], {
        cwd: engine.path,
        detached: true,
        stdio: "ignore",
        env: cpuEnv,
      });
      child.unref();
      return waitForReady("http://localhost:7860/sdapi/v1/sd-models", timeout);
    }

    if (engine.engine === "comfyui" && engine.path) {
      console.error(`${c.dim}Starting ComfyUI...${c.reset}`);
      const { spawn } = await import("node:child_process");
      const child = spawn("python3", ["main.py", "--listen"], {
        cwd: engine.path,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return waitForReady("http://localhost:8188/system_stats", 90);
    }

    if (engine.engine === "fooocus" && engine.path) {
      console.error(`${c.dim}Starting Fooocus...${c.reset}`);
      const { spawn } = await import("node:child_process");
      const child = spawn("python3", ["entry_with_update.py"], {
        cwd: engine.path,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      // Fooocus doesn't have a reliable API — just wait a bit
      await sleep(15000);
      return true;
    }

    if (engine.engine === "docker") {
      console.error(`${c.dim}Starting Docker SD container...${c.reset}`);
      const gpu = detectGpu();
      const gpuFlag = gpu.hasNvidia ? "--gpus all" : "";
      const envFlag = gpu.cpuOnly ? "-e COMMANDLINE_ARGS='--use-cpu all --skip-torch-cuda-test --no-half'" : "";
      tryExec(`docker start sd-webui 2>/dev/null`) ??
        tryExec(`docker run -d ${gpuFlag} -p 7860:7860 --name sd-webui ${envFlag} ghcr.io/ai-dock/stable-diffusion-webui:latest`);
      return waitForReady("http://localhost:7860/sdapi/v1/sd-models", 120);
    }

    return false;
  } catch {
    return false;
  }
}

async function waitForReady(url: string, timeoutSeconds: number): Promise<boolean> {
  const start = Date.now();
  const deadline = start + timeoutSeconds * 1000;
  let dots = 0;

  while (Date.now() < deadline) {
    const check = tryExec(`curl -sf --max-time 2 "${url}" 2>/dev/null`, 3000);
    if (check) {
      console.error(`${c.green}✓${c.reset} Ready! (${((Date.now() - start) / 1000).toFixed(0)}s)`);
      return true;
    }
    dots++;
    if (dots % 5 === 0) {
      const elapsed = ((Date.now() - start) / 1000).toFixed(0);
      console.error(`${c.dim}  Waiting for engine to start... (${elapsed}s)${c.reset}`);
    }
    await sleep(3000);
  }

  console.error(`${c.yellow}⚠${c.reset} Engine not ready after ${timeoutSeconds}s — still loading in the background.`);
  console.error(`${c.dim}  First launch downloads the AI model (~4GB) — this can take 5-10 minutes.${c.reset}`);
  console.error(`${c.dim}  The engine is still starting in the background.${c.reset}`);
  console.error(`${c.dim}  Say "check image status" to see if it's ready, or we'll use cloud for now.${c.reset}`);

  // Store pending action for "is it ready yet"
  const { suggestAction } = await import("../conversation/pendingActions.js");
  suggestAction({
    action: "generate a picture of a cat",
    description: "Try generating locally — engine may be ready now",
    type: "intent",
  });

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/** Check if a path is a Windows drive accessed through WSL */
function isWslWindowsPath(path: string): boolean {
  return path.startsWith("/mnt/") && /^\/mnt\/[a-z]\//.test(path);
}

/** Convert WSL path to Windows path */
function toWindowsPath(wslPath: string): string {
  try {
    return execSync(`wslpath -w "${wslPath}" 2>/dev/null`, { encoding: "utf-8", timeout: 3000 }).trim();
  } catch {
    // Manual conversion: /mnt/d/foo → D:\foo
    const match = wslPath.match(/^\/mnt\/([a-z])\/(.*)$/);
    if (match) return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
    return wslPath;
  }
}

/**
 * Run a command on the Windows side via PowerShell (faster for Windows drives).
 * Falls back to WSL-native execution if PowerShell not available.
 */
async function runOnWindowsSide(cmd: string, cwd: string): Promise<void> {
  const winCwd = toWindowsPath(cwd);
  const psCmd = `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe`;

  try {
    const { spawn: spawnAsync } = await import("node:child_process");
    return new Promise((resolve, reject) => {
      const child = spawnAsync(psCmd, ["-Command", `cd '${winCwd}'; ${cmd}`], {
        stdio: ["ignore", "pipe", "pipe"],
      });

      child.stdout?.on("data", (d: Buffer) => {
        const lines = d.toString().split("\n").filter((l: string) => l.trim());
        for (const line of lines) {
          process.stderr.write(`  ${c.dim}${line.trim()}${c.reset}\n`);
        }
      });
      child.stderr?.on("data", (d: Buffer) => {
        const lines = d.toString().split("\n").filter((l: string) => l.trim());
        for (const line of lines) {
          process.stderr.write(`  ${c.dim}${line.trim()}${c.reset}\n`);
        }
      });

      child.on("close", (code) => code === 0 ? resolve() : reject(new Error(`PowerShell exit ${code}`)));
      child.on("error", reject);
    });
  } catch (err) {
    throw new Error(`Windows-side execution failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Run a command with streaming output. For short commands, runs inline.
 * For long commands (pip install torch), runs as detached background process
 * with log file monitoring — survives parent process timeouts.
 */
async function runWithProgress(cmd: string, args: string[], cwd: string): Promise<void> {
  const { spawn: spawnAsync } = await import("node:child_process");
  const isLongRunning = args.some(a => a.includes("torch") || a.includes("requirements"));
  const logFile = resolve(USER_HOME, ".install-progress.log");

  if (isLongRunning) {
    // Long-running: spawn detached with log file, then poll for completion
    console.error(`${c.dim}  Running in background (logging to ${logFile})...${c.reset}`);

    // Write a shell script that runs the command and writes a status file
    const statusFile = resolve(USER_HOME, ".install-status");
    const script = `#!/bin/bash
${cmd} ${args.map(a => `'${a}'`).join(" ")} > "${logFile}" 2>&1
echo $? > "${statusFile}"
`;
    const scriptFile = resolve(USER_HOME, ".install-run.sh");
    writeFileSync(scriptFile, script, { mode: 0o755 });

    // Remove old status file
    try { (await import("node:fs")).unlinkSync(statusFile); } catch {}

    // Spawn detached — survives parent timeout
    const child = spawnAsync("bash", [scriptFile], {
      cwd,
      detached: true,
      stdio: "ignore",
    });
    child.unref();

    // Poll for completion by watching the status file
    const startTime = Date.now();
    const maxWait = 30 * 60 * 1000; // 30 minutes max

    while (Date.now() - startTime < maxWait) {
      await sleep(5000);

      // Show latest log lines
      try {
        const log = readFileSync(logFile, "utf-8");
        const lines = log.split("\n").filter(l => l.trim());
        const recent = lines.slice(-3);
        for (const line of recent) {
          if (line.includes("Downloading") || line.includes("Installing") ||
              line.includes("Collecting") || line.includes("Successfully") ||
              line.includes("━") || line.includes("%") || line.includes("error")) {
            process.stderr.write(`  ${c.dim}${line.trim()}${c.reset}\n`);
          }
        }
      } catch {}

      // Check if done
      try {
        if (existsSync(statusFile)) {
          const exitCode = parseInt(readFileSync(statusFile, "utf-8").trim());
          if (exitCode === 0) {
            console.error(`${c.green}  ✓ Complete${c.reset}`);
            return;
          } else {
            const log = readFileSync(logFile, "utf-8");
            const lastLines = log.split("\n").filter(l => l.trim()).slice(-5).join("\n");
            throw new Error(`Command failed (exit ${exitCode}): ${lastLines}`);
          }
        }
      } catch (err) {
        if (err instanceof Error && err.message.startsWith("Command failed")) throw err;
      }

      // Show elapsed time every 30s
      const elapsed = Math.round((Date.now() - startTime) / 1000);
      if (elapsed % 30 === 0) {
        console.error(`${c.dim}  Still working... (${elapsed}s elapsed)${c.reset}`);
      }
    }

    throw new Error("Install timed out after 30 minutes");
  }

  // Short-running: inline with streaming output
  return new Promise((resolve, reject) => {
    const child = spawnAsync(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "pipe"],
      shell: false,
    });

    let lastLine = "";
    const handleData = (data: Buffer) => {
      const lines = data.toString().split("\n").filter(l => l.trim());
      for (const line of lines) {
        lastLine = line;
        if (line.includes("Downloading") || line.includes("Installing") ||
            line.includes("Collecting") || line.includes("Successfully") ||
            line.includes("━") || line.includes("error") || line.includes("ERROR") ||
            line.includes("%") || line.includes("curl")) {
          process.stderr.write(`  ${c.dim}${line.trim()}${c.reset}\n`);
        }
      }
    };

    child.stdout?.on("data", handleData);
    child.stderr?.on("data", handleData);

    child.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Command failed (exit ${code}): ${lastLine}`));
    });

    child.on("error", (err) => reject(err));
  });
}

// ─── Cloud API (free, no install, no auth) ─────────────────────────────────

async function generateViaCloud(prompt: string): Promise<GenerateResult> {
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const timestamp = Date.now();
    const safeName = prompt.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
    const imagePath = resolve(OUTPUT_DIR, `${safeName}_${timestamp}.png`);

    // Pollinations.ai — free, no auth, Stable Diffusion
    const encodedPrompt = encodeURIComponent(prompt);
    const url = `https://image.pollinations.ai/prompt/${encodedPrompt}`;

    console.error(`${c.dim}  Prompt: "${prompt}"${c.reset}`);
    console.error(`${c.dim}  Waiting for image (10-30 seconds)...${c.reset}`);

    const { execSync: exec } = await import("node:child_process");
    // Retry up to 3 times — Pollinations sometimes returns 502 on first try
    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        exec(`curl -sL --max-time 120 "${url}" -o "${imagePath}"`, { timeout: 130000 });
        const s = (await import("node:fs")).statSync(imagePath);
        if (s.size > 1000) { success = true; break; }
      } catch {}
      if (attempt < 2) console.error(`${c.dim}  Server busy — retrying (attempt ${attempt + 2}/3)...${c.reset}`);
    }
    if (!success) return { success: false, prompt, error: "Image generation timed out after 3 attempts. The cloud service may be busy — try again in a moment." };

    if (!existsSync(imagePath)) {
      return { success: false, prompt, error: "Image generation failed — no file returned" };
    }

    const { statSync: stat } = await import("node:fs");
    const size = stat(imagePath).size;

    if (size < 1000) {
      // Too small — probably an error response
      return { success: false, prompt, error: "Image generation returned an empty or error response" };
    }

    const stats = recordGeneration(false);
    const usageLine = `  ${c.dim}Cloud images generated: ${stats.cloudGenerations} | Total: ${stats.totalGenerations}${c.reset}`;
    const apiLine = stats.apiKey?.configured
      ? `  ${c.green}✓ API key configured (${stats.apiKey.provider})${c.reset}`
      : `  ${c.dim}Tip: For faster generation, set an API key:${c.reset}\n  ${c.dim}  HuggingFace (free): https://huggingface.co/settings/tokens → export HF_TOKEN=hf_...${c.reset}\n  ${c.dim}  Stability AI: https://platform.stability.ai/account/keys → export STABILITY_API_KEY=sk-...${c.reset}`;
    const localLine = `  ${c.dim}To create images offline for free: notoken install stability-matrix${c.reset}`;

    return {
      success: true,
      engine: "auto1111",
      prompt,
      imagePath,
      message: `${c.green}✓${c.reset} Image generated!\n  ${c.bold}Prompt:${c.reset} ${prompt}\n  ${c.bold}Saved:${c.reset} ${imagePath}\n  ${c.bold}Size:${c.reset} ${(size / 1024).toFixed(0)} KB\n\n${usageLine}\n${apiLine}\n${localLine}`,
    };
  } catch (err) {
    return { success: false, prompt, error: `Cloud generation failed: ${err instanceof Error ? err.message : err}` };
  }
}

// ─── Easy Diffusion API ────────────────────────────────────────────────────

async function generateViaEasyDiffusion(prompt: string, baseUrl: string): Promise<GenerateResult> {
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });
    const timestamp = Date.now();
    const safeName = prompt.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
    const imagePath = resolve(OUTPUT_DIR, `${safeName}_${timestamp}.png`);

    const payload = JSON.stringify({
      prompt,
      negative_prompt: "blurry, bad quality, distorted",
      width: 512, height: 512,
      num_inference_steps: 20,
      guidance_scale: 7,
    });

    const result = tryExec(`curl -sf --max-time 120 -X POST "${baseUrl}/image" -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`, 130000);
    if (!result) return { success: false, prompt, error: "Easy Diffusion generation timed out" };

    const data = JSON.parse(result);
    if (!data.output?.[0]?.data) return { success: false, prompt, error: "No image returned" };

    const imgData = data.output[0].data.replace(/^data:image\/\w+;base64,/, "");
    const buffer = Buffer.from(imgData, "base64");
    writeFileSync(imagePath, buffer);

    return {
      success: true, engine: "easy-diffusion", prompt, imagePath,
      message: `${c.green}✓${c.reset} Image generated (Easy Diffusion)!\n  ${c.bold}Prompt:${c.reset} ${prompt}\n  ${c.bold}Saved:${c.reset} ${imagePath}\n  ${c.bold}Size:${c.reset} ${(buffer.length / 1024).toFixed(0)} KB`,
    };
  } catch (err) {
    return { success: false, prompt, error: `Easy Diffusion failed: ${err instanceof Error ? err.message : err}` };
  }
}

// ─── API Generation ────────────────────────────────────────────────────────

async function generateViaAuto1111(prompt: string, baseUrl: string): Promise<GenerateResult> {
  try {
    mkdirSync(OUTPUT_DIR, { recursive: true });

    // Detect GPU/CPU mode
    const cmdFlags = tryExec(`curl -sf --max-time 3 "${baseUrl}/sdapi/v1/cmd-flags" 2>/dev/null`);
    const isGpuMode = cmdFlags ? !cmdFlags.includes('"skip_torch_cuda_test":true') : false;
    const gpu = detectGpu();
    const modeStr = isGpuMode && gpu.hasNvidia ? `GPU (${gpu.gpuName})` : "CPU";

    console.error(`${c.dim}  Mode: ${modeStr}${c.reset}`);
    console.error(`${c.dim}  Prompt: "${prompt}"${c.reset}`);
    console.error(`${c.dim}  Generating (512x512, 20 steps)...${c.reset}`);

    const payload = JSON.stringify({
      prompt,
      negative_prompt: "blurry, bad quality, distorted, watermark, text",
      steps: 20,
      cfg_scale: 7,
      width: 512,
      height: 512,
      sampler_name: "Euler a",
    });

    // Start generation in background via async fetch
    const { spawn: spawnProc } = await import("node:child_process");
    const tmpResult = resolve(OUTPUT_DIR, `.gen-result-${Date.now()}.json`);
    const curlProc = spawnProc("curl", [
      "-sf", "--max-time", "300",
      "-X", "POST", `${baseUrl}/sdapi/v1/txt2img`,
      "-H", "Content-Type: application/json",
      "-d", payload,
      "-o", tmpResult,
    ], { stdio: "ignore", detached: false });

    // Poll progress while generating
    const startTime = Date.now();
    let lastStep = -1;
    while (!existsSync(tmpResult) || getFileSize(tmpResult) === 0) {
      await sleep(2000);

      // Check progress API
      const prog = tryExec(`curl -sf --max-time 2 "${baseUrl}/sdapi/v1/progress" 2>/dev/null`);
      if (prog) {
        try {
          const p = JSON.parse(prog);
          const pct = Math.round((p.progress ?? 0) * 100);
          const step = p.state?.sampling_step ?? 0;
          const steps = p.state?.sampling_steps ?? 20;
          if (step !== lastStep && step > 0) {
            const bar = "█".repeat(Math.round(pct / 5)) + "░".repeat(20 - Math.round(pct / 5));
            console.error(`  ${c.cyan}${bar}${c.reset} ${pct}% (step ${step}/${steps})`);
            lastStep = step;
          }
        } catch {}
      }

      // Timeout check
      if (Date.now() - startTime > 300000) {
        try { curlProc.kill(); } catch {}
        return { success: false, prompt, error: "Generation timed out after 5 minutes" };
      }
    }

    // Wait a bit for file to finish writing
    await sleep(500);

    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const resultData = readFileSync(tmpResult, "utf-8");
    try { removeFile(tmpResult); } catch {}

    if (!resultData || resultData.length < 100) {
      return { success: false, prompt, error: "Generation returned empty response" };
    }

    const data = JSON.parse(resultData);
    if (!data.images?.[0]) {
      return { success: false, prompt, error: "No image returned from API" };
    }

    // Save base64 image
    const timestamp = Date.now();
    const safeName = prompt.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
    const imagePath = resolve(OUTPUT_DIR, `${safeName}_${timestamp}.png`);
    const buffer = Buffer.from(data.images[0], "base64");
    writeFileSync(imagePath, buffer);

    const stats = recordGeneration(true);

    return {
      success: true,
      engine: "auto1111",
      prompt,
      imagePath,
      message: [
        `${c.green}✓${c.reset} Image generated locally in ${elapsed}s (${modeStr})`,
        `  ${c.bold}Prompt:${c.reset} ${prompt}`,
        `  ${c.bold}Saved:${c.reset} ${imagePath}`,
        `  ${c.bold}Size:${c.reset} ${(buffer.length / 1024).toFixed(0)} KB`,
        `  ${c.dim}Local: ${stats.localGenerations} | Cloud: ${stats.cloudGenerations} | Total: ${stats.totalGenerations}${c.reset}`,
      ].join("\n"),
    };
  } catch (err) {
    return { success: false, prompt, error: `Generation failed: ${err instanceof Error ? err.message : err}` };
  }
}

function getFileSize(filePath: string): number {
  try { return statSync(filePath).size; } catch { return 0; }
}

function removeFile(filePath: string): void {
  try { writeFileSync(filePath, ""); } catch {}
}

// ─── Installation ──────────────────────────────────────────────────────────

export interface InstallPlan {
  engine: string;
  steps: string[];
  requirements: string[];
  estimatedTime: string;
  diskSpace: string;
}

export function getInstallPlan(engine: "auto1111" | "comfyui" | "fooocus" | "docker"): InstallPlan {
  const gpu = detectGpu();
  const torchExtra = gpu.hasNvidia ? "+cu121" : gpu.hasAmd ? "+rocm5.7" : "+cpu";

  const plans: Record<string, InstallPlan> = {
    auto1111: {
      engine: "AUTOMATIC1111 (Stable Diffusion Web UI)",
      requirements: ["Python 3.10+", "git", gpu.hasNvidia ? `NVIDIA GPU (${gpu.gpuName})` : "CPU (slow)"],
      estimatedTime: gpu.hasNvidia ? "10-20 minutes" : "15-30 minutes",
      diskSpace: "~10 GB (with model)",
      steps: [
        `git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui.git ${getSDDir()}`,
        `cd ${getSDDir()} && python3 -m venv venv && source venv/bin/activate`,
        `pip install torch torchvision --index-url https://download.pytorch.org/whl/${torchExtra.replace("+", "")}`,
        `cd ${getSDDir()} && bash webui.sh --api --listen`,
      ],
    },
    comfyui: {
      engine: "ComfyUI (Node-based workflow UI)",
      requirements: ["Python 3.10+", "git", gpu.hasNvidia ? `NVIDIA GPU (${gpu.gpuName})` : "CPU"],
      estimatedTime: "10-15 minutes",
      diskSpace: "~8 GB (with model)",
      steps: [
        `git clone https://github.com/comfyanonymous/ComfyUI.git ${getComfyDir()}`,
        `cd ${getComfyDir()} && python3 -m venv venv && source venv/bin/activate`,
        `pip install torch torchvision --index-url https://download.pytorch.org/whl/${torchExtra.replace("+", "")}`,
        `pip install -r requirements.txt`,
        `python3 main.py --listen`,
      ],
    },
    fooocus: {
      engine: "Fooocus (Simplest — one-click style)",
      requirements: ["Python 3.10+", "git", gpu.hasNvidia ? `NVIDIA GPU (${gpu.gpuName})` : "CPU"],
      estimatedTime: "10-15 minutes",
      diskSpace: "~10 GB (with model)",
      steps: [
        `git clone https://github.com/lllyasviel/Fooocus.git ${getFooocusDir()}`,
        `cd ${getFooocusDir()} && python3 -m venv venv && source venv/bin/activate`,
        `pip install -r requirements_versions.txt`,
        `python3 entry_with_update.py`,
      ],
    },
    docker: {
      engine: "Docker (Containerized — no dependency headaches)",
      requirements: ["Docker", gpu.hasNvidia ? "NVIDIA Container Toolkit" : "CPU mode"],
      estimatedTime: "5-10 minutes (pull only)",
      diskSpace: "~15 GB",
      steps: gpu.hasNvidia
        ? [
            "docker pull ghcr.io/ai-dock/stable-diffusion-webui:latest",
            "docker run -d --gpus all -p 7860:7860 --name sd-webui ghcr.io/ai-dock/stable-diffusion-webui:latest",
          ]
        : [
            "docker pull ghcr.io/ai-dock/stable-diffusion-webui:latest",
            "docker run -d -p 7860:7860 --name sd-webui -e COMMANDLINE_ARGS='--use-cpu all --skip-torch-cuda-test --no-half' ghcr.io/ai-dock/stable-diffusion-webui:latest",
          ],
    },
  };

  return plans[engine];
}

export async function installImageEngine(engine: "auto1111" | "comfyui" | "fooocus" | "docker"): Promise<{ success: boolean; message: string }> {
  const gpu = detectGpu();
  const os = (await import("node:os")).platform();
  const isWSL = !!tryExec("grep -qi microsoft /proc/version && echo wsl");

  // ── Docker path ──
  if (engine === "docker") {
    if (!tryExec("docker --version")) {
      console.log(`${c.cyan}Step 1/${c.reset} Docker not found — installing...`);
      try {
        execSync("curl -fsSL https://get.docker.com | sh", { stdio: "inherit", timeout: 300000 });
      } catch {
        return { success: false, message: `Could not install Docker. Run: notoken install docker` };
      }
    }
    // Check disk space where Docker stores data
    try {
      const dockerRoot = tryExec("docker info 2>/dev/null | grep 'Docker Root Dir' | awk '{print $NF}'") ?? "/var/lib/docker";
      const dockerDrive = getDriveInfo(dockerRoot);
      if (dockerDrive) {
        console.log(`${c.cyan}Step 1b/${c.reset} Docker data: ${dockerRoot} (${dockerDrive.freeGB}GB free)`);
        if (dockerDrive.freeGB < 16) {
          console.log(`${c.yellow}⚠ Only ${dockerDrive.freeGB}GB free where Docker stores data (${dockerRoot}).${c.reset}`);
          console.log(`${c.yellow}  The SD Docker image needs ~15GB. Not enough space.${c.reset}`);
          return { success: false, message: [
            `Not enough space for Docker image (${dockerDrive.freeGB}GB free, need ~15GB).`,
            `Docker stores data at: ${dockerRoot}`,
            ``,
            `${c.bold}Options:${c.reset}`,
            `  1. Free up space on C: drive`,
            `  2. Use Python install instead (installs on any drive):`,
            `     ${c.cyan}notoken install stable-diffusion on D drive${c.reset}`,
            `  3. Move Docker data root manually:`,
            `     ${c.dim}echo '{"data-root":"/mnt/d/docker-data"}' | sudo tee /etc/docker/daemon.json${c.reset}`,
            `     ${c.dim}sudo service docker restart${c.reset}`,
          ].join("\n") };
        }
      }
    } catch {}

    try {
      console.log(`${c.cyan}Step 2/${c.reset} Pulling Stable Diffusion Docker image (~15GB)...`);
      console.log(`${c.dim}  This may take 10-30 minutes depending on connection speed.${c.reset}`);
      execSync("docker pull ghcr.io/ai-dock/stable-diffusion-webui:latest", { stdio: "inherit", timeout: 600000 });
      const gpuFlag = gpu.hasNvidia ? "--gpus all" : "";
      const envFlag = gpu.cpuOnly ? "-e COMMANDLINE_ARGS='--use-cpu all --skip-torch-cuda-test --no-half'" : "";
      console.log(`${c.cyan}Step 3/${c.reset} Starting container...`);
      execSync(`docker run -d ${gpuFlag} -p 7860:7860 --name sd-webui ${envFlag} ghcr.io/ai-dock/stable-diffusion-webui:latest`, { stdio: "inherit", timeout: 30000 });
      trackInstall({
        name: "stable-diffusion-docker",
        type: "docker-image",
        method: "docker-pull",
        path: tryExec("docker info 2>/dev/null | grep 'Docker Root Dir' | awk '{print $NF}'") ?? "/var/lib/docker",
        uninstallCmd: "docker stop sd-webui && docker rm sd-webui && docker rmi ghcr.io/ai-dock/stable-diffusion-webui:latest",
        notes: "Container: sd-webui at localhost:7860",
      });
      return { success: true, message: `${c.green}✓${c.reset} Stable Diffusion running in Docker at ${c.bold}http://localhost:7860${c.reset}` };
    } catch (err) {
      return { success: false, message: `Docker install failed: ${err instanceof Error ? err.message : err}` };
    }
  }

  // ── Windows (no WSL) — Stability Matrix first, then Python ──
  if (os === "win32") {
    console.log(`${c.cyan}Step 0/${c.reset} Windows detected — using Stability Matrix (zero dependencies)`);
    const smResult = await installStabilityMatrix("win32");
    if (smResult.success) return smResult;
    // Fall back to Python install if SM failed
    console.log(`${c.dim}Stability Matrix failed — falling back to Python install...${c.reset}`);
    return installOnWindows(engine, gpu);
  }

  // ── WSL — Stability Matrix first, then Python ──
  if (isWSL) {
    console.log(`${c.cyan}Step 0/${c.reset} WSL detected`);
    // Check if Stability Matrix already installed on Windows side
    const smDir = ["/mnt/d/notoken/ai/StabilityMatrix", "/mnt/c/notoken/ai/StabilityMatrix"].find(d => existsSync(d));
    if (!smDir) {
      console.log(`${c.dim}  Installing Stability Matrix on Windows side (no pip/Python headaches)...${c.reset}`);
      const smResult = await installStabilityMatrix("wsl");
      if (smResult.success) return smResult;
      console.log(`${c.dim}  SM failed — falling back to WSL Python install...${c.reset}`);
    } else {
      console.log(`${c.green}  ✓ Stability Matrix found at ${smDir}${c.reset}`);
      // Launch it
      try {
        const winPath = tryExec(`wslpath -w "${smDir}" 2>/dev/null`);
        if (winPath) {
          execSync(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process '${winPath}\\StabilityMatrix.exe'" 2>/dev/null`, { stdio: "ignore", timeout: 10000 });
          const gpuRec = detectGpu();
          const dv = parseFloat(gpuRec.driverVersion ?? "0");
          const pkgRec = dv > 0 && dv < 570
            ? `\n  ${c.yellow}⚠ Your GPU driver (${gpuRec.driverVersion}) does NOT support Forge Neo (needs driver 570+).${c.reset}\n  ${c.bold}Choose "Reforge" — it works with your driver (CUDA ${gpuRec.maxCudaVersion}).${c.reset}\n  ${c.dim}Do NOT choose "Forge Neo" — it will fail.${c.reset}`
            : `\n  ${c.bold}Choose "Forge Neo" for best performance.${c.reset}`;
          return { success: true, message: `${c.green}✓${c.reset} Stability Matrix launched!${pkgRec}\n  SM downloads everything automatically. Click "Launch" when ready.\n  ${c.dim}Then say "generate a picture of a cat"${c.reset}` };
        }
      } catch {}
    }
  }

  // ── WSL — check if better to install on Windows side ──
  if (isWSL) {
    console.log(`${c.cyan}Step 0/${c.reset} WSL detected — installing inside WSL (GPU passthrough supported)`);
  }

  // Show disk space reasoning
  {
    const choice = chooseBestInstallDir();
    const actualBase = process.env.NOTOKEN_INSTALL_DIR ?? choice.dir;
    const actualFree = getDriveFreeGB(actualBase);

    console.log(`${c.cyan}Disk/${c.reset} ${c.bold}Evaluating disk space...${c.reset}`);
    for (const cand of choice.candidates) {
      const icon = cand.rejected ? `${c.dim}✗${c.reset}` : `${c.green}✓${c.reset}`;
      const note = cand.rejected ? ` ${c.dim}— ${cand.rejected}${c.reset}` : "";
      console.log(`  ${icon} ${cand.path}: ${cand.freeGB}GB free${note}`);
    }
    console.log(`${c.cyan}     ${c.reset} ${c.dim}${choice.reasoning}${c.reset}`);
    console.log(`${c.cyan}Disk/${c.reset} Installing to: ${c.bold}${actualBase}${c.reset} (${actualFree}GB free)`);

    if (actualFree < 10) {
      console.log(`${c.red}⚠ WARNING: Only ${actualFree}GB free — need ~10GB for Stable Diffusion${c.reset}`);
      if (actualFree < 5) {
        return {
          success: false,
          message: [
            `${c.red}✗ Not enough disk space (${actualFree}GB free, need 10GB).${c.reset}`,
            ``,
            `${c.bold}To install on a different drive, say:${c.reset}`,
            `  ${c.cyan}"install stable diffusion on F drive"${c.reset}`,
            `  ${c.cyan}"install stable diffusion on /mnt/f"${c.reset}`,
            `  Or set: ${c.dim}NOTOKEN_INSTALL_DIR=/mnt/f/apps notoken install stable-diffusion${c.reset}`,
          ].join("\n"),
        };
      }
    }
    console.log(`${c.dim}To change location: "put it on F drive" or "install stable diffusion on F drive"${c.reset}\n`);

    // Store as pending action so user can say "put it on F drive"
    const { suggestAction: suggest } = await import("../conversation/pendingActions.js");
    suggest({
      action: `install stable diffusion`,
      description: `Install Stable Diffusion at ${actualBase}`,
      type: "intent",
    });
  }

  // ── Linux / WSL / macOS — install prerequisites then engine ──

  // Step 1: git
  if (!tryExec("git --version")) {
    console.log(`${c.cyan}Step 1/${c.reset} Installing git...`);
    try {
      if (tryExec("apt-get --version")) {
        execSync("apt-get update -qq && apt-get install -y -qq git", { stdio: "inherit", timeout: 120000 });
      } else if (tryExec("dnf --version")) {
        execSync("dnf install -y git", { stdio: "inherit", timeout: 120000 });
      } else if (tryExec("brew --version")) {
        execSync("brew install git", { stdio: "inherit", timeout: 120000 });
      } else {
        return { success: false, message: "Cannot auto-install git. Install it manually first." };
      }
    } catch (err) {
      return { success: false, message: `Failed to install git: ${err instanceof Error ? err.message : err}` };
    }
  } else {
    console.log(`${c.cyan}Step 1/${c.reset} ${c.green}git found${c.reset} — ${tryExec("git --version")}`);
  }

  // Step 2: Python 3.10+
  let pythonCmd = tryExec("python3 --version") ? "python3" : tryExec("python --version") ? "python" : null;
  const pyVersion = pythonCmd ? tryExec(`${pythonCmd} --version`) : null;
  const pyMatch = pyVersion?.match(/(\d+)\.(\d+)/);
  const pyOk = pyMatch && parseInt(pyMatch[1]) >= 3 && parseInt(pyMatch[2]) >= 10;

  if (!pyOk) {
    console.log(`${c.cyan}Step 2/${c.reset} Installing Python 3.11...`);
    try {
      if (tryExec("apt-get --version")) {
        execSync("apt-get update -qq && apt-get install -y -qq python3.11 python3.11-venv python3-pip", { stdio: "inherit", timeout: 120000 });
        pythonCmd = "python3.11";
      } else if (tryExec("dnf --version")) {
        execSync("dnf install -y python3.11 python3.11-pip", { stdio: "inherit", timeout: 120000 });
        pythonCmd = "python3.11";
      } else if (tryExec("brew --version")) {
        execSync("brew install python@3.11", { stdio: "inherit", timeout: 120000 });
        pythonCmd = "python3.11";
      } else {
        return { success: false, message: "Cannot auto-install Python. Install Python 3.10+ manually." };
      }
    } catch (err) {
      return { success: false, message: `Failed to install Python: ${err instanceof Error ? err.message : err}` };
    }
  } else {
    console.log(`${c.cyan}Step 2/${c.reset} ${c.green}Python found${c.reset} — ${pyVersion}`);
  }

  // Step 3: pip/venv
  if (!tryExec(`${pythonCmd} -m venv --help 2>/dev/null`)) {
    console.log(`${c.cyan}Step 3/${c.reset} Installing python3-venv...`);
    try {
      if (tryExec("apt-get --version")) {
        execSync(`apt-get install -y -qq python3-venv python3-full 2>/dev/null || apt-get install -y -qq python3.11-venv 2>/dev/null || true`, { stdio: "inherit", timeout: 60000 });
      }
    } catch {}
  } else {
    console.log(`${c.cyan}Step 3/${c.reset} ${c.green}venv available${c.reset}`);
  }

  // Step 3b: Build tools (needed for scikit-image, tokenizers, scipy, etc.)
  {
    const hasGcc = !!tryExec("gcc --version 2>/dev/null");
    const hasCmake = !!tryExec("cmake --version 2>/dev/null");
    const hasRust = !!tryExec("cargo --version 2>/dev/null") || !!tryExec(". $HOME/.cargo/env 2>/dev/null && cargo --version");

    if (!hasGcc || !hasCmake || !hasRust) {
      console.log(`${c.cyan}Step 3b/${c.reset} Installing build tools...`);
      const missing: string[] = [];
      if (!hasGcc) missing.push("gcc/build-essential");
      if (!hasCmake) missing.push("cmake");
      if (!hasRust) missing.push("rust/cargo");
      console.log(`${c.dim}  Missing: ${missing.join(", ")}${c.reset}`);

      try {
        // C/C++ build tools
        if (!hasGcc || !hasCmake) {
          if (tryExec("apt-get --version")) {
            execSync("apt-get install -y -qq build-essential cmake pkg-config libffi-dev libjpeg-dev libpng-dev 2>/dev/null", { stdio: "inherit", timeout: 120000 });
          } else if (tryExec("dnf --version")) {
            execSync("dnf install -y gcc gcc-c++ cmake pkg-config libffi-devel libjpeg-devel libpng-devel 2>/dev/null", { stdio: "inherit", timeout: 120000 });
          } else if (tryExec("brew --version")) {
            execSync("brew install cmake pkg-config 2>/dev/null", { stdio: "inherit", timeout: 120000 });
          }
        }
        // Rust (needed for tokenizers, safetensors)
        if (!hasRust) {
          console.log(`${c.dim}  Installing Rust (needed for tokenizers)...${c.reset}`);
          execSync("curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y 2>/dev/null", { stdio: "inherit", timeout: 120000 });
        }
        // Python build tools
        tryExec(`${pythonCmd} -m pip install --user meson-python meson ninja Cython 2>/dev/null`);
      } catch {
        console.log(`${c.yellow}⚠${c.reset} Some build tools could not be installed — pip may fall back to pre-built wheels`);
      }
    } else {
      console.log(`${c.cyan}Step 3b/${c.reset} ${c.green}Build tools available${c.reset} (gcc, cmake, rust)`);
    }
  }

  // Step 4: Clone and setup
  const dirs: Record<string, string> = { auto1111: getSDDir(), comfyui: getComfyDir(), fooocus: getFooocusDir() };
  const dir = dirs[engine];
  const repos: Record<string, string> = {
    auto1111: "https://github.com/AUTOMATIC1111/stable-diffusion-webui.git",
    comfyui: "https://github.com/comfyanonymous/ComfyUI.git",
    fooocus: "https://github.com/lllyasviel/Fooocus.git",
  };

  // Always use WSL Python for pip installs — Windows Python may lack build tools
  // and PowerShell execution is unreliable for complex pip builds.
  // The WSL→NTFS bridge is slower but more reliable.
  const useWindowsSide = false;
  if (isWSL && isWslWindowsPath(dir)) {
    console.log(`${c.dim}  Installing to Windows drive via WSL (slower I/O but reliable)${c.reset}`);
  }

  if (existsSync(dir)) {
    console.log(`${c.cyan}Step 4/${c.reset} ${c.green}Already cloned${c.reset} at ${dir}`);
  } else {
    console.log(`${c.cyan}Step 4/${c.reset} Cloning ${engine}...`);
    try {
      if (useWindowsSide) {
        const winDir = toWindowsPath(dir);
        await runOnWindowsSide(`git clone '${repos[engine]}' '${winDir}'`, resolve(dir, ".."));
      } else {
        execSync(`git clone "${repos[engine]}" "${dir}"`, { stdio: "inherit", timeout: 300000 });
      }
    } catch (err) {
      return { success: false, message: `Clone failed: ${err instanceof Error ? err.message : err}` };
    }
  }

  // Step 5: Create venv and install deps
  console.log(`${c.cyan}Step 5/${c.reset} Setting up virtual environment and dependencies...`);
  const sizeNote = gpu.hasNvidia ? "~2GB for GPU" : "~190MB for CPU";
  console.log(`${c.dim}  This downloads PyTorch (${sizeNote}). May take 5-15 minutes.${c.reset}`);
  if (useWindowsSide) {
    console.log(`${c.dim}  Running via Windows Python for faster disk I/O on Windows drives.${c.reset}`);
  }
  const torchExtra = gpu.hasNvidia ? "cu121" : gpu.hasAmd ? "rocm5.7" : "cpu";

  try {
    if (useWindowsSide) {
      // Run via Windows Python — much faster for I/O on NTFS drives
      const winDir = toWindowsPath(dir);
      console.log(`${c.dim}  Creating virtual environment (Windows Python)...${c.reset}`);
      await runOnWindowsSide(`python -m venv venv`, dir);

      console.log(`${c.dim}  Upgrading pip...${c.reset}`);
      await runOnWindowsSide(`venv\\Scripts\\pip install --upgrade pip`, dir);

      console.log(`${c.dim}  Installing PyTorch (${gpu.hasNvidia ? "GPU/CUDA" : "CPU"} version)...${c.reset}`);
      await runOnWindowsSide(`venv\\Scripts\\pip install torch torchvision --index-url https://download.pytorch.org/whl/${torchExtra}`, dir);

      if (engine === "auto1111" && existsSync(resolve(dir, "requirements_versions.txt"))) {
        console.log(`${c.dim}  Installing Stable Diffusion requirements...${c.reset}`);
        await runOnWindowsSide(`venv\\Scripts\\pip install -r requirements_versions.txt`, dir);
      } else if ((engine === "comfyui" || engine === "fooocus")) {
        const reqFile = engine === "fooocus" ? "requirements_versions.txt" : "requirements.txt";
        if (existsSync(resolve(dir, reqFile))) {
          console.log(`${c.dim}  Installing ${reqFile}...${c.reset}`);
          await runOnWindowsSide(`venv\\Scripts\\pip install -r ${reqFile}`, dir);
        }
      }
    } else {
      // Run via WSL Python
      const venvPip = `${dir}/venv/bin/pip`;

      if (!existsSync(`${dir}/venv`)) {
        console.log(`${c.dim}  Creating virtual environment...${c.reset}`);
        execSync(`${pythonCmd} -m venv "${dir}/venv"`, { stdio: "inherit", timeout: 120000 });
      }

      console.log(`${c.dim}  Upgrading pip...${c.reset}`);
      await runWithProgress(venvPip, ["install", "--upgrade", "pip"], dir);

      console.log(`${c.dim}  Installing PyTorch (${gpu.hasNvidia ? "GPU/CUDA" : "CPU"} version)...${c.reset}`);
      await runWithProgress(venvPip, [
        "install", "torch", "torchvision",
        "--index-url", `https://download.pytorch.org/whl/${torchExtra}`,
      ], dir);

      if (engine === "auto1111" && existsSync(resolve(dir, "requirements_versions.txt"))) {
        console.log(`${c.dim}  Installing Stable Diffusion requirements...${c.reset}`);
        // Fix pinned versions that don't have wheels for this Python version
        const reqPath = resolve(dir, "requirements_versions.txt");
        const reqContent = readFileSync(reqPath, "utf-8");
        const fixedReq = reqContent
          .replace(/scikit-image==[\d.]+/, "scikit-image>=0.21")       // 0.21.0 has no wheel for py3.12
          .replace(/numpy==[\d.]+/, "numpy>=1.24")                     // relax numpy too
          .replace(/transformers==[\d.]+/, "transformers>=4.30")       // old pin pulls tokenizers that needs Rust build
          .replace(/tokenizers==[\d.]+/, "tokenizers>=0.14")           // force pre-built wheel version
          .replace(/Pillow==[\d.]+/, "Pillow>=9.5")                    // relax Pillow too
          ;
        const fixedReqPath = resolve(dir, "requirements_notoken.txt");
        writeFileSync(fixedReqPath, fixedReq);
        // Pre-install packages that are hard to build from source
        console.log(`${c.dim}  Pre-installing packages with pre-built wheels...${c.reset}`);
        await runWithProgress(venvPip, ["install", "--only-binary=:all:", "tokenizers>=0.14", "transformers>=4.30", "safetensors>=0.3"], dir);
        console.log(`${c.dim}  Relaxed version pins for wheel compatibility${c.reset}`);
        await runWithProgress(venvPip, ["install", "--prefer-binary", "-r", fixedReqPath], dir);
      } else if (engine === "comfyui" || engine === "fooocus") {
        const reqFile = engine === "fooocus" ? "requirements_versions.txt" : "requirements.txt";
        if (existsSync(resolve(dir, reqFile))) {
          console.log(`${c.dim}  Installing ${reqFile}...${c.reset}`);
          await runWithProgress(venvPip, ["install", "-r", resolve(dir, reqFile)], dir);
        }
      }
    }

    console.log(`${c.green}✓${c.reset} Dependencies installed.`);
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    console.log(`${c.yellow}⚠${c.reset} Python dependency install failed: ${errMsg.split("\n")[0]}`);

    // Auto-fallback: try Docker if available
    if (tryExec("docker --version")) {
      console.log(`\n${c.cyan}Falling back to Docker${c.reset} — no dependency issues, everything pre-built.`);
      const dockerResult = await installImageEngine("docker");
      if (dockerResult.success) return dockerResult;
    }

    return { success: false, message: `Dependency install failed.\n\n${c.bold}Alternatives:${c.reset}\n  ${c.cyan}notoken install stable-diffusion --docker${c.reset} — containerized, no deps\n  ${c.cyan}notoken install stability-matrix${c.reset} — standalone, no Python needed\n  ${c.dim}Or fix manually: cd ${dir} && source venv/bin/activate && pip install -r requirements_versions.txt${c.reset}` };
  }

  // Step 6: Download the base AI model
  {
    const modelsDir = resolve(dir, "models", "Stable-diffusion");
    mkdirSync(modelsDir, { recursive: true });

    // Check if any model already exists
    const hasModel = (() => {
      try {
        const files = readdirSync(modelsDir);
        return files.some(f => f.endsWith(".safetensors") || f.endsWith(".ckpt"));
      } catch { return false; }
    })();

    if (hasModel) {
      console.log(`${c.cyan}Step 6/${c.reset} ${c.green}Model already downloaded${c.reset}`);
    } else {
      // Download SD 1.5 base model (~4.3GB) — most compatible, works on CPU
      const modelUrl = "https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors";
      const modelPath = resolve(modelsDir, "v1-5-pruned-emaonly.safetensors");

      console.log(`${c.cyan}Step 6/${c.reset} Downloading AI model (Stable Diffusion 1.5, ~4.3GB)...`);
      console.log(`${c.dim}  This is the largest download — may take 5-15 minutes depending on connection.${c.reset}`);
      console.log(`${c.dim}  Saving to: ${modelsDir}${c.reset}`);

      try {
        await runWithProgress("curl", [
          "-L", "--progress-bar", "-o", modelPath, modelUrl,
        ], dir);

        // Verify file size (should be ~4GB)
        const { statSync: fstat } = await import("node:fs");
        const size = fstat(modelPath).size;
        if (size > 1_000_000_000) {
          console.log(`${c.green}✓${c.reset} Model downloaded (${(size / 1_073_741_824).toFixed(1)}GB)`);
        } else {
          console.log(`${c.yellow}⚠${c.reset} Model file seems small (${(size / 1_048_576).toFixed(0)}MB) — may need re-download`);
        }
      } catch (err) {
        console.log(`${c.yellow}⚠${c.reset} Model download failed: ${err instanceof Error ? err.message : err}`);
        console.log(`${c.dim}  You can download it manually later. The engine will prompt you on first launch.${c.reset}`);
        console.log(`${c.dim}  Or run: curl -L -o "${modelPath}" "${modelUrl}"${c.reset}`);
      }
    }
  }

  // Step 7: Track install + verify
  console.log(`${c.cyan}Step 7/${c.reset} ${c.green}Installation complete${c.reset}`);
  const plan = getInstallPlan(engine);

  // Track what we installed
  const du = tryExec(`du -sh "${dir}" 2>/dev/null`);
  const installSize = du?.split("\t")[0] ?? "unknown";
  trackInstall({
    name: `stable-diffusion-${engine}`,
    type: "engine",
    method: "git-clone",
    path: dir,
    size: installSize,
    uninstallCmd: `rm -rf "${dir}"`,
    dependencies: ["torch", "torchvision", "numpy", "pillow"],
    notes: `Installed via notoken on ${new Date().toLocaleDateString()}`,
  });

  // Check if model was downloaded
  const modelsCheck = resolve(dir, "models", "Stable-diffusion");
  let hasModelNow = false;
  try {
    hasModelNow = readdirSync(modelsCheck).some(f => f.endsWith(".safetensors") || f.endsWith(".ckpt"));
  } catch {}

  // Store pending action so user can say "try it"
  const { suggestAction } = await import("../conversation/pendingActions.js");
  suggestAction({
    action: "generate a picture of a cat",
    description: "Generate a test image to verify the install works",
    type: "intent",
  });

  const modelNote = hasModelNow
    ? `${c.green}✓${c.reset} Model downloaded — ready to generate.`
    : `${c.yellow}Note:${c.reset} First launch will download the AI model (~4GB). Takes 5-10 minutes.`;

  return {
    success: true,
    message: [
      `${c.green}✓${c.reset} ${plan.engine} installed at ${dir} (${installSize})`,
      ``,
      modelNote,
      ``,
      `${c.bold}Say "try it" or "generate a picture of a cat" to test.${c.reset}`,
    ].join("\n"),
  };
}

// ─── Windows Native Install ────────────────────────────────────────────────

async function installStabilityMatrix(platform: "win32" | "wsl"): Promise<{ success: boolean; message: string }> {
  const smUrl = "https://github.com/LykosAI/StabilityMatrix/releases/latest/download/StabilityMatrix-win-x64.zip";

  try {
    if (platform === "wsl") {
      const installDir = process.env.NOTOKEN_INSTALL_DIR ?? "/mnt/d/notoken/ai";
      const smDir = `${installDir}/StabilityMatrix`;
      const smZip = "/tmp/StabilityMatrix.zip";

      console.log(`${c.dim}  Downloading Stability Matrix (138MB)...${c.reset}`);
      execSync(`curl -sfL -o "${smZip}" "${smUrl}"`, { stdio: "inherit", timeout: 300000 });
      console.log(`${c.dim}  Extracting...${c.reset}`);
      mkdirSync(smDir, { recursive: true });
      execSync(`unzip -o -q "${smZip}" -d "${smDir}"`, { stdio: "inherit", timeout: 60000 });

      // Launch on Windows side
      const winPath = tryExec(`wslpath -w "${smDir}" 2>/dev/null`);
      if (winPath) {
        console.log(`${c.dim}  Launching on Windows...${c.reset}`);
        try {
          execSync(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process '${winPath}\\StabilityMatrix.exe'" 2>/dev/null`, { stdio: "ignore", timeout: 10000 });
        } catch {}
      }

      // Auto-configure SM settings to skip first-launch wizard
      try {
        const settingsPath = resolve(smDir, "Data", "settings.json");
        mkdirSync(resolve(smDir, "Data"), { recursive: true });
        let settings: Record<string, unknown> = {};
        if (existsSync(settingsPath)) {
          try { settings = JSON.parse(readFileSync(settingsPath, "utf-8")); } catch {}
        }
        settings.FirstLaunchSetupComplete = true;
        settings.HasSeenWelcomeNotification = true;
        settings.Theme = "Dark";
        writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
        console.log(`${c.dim}  Auto-configured settings (skip wizard, dark theme)${c.reset}`);
      } catch {}

      trackInstall({ name: "StabilityMatrix", type: "engine", method: "curl", path: smDir, uninstallCmd: `rm -rf "${smDir}"` });

      // Detect driver to recommend the right package
      const gpuCheck = detectGpu();
      const maxCuda = gpuCheck.maxCudaVersion ?? "unknown";
      const recommended = gpuCheck.driverVersion && parseFloat(gpuCheck.driverVersion) < 570
        ? `"Stable Diffusion WebUI Forge"` // uses cu121/cu124, works with older drivers
        : `"Forge Neo"`;                    // uses cu130, needs driver 570+
      const driverNote = gpuCheck.driverVersion && parseFloat(gpuCheck.driverVersion) < 570
        ? `\n  ${c.yellow}⚠ Your driver (${gpuCheck.driverVersion}) supports CUDA ${maxCuda} — do NOT choose "Forge Neo" (needs CUDA 13.0)${c.reset}`
        : "";

      return {
        success: true,
        message: [
          `${c.green}✓${c.reset} Stability Matrix installed at ${smDir}`,
          ``,
          `${c.bold}It's now open on your Windows desktop.${c.reset}`,
          `  1. Click "+" and choose ${c.bold}${recommended}${c.reset}${driverNote}`,
          `  2. SM downloads Python, models, and everything automatically`,
          `  3. Click "Launch" when it's done installing`,
          `  4. Once running, come back and say "generate a picture of a cat"`,
          ``,
          `${c.dim}No manual setup needed — SM handles all dependencies.${c.reset}`,
        ].join("\n"),
      };
    }

    // Native Windows
    const installDir = process.env.NOTOKEN_INSTALL_DIR ?? "D:\\notoken\\ai";
    const smDir = `${installDir}\\StabilityMatrix`;
    const smZip = `${process.env.TEMP ?? "C:\\Temp"}\\StabilityMatrix.zip`;

    console.log(`${c.dim}  Downloading Stability Matrix (138MB)...${c.reset}`);
    execSync(`powershell -Command "New-Item -Path '${installDir}' -ItemType Directory -Force | Out-Null; Invoke-WebRequest -Uri '${smUrl}' -OutFile '${smZip}'"`, { stdio: "inherit", timeout: 300000, shell: "cmd.exe" });
    console.log(`${c.dim}  Extracting...${c.reset}`);
    execSync(`powershell -Command "Expand-Archive -Path '${smZip}' -DestinationPath '${smDir}' -Force"`, { stdio: "inherit", timeout: 60000, shell: "cmd.exe" });
    console.log(`${c.dim}  Launching...${c.reset}`);
    try {
      execSync(`start "" "${smDir}\\StabilityMatrix.exe"`, { stdio: "ignore", shell: "cmd.exe", timeout: 10000 });
    } catch {}

    trackInstall({ name: "StabilityMatrix", type: "engine", method: "curl", path: smDir, uninstallCmd: `rmdir /s /q "${smDir}"` });

    return {
      success: true,
      message: [
        `${c.green}✓${c.reset} Stability Matrix installed at ${smDir}`,
        `  It's now open — choose a UI and it downloads everything.`,
        `  Say "generate a picture of a cat" when ready.`,
      ].join("\n"),
    };
  } catch (err) {
    return { success: false, message: `Stability Matrix download failed: ${err instanceof Error ? err.message : err}` };
  }
}

async function installOnWindows(
  engine: "auto1111" | "comfyui" | "fooocus",
  gpu: GpuInfo,
): Promise<{ success: boolean; message: string }> {
  const home = process.env.USERPROFILE ?? "C:\\Users\\Default";
  const installDir = `${home}\\StableDiffusion`;

  // Strategy: try winget for prerequisites, then PowerShell for download
  console.log(`${c.cyan}Step 1/${c.reset} Windows detected — setting up prerequisites...`);

  // 1. Check/install git via winget
  if (!tryExec("git --version")) {
    console.log(`${c.cyan}  1a/${c.reset} Installing git via winget...`);
    try {
      execSync("winget install Git.Git --accept-source-agreements --accept-package-agreements -h", { stdio: "inherit", timeout: 120000 });
      // Refresh PATH
      console.log(`${c.green}  ✓${c.reset} git installed. You may need to restart terminal for PATH update.`);
    } catch {
      console.log(`${c.yellow}  ⚠${c.reset} winget not available — trying direct download...`);
      try {
        execSync(`powershell -Command "Invoke-WebRequest -Uri 'https://github.com/git-for-windows/git/releases/latest/download/Git-2.47.1-64-bit.exe' -OutFile '%TEMP%\\git-installer.exe'; Start-Process '%TEMP%\\git-installer.exe' -ArgumentList '/VERYSILENT /NORESTART' -Wait"`, { stdio: "inherit", timeout: 300000, shell: "cmd.exe" });
      } catch {
        return { success: false, message: "Could not install git. Install manually from https://git-scm.com/download/win" };
      }
    }
  } else {
    console.log(`${c.cyan}  1a/${c.reset} ${c.green}git found${c.reset}`);
  }

  // 2. Check/install Python via winget
  const python = tryExec("python --version") ?? tryExec("python3 --version");
  const pyMatch = python?.match(/(\d+)\.(\d+)/);
  const pyOk = pyMatch && parseInt(pyMatch[1]) >= 3 && parseInt(pyMatch[2]) >= 10;

  if (!pyOk) {
    console.log(`${c.cyan}  1b/${c.reset} Installing Python 3.11...`);
    try {
      execSync("winget install Python.Python.3.11 --accept-source-agreements --accept-package-agreements -h", { stdio: "inherit", timeout: 120000 });
      console.log(`${c.green}  ✓${c.reset} Python 3.11 installed.`);
    } catch {
      try {
        // Direct download fallback
        execSync(`powershell -Command "Invoke-WebRequest -Uri 'https://www.python.org/ftp/python/3.11.9/python-3.11.9-amd64.exe' -OutFile '%TEMP%\\python-installer.exe'; Start-Process '%TEMP%\\python-installer.exe' -ArgumentList '/quiet InstallAllUsers=1 PrependPath=1' -Wait"`, { stdio: "inherit", timeout: 300000, shell: "cmd.exe" });
      } catch {
        return { success: false, message: "Could not install Python. Install manually from https://python.org/downloads/" };
      }
    }
  } else {
    console.log(`${c.cyan}  1b/${c.reset} ${c.green}Python found${c.reset} — ${python}`);
  }

  // 3. Clone the repo
  console.log(`${c.cyan}Step 2/${c.reset} Downloading ${engine}...`);
  const repos: Record<string, string> = {
    auto1111: "https://github.com/AUTOMATIC1111/stable-diffusion-webui.git",
    comfyui: "https://github.com/comfyanonymous/ComfyUI.git",
    fooocus: "https://github.com/lllyasviel/Fooocus.git",
  };
  const engineDir = `${installDir}\\${engine}`;

  try {
    execSync(`if not exist "${installDir}" mkdir "${installDir}"`, { shell: "cmd.exe", stdio: "ignore" });
    if (tryExec(`if exist "${engineDir}" echo yes`)) {
      console.log(`${c.green}  ✓${c.reset} Already downloaded at ${engineDir}`);
    } else {
      execSync(`git clone "${repos[engine]}" "${engineDir}"`, { stdio: "inherit", timeout: 300000 });
    }
  } catch (err) {
    return { success: false, message: `Download failed: ${err instanceof Error ? err.message : err}` };
  }

  // 4. Create venv and install deps
  console.log(`${c.cyan}Step 3/${c.reset} Setting up Python environment and dependencies...`);
  console.log(`${c.dim}  This may take 5-15 minutes (downloading PyTorch)...${c.reset}`);
  const torchUrl = gpu.hasNvidia ? "cu121" : "cpu";
  const pythonExe = "python";

  try {
    console.log(`${c.dim}  Creating virtual environment...${c.reset}`);
    execSync(`cd /d "${engineDir}" && ${pythonExe} -m venv venv`, { stdio: "inherit", timeout: 60000, shell: "cmd.exe" });
    console.log(`${c.dim}  Upgrading pip...${c.reset}`);
    execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install --upgrade pip`, { stdio: "inherit", timeout: 60000, shell: "cmd.exe" });
    console.log(`${c.dim}  Installing PyTorch (${gpu.hasNvidia ? "GPU" : "CPU"})...${c.reset}`);
    execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install torch torchvision --index-url https://download.pytorch.org/whl/${torchUrl}`, { stdio: "inherit", timeout: 600000, shell: "cmd.exe" });

    // Install engine requirements
    if (engine === "auto1111") {
      console.log(`${c.dim}  Installing Stable Diffusion requirements...${c.reset}`);
      execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install -r requirements_versions.txt`, { stdio: "inherit", timeout: 600000, shell: "cmd.exe" });
    } else if (engine === "comfyui") {
      execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install -r requirements.txt`, { stdio: "inherit", timeout: 600000, shell: "cmd.exe" });
    } else if (engine === "fooocus") {
      execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install -r requirements_versions.txt`, { stdio: "inherit", timeout: 600000, shell: "cmd.exe" });
    }
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // If build fails, try installing Visual C++ Build Tools
    if (errMsg.includes("error") && errMsg.includes("build")) {
      console.log(`${c.yellow}⚠ Build failed — trying to install Visual C++ Build Tools...${c.reset}`);
      try {
        execSync("winget install Microsoft.VisualStudio.2022.BuildTools --accept-source-agreements --accept-package-agreements -h", { stdio: "inherit", timeout: 300000 });
        console.log(`${c.dim}  Retrying pip install...${c.reset}`);
        execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install -r requirements_versions.txt`, { stdio: "inherit", timeout: 600000, shell: "cmd.exe" });
      } catch {
        return { success: false, message: `Dependency install failed.\n\n${c.bold}Alternatives:${c.reset}\n  ${c.cyan}Download Stability Matrix:${c.reset} https://lykos.ai (no build tools needed)\n  ${c.dim}Or install Visual C++ Build Tools manually: winget install Microsoft.VisualStudio.2022.BuildTools${c.reset}` };
      }
    } else {
      return { success: false, message: `Dependency install failed: ${errMsg.split("\n")[0]}\n\n${c.dim}Alternative: download Stability Matrix from https://lykos.ai (no Python needed)${c.reset}` };
    }
  }

  // 5. Download base model
  {
    const modelsDir = `${engineDir}\\models\\Stable-diffusion`;
    try { execSync(`if not exist "${modelsDir}" mkdir "${modelsDir}"`, { shell: "cmd.exe", stdio: "ignore" }); } catch {}
    const modelPath = `${modelsDir}\\v1-5-pruned-emaonly.safetensors`;
    const hasModel = tryExec(`if exist "${modelPath}" echo yes`);

    if (hasModel) {
      console.log(`${c.cyan}Step 4/${c.reset} ${c.green}Model already downloaded${c.reset}`);
    } else {
      console.log(`${c.cyan}Step 4/${c.reset} Downloading AI model (SD 1.5, ~4.3GB)...`);
      console.log(`${c.dim}  This is the largest download — may take 5-15 minutes.${c.reset}`);
      try {
        execSync(`powershell -Command "Invoke-WebRequest -Uri 'https://huggingface.co/stable-diffusion-v1-5/stable-diffusion-v1-5/resolve/main/v1-5-pruned-emaonly.safetensors' -OutFile '${modelPath}'"`, { stdio: "inherit", timeout: 600000, shell: "cmd.exe" });
        console.log(`${c.green}✓${c.reset} Model downloaded.`);
      } catch {
        console.log(`${c.yellow}⚠${c.reset} Model download failed — the engine will download it on first launch.`);
      }
    }
  }

  // 6. Create a launcher script
  console.log(`${c.cyan}Step 5/${c.reset} Creating launcher...`);
  const launcherPath = `${engineDir}\\start-notoken.bat`;
  const launcherContent = engine === "auto1111"
    ? `@echo off\ncd /d "${engineDir}"\ncall venv\\Scripts\\activate\npython webui.py --api --listen\npause`
    : engine === "comfyui"
    ? `@echo off\ncd /d "${engineDir}"\ncall venv\\Scripts\\activate\npython main.py --listen\npause`
    : `@echo off\ncd /d "${engineDir}"\ncall venv\\Scripts\\activate\npython entry_with_update.py\npause`;

  try {
    writeFileSync(launcherPath, launcherContent);
  } catch {}

  console.log(`${c.green}✓${c.reset} Installation complete!`);
  console.log(`  ${c.bold}Location:${c.reset} ${engineDir}`);
  console.log(`  ${c.bold}Launcher:${c.reset} ${launcherPath}`);

  return {
    success: true,
    message: `${c.green}✓${c.reset} ${engine} installed at ${engineDir}\n\n${c.dim}Start: double-click ${launcherPath}\nOr just say "generate a picture of a cat" — it will auto-start.${c.reset}`,
  };
}

// ─── Formatting ────────────────────────────────────────────────────────────

function formatNoEngineMessage(prompt: string): string {
  const gpu = detectGpu();
  const lines: string[] = [];

  lines.push(`${c.bold}${c.magenta}Image Generation${c.reset}\n`);
  lines.push(`You asked to generate: ${c.bold}"${prompt}"${c.reset}\n`);

  lines.push(`${c.bold}No local image generator detected.${c.reset} Here are your options:\n`);

  // Online services
  lines.push(`${c.bold}${c.cyan}Online Services (no install needed):${c.reset}`);
  lines.push(`  ${c.bold}ChatGPT / DALL-E${c.reset} — generate via OpenAI API or chat.openai.com`);
  lines.push(`  ${c.bold}Midjourney${c.reset} — Discord-based, subscription ($10-60/mo)`);
  lines.push(`  ${c.bold}Leonardo.ai${c.reset} — web-based, free tier available`);
  lines.push(`  ${c.bold}Stability AI${c.reset} — API access to Stable Diffusion models`);
  lines.push(`  ${c.bold}Ideogram${c.reset} — great for text in images, free tier`);
  lines.push("");

  // Local install
  lines.push(`${c.bold}${c.green}Local Install (free, private, unlimited, works offline):${c.reset}`);

  if (gpu.hasNvidia) {
    lines.push(`  ${c.green}✓ GPU detected: ${gpu.gpuName}${gpu.vram ? ` (${gpu.vram})` : ""}${c.reset}`);
    if (gpu.cudaVersion) lines.push(`  ${c.green}✓ CUDA: ${gpu.cudaVersion}${c.reset}`);
  } else {
    lines.push(`  ${c.yellow}⚠ No GPU detected — will use CPU (slower but works)${c.reset}`);
  }
  lines.push("");

  // Beginner-friendly options first
  lines.push(`  ${c.bold}${c.cyan}Easiest (no technical setup):${c.reset}`);
  lines.push(`  ${c.bold}1. Stability Matrix${c.reset} — All-in-one launcher, manages everything`);
  lines.push(`     ${c.dim}Download: https://lykos.ai — Windows/Mac/Linux${c.reset}`);
  lines.push(`     ${c.dim}Or: notoken install stability-matrix${c.reset}`);
  lines.push(`  ${c.bold}2. Easy Diffusion${c.reset} — One-click installer, simple UI`);
  lines.push(`     ${c.dim}Download: https://easydiffusion.github.io — Windows/Mac/Linux${c.reset}`);
  lines.push(`     ${c.dim}Or: notoken install easy-diffusion${c.reset}`);
  lines.push(`  ${c.bold}3. Fooocus${c.reset} — Simplest, Midjourney-like experience`);
  lines.push(`     ${c.dim}Download: https://github.com/lllyasviel/Fooocus — Windows one-click package${c.reset}`);
  lines.push(`     ${c.dim}Or: notoken install fooocus${c.reset}`);
  lines.push("");

  // Advanced options
  lines.push(`  ${c.bold}${c.dim}Advanced (requires Python/Docker):${c.reset}`);
  lines.push(`  ${c.dim}4. AUTOMATIC1111 — Most popular, full API: notoken install stable-diffusion${c.reset}`);
  lines.push(`  ${c.dim}5. ComfyUI — Node-based workflows: notoken install comfyui${c.reset}`);
  lines.push(`  ${c.dim}6. Docker — Containerized: notoken install stable-diffusion --docker${c.reset}`);
  lines.push("");
  lines.push(`${c.dim}After installing, say "generate a picture of a cat" — works offline, private, unlimited.${c.reset}`);

  return lines.join("\n");
}

function formatStartMessage(engine: ImageEngineStatus): string {
  const lines: string[] = [];
  lines.push(`${c.bold}${engine.engine}${c.reset} is installed but not running.\n`);

  if (engine.engine === "auto1111") {
    lines.push(`Start it with:`);
    lines.push(`  ${c.cyan}cd ${engine.path} && bash webui.sh --api --listen${c.reset}\n`);
    lines.push(`Or use notoken:`);
    lines.push(`  ${c.cyan}notoken start stable-diffusion${c.reset}`);
  } else if (engine.engine === "comfyui") {
    lines.push(`Start it with:`);
    lines.push(`  ${c.cyan}cd ${engine.path} && python3 main.py --listen${c.reset}`);
  } else if (engine.engine === "fooocus") {
    lines.push(`Start it with:`);
    lines.push(`  ${c.cyan}cd ${engine.path} && python3 entry_with_update.py${c.reset}`);
  }

  return lines.join("\n");
}

export function formatImageEngineStatus(engines: ImageEngineStatus[]): string {
  const lines: string[] = [];
  const gpu = detectGpu();

  lines.push(`${c.bold}Image Generation Engines${c.reset}\n`);

  if (gpu.hasNvidia) {
    lines.push(`  ${c.green}GPU:${c.reset} ${gpu.gpuName}${gpu.vram ? ` (${gpu.vram})` : ""}${gpu.cudaVersion ? ` CUDA ${gpu.cudaVersion}` : ""}`);
  } else if (gpu.hasAmd) {
    lines.push(`  ${c.green}GPU:${c.reset} AMD (ROCm)`);
  } else {
    lines.push(`  ${c.yellow}GPU:${c.reset} None detected (CPU only)`);
  }
  lines.push("");

  for (const e of engines) {
    const icon = e.running ? `${c.green}⬤${c.reset}` :
                 e.installed ? `${c.yellow}⬤${c.reset}` :
                 `${c.dim}○${c.reset}`;
    const status = e.running ? `${c.green}running${c.reset}` :
                   e.installed ? `${c.yellow}installed (stopped)${c.reset}` :
                   `${c.dim}not installed${c.reset}`;
    const url = e.url ? ` ${c.dim}${e.url}${c.reset}` : "";
    const plat = e.platform ? ` ${c.dim}[${e.platform}]${c.reset}` : "";
    const conflict = e.portConflict ? ` ${c.red}⚠ PORT CONFLICT${c.reset}` : "";
    const pid = e.pid ? ` ${c.dim}(pid ${e.pid})${c.reset}` : "";
    lines.push(`  ${icon} ${c.bold}${e.engine}${c.reset}${plat} — ${status}${url}${pid}${conflict}`);
  }

  // Check for port conflicts
  const conflicts = engines.filter(e => e.portConflict);
  if (conflicts.length > 0) {
    lines.push("");
    lines.push(`  ${c.red}⚠ Port conflict detected!${c.reset} Multiple engines trying to use port 7860.`);
    lines.push(`  ${c.dim}Stop one with: "stop sd" or stop the Windows engine from Stability Matrix.${c.reset}`);
  }

  // Explain what's currently being used
  const running = engines.find(e => e.running);
  const installed = engines.find(e => e.installed && e.engine !== "docker");
  lines.push("");
  if (running) {
    lines.push(`  ${c.bold}Currently using:${c.reset} ${c.green}${running.engine}${c.reset} (local, ${running.url})`);
    if (running.path) lines.push(`  ${c.dim}Location: ${running.path}${c.reset}`);
  } else if (installed) {
    lines.push(`  ${c.bold}Currently using:${c.reset} ${c.yellow}${installed.engine} installed but stopped${c.reset} — will auto-start on generate`);
    if (installed.path) {
      const size = tryExec(`du -sh "${installed.path}" 2>/dev/null`)?.split("\t")[0] ?? "?";
      lines.push(`  ${c.dim}Location: ${installed.path} (${size})${c.reset}`);
      // Show which drive/partition
      const dfLine = tryExec(`df -h "${installed.path}" 2>/dev/null | tail -1`);
      if (dfLine) {
        const parts = dfLine.split(/\s+/);
        const mount = parts[parts.length - 1];
        const avail = parts[3];
        const pct = parts[4];
        lines.push(`  ${c.dim}Drive: ${mount} — ${avail} free (${pct} used)${c.reset}`);
      }
    }
  } else {
    lines.push(`  ${c.bold}Currently using:${c.reset} ${c.cyan}Cloud API (Pollinations.ai)${c.reset} — free, no install needed`);
    lines.push(`  ${c.dim}Powered by Stable Diffusion via Pollinations. Images are generated on their servers.${c.reset}`);
    lines.push(`  ${c.dim}For private/offline generation, install a local engine above.${c.reset}`);
  }

  // Check if a previously-started engine is now ready
  if (installed && !running) {
    // Quick check if it came up since we last looked
    const a1Check = !!tryExec("curl -sf --max-time 2 http://localhost:7860/sdapi/v1/sd-models 2>/dev/null");
    const comfyCheck = !!tryExec("curl -sf --max-time 2 http://localhost:8188/system_stats 2>/dev/null");
    const edCheck = !!tryExec("curl -sf --max-time 2 http://localhost:9000/ping 2>/dev/null");

    if (a1Check) {
      lines.push(`  ${c.green}✓ auto1111 just became ready at http://localhost:7860!${c.reset}`);
      lines.push(`  ${c.bold}Say "generate a picture of a cat" to use it.${c.reset}`);
    } else if (comfyCheck) {
      lines.push(`  ${c.green}✓ ComfyUI just became ready at http://localhost:8188!${c.reset}`);
    } else if (edCheck) {
      lines.push(`  ${c.green}✓ Easy Diffusion just became ready at http://localhost:9000!${c.reset}`);
    } else {
      // Check if the process is at least running
      const sdProcess = tryExec("ps aux 2>/dev/null | grep -E 'webui\\.py|main\\.py|entry_with_update' | grep -v grep");
      if (sdProcess) {
        lines.push(`  ${c.yellow}⏳ Engine process is running — still loading (model download may be in progress)${c.reset}`);
        lines.push(`  ${c.dim}Check again in a minute: "image status"${c.reset}`);
      }
    }
  }

  // Docker data location warning
  const dockerEngine = engines.find(e => e.engine === "docker" && e.installed);
  if (dockerEngine) {
    const dockerRoot = tryExec("docker info 2>/dev/null | grep 'Docker Root Dir' | awk '{print $NF}'");
    if (dockerRoot) {
      const dockerDrive = getDriveInfo(dockerRoot);
      if (dockerDrive) {
        lines.push(`\n  ${c.dim}Docker data: ${dockerRoot} (${dockerDrive.mount} — ${dockerDrive.freeGB}GB free)${c.reset}`);
        if (dockerDrive.freeGB < 10) {
          lines.push(`  ${c.yellow}⚠ Docker drive is low on space!${c.reset}`);
        }
      }
    }
  }

  lines.push(`\n  ${c.dim}Images saved to: ${OUTPUT_DIR}${c.reset}`);
  lines.push(`  ${c.dim}Install base: ${getInstallBase()}${c.reset}`);
  return lines.join("\n");
}
