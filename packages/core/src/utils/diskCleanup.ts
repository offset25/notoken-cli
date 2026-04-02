/**
 * Disk cleanup scanner and executor.
 *
 * Scans known safe-to-clean locations, presents findings, and asks
 * before deleting anything. Platform-aware: Windows (PowerShell) and Linux.
 */

import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { detectLocalPlatform, type PlatformInfo } from "./platform.js";
import { askForConfirmation, askForStrictConfirmation, askWithControl } from "../policy/confirm.js";
import { taskRunner } from "../agents/taskRunner.js";

const execAsync = promisify(exec);

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

export interface CleanupTarget {
  name: string;
  path: string;
  sizeGB: number;
  safe: boolean;
  description: string;
  cleanCommand: string;
}

// ─── Windows scan targets ────────────────────────────────────────────────────

function getWindowsScanTargets(userHome: string): Array<{
  name: string;
  path: string;
  description: string;
  cleanCommand: string;
}> {
  return [
    {
      name: "npm cache",
      path: `${userHome}\\AppData\\Local\\npm-cache`,
      description: "Cached package downloads — re-downloaded as needed",
      cleanCommand: "npm cache clean --force",
    },
    {
      name: "Temp files",
      path: `${userHome}\\AppData\\Local\\Temp`,
      description: "Temporary files from apps and system",
      cleanCommand: `powershell -Command "Remove-Item '${userHome}\\AppData\\Local\\Temp\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    },
    {
      name: "Windows Temp",
      path: "C:\\Windows\\Temp",
      description: "System temporary files",
      cleanCommand: `powershell -Command "Remove-Item 'C:\\Windows\\Temp\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    },
    {
      name: "pnpm store",
      path: `${userHome}\\AppData\\Local\\pnpm`,
      description: "Cached pnpm packages",
      cleanCommand: "pnpm store prune",
    },
    {
      name: "yarn cache",
      path: `${userHome}\\AppData\\Local\\Yarn\\Cache`,
      description: "Cached yarn packages",
      cleanCommand: "yarn cache clean",
    },
    {
      name: "npm global",
      path: `${userHome}\\AppData\\Roaming\\npm`,
      description: "NOT auto-deleted — shows installed global packages for manual review",
      cleanCommand: `npm ls -g --depth=0`,
    },
    {
      name: "NuGet cache",
      path: `${userHome}\\.nuget\\packages`,
      description: "Cached .NET packages",
      cleanCommand: "dotnet nuget locals all --clear",
    },
    {
      name: "pip cache",
      path: `${userHome}\\AppData\\Local\\pip\\cache`,
      description: "Cached Python packages",
      cleanCommand: "pip cache purge",
    },
    {
      name: "Windows Update",
      path: "C:\\Windows\\SoftwareDistribution\\Download",
      description: "Old Windows Update files",
      cleanCommand: `powershell -Command "Remove-Item 'C:\\Windows\\SoftwareDistribution\\Download\\*' -Recurse -Force -ErrorAction SilentlyContinue"`,
    },
  ];
}

// ─── Linux scan targets ──────────────────────────────────────────────────────

function getLinuxScanTargets(userHome: string): Array<{
  name: string;
  path: string;
  description: string;
  cleanCommand: string;
}> {
  return [
    {
      name: "npm cache",
      path: `${userHome}/.npm`,
      description: "Cached package downloads — re-downloaded as needed",
      cleanCommand: "npm cache clean --force",
    },
    {
      name: "Temp files",
      path: "/tmp",
      description: "Temporary files",
      cleanCommand: "sudo rm -rf /tmp/* 2>/dev/null",
    },
    {
      name: "apt cache",
      path: "/var/cache/apt/archives",
      description: "Downloaded .deb packages",
      cleanCommand: "sudo apt-get clean",
    },
    {
      name: "Journal logs",
      path: "/var/log/journal",
      description: "Systemd journal logs (keeps last 3 days)",
      cleanCommand: "sudo journalctl --vacuum-time=3d",
    },
    {
      name: "pnpm store",
      path: `${userHome}/.local/share/pnpm`,
      description: "Cached pnpm packages",
      cleanCommand: "pnpm store prune",
    },
    {
      name: "yarn cache",
      path: `${userHome}/.cache/yarn`,
      description: "Cached yarn packages",
      cleanCommand: "yarn cache clean",
    },
    {
      name: "pip cache",
      path: `${userHome}/.cache/pip`,
      description: "Cached Python packages",
      cleanCommand: "pip cache purge",
    },
    {
      name: "Trash",
      path: `${userHome}/.local/share/Trash`,
      description: "Deleted files in trash",
      cleanCommand: `rm -rf ${userHome}/.local/share/Trash/*`,
    },
  ];
}

// ─── WSL scan targets (Windows paths via /mnt/c/) ───────────────────────────

function getWSLScanTargets(winUser: string): Array<{
  name: string;
  path: string;
  description: string;
  cleanCommand: string;
}> {
  const winHome = `/mnt/c/Users/${winUser}`;
  return [
    {
      name: "npm cache (Win)",
      path: `${winHome}/AppData/Local/npm-cache`,
      description: "Windows npm cache — re-downloaded as needed",
      cleanCommand: `rm -rf "${winHome}/AppData/Local/npm-cache"`,
    },
    {
      name: "Temp files (Win)",
      path: `${winHome}/AppData/Local/Temp`,
      description: "Windows user temp files",
      cleanCommand: `find "${winHome}/AppData/Local/Temp" -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null`,
    },
    {
      name: "pnpm store (Win)",
      path: `${winHome}/AppData/Local/pnpm`,
      description: "Windows pnpm cached packages",
      cleanCommand: `rm -rf "${winHome}/AppData/Local/pnpm/store"`,
    },
    {
      name: "yarn cache (Win)",
      path: `${winHome}/AppData/Local/Yarn/Cache`,
      description: "Windows yarn cached packages",
      cleanCommand: `rm -rf "${winHome}/AppData/Local/Yarn/Cache"`,
    },
    {
      name: "npm global (Win)",
      path: `${winHome}/AppData/Roaming/npm`,
      description: "NOT auto-deleted — shows installed global packages for manual review",
      cleanCommand: `ls "${winHome}/AppData/Roaming/npm/node_modules"`,
    },
    {
      name: "pip cache (Win)",
      path: `${winHome}/AppData/Local/pip/cache`,
      description: "Windows pip cached packages",
      cleanCommand: `rm -rf "${winHome}/AppData/Local/pip/cache"`,
    },
    {
      name: "NuGet cache (Win)",
      path: `${winHome}/.nuget/packages`,
      description: "Windows .NET NuGet packages",
      cleanCommand: `rm -rf "${winHome}/.nuget/packages"`,
    },
    {
      name: "Windows Temp",
      path: "/mnt/c/Windows/Temp",
      description: "System temporary files",
      cleanCommand: `find /mnt/c/Windows/Temp -mindepth 1 -maxdepth 1 -mtime +1 -exec rm -rf {} + 2>/dev/null`,
    },
    {
      name: "Win Update DL",
      path: "/mnt/c/Windows/SoftwareDistribution/Download",
      description: "Old Windows Update download files",
      cleanCommand: `rm -rf /mnt/c/Windows/SoftwareDistribution/Download/* 2>/dev/null`,
    },
  ];
}

function detectWindowsUser(): string | null {
  try {
    // Try cmd.exe interop first — most reliable
    const whoamiRaw = execSync(
      "cmd.exe /c echo %USERNAME% 2>/dev/null",
      { encoding: "utf-8", timeout: 5000 }
    ).trim();
    // cmd.exe may print UNC path warning lines before the actual output
    const lastLine = whoamiRaw.split("\n").pop()?.trim() ?? "";
    if (lastLine && !lastLine.includes("%") && !lastLine.includes("UNC")) {
      return lastLine;
    }
  } catch {}

  try {
    // Fallback: scan /mnt/c/Users for real user directories
    const dirs = execSync("ls /mnt/c/Users 2>/dev/null", { encoding: "utf-8" }).trim().split("\n");
    const systemDirs = new Set([
      "Public", "Default", "Default User", "All Users",
      "desktop.ini", "TEMP", "UMFD-0", "UMFD-1",
      "postgres", "ContainerAdministrator", "ContainerUser",
    ]);
    const users = dirs.filter((d) => d && !systemDirs.has(d) && !d.startsWith("."));
    return users[0] ?? null;
  } catch {
    return null;
  }
}

// ─── Docker scan ─────────────────────────────────────────────────────────────

interface DockerWaste {
  name: string;
  sizeGB: number;
  description: string;
  cleanCommand: string;
}

async function scanDocker(isWin: boolean): Promise<DockerWaste[]> {
  const results: DockerWaste[] = [];

  // Check if Docker is available and responsive
  try {
    await execAsync("docker info", { timeout: 10_000 });
  } catch {
    return results; // Docker not running or not installed
  }

  // Stopped containers
  try {
    const { stdout } = await execAsync(
      'docker ps -a --filter "status=exited" --filter "status=dead" --format "{{.Size}}"',
      { timeout: 15_000 }
    );
    const containerLines = stdout.trim().split("\n").filter(Boolean);
    if (containerLines.length > 0) {
      // Get count for description
      const { stdout: countOut } = await execAsync(
        'docker ps -a --filter "status=exited" --filter "status=dead" -q',
        { timeout: 10_000 }
      );
      const count = countOut.trim().split("\n").filter(Boolean).length;
      if (count > 0) {
        // Estimate size from docker system df
        const sizeGB = await getDockerComponentSize("Containers");
        if (sizeGB > 0.01) {
          results.push({
            name: "Stopped containers",
            sizeGB,
            description: `${count} stopped/dead container(s)`,
            cleanCommand: "docker container prune -f",
          });
        }
      }
    }
  } catch {}

  // Dangling images (untagged, orphaned)
  try {
    const { stdout } = await execAsync(
      'docker images --filter "dangling=true" -q',
      { timeout: 10_000 }
    );
    const danglingIds = stdout.trim().split("\n").filter(Boolean);
    if (danglingIds.length > 0) {
      const sizeGB = await getDockerImageSize("dangling=true");
      if (sizeGB > 0.01) {
        results.push({
          name: "Dangling images",
          sizeGB,
          description: `${danglingIds.length} untagged/orphaned image(s)`,
          cleanCommand: "docker image prune -f",
        });
      }
    }
  } catch {}

  // Unused images (not referenced by any container)
  try {
    const { stdout: allImages } = await execAsync("docker images -q", { timeout: 10_000 });
    const { stdout: usedImages } = await execAsync(
      'docker ps -a --format "{{.Image}}"',
      { timeout: 10_000 }
    );
    const allCount = allImages.trim().split("\n").filter(Boolean).length;
    const usedSet = new Set(usedImages.trim().split("\n").filter(Boolean));
    // Count unused non-dangling images
    const { stdout: tagged } = await execAsync(
      'docker images --format "{{.Repository}}:{{.Tag}}" --filter "dangling=false"',
      { timeout: 10_000 }
    );
    const taggedImages = tagged.trim().split("\n").filter(Boolean);
    const unused = taggedImages.filter((img) => !usedSet.has(img) && img !== "<none>:<none>");
    if (unused.length > 0) {
      const sizeGB = await getDockerImageSize("dangling=false") * (unused.length / Math.max(taggedImages.length, 1));
      if (sizeGB > 0.05) {
        results.push({
          name: "Unused images",
          sizeGB: Math.round(sizeGB * 100) / 100,
          description: `${unused.length} image(s) not used by any container`,
          cleanCommand: "docker image prune -af",
        });
      }
    }
  } catch {}

  // Dangling volumes
  try {
    const { stdout } = await execAsync(
      "docker volume ls --filter dangling=true -q",
      { timeout: 10_000 }
    );
    const vols = stdout.trim().split("\n").filter(Boolean);
    if (vols.length > 0) {
      // Volumes can be huge — estimate via docker system df
      const sizeGB = await getDockerComponentSize("Volumes");
      results.push({
        name: "Dangling volumes",
        sizeGB: sizeGB > 0 ? sizeGB : 0.01,
        description: `${vols.length} volume(s) not used by any container`,
        cleanCommand: "docker volume prune -f",
      });
    }
  } catch {}

  // Build cache
  try {
    const sizeGB = await getDockerComponentSize("Build Cache");
    if (sizeGB > 0.05) {
      results.push({
        name: "Docker build cache",
        sizeGB,
        description: "Cached build layers",
        cleanCommand: "docker builder prune -f",
      });
    }
  } catch {}

  return results;
}

async function getDockerComponentSize(component: string): Promise<number> {
  try {
    const { stdout } = await execAsync("docker system df", { timeout: 15_000 });
    for (const line of stdout.split("\n")) {
      if (line.startsWith(component) || line.includes(component)) {
        // Parse: TYPE   TOTAL   ACTIVE   SIZE   RECLAIMABLE
        const parts = line.split(/\s{2,}/);
        // Reclaimable is the last column, e.g. "2.5GB (100%)"
        const reclaimable = parts[parts.length - 1];
        const sizeMatch = reclaimable.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
        if (sizeMatch) {
          const num = parseFloat(sizeMatch[1]);
          const unit = sizeMatch[2].toUpperCase();
          if (unit === "TB") return num * 1024;
          if (unit === "GB") return num;
          if (unit === "MB") return num / 1024;
          if (unit === "KB") return num / (1024 * 1024);
          return num / 1073741824;
        }
      }
    }
  } catch {}
  return 0;
}

async function getDockerImageSize(filter: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `docker images --filter "${filter}" --format "{{.Size}}"`,
      { timeout: 10_000 }
    );
    let total = 0;
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const match = line.match(/([\d.]+)\s*(B|KB|MB|GB|TB)/i);
      if (match) {
        const num = parseFloat(match[1]);
        const unit = match[2].toUpperCase();
        if (unit === "TB") total += num * 1024;
        else if (unit === "GB") total += num;
        else if (unit === "MB") total += num / 1024;
        else if (unit === "KB") total += num / (1024 * 1024);
      }
    }
    return Math.round(total * 100) / 100;
  } catch {
    return 0;
  }
}

