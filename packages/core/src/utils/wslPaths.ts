/**
 * Windows/WSL path support.
 *
 * Handles:
 * - Detecting WSL environment
 * - Converting between Windows (C:\Users\...) and Linux (/mnt/c/Users/...) paths
 * - Resolving ~ and %USERPROFILE% across platforms
 * - Path normalization for cross-platform commands
 */

import { execSync } from "node:child_process";
import { platform as osPlatform } from "node:os";
import { resolve } from "node:path";

const isWSL = osPlatform() === "linux" && (
  process.env.WSL_DISTRO_NAME !== undefined ||
  process.env.WSLENV !== undefined ||
  (() => { try { return require("os").release().toLowerCase().includes("microsoft"); } catch { return false; } })()
);

const isWindows = osPlatform() === "win32";

/**
 * Convert a Windows path to WSL Linux path.
 * C:\Users\dino\docs → /mnt/c/Users/dino/docs
 */
export function winToLinux(winPath: string): string {
  if (!winPath) return winPath;

  // Already a Linux path
  if (winPath.startsWith("/")) return winPath;

  // Try wslpath if available (most reliable)
  if (isWSL) {
    try {
      return execSync(`wslpath -u ${JSON.stringify(winPath)}`, { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {}
  }

  // Manual conversion: C:\Users\... → /mnt/c/Users/...
  const match = winPath.match(/^([A-Za-z]):[\\\/](.*)/);
  if (match) {
    const drive = match[1].toLowerCase();
    const rest = match[2].replace(/\\/g, "/");
    return `/mnt/${drive}/${rest}`;
  }

  // UNC path: \\server\share → /mnt/server/share (approximation)
  if (winPath.startsWith("\\\\")) {
    return winPath.replace(/\\/g, "/").replace(/^\/\//, "/mnt/");
  }

  return winPath;
}

/**
 * Convert a WSL Linux path to Windows path.
 * /mnt/c/Users/dino/docs → C:\Users\dino\docs
 */
export function linuxToWin(linuxPath: string): string {
  if (!linuxPath) return linuxPath;

  // Already a Windows path
  if (/^[A-Za-z]:/.test(linuxPath)) return linuxPath;

  // Try wslpath if available
  if (isWSL) {
    try {
      return execSync(`wslpath -w ${JSON.stringify(linuxPath)}`, { encoding: "utf-8", timeout: 3000 }).trim();
    } catch {}
  }

  // Manual: /mnt/c/Users/... → C:\Users\...
  const match = linuxPath.match(/^\/mnt\/([a-z])\/(.*)/);
  if (match) {
    const drive = match[1].toUpperCase();
    const rest = match[2].replace(/\//g, "\\");
    return `${drive}:\\${rest}`;
  }

  return linuxPath;
}

/**
 * Normalize a path for the current platform.
 * Accepts either Windows or Linux format, returns appropriate format.
 */
export function normalizePath(inputPath: string): string {
  if (!inputPath) return inputPath;

  // Expand ~ to home directory
  if (inputPath.startsWith("~")) {
    const home = process.env.HOME || process.env.USERPROFILE || "";
    inputPath = resolve(home, inputPath.slice(2));
  }

  // Expand %USERPROFILE% (Windows env var)
  if (inputPath.includes("%USERPROFILE%")) {
    const profile = process.env.USERPROFILE || process.env.HOME || "";
    inputPath = inputPath.replace(/%USERPROFILE%/gi, profile);
  }

  // On WSL: convert Windows paths to Linux paths
  if (isWSL && /^[A-Za-z]:/.test(inputPath)) {
    return winToLinux(inputPath);
  }

  // On Windows: convert Linux-style /mnt/c paths
  if (isWindows && inputPath.startsWith("/mnt/")) {
    return linuxToWin(inputPath);
  }

  return inputPath;
}

/**
 * Get common user directories in the correct format.
 */
export function getUserDirs(): Record<string, string> {
  const home = process.env.HOME || process.env.USERPROFILE || "";

  if (isWindows) {
    const profile = process.env.USERPROFILE || "";
    return {
      home: profile,
      documents: resolve(profile, "Documents"),
      downloads: resolve(profile, "Downloads"),
      desktop: resolve(profile, "Desktop"),
    };
  }

  if (isWSL) {
    // In WSL, get both Linux home and Windows home
    const winHome = tryExec("wslpath -u \"$(cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null | tr -d '\\r')\"");
    return {
      home,
      documents: winHome ? `${winHome}/Documents` : resolve(home, "Documents"),
      downloads: winHome ? `${winHome}/Downloads` : resolve(home, "Downloads"),
      desktop: winHome ? `${winHome}/Desktop` : resolve(home, "Desktop"),
      winHome: winHome || "",
    };
  }

  return {
    home,
    documents: resolve(home, "Documents"),
    downloads: resolve(home, "Downloads"),
    desktop: resolve(home, "Desktop"),
  };
}

export { isWSL, isWindows };

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", timeout: 5000, stdio: ["pipe", "pipe", "pipe"] }).trim() || null;
  } catch {
    return null;
  }
}
