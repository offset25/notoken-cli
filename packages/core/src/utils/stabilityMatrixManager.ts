/**
 * Stability Matrix Manager.
 *
 * Controls Stability Matrix without browser automation — reads/writes
 * settings.json directly, launches packages via their launch commands,
 * and manages models via the shared folder structure.
 *
 * SM stores config in:
 *   <SM_DIR>/Data/settings.json     — main config
 *   <SM_DIR>/Packages/<name>/       — installed packages
 *   <SM_DIR>/Models/                — shared models folder
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { homedir } from "node:os";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

function tryExec(cmd: string, timeout = 5000): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout }).trim() || null;
  } catch { return null; }
}

// ─── SM Discovery ──────────────────────────────────────────────────────────

export interface SMLocation {
  path: string;
  platform: "windows" | "wsl";
  settingsPath: string;
  packagesDir: string;
  modelsDir: string;
}

export function findStabilityMatrix(): SMLocation | null {
  const candidates = [
    // WSL paths to Windows drives
    "/mnt/d/notoken/ai/StabilityMatrix",
    "/mnt/c/notoken/ai/StabilityMatrix",
    "/mnt/d/StabilityMatrix",
    resolve(homedir(), "StabilityMatrix"),
    resolve(homedir(), "AppData", "Local", "StabilityMatrix"),
    // Native Windows paths
    "D:\\notoken\\ai\\StabilityMatrix",
    "C:\\notoken\\ai\\StabilityMatrix",
  ];

  for (const p of candidates) {
    const settingsPath = resolve(p, "Data", "settings.json");
    if (existsSync(settingsPath)) {
      const isWSL = p.startsWith("/mnt/");
      return {
        path: p,
        platform: isWSL ? "wsl" : "windows",
        settingsPath,
        packagesDir: resolve(p, "Data", "Packages"),
        modelsDir: resolve(p, "Data", "Models"),
      };
    }
    // Also check if SM exe exists without settings yet
    if (existsSync(resolve(p, "StabilityMatrix.exe"))) {
      const isWSL = p.startsWith("/mnt/");
      return {
        path: p,
        platform: isWSL ? "wsl" : "windows",
        settingsPath: resolve(p, "Data", "settings.json"),
        packagesDir: resolve(p, "Data", "Packages"),
        modelsDir: resolve(p, "Data", "Models"),
      };
    }
  }
  return null;
}

// ─── Settings ──────────────────────────────────────────────────────────────

export interface SMSettings {
  InstalledPackages: SMPackage[];
  ActiveInstalledPackage: string;
  FirstLaunchSetupComplete: boolean;
  Theme: string;
  PreferredGpu?: { Name: string; MemoryBytes: number; IsNvidia: boolean };
  [key: string]: unknown;
}

export interface SMPackage {
  Id: string;
  DisplayName: string;
  PackageName: string;
  Version: { InstalledBranch: string; InstalledCommitSha: string };
  LibraryPath: string;
  LaunchCommand: string;
  LaunchArgs: Array<{ Name: string; Type: string; OptionValue: unknown }>;
  PythonVersion: string;
}

export function readSMSettings(sm: SMLocation): SMSettings | null {
  try {
    return JSON.parse(readFileSync(sm.settingsPath, "utf-8"));
  } catch { return null; }
}

export function writeSMSettings(sm: SMLocation, settings: SMSettings): void {
  mkdirSync(resolve(sm.settingsPath, ".."), { recursive: true });
  writeFileSync(sm.settingsPath, JSON.stringify(settings, null, 2));
}

// ─── Package Management ────────────────────────────────────────────────────

export function getInstalledPackages(sm: SMLocation): SMPackage[] {
  const settings = readSMSettings(sm);
  return settings?.InstalledPackages ?? [];
}

export function getActivePackage(sm: SMLocation): SMPackage | null {
  const settings = readSMSettings(sm);
  if (!settings) return null;
  return settings.InstalledPackages.find(p => p.Id === settings.ActiveInstalledPackage) ?? null;
}

export function isPackageRunning(sm: SMLocation): { running: boolean; port: number; url: string } {
  // Check common ports
  for (const port of [7860, 7861, 8188, 9090]) {
    const check = tryExec(`curl -sf --max-time 2 http://localhost:${port}/sdapi/v1/sd-models 2>/dev/null`);
    if (check) return { running: true, port, url: `http://localhost:${port}` };
    // ComfyUI
    const comfyCheck = tryExec(`curl -sf --max-time 2 http://localhost:${port}/system_stats 2>/dev/null`);
    if (comfyCheck) return { running: true, port, url: `http://localhost:${port}` };
  }
  return { running: false, port: 0, url: "" };
}

export function launchPackage(sm: SMLocation, pkg?: SMPackage): { success: boolean; message: string } {
  const active = pkg ?? getActivePackage(sm);
  if (!active) return { success: false, message: "No active package found in Stability Matrix" };

  const pkgDir = resolve(sm.packagesDir, active.LibraryPath.replace(/\\/g, "/"));
  if (!existsSync(pkgDir)) return { success: false, message: `Package directory not found: ${pkgDir}` };

  // Build launch args
  const args = active.LaunchArgs
    .filter(a => a.OptionValue === true)
    .map(a => a.Name)
    .join(" ");

  const launchCmd = active.LaunchCommand;
  const pythonDir = resolve(sm.path, "Data", "Assets", `python-${active.PythonVersion}`);
  const venvDir = resolve(pkgDir, "venv");

  // Launch via Windows PowerShell (SM packages run on Windows)
  if (sm.platform === "wsl") {
    const winPkgDir = tryExec(`wslpath -w "${pkgDir}"`);
    if (!winPkgDir) return { success: false, message: "Could not convert path" };

    try {
      execSync(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process -WorkingDirectory '${winPkgDir}' -FilePath 'python' -ArgumentList '${launchCmd} --api ${args}' -WindowStyle Normal" 2>/dev/null`, { stdio: "ignore", timeout: 10000 });
      return { success: true, message: `${c.green}✓${c.reset} Launched ${active.DisplayName} (${launchCmd} --api ${args})` };
    } catch (err) {
      return { success: false, message: `Launch failed: ${err instanceof Error ? err.message : err}` };
    }
  }

  // Native Windows
  try {
    execSync(`start "" /D "${pkgDir}" python ${launchCmd} --api ${args}`, { stdio: "ignore", shell: "cmd.exe", timeout: 10000 });
    return { success: true, message: `${c.green}✓${c.reset} Launched ${active.DisplayName}` };
  } catch (err) {
    return { success: false, message: `Launch failed: ${err instanceof Error ? err.message : err}` };
  }
}

export function stopPackage(): { success: boolean; message: string } {
  // Kill python processes running SD
  try {
    const killed = tryExec("pkill -f 'launch.py\\|webui.py\\|main.py' 2>/dev/null");
    // Also try Windows side
    tryExec(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Get-Process python -ErrorAction SilentlyContinue | Where-Object {\\$_.CommandLine -like '*launch.py*'} | Stop-Process -Force" 2>/dev/null`);
    return { success: true, message: `${c.green}✓${c.reset} Stopped SD processes` };
  } catch {
    return { success: false, message: "Could not stop processes" };
  }
}

// ─── Model Management ──────────────────────────────────────────────────────

export interface ModelInfo {
  name: string;
  path: string;
  size: string;
  type: "checkpoint" | "lora" | "vae" | "embedding" | "controlnet" | "other";
}

export function listModels(sm: SMLocation): ModelInfo[] {
  const models: ModelInfo[] = [];
  const modelsDir = sm.modelsDir;

  if (!existsSync(modelsDir)) return models;

  const typeMap: Record<string, ModelInfo["type"]> = {
    "StableDiffusion": "checkpoint",
    "Lora": "lora",
    "VAE": "vae",
    "TextualInversion": "embedding",
    "ControlNet": "controlnet",
  };

  for (const [dirName, type] of Object.entries(typeMap)) {
    const typeDir = resolve(modelsDir, dirName);
    if (!existsSync(typeDir)) continue;
    try {
      for (const file of readdirSync(typeDir, { recursive: true })) {
        const fName = String(file);
        if (fName.endsWith(".safetensors") || fName.endsWith(".ckpt") || fName.endsWith(".pt")) {
          const fullPath = resolve(typeDir, fName);
          const size = tryExec(`du -sh "${fullPath}" 2>/dev/null`)?.split("\t")[0] ?? "?";
          models.push({ name: fName, path: fullPath, size, type });
        }
      }
    } catch {}
  }

  return models;
}

export async function downloadModel(sm: SMLocation, url: string, name?: string): Promise<{ success: boolean; message: string }> {
  const modelsDir = resolve(sm.modelsDir, "StableDiffusion");
  mkdirSync(modelsDir, { recursive: true });

  const fileName = name ?? url.split("/").pop() ?? "model.safetensors";
  const destPath = resolve(modelsDir, fileName);

  if (existsSync(destPath)) {
    return { success: true, message: `${c.green}✓${c.reset} Model already exists: ${fileName}` };
  }

  console.log(`${c.dim}Downloading model to ${destPath}...${c.reset}`);
  try {
    execSync(`curl -L --progress-bar -o "${destPath}" "${url}"`, { stdio: "inherit", timeout: 600000 });
    return { success: true, message: `${c.green}✓${c.reset} Model downloaded: ${fileName}` };
  } catch (err) {
    return { success: false, message: `Download failed: ${err instanceof Error ? err.message : err}` };
  }
}

// ─── Status Formatting ─────────────────────────────────────────────────────

export function formatSMStatus(sm: SMLocation): string {
  const lines: string[] = [];
  const settings = readSMSettings(sm);
  const packages = getInstalledPackages(sm);
  const active = getActivePackage(sm);
  const running = isPackageRunning(sm);
  const models = listModels(sm);

  lines.push(`${c.bold}${c.cyan}Stability Matrix${c.reset}`);
  lines.push(`  ${c.dim}Location: ${sm.path} (${sm.platform})${c.reset}`);

  if (settings?.PreferredGpu) {
    const gpu = settings.PreferredGpu;
    const vram = (gpu.MemoryBytes / 1073741824).toFixed(1);
    lines.push(`  ${c.dim}GPU: ${gpu.Name} (${vram}GB)${c.reset}`);
  }
  lines.push("");

  // Packages
  lines.push(`${c.bold}Installed Packages:${c.reset}`);
  if (packages.length === 0) {
    lines.push(`  ${c.dim}None — open SM and click "+" to install one${c.reset}`);
  } else {
    for (const pkg of packages) {
      const isActive = pkg.Id === settings?.ActiveInstalledPackage;
      const icon = isActive ? (running.running ? `${c.green}⬤${c.reset}` : `${c.yellow}⬤${c.reset}`) : `${c.dim}○${c.reset}`;
      const status = isActive && running.running ? `${c.green}running${c.reset} at ${running.url}` :
                     isActive ? `${c.yellow}active (stopped)${c.reset}` : `${c.dim}inactive${c.reset}`;
      lines.push(`  ${icon} ${c.bold}${pkg.DisplayName}${c.reset} — ${status}`);
      lines.push(`    ${c.dim}Python ${pkg.PythonVersion} | ${pkg.LaunchCommand} | Branch: ${pkg.Version.InstalledBranch}${c.reset}`);
    }
  }
  lines.push("");

  // Models
  if (models.length > 0) {
    lines.push(`${c.bold}Models:${c.reset}`);
    for (const m of models) {
      lines.push(`  ${c.dim}${m.type}:${c.reset} ${m.name} (${m.size})`);
    }
  } else {
    lines.push(`${c.bold}Models:${c.reset} ${c.dim}None yet — SM will download on first launch${c.reset}`);
  }

  return lines.join("\n");
}

// ─── Configure Launch Args ─────────────────────────────────────────────────

export function setLaunchArgs(sm: SMLocation, args: Record<string, boolean>): void {
  const settings = readSMSettings(sm);
  if (!settings) return;

  const active = settings.InstalledPackages.find(p => p.Id === settings.ActiveInstalledPackage);
  if (!active) return;

  for (const [name, value] of Object.entries(args)) {
    const existing = active.LaunchArgs.find(a => a.Name === name);
    if (existing) {
      existing.OptionValue = value;
    } else {
      active.LaunchArgs.push({ Name: name, Type: "Bool", OptionValue: value });
    }
  }

  // Ensure --api is always enabled for NoToken integration
  if (!active.LaunchArgs.find(a => a.Name === "--api")) {
    active.LaunchArgs.push({ Name: "--api", Type: "Bool", OptionValue: true });
  }

  writeSMSettings(sm, settings);
}

export function enableAPI(sm: SMLocation): void {
  setLaunchArgs(sm, { "--api": true, "--listen": true });
}