// ─── Scanner ─────────────────────────────────────────────────────────────────

/** Convert a WSL /mnt/c/... path to a Windows C:\... path for PowerShell. */
function wslToWinPath(p: string): string | null {
  const match = p.match(/^\/mnt\/([a-z])\/(.*)$/);
  if (!match) return null;
  return `${match[1].toUpperCase()}:\\${match[2].replace(/\//g, "\\")}`;
}

const POWERSHELL_EXE = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";

async function getDirSizeGB(dirPath: string, platform: PlatformInfo): Promise<number> {
  try {
    if (platform.os === "windows") {
      const { stdout } = await execAsync(
        `powershell -Command "(Get-ChildItem '${dirPath}' -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB"`,
        { timeout: 60_000 }
      );
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? 0 : Math.round(val * 100) / 100;
    }

    // WSL + Windows path: use PowerShell for speed (du on /mnt/c is very slow)
    const winPath = platform.isWSL ? wslToWinPath(dirPath) : null;
    if (winPath) {
      const { stdout } = await execAsync(
        `${POWERSHELL_EXE} -Command "(Get-ChildItem '${winPath}' -Recurse -Force -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1GB"`,
        { timeout: 60_000 }
      );
      const val = parseFloat(stdout.trim());
      return isNaN(val) ? 0 : Math.round(val * 100) / 100;
    }

    // Linux native path
    const { stdout } = await execAsync(
      `du -sb "${dirPath}" 2>/dev/null | cut -f1`,
      { timeout: 30_000 }
    );
    const bytes = parseInt(stdout.trim());
    return isNaN(bytes) ? 0 : Math.round((bytes / 1073741824) * 100) / 100;
  } catch {
    return 0;
  }
}

