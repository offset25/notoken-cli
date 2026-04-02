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
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir, platform } from "node:os";
import { USER_HOME } from "./paths.js";

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
  try {
    const output = execSync(`df -BG "${path}" 2>/dev/null | tail -1`, { encoding: "utf-8", timeout: 3000 });
    const parts = output.trim().split(/\s+/);
    if (parts.length < 6) return null;
    const total = parseInt(parts[1]) || 0;
    const free = parseInt(parts[3]) || 0;
    const pct = parseInt(parts[4]) || 0;
    return { path, freeGB: free, totalGB: total, usedPct: pct, mount: parts[parts.length - 1] };
  } catch { return null; }
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

const _installChoice = chooseBestInstallDir();
const INSTALL_BASE = process.env.NOTOKEN_INSTALL_DIR ?? _installChoice.dir;
const SD_DIR = resolve(INSTALL_BASE, "stable-diffusion-webui");
const COMFY_DIR = resolve(INSTALL_BASE, "ComfyUI");
const FOOOCUS_DIR = resolve(INSTALL_BASE, "Fooocus");
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
}

export interface GpuInfo {
  hasNvidia: boolean;
  hasAmd: boolean;
  gpuName?: string;
  vram?: string;
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
  const nvidia = tryExec("nvidia-smi --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null");
  const cuda = tryExec("nvcc --version 2>/dev/null");
  const amd = tryExec("rocm-smi --showproductname 2>/dev/null");
  // WSL check
  const wslNvidia = !nvidia ? tryExec("nvidia-smi.exe --query-gpu=name,memory.total --format=csv,noheader,nounits 2>/dev/null") : null;

  const gpuLine = nvidia ?? wslNvidia;
  let gpuName: string | undefined;
  let vram: string | undefined;

  if (gpuLine) {
    const parts = gpuLine.split(",").map(s => s.trim());
    gpuName = parts[0];
    vram = parts[1] ? `${parts[1]} MB` : undefined;
  }

  const cudaMatch = cuda?.match(/release ([\d.]+)/);

  return {
    hasNvidia: !!(nvidia || wslNvidia),
    hasAmd: !!amd,
    gpuName,
    vram,
    cudaVersion: cudaMatch?.[1],
    cpuOnly: !(nvidia || wslNvidia || amd),
  };
}

