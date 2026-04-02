/**
 * Smart archive creation.
 *
 * Auto-excludes heavy/non-essential directories (node_modules, .git, etc.)
 * unless the user explicitly requests them. Checks disk space before archiving.
 */

import { exec, execSync } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { resolve, basename } from "node:path";
import { detectLocalPlatform } from "./platform.js";
import { askForConfirmation } from "../policy/confirm.js";

const execAsync = promisify(exec);

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

/** Directories that are safe to exclude by default (regenerable/cached). */
const DEFAULT_EXCLUDES = [
  "node_modules",
  ".git",
  ".next",
  ".nuxt",
  "dist",
  "build",
  "__pycache__",
  ".venv",
  "venv",
  ".env.local",
  ".cache",
  ".turbo",
  "vendor",           // PHP composer
  "target",           // Rust cargo
  ".gradle",
  ".idea",
  ".vscode",
  "*.pyc",
  "*.o",
  "*.class",
  ".DS_Store",
  "Thumbs.db",
];

export interface ArchiveOptions {
  source: string;
  destination?: string;
  includeAll?: boolean;   // include node_modules etc.
  excludes?: string[];    // additional excludes
}

/** Estimate the size of a directory (excluding default excludes). */
async function estimateSize(source: string, excludes: string[]): Promise<{ totalGB: number; excludedGB: number }> {
  const plat = detectLocalPlatform();
  try {
    // Total size
    const { stdout: totalOut } = await execAsync(
      `du -sb "${source}" 2>/dev/null | cut -f1`,
      { timeout: 30_000 }
    );
    const totalBytes = parseInt(totalOut.trim()) || 0;

    // Size of excluded dirs
    let excludedBytes = 0;
    for (const ex of excludes) {
      if (ex.startsWith("*")) continue; // skip glob patterns
      const exPath = resolve(source, ex);
      if (existsSync(exPath)) {
        try {
          const { stdout } = await execAsync(
            `du -sb "${exPath}" 2>/dev/null | cut -f1`,
            { timeout: 10_000 }
          );
          excludedBytes += parseInt(stdout.trim()) || 0;
        } catch {}
      }
    }

    return {
      totalGB: totalBytes / 1073741824,
      excludedGB: excludedBytes / 1073741824,
    };
  } catch {
    return { totalGB: 0, excludedGB: 0 };
  }
}

/** Check available disk space at a path. */
async function getAvailableSpaceGB(path: string): Promise<number> {
  try {
    const { stdout } = await execAsync(
      `df -B1 "${path}" 2>/dev/null | tail -1 | awk '{print $4}'`,
      { timeout: 5000 }
    );
    return parseInt(stdout.trim()) / 1073741824;
  } catch {
    return -1; // unknown
  }
}

/**
 * Smart archive: checks space, shows what will be excluded, asks before creating.
 */
