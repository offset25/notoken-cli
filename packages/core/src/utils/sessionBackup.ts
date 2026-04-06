/**
 * Session backup and restore.
 *
 * Backup: tars ~/.notoken/ into a timestamped archive
 * Restore: extracts an archive back to ~/.notoken/
 * Manages open/closed state per session for the dashboard
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { USER_HOME } from "./paths.js";

const PREFS_FILE = resolve(USER_HOME, "session-prefs.json");
const BACKUP_DIR = resolve(USER_HOME, "backups");

// ─── Session Open/Close State ───────────────────────────────────────────────

interface SessionPrefs {
  /** Which sessions are expanded/open in the dashboard */
  openSessions: string[];
  /** Sessions the user has archived/hidden */
  hiddenSessions: string[];
  /** Last viewed session */
  lastViewed?: string;
}

function loadPrefs(): SessionPrefs {
  try {
    if (existsSync(PREFS_FILE)) return JSON.parse(readFileSync(PREFS_FILE, "utf-8"));
  } catch {}
  return { openSessions: [], hiddenSessions: [] };
}

function savePrefs(prefs: SessionPrefs): void {
  try {
    mkdirSync(USER_HOME, { recursive: true });
    writeFileSync(PREFS_FILE, JSON.stringify(prefs, null, 2));
  } catch {}
}

export function isSessionOpen(sessionId: string): boolean {
  return loadPrefs().openSessions.includes(sessionId);
}

export function toggleSession(sessionId: string): boolean {
  const prefs = loadPrefs();
  const idx = prefs.openSessions.indexOf(sessionId);
  if (idx >= 0) {
    prefs.openSessions.splice(idx, 1);
    savePrefs(prefs);
    return false;
  } else {
    prefs.openSessions.push(sessionId);
    prefs.lastViewed = sessionId;
    savePrefs(prefs);
    return true;
  }
}

export function hideSession(sessionId: string): void {
  const prefs = loadPrefs();
  if (!prefs.hiddenSessions.includes(sessionId)) {
    prefs.hiddenSessions.push(sessionId);
  }
  prefs.openSessions = prefs.openSessions.filter(s => s !== sessionId);
  savePrefs(prefs);
}

export function unhideSession(sessionId: string): void {
  const prefs = loadPrefs();
  prefs.hiddenSessions = prefs.hiddenSessions.filter(s => s !== sessionId);
  savePrefs(prefs);
}

export function getHiddenSessions(): string[] {
  return loadPrefs().hiddenSessions;
}

export function getLastViewedSession(): string | undefined {
  return loadPrefs().lastViewed;
}

// ─── Full Backup ────────────────────────────────────────────────────────────

export interface BackupInfo {
  path: string;
  filename: string;
  size: string;
  createdAt: string;
}

/**
 * Create a full backup of ~/.notoken/ as a tar.gz archive.
 * Saves to ~/.notoken/backups/ by default, or a custom path.
 */
export function createFullBackup(outputDir?: string): BackupInfo {
  const dir = outputDir ?? BACKUP_DIR;
  mkdirSync(dir, { recursive: true });

  const ts = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const filename = `notoken-backup-${ts}.tar.gz`;
  const fullPath = resolve(dir, filename);

  // Tar everything except the backups directory itself
  execSync(
    `tar -czf "${fullPath}" -C "${resolve(USER_HOME, "..")}" --exclude="backups" "${basename(USER_HOME)}"`,
    { timeout: 60_000, stdio: "pipe" }
  );

  const size = tryExec(`ls -lh "${fullPath}" | awk '{print $5}'`) ?? "unknown";

  return {
    path: fullPath,
    filename,
    size,
    createdAt: new Date().toISOString(),
  };
}

/**
 * Restore from a backup archive.
 * Creates a safety backup of current state first.
 */
export function restoreFromBackup(archivePath: string): { success: boolean; message: string } {
  if (!existsSync(archivePath)) {
    return { success: false, message: `Backup not found: ${archivePath}` };
  }

  // Safety backup of current state
  try {
    const safety = createFullBackup();
    console.error(`\x1b[2m[backup] Safety backup created: ${safety.path}\x1b[0m`);
  } catch {}

  // Extract
  try {
    execSync(
      `tar -xzf "${archivePath}" -C "${resolve(USER_HOME, "..")}"`,
      { timeout: 60_000, stdio: "pipe" }
    );
    return { success: true, message: `Restored from ${basename(archivePath)}` };
  } catch (err) {
    return { success: false, message: `Restore failed: ${(err as Error).message}` };
  }
}

/**
 * List available backups.
 */
export function listFullBackups(): BackupInfo[] {
  if (!existsSync(BACKUP_DIR)) return [];

  try {
    return readdirSync(BACKUP_DIR)
      .filter((f: string) => f.startsWith("notoken-backup-") && f.endsWith(".tar.gz"))
      .map((f: string) => {
        const full = resolve(BACKUP_DIR, f);
        const stat = statSync(full);
        return {
          path: full,
          filename: f,
          size: formatSize(stat.size),
          createdAt: stat.mtime.toISOString(),
        };
      })
      .sort((a: BackupInfo, b: BackupInfo) => b.createdAt.localeCompare(a.createdAt));
  } catch {
    return [];
  }
}

/**
 * Format backup list for display.
 */
export function formatBackupsList(backups: BackupInfo[]): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m" };

  if (backups.length === 0) return `${c.dim}No backups found.${c.reset}`;

  const lines = [`${c.bold}Backups:${c.reset}\n`];
  for (const b of backups) {
    const ago = timeAgo(b.createdAt);
    lines.push(`  ${c.cyan}${b.filename}${c.reset} — ${b.size} — ${ago}`);
  }
  lines.push(`\n  ${c.dim}Backup dir: ${BACKUP_DIR}${c.reset}`);
  lines.push(`  ${c.dim}Restore: notoken restore <filename>${c.reset}`);
  return lines.join("\n");
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function timeAgo(dateStr: string): string {
  const ms = Date.now() - new Date(dateStr).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 }).trim() || null;
  } catch { return null; }
}