function getUserHome(platform: PlatformInfo): string {
  if (platform.os === "windows") {
    return process.env.USERPROFILE ?? "C:\\Users\\" + (process.env.USERNAME ?? "User");
  }
  return process.env.HOME ?? "/root";
}

export async function scanForCleanup(platform?: PlatformInfo): Promise<CleanupTarget[]> {
  const plat = platform ?? detectLocalPlatform();
  const userHome = getUserHome(plat);

  let targets: Array<{ name: string; path: string; description: string; cleanCommand: string }>;

  if (plat.os === "windows") {
    targets = getWindowsScanTargets(userHome);
  } else {
    targets = getLinuxScanTargets(userHome);
    // In WSL, also scan Windows-side paths via /mnt/c
    if (plat.isWSL) {
      const winUser = detectWindowsUser();
      if (winUser) {
        targets = [...targets, ...getWSLScanTargets(winUser)];
      }
    }
  }

  const results: CleanupTarget[] = [];

  // Scan in parallel batches of 4 to avoid overwhelming the system
  for (let i = 0; i < targets.length; i += 4) {
    const batch = targets.slice(i, i + 4);
    const sizes = await Promise.all(
      batch.map((t) => getDirSizeGB(t.path, plat))
    );
    for (let j = 0; j < batch.length; j++) {
      if (sizes[j] > 0.01) {
        results.push({
          name: batch[j].name,
          path: batch[j].path,
          sizeGB: sizes[j],
          safe: true,
          description: batch[j].description,
          cleanCommand: batch[j].cleanCommand,
        });
      }
    }
  }

  // Scan Docker separately (uses docker CLI, not directory sizes)
  try {
    const dockerTargets = await scanDocker(plat.os === "windows");
    for (const dt of dockerTargets) {
      results.push({
        name: dt.name,
        path: "[docker]",
        sizeGB: dt.sizeGB,
        safe: true,
        description: dt.description,
        cleanCommand: dt.cleanCommand,
      });
    }
  } catch {}

  // Sort by size descending
  results.sort((a, b) => b.sizeGB - a.sizeGB);
  return results;
}

