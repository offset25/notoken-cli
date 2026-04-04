/**
 * User Context — detect who's running notoken and where their configs live.
 *
 * Handles: root, regular user, WSL user running as root, Windows user
 * Prevents: auth conflicts, wrong config paths, stale tokens from other users
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

export interface UserContext {
  /** Effective user running the process */
  effectiveUser: string;
  /** Logged-in user (may differ from effective in sudo/WSL) */
  loginUser: string;
  /** Home directory of the effective user */
  homeDir: string;
  /** Home directory of the login user (for finding their configs) */
  loginHomeDir: string;
  /** Whether running as root */
  isRoot: boolean;
  /** Whether running in WSL */
  isWSL: boolean;
  /** Whether running on native Windows */
  isWindows: boolean;
  /** Windows user profile path (if in WSL or Windows) */
  windowsProfile: string | null;
  /** Path to this user's OpenClaw config */
  openclawHome: string;
  /** Path to this user's Claude credentials */
  claudeCredsPath: string;
  /** Path to this user's Codex auth */
  codexAuthPath: string;
  /** Path to this user's notoken data */
  notokenHome: string;
}

let _cached: UserContext | null = null;

function tryExec(cmd: string): string {
  try { return execSync(cmd, { encoding: "utf-8", timeout: 3000, stdio: ["pipe", "pipe", "pipe"] }).trim(); } catch { return ""; }
}

/**
 * Detect the current user context.
 */
export function getUserContext(): UserContext {
  if (_cached) return _cached;

  const isWindows = process.platform === "win32";
  const isWSL = !isWindows && existsSync("/proc/version") &&
    (tryExec("grep -qi microsoft /proc/version && echo wsl") === "wsl");

  // Effective user (who the process runs as)
  const effectiveUser = isWindows
    ? (process.env.USERNAME ?? "user")
    : tryExec("whoami") || "root";

  // Login user (who actually logged in — important for sudo/WSL)
  const loginUser = process.env.SUDO_USER
    ?? process.env.USER
    ?? process.env.LOGNAME
    ?? effectiveUser;

  // Home directories
  const homeDir = homedir();
  let loginHomeDir = homeDir;
  if (effectiveUser === "root" && loginUser !== "root") {
    // Running as root but logged in as another user
    const userHome = `/home/${loginUser}`;
    if (existsSync(userHome)) loginHomeDir = userHome;
  }

  const isRoot = effectiveUser === "root";

  // Windows profile
  let windowsProfile: string | null = null;
  if (isWSL) {
    windowsProfile = tryExec("cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null").replace(/\r/g, "");
  } else if (isWindows) {
    windowsProfile = process.env.USERPROFILE ?? null;
  }

  const sep = isWindows ? "\\" : "/";

  // Config paths — prefer login user's paths over root's
  // This way "sudo notoken" still reads ino's configs
  const configBase = loginHomeDir;

  _cached = {
    effectiveUser,
    loginUser,
    homeDir,
    loginHomeDir,
    isRoot,
    isWSL,
    isWindows,
    windowsProfile,
    openclawHome: resolve(configBase, ".openclaw"),
    claudeCredsPath: resolve(configBase, ".claude", ".credentials.json"),
    codexAuthPath: resolve(configBase, ".codex", "auth.json"),
    notokenHome: resolve(configBase, ".notoken"),
  };

  return _cached;
}

/**
 * Get the right OpenClaw auth profiles path for the current user.
 */
export function getAuthProfilesPath(): string {
  const ctx = getUserContext();
  return resolve(ctx.openclawHome, "agents", "main", "agent", "auth-profiles.json");
}

/**
 * Detect if there's a user mismatch (running as root but configs belong to another user).
 */
export function detectUserMismatch(): { mismatch: boolean; message: string } {
  const ctx = getUserContext();
  if (!ctx.isRoot || ctx.loginUser === "root") {
    return { mismatch: false, message: "" };
  }

  // Check if root's openclaw config exists vs login user's
  const rootOC = existsSync(resolve("/root", ".openclaw", "openclaw.json"));
  const userOC = existsSync(resolve(ctx.loginHomeDir, ".openclaw", "openclaw.json"));

  if (rootOC && userOC) {
    return {
      mismatch: true,
      message: `Running as root but ${ctx.loginUser} also has OpenClaw config. Using ${ctx.loginUser}'s config from ${ctx.loginHomeDir}.`,
    };
  }

  if (rootOC && !userOC) {
    return {
      mismatch: true,
      message: `Running as root. ${ctx.loginUser} has no OpenClaw config — using root's.`,
    };
  }

  return { mismatch: false, message: "" };
}

/**
 * Find the freshest Claude token across all users.
 */
export function findFreshestClaudeToken(): { token: string; expires: number; source: string } | null {
  const candidates = [
    { path: "/root/.claude/.credentials.json", label: "root" },
    { path: resolve(getUserContext().loginHomeDir, ".claude", ".credentials.json"), label: getUserContext().loginUser },
  ];

  let best: { token: string; expires: number; source: string } | null = null;

  for (const { path, label } of candidates) {
    try {
      if (!existsSync(path)) continue;
      const data = JSON.parse(readFileSync(path, "utf-8"));
      const token = data?.claudeAiOauth?.accessToken;
      const expires = data?.claudeAiOauth?.expiresAt ?? 0;
      if (token && (!best || expires > best.expires)) {
        best = { token, expires, source: label };
      }
    } catch {}
  }

  return best;
}

/** Reset cache (for testing). */
export function resetUserContext(): void { _cached = null; }
