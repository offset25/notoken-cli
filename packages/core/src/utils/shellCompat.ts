/**
 * Shell compatibility layer.
 *
 * Abstracts platform differences so commands work on:
 *   - Linux (bash)
 *   - macOS (zsh/bash)
 *   - Windows (cmd.exe / PowerShell)
 *   - WSL (bash, but with /mnt/ Windows drives)
 *
 * Use these helpers instead of raw execSync with bash-isms.
 */

import { execSync } from "node:child_process";
import { platform as osPlatform, tmpdir, homedir } from "node:os";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

const isWin = osPlatform() === "win32";
const isWSL = (() => {
  try {
    return !!execSync("grep -qi microsoft /proc/version && echo wsl", {
      encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 2000,
    }).trim();
  } catch { return false; }
})();

export { isWin, isWSL };

/**
 * Check if a command exists on this platform.
 */
export function commandExists(cmd: string): boolean {
  try {
    if (isWin) {
      execSync(`where ${cmd}`, { stdio: "pipe", timeout: 5000 });
    } else {
      execSync(`command -v ${cmd}`, { stdio: "pipe", timeout: 5000 });
    }
    return true;
  } catch { return false; }
}

/**
 * Run a command and get output. Returns null on failure.
 * Handles stderr redirection cross-platform.
 */
export function tryExec(cmd: string, timeout = 5000): string | null {
  try {
    const result = execSync(cmd, {
      encoding: "utf-8" as const,
      stdio: ["pipe", "pipe", "pipe"] as const,
      timeout,
      ...(isWin ? { shell: "cmd.exe" } : {}),
    });
    return result.trim() || null;
  } catch { return null; }
}

/**
 * Get the temp directory.
 */
export function getTempDir(): string {
  return tmpdir();
}

/**
 * Generate a timestamp string (replaces `$(date +%Y%m%d-%H%M%S)` in shell).
 */
export function timestamp(): string {
  const d = new Date();
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}-${String(d.getHours()).padStart(2, "0")}${String(d.getMinutes()).padStart(2, "0")}${String(d.getSeconds()).padStart(2, "0")}`;
}

/**
 * Get file size in bytes. Returns 0 if file doesn't exist.
 */
export function fileSize(path: string): number {
  try { return statSync(path).size; } catch { return 0; }
}

/**
 * Count lines in a file without shell commands.
 */
export function lineCount(path: string): number {
  try {
    return readFileSync(path, "utf-8").split("\n").length;
  } catch { return 0; }
}

/**
 * Run a command with proper shell for this platform.
 */
export function shellExec(cmd: string, opts: {
  cwd?: string;
  timeout?: number;
  stdio?: "inherit" | "pipe";
} = {}): string {
  const execOpts: Record<string, unknown> = {
    encoding: "utf-8" as const,
    timeout: opts.timeout ?? 30000,
    stdio: opts.stdio === "pipe" ? ["pipe", "pipe", "pipe"] : "inherit",
  };
  if (opts.cwd) execOpts.cwd = opts.cwd;
  if (isWin) execOpts.shell = "cmd.exe";

  return execSync(cmd, execOpts as Parameters<typeof execSync>[1]) as unknown as string;
}

/**
 * Build a command that works on both Unix and Windows.
 * Handles: stderr redirection, path separators, etc.
 */
export function crossPlatformCmd(unixCmd: string, windowsCmd?: string): string {
  if (isWin && windowsCmd) return windowsCmd;
  return unixCmd;
}

/**
 * Redirect stderr to null, cross-platform.
 * Unix: 2>/dev/null
 * Windows: 2>NUL
 */
export function silenceStderr(cmd: string): string {
  if (isWin) return `${cmd} 2>NUL`;
  return `${cmd} 2>/dev/null`;
}

/**
 * Get the home directory path.
 */
export function getHome(): string {
  return homedir();
}

/**
 * Resolve a path that works on this platform.
 */
export function resolvePath(...parts: string[]): string {
  return resolve(...parts);
}

/**
 * Check if running as root/admin.
 */
export function isAdmin(): boolean {
  if (isWin) {
    return !!tryExec("net session 2>NUL");
  }
  return process.getuid?.() === 0;
}

/**
 * Get the package install command for this platform.
 */
export function getSystemInstallCmd(pkg: string): string {
  if (isWin) {
    if (commandExists("winget")) return `winget install ${pkg} --accept-source-agreements --accept-package-agreements -h`;
    if (commandExists("choco")) return `choco install ${pkg} -y`;
    return `echo "Please install ${pkg} manually"`;
  }
  if (commandExists("apt-get")) return `sudo apt-get install -y ${pkg}`;
  if (commandExists("dnf")) return `sudo dnf install -y ${pkg}`;
  if (commandExists("brew")) return `brew install ${pkg}`;
  if (commandExists("apk")) return `apk add ${pkg}`;
  return `echo "Please install ${pkg} manually"`;
}

/**
 * Platform info for display.
 */
export function getPlatformSummary(): string {
  const os = osPlatform();
  if (isWSL) return "WSL (Windows Subsystem for Linux)";
  if (os === "win32") return "Windows";
  if (os === "darwin") return "macOS";
  return "Linux";
}