// ─── Formatter ───────────────────────────────────────────────────────────────

export function formatCleanupTable(targets: CleanupTarget[]): string {
  if (targets.length === 0) {
    return `${c.green}✓ No significant reclaimable space found.${c.reset}`;
  }

  const lines: string[] = [];
  const totalGB = targets.reduce((sum, t) => sum + t.sizeGB, 0);

  lines.push(`\n${c.bold}${c.cyan}── Disk Cleanup Scan ──${c.reset}\n`);

  // Table header
  const nameW = Math.max(12, ...targets.map((t) => t.name.length)) + 2;
  const sizeW = 10;

  lines.push(
    `  ${c.bold}${"#".padEnd(4)}${"Location".padEnd(nameW)}${"Size".padStart(sizeW)}  ${"Description"}${c.reset}`
  );
  lines.push(`  ${"─".repeat(4)}${"─".repeat(nameW)}${"─".repeat(sizeW)}${"─".repeat(2)}${"─".repeat(30)}`);

  for (let i = 0; i < targets.length; i++) {
    const t = targets[i];
    const sizeStr = t.sizeGB >= 1
      ? `${t.sizeGB.toFixed(2)} GB`
      : `${(t.sizeGB * 1024).toFixed(0)} MB`;
    const color = t.sizeGB >= 1 ? c.yellow : c.dim;
    lines.push(
      `  ${String(i + 1).padEnd(4)}${t.name.padEnd(nameW)}${color}${sizeStr.padStart(sizeW)}${c.reset}  ${c.dim}${t.description}${c.reset}`
    );
  }

  lines.push(`\n  ${c.bold}Total reclaimable: ~${totalGB.toFixed(2)} GB${c.reset}`);
  lines.push(`\n  ${c.green}${c.bold}Nothing has been deleted yet.${c.reset} These are only caches and temp files.`);
  lines.push(`  ${c.green}None of your code, projects, documents, or settings will be touched.${c.reset}`);
  lines.push(`  ${c.dim}You will be asked to confirm each item individually before anything is removed.${c.reset}`);

  // WSL note: mention restart option will be offered after cleanup
  const plat = detectLocalPlatform();
  if (plat.isWSL && targets.some((t) => t.path.startsWith("/mnt/"))) {
    lines.push(`  ${c.yellow}${c.bold}⚠ WSL:${c.reset} After cleanup, you'll be offered to restart WSL to clear I/O errors.`);
  }

  return lines.join("\n");
}

