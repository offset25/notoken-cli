/**
 * Auto-backup system.
 *
 * Before any file modification (copy, move, remove, env.set),
 * creates a timestamped backup in ~/.notoken/backups/.
 * Backups are kept for a configurable number of hours (default: 6).
 *
 * Also supports manual rollback.
 */

import { existsSync, mkdirSync, copyFileSync, readdirSync, unlinkSync, statSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, basename, dirname } from "node:path";
import { homedir } from "node:os";

const BACKUP_ROOT = resolve(homedir(), ".notoken", "backups");
const DEFAULT_RETENTION_HOURS = 6;

export interface BackupRecord {
  id: string;
  originalPath: string;
  backupPath: string;
  timestamp: string;
  intent: string;
  expiresAt: string;
}

function ensureBackupDir(): void {
  if (!existsSync(BACKUP_ROOT)) {
    mkdirSync(BACKUP_ROOT, { recursive: true });
  }
}

/**
 * Create a backup of a file before modifying it.
 * Returns the backup record, or null if the file doesn't exist.
 */
export function createBackup(
  originalPath: string,
  intent: string,
  retentionHours = DEFAULT_RETENTION_HOURS
): BackupRecord | null {
  // For remote files, we can't backup locally — this is for local files
  if (!existsSync(originalPath)) return null;

  ensureBackupDir();

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const name = basename(originalPath);
  const id = `${name}_${ts}`;
  const backupPath = resolve(BACKUP_ROOT, id);

  copyFileSync(originalPath, backupPath);

  const record: BackupRecord = {
    id,
    originalPath,
    backupPath,
    timestamp: new Date().toISOString(),
    intent,
    expiresAt: new Date(Date.now() + retentionHours * 3600_000).toISOString(),
  };

  // Save record index
  const index = loadIndex();
  index.push(record);
  saveIndex(index);

  return record;
}

/**
 * Generate the remote backup command to run before modifying a file.
 * This returns a shell command string that creates a backup on the remote server.
 */
export function getRemoteBackupCommand(filePath: string): string {
  const ts = "$(date +%Y%m%d-%H%M%S)";
  const backupDir = "/tmp/.notoken-backups";
  const name = filePath.split("/").pop() ?? "file";
  return `mkdir -p ${backupDir} && cp -a ${filePath} ${backupDir}/${name}.${ts}.bak 2>/dev/null; `;
}

/**
 * Rollback a file from backup.
 */
export function rollback(id: string): boolean {
  const index = loadIndex();
  const record = index.find((r) => r.id === id);
  if (!record) return false;

  if (!existsSync(record.backupPath)) return false;

  // Backup the current file before rolling back (safety)
  if (existsSync(record.originalPath)) {
    const safetyBackup = record.backupPath + ".pre-rollback";
    copyFileSync(record.originalPath, safetyBackup);
  }

  copyFileSync(record.backupPath, record.originalPath);
  return true;
}

/**
 * List all current backups.
 */
export function listBackups(): BackupRecord[] {
  const index = loadIndex();
  // Filter out expired
  const now = new Date();
  return index.filter((r) => new Date(r.expiresAt) > now && existsSync(r.backupPath));
}

/**
 * Clean up expired backups.
 */
export function cleanExpiredBackups(): number {
  const index = loadIndex();
  const now = new Date();
  let cleaned = 0;

  const remaining = index.filter((r) => {
    if (new Date(r.expiresAt) <= now) {
      try {
        if (existsSync(r.backupPath)) unlinkSync(r.backupPath);
      } catch {}
      cleaned++;
      return false;
    }
    return true;
  });

  saveIndex(remaining);
  return cleaned;
}

/**
 * Format backup list for display.
 */
export function formatBackupList(records: BackupRecord[]): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m", green: "\x1b[32m" };

  if (records.length === 0) return `${c.dim}No backups available.${c.reset}`;

  const lines = [`${c.bold}Auto-backups:${c.reset}`];
  for (const r of records) {
    const age = Math.round((Date.now() - new Date(r.timestamp).getTime()) / 60000);
    const ageStr = age < 60 ? `${age}m ago` : `${Math.round(age / 60)}h ago`;
    const expires = Math.round((new Date(r.expiresAt).getTime() - Date.now()) / 60000);
    const expiresStr = expires < 60 ? `${expires}m left` : `${Math.round(expires / 60)}h left`;

    lines.push(`  ${c.cyan}${r.id}${c.reset}`);
    lines.push(`    ${r.originalPath} → ${c.dim}${r.backupPath}${c.reset}`);
    lines.push(`    ${c.dim}${ageStr} | ${expiresStr} | ${r.intent}${c.reset}`);
  }

  lines.push(`\n  ${c.dim}Rollback: :rollback <id>${c.reset}`);
  return lines.join("\n");
}

// ─── Index management ────────────────────────────────────────────────────────

const INDEX_FILE = resolve(BACKUP_ROOT, "index.json");

function loadIndex(): BackupRecord[] {
  ensureBackupDir();
  if (!existsSync(INDEX_FILE)) return [];
  try {
    return JSON.parse(readFileSync(INDEX_FILE, "utf-8"));
  } catch {
    return [];
  }
}

function saveIndex(records: BackupRecord[]): void {
  ensureBackupDir();
  writeFileSync(INDEX_FILE, JSON.stringify(records, null, 2));
}
