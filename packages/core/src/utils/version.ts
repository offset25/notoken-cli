/**
 * Version check and self-upgrade utilities.
 *
 * Checks npm registry for latest published version and compares
 * with the locally installed version.
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { homedir } from "node:os";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

/** Get the current local version from package.json. */
export function getLocalVersion(): string {
  try {
    // Try relative to this file first (works in dist/)
    const pkgPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../package.json");
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"));
    return pkg.version ?? "unknown";
  } catch {
    return "unknown";
  }
}

/** Fetch the latest version from npm registry (non-blocking, best-effort). */
export async function getLatestVersion(): Promise<string | null> {
  try {
    const result = execSync("npm view notoken version 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    return result || null;
  } catch {
    return null;
  }
}

/** Compare two semver strings. Returns 1 if a > b, -1 if a < b, 0 if equal. */
export function compareSemver(a: string, b: string): number {
  const pa = a.split(".").map(Number);
  const pb = b.split(".").map(Number);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] ?? 0) > (pb[i] ?? 0)) return 1;
    if ((pa[i] ?? 0) < (pb[i] ?? 0)) return -1;
  }
  return 0;
}

/** Check if an update is available. Returns formatted message or null. */
export async function checkForUpdate(): Promise<string | null> {
  const local = getLocalVersion();
  if (local === "unknown") return null;

  const latest = await getLatestVersion();
  if (!latest) return null;

  if (compareSemver(latest, local) > 0) {
    return `${c.yellow}Update available: ${c.bold}v${local}${c.reset}${c.yellow} → ${c.bold}${c.green}v${latest}${c.reset}${c.yellow}  Run: ${c.cyan}notoken upgrade${c.reset}`;
  }
  return null;
}

// ─── Version history ─────────────────────────────────────────────────────────

const VERSION_HISTORY_PATH = resolve(homedir(), ".notoken", "version-history.json");

interface VersionHistoryEntry {
  version: string;
  date: string;
  action: "install" | "upgrade" | "rollback";
}

function loadVersionHistory(): VersionHistoryEntry[] {
  try {
    if (existsSync(VERSION_HISTORY_PATH)) {
      return JSON.parse(readFileSync(VERSION_HISTORY_PATH, "utf-8"));
    }
  } catch {}
  return [];
}

function saveVersionHistory(history: VersionHistoryEntry[]): void {
  const dir = dirname(VERSION_HISTORY_PATH);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(VERSION_HISTORY_PATH, JSON.stringify(history, null, 2) + "\n");
}

function recordVersion(version: string, action: "install" | "upgrade" | "rollback"): void {
  const history = loadVersionHistory();
  history.push({ version, date: new Date().toISOString(), action });
  // Keep last 20 entries
  if (history.length > 20) history.splice(0, history.length - 20);
  saveVersionHistory(history);
}

/** Get the previous version from history. */
function getPreviousVersion(): string | null {
  const history = loadVersionHistory();
  // Find the second-to-last unique version
  const versions = [...new Set(history.map((h) => h.version))];
  return versions.length >= 2 ? versions[versions.length - 2] : null;
}

// ─── Upgrade ─────────────────────────────────────────────────────────────────

/** Run the upgrade. Records current version before upgrading for rollback. */
export async function runUpgrade(): Promise<void> {
  const local = getLocalVersion();
  const latest = await getLatestVersion();

  console.log(`${c.bold}notoken upgrade${c.reset}\n`);
  console.log(`  Current version: ${c.bold}v${local}${c.reset}`);

  if (!latest) {
    console.log(`  ${c.yellow}Could not check npm registry.${c.reset}`);
    console.log(`  ${c.dim}Try manually: npm install -g notoken@latest${c.reset}`);
    return;
  }

  console.log(`  Latest version:  ${c.bold}v${latest}${c.reset}`);

  if (compareSemver(latest, local) <= 0) {
    console.log(`\n  ${c.green}✓ Already up to date.${c.reset}`);
    return;
  }

  // Record current version before upgrading
  recordVersion(local, "upgrade");

  console.log(`\n  ${c.cyan}Upgrading v${local} → v${latest}...${c.reset}`);
  console.log(`  ${c.dim}Previous version saved — run "notoken rollback" to revert.${c.reset}\n`);

  try {
    execSync("npm install -g notoken@latest", {
      stdio: "inherit",
      timeout: 120_000,
    });
    recordVersion(latest, "upgrade");
    console.log(`\n  ${c.green}✓ Upgraded to v${latest}${c.reset}`);
    console.log(`  ${c.dim}If something breaks: notoken rollback${c.reset}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${c.red}✗ Upgrade failed: ${msg.split("\n")[0]}${c.reset}`);
    console.error(`  ${c.dim}Try manually: npm install -g notoken@latest${c.reset}`);
  }
}