// ─── Interactive cleanup ─────────────────────────────────────────────────────

export async function runInteractiveCleanup(targets: CleanupTarget[]): Promise<string> {
  if (targets.length === 0) {
    return `${c.green}✓ Nothing to clean.${c.reset}`;
  }

  const lines: string[] = [];
  let totalCleaned = 0;
  let cleanAll = false;

  console.log(`\n${c.bold}Reviewing each item — nothing is deleted without your approval:${c.reset}`);
  console.log(`${c.dim}  y = yes, N = no (default), all = clean remaining, stop = done${c.reset}\n`);

  for (const target of targets) {
    const sizeStr = target.sizeGB >= 1
      ? `${target.sizeGB.toFixed(2)} GB`
      : `${(target.sizeGB * 1024).toFixed(0)} MB`;

    let shouldClean = false;

    if (cleanAll) {
      shouldClean = true;
      console.log(`  ${c.cyan}→${c.reset} ${target.name} (${sizeStr}) — auto-cleaning`);
    } else {
      const answer = await askWithControl(
        `Delete ${c.bold}${target.name}${c.reset} (${c.yellow}${sizeStr}${c.reset})? ${c.dim}${target.description}${c.reset}`
      );

      if (answer === "stop") {
        lines.push(`  ${c.dim}  Stopped — remaining items not deleted.${c.reset}`);
        break;
      } else if (answer === "all") {
        shouldClean = true;
        cleanAll = true;
        console.log(`  ${c.cyan}Cleaning all remaining items...${c.reset}`);
      } else if (answer === "yes") {
        shouldClean = true;
      } else {
        lines.push(`  ${c.dim}  Skipped ${target.name} — not deleted${c.reset}`);
      }
    }

    if (shouldClean) {
      try {
        await execAsync(target.cleanCommand, { timeout: 120_000 });
        lines.push(`  ${c.green}✓${c.reset} Deleted ${target.name} (${sizeStr} freed)`);
        totalCleaned += target.sizeGB;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        lines.push(`  ${c.red}✗${c.reset} Failed to delete ${target.name}: ${msg.split("\n")[0]}`);
      }
    }
  }

  if (totalCleaned > 0) {
    lines.push(`\n${c.green}${c.bold}✓ Freed ~${totalCleaned.toFixed(2)} GB${c.reset}`);

    // WSL: offer to restart WSL to clear I/O errors
    const plat = detectLocalPlatform();
    if (plat.isWSL) {
      console.log(lines.join("\n"));
      lines.length = 0;

      console.log(`\n  ${c.yellow}${c.bold}⚠ WSL:${c.reset} If you were seeing I/O errors, WSL needs to restart to clear them.`);
      console.log(`  ${c.red}${c.bold}  This will shut down ALL WSL sessions and disconnect this terminal.${c.reset}`);
      console.log(`  ${c.dim}  You can also do this manually later from PowerShell: wsl --shutdown${c.reset}\n`);

      const confirmed = await askForStrictConfirmation(
        `  ${c.bold}Restart WSL now?${c.reset}`,
        "RESTART_WSL"
      );

      if (confirmed) {
        console.log(`\n  ${c.cyan}Shutting down WSL...${c.reset}`);
        try {
          await execAsync("cmd.exe /c wsl --shutdown", { timeout: 30_000 });
          // If we get here, WSL didn't actually kill us yet
          lines.push(`  ${c.green}✓${c.reset} WSL shutdown initiated. Reopen your terminal.`);
        } catch {
          // Expected — the process gets killed when WSL shuts down
          lines.push(`  ${c.dim}WSL is shutting down...${c.reset}`);
        }
      } else {
        lines.push(`  ${c.dim}Skipped WSL restart. Run manually if needed:${c.reset} ${c.cyan}wsl --shutdown${c.reset}`);
      }
    }
  } else {
    lines.push(`\n${c.dim}No changes made.${c.reset}`);
  }

  return lines.join("\n");
}