export function detectImageEngines(): ImageEngineStatus[] {
  const engines: ImageEngineStatus[] = [];

  // AUTOMATIC1111
  const a1Installed = existsSync(SD_DIR) && existsSync(resolve(SD_DIR, "webui.py"));
  const a1Running = !!tryExec("curl -sf --max-time 2 http://localhost:7860/sdapi/v1/sd-models 2>/dev/null");
  engines.push({
    engine: "auto1111",
    installed: a1Installed,
    running: a1Running,
    path: a1Installed ? SD_DIR : undefined,
    url: a1Running ? "http://localhost:7860" : undefined,
  });

  // ComfyUI
  const comfyInstalled = existsSync(COMFY_DIR) && existsSync(resolve(COMFY_DIR, "main.py"));
  const comfyRunning = !!tryExec("curl -sf --max-time 2 http://localhost:8188/system_stats 2>/dev/null");
  engines.push({
    engine: "comfyui",
    installed: comfyInstalled,
    running: comfyRunning,
    path: comfyInstalled ? COMFY_DIR : undefined,
    url: comfyRunning ? "http://localhost:8188" : undefined,
  });

  // Fooocus
  const fooocusInstalled = existsSync(FOOOCUS_DIR) && existsSync(resolve(FOOOCUS_DIR, "entry_with_update.py"));
  engines.push({
    engine: "fooocus",
    installed: fooocusInstalled,
    running: false, // Fooocus doesn't have a reliable API check
    path: fooocusInstalled ? FOOOCUS_DIR : undefined,
  });

  // Stability Matrix (standalone launcher — Windows/Linux/Mac)
  const smDir = [
    STABILITY_MATRIX_DIR,
    resolve(homedir(), "AppData", "Local", "StabilityMatrix"),
    resolve(homedir(), ".local", "share", "StabilityMatrix"),
  ].find(d => existsSync(d));
  // Stability Matrix launches auto1111/comfy on standard ports
  engines.push({
    engine: "stability-matrix",
    installed: !!smDir,
    running: a1Running || comfyRunning, // it launches standard engines
    path: smDir,
    url: a1Running ? "http://localhost:7860" : comfyRunning ? "http://localhost:8188" : undefined,
  });

  // Easy Diffusion (standalone — Windows/Linux/Mac)
  const edDir = [
    EASY_DIFFUSION_DIR,
    resolve(homedir(), "EasyDiffusion"),
    resolve(homedir(), "easy_diffusion"),
  ].find(d => existsSync(d));
  const edRunning = !!tryExec("curl -sf --max-time 2 http://localhost:9000/ping 2>/dev/null");
  engines.push({
    engine: "easy-diffusion",
    installed: !!edDir,
    running: edRunning,
    path: edDir,
    url: edRunning ? "http://localhost:9000" : undefined,
  });

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
      console.error(`${c.dim}Starting Stable Diffusion...${c.reset}`);
      // Launch in background — detached so it survives this process
      const { spawn } = await import("node:child_process");
      const child = spawn("bash", [resolve(engine.path, "webui.sh"), "--api", "--listen"], {
        cwd: engine.path,
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      return waitForReady("http://localhost:7860/sdapi/v1/sd-models", 120);
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

    const payload = JSON.stringify({
      prompt,
      negative_prompt: "blurry, bad quality, distorted, watermark, text",
      steps: 20,
      cfg_scale: 7,
      width: 512,
      height: 512,
      sampler_name: "Euler a",
    });

    const result = tryExec(`curl -sf --max-time 120 -X POST "${baseUrl}/sdapi/v1/txt2img" -H "Content-Type: application/json" -d '${payload.replace(/'/g, "'\\''")}'`, 130000);

    if (!result) {
      return { success: false, prompt, error: "Generation timed out or failed. Is the model loaded?" };
    }

    const data = JSON.parse(result);
    if (!data.images?.[0]) {
      return { success: false, prompt, error: "No image returned from API" };
    }

    // Save base64 image
    const timestamp = Date.now();
    const safeName = prompt.replace(/[^a-zA-Z0-9]/g, "_").slice(0, 40);
    const imagePath = resolve(OUTPUT_DIR, `${safeName}_${timestamp}.png`);
    const buffer = Buffer.from(data.images[0], "base64");
    writeFileSync(imagePath, buffer);

    return {
      success: true,
      engine: "auto1111",
      prompt,
      imagePath,
      message: `${c.green}✓${c.reset} Image generated!\n  ${c.bold}Prompt:${c.reset} ${prompt}\n  ${c.bold}Saved:${c.reset} ${imagePath}\n  ${c.bold}Size:${c.reset} ${(buffer.length / 1024).toFixed(0)} KB`,
    };
  } catch (err) {
    return { success: false, prompt, error: `Generation failed: ${err instanceof Error ? err.message : err}` };
  }
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
        `git clone https://github.com/AUTOMATIC1111/stable-diffusion-webui.git ${SD_DIR}`,
        `cd ${SD_DIR} && python3 -m venv venv && source venv/bin/activate`,
        `pip install torch torchvision --index-url https://download.pytorch.org/whl/${torchExtra.replace("+", "")}`,
        `cd ${SD_DIR} && bash webui.sh --api --listen`,
      ],
    },
    comfyui: {
      engine: "ComfyUI (Node-based workflow UI)",
      requirements: ["Python 3.10+", "git", gpu.hasNvidia ? `NVIDIA GPU (${gpu.gpuName})` : "CPU"],
      estimatedTime: "10-15 minutes",
      diskSpace: "~8 GB (with model)",
      steps: [
        `git clone https://github.com/comfyanonymous/ComfyUI.git ${COMFY_DIR}`,
        `cd ${COMFY_DIR} && python3 -m venv venv && source venv/bin/activate`,
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
        `git clone https://github.com/lllyasviel/Fooocus.git ${FOOOCUS_DIR}`,
        `cd ${FOOOCUS_DIR} && python3 -m venv venv && source venv/bin/activate`,
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
    try {
      console.log(`${c.cyan}Step 2/${c.reset} Pulling Stable Diffusion Docker image...`);
      execSync("docker pull ghcr.io/ai-dock/stable-diffusion-webui:latest", { stdio: "inherit", timeout: 600000 });
      const gpuFlag = gpu.hasNvidia ? "--gpus all" : "";
      const envFlag = gpu.cpuOnly ? "-e COMMANDLINE_ARGS='--use-cpu all --skip-torch-cuda-test --no-half'" : "";
      console.log(`${c.cyan}Step 3/${c.reset} Starting container...`);
      execSync(`docker run -d ${gpuFlag} -p 7860:7860 --name sd-webui ${envFlag} ghcr.io/ai-dock/stable-diffusion-webui:latest`, { stdio: "inherit", timeout: 30000 });
      return { success: true, message: `${c.green}✓${c.reset} Stable Diffusion running in Docker at ${c.bold}http://localhost:7860${c.reset}` };
    } catch (err) {
      return { success: false, message: `Docker install failed: ${err instanceof Error ? err.message : err}` };
    }
  }

  // ── Windows (no WSL) — frictionless install via PowerShell ──
  if (os === "win32") {
    return installOnWindows(engine, gpu);
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

  // Step 4: Clone and setup
  const dirs: Record<string, string> = { auto1111: SD_DIR, comfyui: COMFY_DIR, fooocus: FOOOCUS_DIR };
  const dir = dirs[engine];
  const repos: Record<string, string> = {
    auto1111: "https://github.com/AUTOMATIC1111/stable-diffusion-webui.git",
    comfyui: "https://github.com/comfyanonymous/ComfyUI.git",
    fooocus: "https://github.com/lllyasviel/Fooocus.git",
  };

  if (existsSync(dir)) {
    console.log(`${c.cyan}Step 4/${c.reset} ${c.green}Already cloned${c.reset} at ${dir}`);
  } else {
    console.log(`${c.cyan}Step 4/${c.reset} Cloning ${engine}...`);
    try {
      execSync(`git clone "${repos[engine]}" "${dir}"`, { stdio: "inherit", timeout: 300000 });
    } catch (err) {
      return { success: false, message: `Clone failed: ${err instanceof Error ? err.message : err}` };
    }
  }

  // Step 5: Create venv and install deps
  console.log(`${c.cyan}Step 5/${c.reset} Setting up virtual environment and dependencies...`);
  const torchExtra = gpu.hasNvidia ? "cu121" : gpu.hasAmd ? "rocm5.7" : "cpu";

  try {
    const venvPython = `${dir}/venv/bin/python`;
    const venvPip = `${dir}/venv/bin/pip`;

    if (!existsSync(`${dir}/venv`)) {
      execSync(`${pythonCmd} -m venv "${dir}/venv"`, { stdio: "inherit", timeout: 60000 });
    }
    execSync(`${venvPip} install --upgrade pip`, { stdio: "inherit", timeout: 60000 });
    execSync(`${venvPip} install torch torchvision --index-url https://download.pytorch.org/whl/${torchExtra}`, { stdio: "inherit", timeout: 600000 });

    if (engine === "comfyui" || engine === "fooocus") {
      const reqFile = engine === "fooocus" ? "requirements_versions.txt" : "requirements.txt";
      if (existsSync(resolve(dir, reqFile))) {
        execSync(`${venvPip} install -r "${resolve(dir, reqFile)}"`, { stdio: "inherit", timeout: 600000 });
      }
    }

    console.log(`${c.green}✓${c.reset} Dependencies installed.`);
  } catch (err) {
    return { success: false, message: `Dependency install failed: ${err instanceof Error ? err.message : err}\n\n${c.dim}Try: notoken install stability-matrix (standalone, no Python needed)${c.reset}` };
  }

  // Step 6: Verify
  console.log(`${c.cyan}Step 6/${c.reset} ${c.green}Installation complete${c.reset}`);
  const plan = getInstallPlan(engine);

  // Store pending action so user can say "try it"
  const { suggestAction } = await import("../conversation/pendingActions.js");
  suggestAction({
    action: "generate a picture of a cat",
    description: "Generate a test image to verify the install works",
    type: "intent",
  });

  return {
    success: true,
    message: [
      `${c.green}✓${c.reset} ${plan.engine} installed at ${dir}`,
      ``,
      `${c.yellow}Note:${c.reset} First launch will download the AI model (~4GB). This takes 5-10 minutes.`,
      `After that, startup takes about 30-60 seconds.`,
      ``,
      `${c.bold}Say "try it" or "generate a picture of a cat" to test.${c.reset}`,
    ].join("\n"),
  };
}

// ─── Windows Native Install ────────────────────────────────────────────────

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
    execSync(`cd /d "${engineDir}" && ${pythonExe} -m venv venv`, { stdio: "inherit", timeout: 60000, shell: "cmd.exe" });
    execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install --upgrade pip`, { stdio: "inherit", timeout: 60000, shell: "cmd.exe" });
    execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install torch torchvision --index-url https://download.pytorch.org/whl/${torchUrl}`, { stdio: "inherit", timeout: 600000, shell: "cmd.exe" });

    if (engine === "comfyui") {
      execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install -r requirements.txt`, { stdio: "inherit", timeout: 300000, shell: "cmd.exe" });
    } else if (engine === "fooocus") {
      execSync(`cd /d "${engineDir}" && venv\\Scripts\\pip install -r requirements_versions.txt`, { stdio: "inherit", timeout: 300000, shell: "cmd.exe" });
    }
  } catch (err) {
    return { success: false, message: `Dependency install failed: ${err instanceof Error ? err.message : err}\n\n${c.dim}Alternative: download Stability Matrix from https://lykos.ai (no Python needed)${c.reset}` };
  }

  // 5. Create a launcher script
  console.log(`${c.cyan}Step 4/${c.reset} Creating launcher...`);
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
    lines.push(`  ${icon} ${c.bold}${e.engine}${c.reset} — ${status}${url}`);
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
  lines.push(`  ${c.dim}Install base: ${INSTALL_BASE}${c.reset}`);
  return lines.join("\n");
}
