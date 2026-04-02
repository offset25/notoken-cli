/**
 * Centralized path resolution.
 *
 * Single source of truth for all directory paths used by notoken.
 * Everything lives under ~/.notoken/
 *
 * ~/.notoken/
 *   data/              — history, sessions
 *   logs/              — failures, uncertainty
 *   backups/           — auto-backups before file modifications
 *   conversations/     — conversation persistence
 *   .update-check.json — update cache
 */

import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";
import { existsSync, mkdirSync } from "node:fs";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

/** Whether running as a Node.js Single Executable Application */
export function isSEA(): boolean {
  try {
    return !!(globalThis as Record<string, unknown>).__sea_resources__;
  } catch {
    return false;
  }
}

/** Package root: two levels up from dist/utils/ or src/utils/ */
export const PACKAGE_ROOT = resolve(__dirname, "../..");

/** Read-only config directory (ships with the package) */
export const CONFIG_DIR = resolve(PACKAGE_ROOT, "config");

/** User home — everything writable lives here: ~/.notoken/ */
export const USER_HOME = resolve(
  process.env.NOTOKEN_HOME ?? resolve(homedir(), ".notoken")
);

/** Writable data directory (history, sessions) */
export const DATA_DIR = resolve(USER_HOME, "data");

/** Writable logs directory (failures, uncertainty) */
export const LOG_DIR = resolve(USER_HOME, "logs");

/** Ensure writable directories exist */
export function ensureUserDirs(): void {
  for (const dir of [USER_HOME, DATA_DIR, LOG_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}