// ─── Smart Drive Scan ────────────────────────────────────────────────────────

export interface DriveInfo {
  device: string;
  label: string;
  filesystem: string;
  sizeGB: number;
  usedGB: number;
  freeGB: number;
  usePct: number;
  mount: string;
}

export async function smartDriveScan(platform?: PlatformInfo): Promise<DriveInfo[]> {
  const plat = platform ?? detectLocalPlatform();

  if (plat.os === "windows") {
    return scanWindowsDrives("powershell");
  } else if (plat.isWSL) {
    return scanWSLDrives();
  } else {
    return scanLinuxDrives();
  }
}

async function scanWindowsDrives(psExe: string): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = [];
  try {
    const { stdout } = await execAsync(
      `${psExe} -Command "Get-CimInstance Win32_LogicalDisk -Filter 'DriveType=3' | ForEach-Object { \\$_.DeviceID + '|' + \\$_.VolumeName + '|' + \\$_.FileSystem + '|' + \\$_.Size + '|' + \\$_.FreeSpace }"`,
      { timeout: 15_000 }
    );
    for (const line of stdout.trim().split("\n").filter(Boolean)) {
      const [device, label, fs, sizeRaw, freeRaw] = line.trim().split("|");
      const sizeGB = Math.round(parseInt(sizeRaw) / 1073741824 * 10) / 10;
      const freeGB = Math.round(parseInt(freeRaw) / 1073741824 * 10) / 10;
      const usedGB = Math.round((sizeGB - freeGB) * 10) / 10;
      const usePct = sizeGB > 0 ? Math.round((usedGB / sizeGB) * 100) : 0;
      drives.push({ device, label: label || "", filesystem: fs || "", sizeGB, usedGB, freeGB, usePct, mount: device + "\\" });
    }
  } catch {}
  return drives;
}

