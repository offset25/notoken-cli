/**
 * Update checker.
 *
 * Checks notoken.sh/api/version (primary) or npm registry (fallback)
 * for the latest version. Caches result for 1 hour.
 *
 * Used by both CLI (startup banner) and desktop app (badge).
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { execSync } from "node:child_process";
import { USER_HOME } from "./paths.js";

const CACHE_FILE = resolve(USER_HOME, ".update-check.json");
const CACHE_TTL = 3600_000; // 1 hour
const CURRENT_VERSION = getInstalledVersion();

export interface UpdateInfo {
  current: string;
  latest: string;
  updateAvailable: boolean;
  checkedAt: string;
}

/**
 * Check for updates. Returns cached result if fresh.
 * Non-blocking — never throws, returns null on failure.
 */
export async function checkForUpdate(): Promise<UpdateInfo | null> {
  try {
    // Check cache first
    const cached = readCache();
    if (cached) return cached;

    // Fetch latest version
    const latest = await fetchLatestVersion();
    if (!latest) return null;

    const info: UpdateInfo = {
      current: CURRENT_VERSION,
      latest,
      updateAvailable: isNewer(latest, CURRENT_VERSION),
      checkedAt: new Date().toISOString(),
    };

    writeCache(info);
    return info;
  } catch {
    return null;
  }
}

/**
 * Synchronous check — reads cache only, no network.
 * Use this for startup banner (non-blocking).
 */
export function checkForUpdateSync(): UpdateInfo | null {
  return readCache();
}

/**
 * Run the actual update.
 */
export function runUpdate(): string {
  try {
    const result = execSync("npm install -g notoken@latest", {
      encoding: "utf-8",
      timeout: 120_000,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // Clear cache so next check picks up new version
    clearCache();
    return result;
  } catch (err) {
    throw new Error(`Update failed: ${err instanceof Error ? err.message : err}`);
  }
}

/**
 * Format update banner for terminal.
 */
export function formatUpdateBanner(info: UpdateInfo): string {
  if (!info.updateAvailable) return "";
  return `\x1b[33m⬆ Update available: ${info.current} → ${info.latest}\x1b[0m \x1b[2m(notoken update)\x1b[0m`;
}

// ─── Internals ──────────────────────────────────────────────────────────────

async function fetchLatestVersion(): Promise<string | null> {
  // Try notoken.sh API first
  try {
    const response = await fetch("https://notoken.sh/api/version", { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = (await response.json()) as { version?: string };
      if (data.version) return data.version;
    }
  } catch {}

  // Fallback: npm registry
  try {
    const response = await fetch("https://registry.npmjs.org/notoken/latest", { signal: AbortSignal.timeout(5000) });
    if (response.ok) {
      const data = (await response.json()) as { version?: string };
      if (data.version) return data.version;
    }
  } catch {}

  // Fallback: npm CLI
  try {
    const result = execSync("npm view notoken version", { encoding: "utf-8", timeout: 10_000, stdio: ["pipe", "pipe", "pipe"] });
    return result.trim() || null;
  } catch {}

  return null;
}

function getInstalledVersion(): string {
  try {
    // Read from our own package.json
    const pkg = JSON.parse(execSync("npm list -g notoken --json --depth=0 2>/dev/null", { encoding: "utf-8", timeout: 5000 }));
    return pkg.dependencies?.notoken?.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function isNewer(latest: string, current: string): boolean {
  const l = latest.split(".").map(Number);
  const c = current.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((l[i] ?? 0) > (c[i] ?? 0)) return true;
    if ((l[i] ?? 0) < (c[i] ?? 0)) return false;
  }
  return false;
}

function readCache(): UpdateInfo | null {
  try {
    if (!existsSync(CACHE_FILE)) return null;
    const raw = JSON.parse(readFileSync(CACHE_FILE, "utf-8")) as UpdateInfo;
    const age = Date.now() - new Date(raw.checkedAt).getTime();
    if (age > CACHE_TTL) return null;
    // Refresh current version in case user updated
    raw.current = CURRENT_VERSION;
    raw.updateAvailable = isNewer(raw.latest, CURRENT_VERSION);
    return raw;
  } catch {
    return null;
  }
}

function writeCache(info: UpdateInfo): void {
  try {
    mkdirSync(USER_HOME, { recursive: true });
    writeFileSync(CACHE_FILE, JSON.stringify(info));
  } catch {}
}

function clearCache(): void {
  try {
    if (existsSync(CACHE_FILE)) writeFileSync(CACHE_FILE, "{}");
  } catch {}
}
