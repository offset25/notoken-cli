/**
 * Centralized path resolution.
 *
 * Single source of truth for all directory paths used by mycli.
 * Supports three modes:
 *   1. Development (tsx): src/utils/paths.ts → resolve("../..")
 *   2. npm package: dist/utils/paths.js → resolve("../..")
 *   3. SEA binary: embedded assets, writable dirs in ~/.mycli/
 *
 * Writable directories (data, logs) always go to ~/.mycli/ so they
 * work in all modes. Config is read-only and ships with the package.
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
    // node:sea module only exists when running as a SEA binary
    // Use globalThis to check for the injected fuse
    return !!(globalThis as Record<string, unknown>).__sea_resources__;
  } catch {
    return false;
  }
}

/** Package root: two levels up from dist/utils/ or src/utils/ */
export const PACKAGE_ROOT = resolve(__dirname, "../..");

/** Read-only config directory (ships with the package) */
export const CONFIG_DIR = resolve(PACKAGE_ROOT, "config");

/** User data root — writable, lives in home directory */
export const USER_HOME = resolve(
  process.env.MYCLI_DATA_DIR ?? resolve(homedir(), ".mycli")
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