async function scanWSLDrives(): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = [];

  // Get Windows drives via PowerShell (accurate labels + filesystem info)
  try {
    const winDrives = await scanWindowsDrives(POWERSHELL_EXE);
    for (const d of winDrives) {
      const letter = d.device.replace(":", "").toLowerCase();
      d.mount = `/mnt/${letter}`;
      drives.push(d);
    }
  } catch {}

  // Also add the WSL root filesystem
  try {
    const { stdout } = await execAsync("df -B1 / | tail -1", { timeout: 5000 });
    const parts = stdout.trim().split(/\s+/);
    if (parts.length >= 5) {
      const sizeGB = Math.round(parseInt(parts[1]) / 1073741824 * 10) / 10;
      const usedGB = Math.round(parseInt(parts[2]) / 1073741824 * 10) / 10;
      const freeGB = Math.round(parseInt(parts[3]) / 1073741824 * 10) / 10;
      const usePct = parseInt(parts[4]);
      drives.push({ device: parts[0], label: "WSL Root", filesystem: "ext4", sizeGB, usedGB, freeGB, usePct, mount: "/" });
    }
  } catch {}

  return drives;
}

async function scanLinuxDrives(): Promise<DriveInfo[]> {
  const drives: DriveInfo[] = [];
  try {
    const { stdout } = await execAsync(
      "df -B1 -x tmpfs -x devtmpfs -x squashfs -x overlay 2>/dev/null || df -B1 | grep -v tmpfs",
      { timeout: 10_000 }
    );
    for (const line of stdout.trim().split("\n").slice(1)) {
      const parts = line.trim().split(/\s+/);
      if (parts.length < 6 || parts[0] === "Filesystem" || parts[0].startsWith("snap")) continue;
      const sizeGB = Math.round(parseInt(parts[1]) / 1073741824 * 10) / 10;
      const usedGB = Math.round(parseInt(parts[2]) / 1073741824 * 10) / 10;
      const freeGB = Math.round(parseInt(parts[3]) / 1073741824 * 10) / 10;
      const usePct = parseInt(parts[4]);
      if (sizeGB < 0.1) continue;
      drives.push({ device: parts[0], label: "", filesystem: "", sizeGB, usedGB, freeGB, usePct, mount: parts[5] });
    }
  } catch {}
  return drives;
}

/** Scan top-level directories on a drive to find space hogs. */
async function scanTopDirs(drive: DriveInfo, platform: PlatformInfo): Promise<Array<{ path: string; sizeGB: number }>> {
  const results: Array<{ path: string; sizeGB: number }> = [];

  if (platform.os === "windows" || (platform.isWSL && drive.mount.startsWith("/mnt/"))) {
    const winDrive = platform.isWSL ? drive.device + "\\" : drive.mount;
    const psExe = platform.isWSL ? POWERSHELL_EXE : "powershell";
    try {
      const { stdout } = await execAsync(
        `${psExe} -Command "Get-ChildItem '${winDrive}' -Directory -Force -ErrorAction SilentlyContinue | Where-Object { \\$_.Name -notmatch '^(\\$Recycle|System Volume|Recovery)' } | ForEach-Object { \\$s = 0; try { \\$s = (Get-ChildItem \\$_.FullName -Recurse -File -Force -ErrorAction SilentlyContinue | Measure-Object -Property Length -Sum -ErrorAction SilentlyContinue).Sum } catch {}; if(\\$s -gt 104857600) { '{0}|{1}' -f [math]::Round(\\$s/1GB,2),\\$_.Name } }"`,
        { timeout: 300_000 }
      );
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const [sizeStr, name] = line.trim().split("|");
        if (name && sizeStr && !isNaN(parseFloat(sizeStr))) {
          results.push({ path: name, sizeGB: parseFloat(sizeStr) });
        }
      }
    } catch {}
  } else {
    try {
      const { stdout } = await execAsync(
        `du -B1 --max-depth=1 "${drive.mount}" 2>/dev/null | sort -rn | head -15`,
        { timeout: 30_000 }
      );
      for (const line of stdout.trim().split("\n").filter(Boolean)) {
        const parts = line.split("\t");
        if (parts.length < 2) continue;
        const sizeGB = Math.round(parseInt(parts[0]) / 1073741824 * 100) / 100;
        const dirName = parts[1].replace(drive.mount === "/" ? "" : drive.mount, "").replace(/^\//, "") || "/";
        if (sizeGB > 0.1 && dirName !== drive.mount && dirName !== "") {
          results.push({ path: dirName, sizeGB });
        }
      }
    } catch {}
  }

  results.sort((a, b) => b.sizeGB - a.sizeGB);
  return results.slice(0, 10);
}

function driveUsageBar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent >= 95 ? c.red : percent >= 85 ? c.yellow : c.green;
  return `${color}${"█".repeat(filled)}${"░".repeat(empty)}${c.reset}`;
}

