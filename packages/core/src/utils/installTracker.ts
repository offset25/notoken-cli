/**
 * Install Tracker.
 *
 * Tracks what NoToken has installed so it can cleanly uninstall later.
 * Persisted to ~/.notoken/install-history.json
 *
 * Records:
 *   - What was installed (tool name, engine, package)
 *   - Where it was installed (path, drive)
 *   - When it was installed
 *   - How it was installed (npm, git clone, docker pull, apt, brew, winget)
 *   - Dependencies that were also installed
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { USER_HOME } from "./paths.js";

const HISTORY_FILE = resolve(USER_HOME, "install-history.json");

export interface InstalledItem {
  name: string;
  type: "tool" | "engine" | "model" | "docker-image" | "system-package" | "build-tools";
  method: "npm" | "git-clone" | "docker-pull" | "apt" | "dnf" | "brew" | "winget" | "curl" | "pip";
  path?: string;
  size?: string;
  version?: string;
  installedAt: string;
  dependencies?: string[];
  uninstallCmd?: string;
  notes?: string;
}

export interface InstallHistory {
  items: InstalledItem[];
  lastUpdated: string;
}

function loadHistory(): InstallHistory {
  try {
    if (existsSync(HISTORY_FILE)) {
      return JSON.parse(readFileSync(HISTORY_FILE, "utf-8"));
    }
  } catch {}
  return { items: [], lastUpdated: new Date().toISOString() };
}

function saveHistory(history: InstallHistory): void {
  try {
    mkdirSync(USER_HOME, { recursive: true });
    history.lastUpdated = new Date().toISOString();
    writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));
  } catch {}
}

/**
 * Record that something was installed.
 */
export function trackInstall(item: Omit<InstalledItem, "installedAt">): void {
  const history = loadHistory();
  // Don't duplicate — update if same name+type exists
  const existing = history.items.findIndex(i => i.name === item.name && i.type === item.type);
  const entry: InstalledItem = { ...item, installedAt: new Date().toISOString() };
  if (existing >= 0) {
    history.items[existing] = entry;
  } else {
    history.items.push(entry);
  }
  saveHistory(history);
}

/**
 * Get all installed items.
 */
export function getInstallHistory(): InstalledItem[] {
  return loadHistory().items;
}

/**
 * Get installed items by type.
 */
export function getInstalledByType(type: InstalledItem["type"]): InstalledItem[] {
  return loadHistory().items.filter(i => i.type === type);
}

/**
 * Get a specific installed item.
 */
export function getInstalledItem(name: string): InstalledItem | undefined {
  return loadHistory().items.find(i => i.name === name);
}

/**
 * Remove an item from tracking (after uninstall).
 */
export function untrackInstall(name: string): void {
  const history = loadHistory();
  history.items = history.items.filter(i => i.name !== name);
  saveHistory(history);
}

/**
 * Format install history for display.
 */
export function formatInstallHistory(): string {
  const c = {
    reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
    green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
  };

  const items = getInstallHistory();
  if (items.length === 0) return `${c.dim}No installations tracked by NoToken.${c.reset}`;

  const lines: string[] = [];
  lines.push(`${c.bold}NoToken Install History${c.reset} (${items.length} items)\n`);

  // Group by type
  const grouped = new Map<string, InstalledItem[]>();
  for (const item of items) {
    const list = grouped.get(item.type) ?? [];
    list.push(item);
    grouped.set(item.type, list);
  }

  for (const [type, typeItems] of grouped) {
    lines.push(`${c.bold}${type}:${c.reset}`);
    for (const item of typeItems) {
      const ver = item.version ? ` v${item.version}` : "";
      const size = item.size ? ` (${item.size})` : "";
      const path = item.path ? `\n    ${c.dim}${item.path}${c.reset}` : "";
      const method = `${c.dim}via ${item.method}${c.reset}`;
      const date = new Date(item.installedAt).toLocaleDateString();
      lines.push(`  ${c.green}✓${c.reset} ${c.bold}${item.name}${c.reset}${ver}${size} — ${method} ${c.dim}${date}${c.reset}${path}`);
      if (item.uninstallCmd) {
        lines.push(`    ${c.dim}Uninstall: ${item.uninstallCmd}${c.reset}`);
      }
    }
    lines.push("");
  }

  return lines.join("\n");
}

/**
 * Generate uninstall commands for an item.
 */
export function getUninstallSteps(name: string): string[] {
  const item = getInstalledItem(name);
  if (!item) return [];

  const steps: string[] = [];

  switch (item.method) {
    case "npm":
      steps.push(`npm uninstall -g ${name}`);
      break;
    case "git-clone":
      if (item.path) steps.push(`rm -rf "${item.path}"`);
      break;
    case "docker-pull":
      steps.push(`docker rmi ${name}`);
      steps.push(`docker rm -f sd-webui 2>/dev/null`);
      break;
    case "apt":
      steps.push(`sudo apt-get remove -y ${name}`);
      break;
    case "dnf":
      steps.push(`sudo dnf remove -y ${name}`);
      break;
    case "brew":
      steps.push(`brew uninstall ${name}`);
      break;
    case "winget":
      steps.push(`winget uninstall ${name}`);
      break;
    case "pip":
      if (item.path) steps.push(`rm -rf "${item.path}"`);
      break;
    case "curl":
      if (item.path) steps.push(`rm -f "${item.path}"`);
      break;
  }

  // Clean up dependencies
  if (item.dependencies?.length) {
    steps.push(`# Dependencies installed: ${item.dependencies.join(", ")}`);
  }

  return steps;
}