export async function smartArchive(options: ArchiveOptions): Promise<string> {
  const source = resolve(options.source);
  const lines: string[] = [];

  if (!existsSync(source)) {
    return `${c.red}✗ Source not found: ${source}${c.reset}`;
  }

  // Determine destination
  const destName = options.destination || `${basename(source)}.tar.gz`;
  const dest = resolve(destName.endsWith(".tar.gz") || destName.endsWith(".tgz") ? destName : destName + ".tar.gz");

  // Determine exclusions
  const excludes = options.includeAll ? [] : DEFAULT_EXCLUDES;
  const foundExcludes: Array<{ name: string; sizeGB: number }> = [];

  // Check which excludable dirs actually exist in source
  if (!options.includeAll) {
    for (const ex of DEFAULT_EXCLUDES) {
      if (ex.startsWith("*")) continue;
      const exPath = resolve(source, ex);
      if (existsSync(exPath)) {
        try {
          const stat = statSync(exPath);
          if (stat.isDirectory()) {
            const { stdout } = await execAsync(
              `du -sb "${exPath}" 2>/dev/null | cut -f1`,
              { timeout: 10_000 }
            );
            const sizeGB = parseInt(stdout.trim()) / 1073741824;
            foundExcludes.push({ name: ex, sizeGB });
          }
        } catch {}
      }
    }
  }

  // Estimate sizes
  const sizes = await estimateSize(source, options.includeAll ? [] : DEFAULT_EXCLUDES.filter(e => !e.startsWith("*")));
  const archiveEstimateGB = (sizes.totalGB - sizes.excludedGB) * 0.3; // rough compression ratio
  const availableGB = await getAvailableSpaceGB(resolve(dest, ".."));

  lines.push(`\n${c.bold}${c.cyan}── Smart Archive ──${c.reset}\n`);
  lines.push(`  Source:      ${c.bold}${source}${c.reset}`);
  lines.push(`  Destination: ${c.bold}${dest}${c.reset}`);
  lines.push(`  Source size: ${c.bold}${sizes.totalGB.toFixed(2)} GB${c.reset}`);

  if (foundExcludes.length > 0) {
    const totalExcluded = foundExcludes.reduce((s, e) => s + e.sizeGB, 0);
    lines.push(`\n  ${c.bold}Auto-excluding (${totalExcluded.toFixed(2)} GB saved):${c.reset}`);
    for (const ex of foundExcludes.sort((a, b) => b.sizeGB - a.sizeGB)) {
      const sizeStr = ex.sizeGB >= 1 ? `${ex.sizeGB.toFixed(2)} GB` : `${(ex.sizeGB * 1024).toFixed(0)} MB`;
      lines.push(`    ${c.yellow}${sizeStr.padStart(10)}${c.reset}  ${ex.name}/`);
    }
    lines.push(`\n  ${c.dim}To include everything: add "include all" or "with node_modules"${c.reset}`);
  }

  lines.push(`\n  Estimated archive: ${c.bold}~${archiveEstimateGB.toFixed(2)} GB${c.reset} ${c.dim}(compressed)${c.reset}`);

  // Space check
  if (availableGB >= 0) {
    lines.push(`  Available space:  ${c.bold}${availableGB.toFixed(2)} GB${c.reset}`);
    if (archiveEstimateGB > availableGB * 0.9) {
      lines.push(`\n  ${c.red}${c.bold}⚠ NOT ENOUGH SPACE!${c.reset} Archive (~${archiveEstimateGB.toFixed(2)} GB) may exceed available space (${availableGB.toFixed(2)} GB).`);
      lines.push(`  ${c.yellow}Free up space first: notoken "free up space"${c.reset}`);
      return lines.join("\n");
    } else if (archiveEstimateGB > availableGB * 0.5) {
      lines.push(`  ${c.yellow}⚠ This will use ${Math.round((archiveEstimateGB / availableGB) * 100)}% of remaining space.${c.reset}`);
    } else {
      lines.push(`  ${c.green}✓ Plenty of space.${c.reset}`);
    }
  }

  console.log(lines.join("\n"));

  // Confirm
  const ok = await askForConfirmation(`\nCreate archive?`);
  if (!ok) {
    return `${c.dim}Cancelled.${c.reset}`;
  }

  // Build tar command
  const excludeFlags = excludes.map((e) => `--exclude='${e}'`).join(" ");
  const tarCmd = `tar -czf "${dest}" ${excludeFlags} -C "${resolve(source, "..")}" "${basename(source)}"`;

  console.log(`\n${c.dim}→ ${tarCmd}${c.reset}`);

  try {
    await execAsync(tarCmd, { timeout: 600_000 }); // 10 min timeout for large archives

    // Show result
    const stat = statSync(dest);
    const resultGB = stat.size / 1073741824;
    const sizeStr = resultGB >= 1 ? `${resultGB.toFixed(2)} GB` : `${(resultGB * 1024).toFixed(0)} MB`;
    return `\n${c.green}${c.bold}✓ Archive created: ${dest}${c.reset}\n  Size: ${c.bold}${sizeStr}${c.reset}`;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return `\n${c.red}✗ Archive failed: ${msg.split("\n")[0]}${c.reset}`;
  }
}