export async function formatDriveScan(drives: DriveInfo[], deepScan = false): Promise<string> {
  const plat = detectLocalPlatform();
  const lines: string[] = [];

  lines.push(`\n${c.bold}${c.cyan}── Drive Analysis ──${c.reset}\n`);

  const sorted = [...drives].sort((a, b) => b.usePct - a.usePct);

  for (const d of sorted) {
    const bar = driveUsageBar(d.usePct);
    const status = d.usePct >= 95 ? `${c.red}CRITICAL${c.reset}` :
                   d.usePct >= 85 ? `${c.yellow}WARNING${c.reset}` :
                   d.usePct >= 70 ? `${c.dim}MODERATE${c.reset}` :
                   `${c.green}OK${c.reset}`;
    const labelStr = d.label ? ` ${c.dim}(${d.label})${c.reset}` : "";
    const fsStr = d.filesystem ? ` ${c.dim}[${d.filesystem}]${c.reset}` : "";

    lines.push(`  ${c.bold}${d.device}${c.reset}${labelStr}${fsStr}  ${d.mount}`);
    lines.push(`  ${bar}  ${d.usePct}% used  ${c.bold}${d.usedGB}G${c.reset} / ${d.sizeGB}G  (${c.bold}${d.freeGB}G free${c.reset})  ${status}`);

    // Deep scan: show top directories for critical/warning drives
    if (deepScan && d.usePct >= 85) {
      const topDirs = await scanTopDirs(d, plat);
      if (topDirs.length > 0) {
        lines.push(`  ${c.dim}Top space usage:${c.reset}`);
        for (const dir of topDirs.slice(0, 5)) {
          const pct = d.sizeGB > 0 ? Math.round((dir.sizeGB / d.sizeGB) * 100) : 0;
          const sizeStr = dir.sizeGB >= 1 ? `${dir.sizeGB.toFixed(1)}G` : `${(dir.sizeGB * 1024).toFixed(0)}M`;
          lines.push(`    ${c.yellow}${sizeStr.padStart(7)}${c.reset}  ${dir.path}  ${c.dim}(${pct}%)${c.reset}`);
        }
      }
    }
    lines.push("");
  }

  const critCount = sorted.filter(d => d.usePct >= 95).length;
  const warnCount = sorted.filter(d => d.usePct >= 85 && d.usePct < 95).length;
  if (critCount > 0) {
    lines.push(`  ${c.red}${c.bold}${critCount} drive(s) critically full!${c.reset} Run "free up space" to clean.`);
  }
  if (warnCount > 0) {
    lines.push(`  ${c.yellow}${warnCount} drive(s) approaching full.${c.reset}`);
  }
  if (critCount === 0 && warnCount === 0) {
    lines.push(`  ${c.green}✓ All drives healthy.${c.reset}`);
  }

  return lines.join("\n");
}

// ─── Background deep scan ────────────────────────────────────────────────────

/**
 * Kicks off a background deep scan of critical/warning drives.
 * Shows top space-consuming directories when complete.
 * Uses the TaskRunner so the interactive REPL picks up the notification.
 */
export function runDeepScanBackground(drives: DriveInfo[]): void {
  const intent = {
    intent: "disk.scan.deep",
    confidence: 1,
    rawText: "deep scan drives",
    fields: {},
  };

  taskRunner.submit("Deep scanning drives for top space usage...", intent, async () => {
    const plat = detectLocalPlatform();
    const lines: string[] = [];
    lines.push(`\n${c.bold}${c.cyan}── Deep Scan Results ──${c.reset}\n`);

    for (const d of drives) {
      const topDirs = await scanTopDirs(d, plat);
      if (topDirs.length === 0) continue;

      const labelStr = d.label ? ` (${d.label})` : "";
      lines.push(`  ${c.bold}${d.device}${c.reset}${labelStr}  ${d.mount}  ${c.dim}(${d.usePct}% full, ${d.freeGB}G free)${c.reset}`);

      for (const dir of topDirs.slice(0, 7)) {
        const pct = d.sizeGB > 0 ? Math.round((dir.sizeGB / d.sizeGB) * 100) : 0;
        const sizeStr = dir.sizeGB >= 1 ? `${dir.sizeGB.toFixed(1)}G` : `${(dir.sizeGB * 1024).toFixed(0)}M`;
        lines.push(`    ${c.yellow}${sizeStr.padStart(7)}${c.reset}  ${dir.path}  ${c.dim}(${pct}% of drive)${c.reset}`);
      }
      lines.push("");
    }

    lines.push(`  ${c.dim}Tip: Run "free up space" to clean caches and temp files.${c.reset}`);
    return lines.join("\n");
  });
}