// ─── Rollback ────────────────────────────────────────────────────────────────

/** Roll back to the previous version. */
export async function runRollback(targetVersion?: string): Promise<void> {
  const local = getLocalVersion();

  console.log(`${c.bold}notoken rollback${c.reset}\n`);
  console.log(`  Current version: ${c.bold}v${local}${c.reset}`);

  // Determine target version
  let target = targetVersion;

  if (!target) {
    target = getPreviousVersion() ?? undefined;
  }

  if (!target) {
    // No history — list available versions for the user to pick
    console.log(`  ${c.yellow}No previous version in history.${c.reset}\n`);
    console.log(`  ${c.bold}Available versions:${c.reset}`);
    await listVersions();
    console.log(`\n  ${c.dim}To rollback to a specific version:${c.reset}`);
    console.log(`  ${c.cyan}notoken rollback 1.0.1${c.reset}`);
    return;
  }

  if (target === local) {
    console.log(`  ${c.green}✓ Already on v${target}.${c.reset}`);
    return;
  }

  console.log(`  Rolling back to: ${c.bold}v${target}${c.reset}\n`);

  try {
    execSync(`npm install -g notoken@${target}`, {
      stdio: "inherit",
      timeout: 120_000,
    });
    recordVersion(target, "rollback");
    console.log(`\n  ${c.green}✓ Rolled back to v${target}${c.reset}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`\n  ${c.red}✗ Rollback failed: ${msg.split("\n")[0]}${c.reset}`);
    console.error(`  ${c.dim}Try manually: npm install -g notoken@${target}${c.reset}`);
  }
}

/** List recent published versions from npm. */
async function listVersions(): Promise<void> {
  try {
    const result = execSync("npm view notoken versions --json 2>/dev/null", {
      encoding: "utf-8",
      timeout: 10_000,
    }).trim();
    const versions: string[] = JSON.parse(result);
    const recent = versions.slice(-10).reverse();
    const local = getLocalVersion();
    for (const v of recent) {
      const marker = v === local ? ` ${c.green}← current${c.reset}` : "";
      console.log(`    ${c.cyan}v${v}${c.reset}${marker}`);
    }
  } catch {
    console.log(`  ${c.yellow}Could not fetch versions from npm.${c.reset}`);
  }
}

/** Show version history. */
export function showVersionHistory(): void {
  const history = loadVersionHistory();

  console.log(`${c.bold}notoken version history${c.reset}\n`);
  console.log(`  Current: ${c.bold}v${getLocalVersion()}${c.reset}\n`);

  if (history.length === 0) {
    console.log(`  ${c.dim}No upgrade/rollback history yet.${c.reset}`);
    return;
  }

  for (const entry of history.slice(-10).reverse()) {
    const icon = entry.action === "upgrade" ? `${c.green}↑${c.reset}` :
                 entry.action === "rollback" ? `${c.yellow}↓${c.reset}` :
                 `${c.cyan}•${c.reset}`;
    const date = new Date(entry.date).toLocaleDateString();
    console.log(`  ${icon} v${entry.version}  ${c.dim}${date}  ${entry.action}${c.reset}`);
  }

  const prev = getPreviousVersion();
  if (prev) {
    console.log(`\n  ${c.dim}To rollback: ${c.cyan}notoken rollback${c.reset} ${c.dim}(→ v${prev})${c.reset}`);
  }
}
