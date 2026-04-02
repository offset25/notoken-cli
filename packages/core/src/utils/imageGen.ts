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
import { homedir } from "node:os";
import { USER_HOME } from "./paths.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m",
  cyan: "\x1b[36m", magenta: "\x1b[35m", blue: "\x1b[34m",
};

const SD_DIR = resolve(homedir(), "stable-diffusion-webui");
const COMFY_DIR = resolve(homedir(), "ComfyUI");
const FOOOCUS_DIR = resolve(homedir(), "Fooocus");
const OUTPUT_DIR = resolve(USER_HOME, "generated-images");

// ─── Types ─────────────────────────────────────────────────────────────────

export type ImageEngine = "auto1111" | "comfyui" | "fooocus" | "docker" | "none";

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
    // No local engine — try Hugging Face API as zero-install fallback
    const hfResult = await generateViaCloud(prompt);
    if (hfResult.success) return hfResult;

    // If cloud also failed, show the full options message
    return {
      success: false,
      prompt,
      message: (hfResult.error ? `${c.yellow}Cloud API:${c.reset} ${hfResult.error}\n\n` : "") + formatNoEngineMessage(prompt),
    };
  }

  // If installed but not running — auto-start it, wait, then generate
  if (engine.installed && !engine.running) {
    const started = await autoStartEngine(engine);
    if (!started) {
      return {
        success: false,
        engine: engine.engine,
        prompt,
        message: formatStartMessage(engine),
      };
    }
    // Re-detect to get the URL
    const refreshed = detectImageEngines().find(e => e.engine === engine.engine);
    if (refreshed?.running) {
      engine.running = true;
      engine.url = refreshed.url;
    }
  }

  // Engine is running — generate via API
  if (engine.engine === "auto1111" || (engine.engine === "docker" && engine.url?.includes("7860"))) {
    return generateViaAuto1111(prompt, engine.url ?? "http://localhost:7860");
  }

  if (engine.engine === "comfyui") {
    return generateViaAuto1111(prompt, engine.url ?? "http://localhost:8188");
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

  console.error(`${c.yellow}⚠${c.reset} Timed out waiting for engine after ${timeoutSeconds}s`);
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

    console.error(`${c.dim}Generating image (this may take 10-30 seconds)...${c.reset}`);

    const { execSync: exec } = await import("node:child_process");
    // Retry up to 3 times — Pollinations sometimes returns 502 on first try
    let success = false;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        exec(`curl -sL --max-time 120 "${url}" -o "${imagePath}"`, { timeout: 130000 });
        const s = (await import("node:fs")).statSync(imagePath);
        if (s.size > 1000) { success = true; break; }
      } catch {}
      if (attempt === 0) console.error(`${c.dim}  Retrying...${c.reset}`);
    }
    if (!success) return { success: false, prompt, error: "Image generation timed out or failed" };

    if (!existsSync(imagePath)) {
      return { success: false, prompt, error: "Image generation failed — no file returned" };
    }

    const { statSync: stat } = await import("node:fs");
    const size = stat(imagePath).size;

    if (size < 1000) {
      // Too small — probably an error response
      return { success: false, prompt, error: "Image generation returned an empty or error response" };
    }

    return {
      success: true,
      engine: "auto1111",
      prompt,
      imagePath,
      message: `${c.green}✓${c.reset} Image generated!\n  ${c.bold}Prompt:${c.reset} ${prompt}\n  ${c.bold}Saved:${c.reset} ${imagePath}\n  ${c.bold}Size:${c.reset} ${(size / 1024).toFixed(0)} KB\n\n  ${c.dim}Generated via cloud API (free). For local generation: notoken install stable-diffusion${c.reset}`,
    };
  } catch (err) {
    return { success: false, prompt, error: `Cloud generation failed: ${err instanceof Error ? err.message : err}` };
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

  if (engine === "docker") {
    if (!tryExec("docker --version")) {
      return { success: false, message: "Docker is not installed. Run: notoken install docker" };
    }
    try {
      console.log(`${c.dim}Pulling Stable Diffusion Docker image...${c.reset}`);
      execSync("docker pull ghcr.io/ai-dock/stable-diffusion-webui:latest", { stdio: "inherit", timeout: 600000 });

      const gpuFlag = gpu.hasNvidia ? "--gpus all" : "";
      const envFlag = gpu.cpuOnly ? "-e COMMANDLINE_ARGS='--use-cpu all --skip-torch-cuda-test --no-half'" : "";
      execSync(`docker run -d ${gpuFlag} -p 7860:7860 --name sd-webui ${envFlag} ghcr.io/ai-dock/stable-diffusion-webui:latest`, { stdio: "inherit", timeout: 30000 });

      return { success: true, message: `${c.green}✓${c.reset} Stable Diffusion running in Docker at ${c.bold}http://localhost:7860${c.reset}` };
    } catch (err) {
      return { success: false, message: `Docker install failed: ${err instanceof Error ? err.message : err}` };
    }
  }

  // For non-Docker, check prerequisites
  const python = tryExec("python3 --version") ?? tryExec("python --version");
  if (!python) {
    return { success: false, message: "Python 3.10+ is required. Install with: notoken install python" };
  }
  const pyVer = python.match(/(\d+)\.(\d+)/);
  if (pyVer && (parseInt(pyVer[1]) < 3 || parseInt(pyVer[2]) < 10)) {
    return { success: false, message: `Python 3.10+ required (found ${python}). Upgrade with: pyenv install 3.11` };
  }
  if (!tryExec("git --version")) {
    return { success: false, message: "git is required. Install with: notoken fix git" };
  }

  const dirs: Record<string, string> = { auto1111: SD_DIR, comfyui: COMFY_DIR, fooocus: FOOOCUS_DIR };
  const dir = dirs[engine];
  const plan = getInstallPlan(engine);

  try {
    for (const step of plan.steps) {
      console.log(`${c.dim}$ ${step}${c.reset}`);
      execSync(step, { stdio: "inherit", timeout: 600000, shell: "/bin/bash" });
    }
    return { success: true, message: `${c.green}✓${c.reset} ${plan.engine} installed at ${dir}` };
  } catch (err) {
    return { success: false, message: `Installation failed: ${err instanceof Error ? err.message : err}` };
  }
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
  lines.push(`${c.bold}${c.green}Local Install (free, private, unlimited):${c.reset}`);

  if (gpu.hasNvidia) {
    lines.push(`  ${c.green}✓ GPU detected: ${gpu.gpuName}${gpu.vram ? ` (${gpu.vram})` : ""}${c.reset}`);
    if (gpu.cudaVersion) lines.push(`  ${c.green}✓ CUDA: ${gpu.cudaVersion}${c.reset}`);
    lines.push("");
  } else {
    lines.push(`  ${c.yellow}⚠ No GPU detected — will use CPU (slower but works)${c.reset}`);
    lines.push("");
  }

  lines.push(`  ${c.bold}1. AUTOMATIC1111${c.reset} — Most popular, full API, many extensions`);
  lines.push(`     ${c.dim}Install: notoken install stable-diffusion${c.reset}`);
  lines.push(`  ${c.bold}2. ComfyUI${c.reset} — Node-based workflow, more control, lighter`);
  lines.push(`     ${c.dim}Install: notoken install comfyui${c.reset}`);
  lines.push(`  ${c.bold}3. Fooocus${c.reset} — Simplest, one-click, Midjourney-like experience`);
  lines.push(`     ${c.dim}Install: notoken install fooocus${c.reset}`);
  lines.push(`  ${c.bold}4. Docker${c.reset} — Containerized, no dependency headaches`);
  lines.push(`     ${c.dim}Install: notoken install stable-diffusion --docker${c.reset}`);
  lines.push("");
  lines.push(`${c.dim}After installing, just say "generate a picture of a cat" and it works.${c.reset}`);

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
  } else if (installed) {
    lines.push(`  ${c.bold}Currently using:${c.reset} ${c.yellow}${installed.engine} installed but stopped${c.reset} — will auto-start on generate`);
  } else {
    lines.push(`  ${c.bold}Currently using:${c.reset} ${c.cyan}Cloud API (Pollinations.ai)${c.reset} — free, no install needed`);
    lines.push(`  ${c.dim}Powered by Stable Diffusion via Pollinations. Images are generated on their servers.${c.reset}`);
    lines.push(`  ${c.dim}For private/offline generation, install a local engine above.${c.reset}`);
  }

  lines.push(`\n  ${c.dim}Images saved to: ${OUTPUT_DIR}${c.reset}`);
  return lines.join("\n");
}
