/**
 * Intelligent output analysis.
 *
 * Parses raw command output and adds human-readable commentary:
 * - Load: checks vCPUs vs load average, flags overload
 * - Disk: flags partitions above thresholds, checks specific paths
 * - Memory: flags low memory, high swap usage
 * - Directory: detects project types, file breakdowns
 */

import { analyzeDirectory as analyzeDirectoryImpl } from "./dirAnalysis.js";
import { detectLocalPlatform } from "./platform.js";

function analyzeDirectoryOutput(output: string): string {
  return analyzeDirectoryImpl(output);
}

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
};

// ─── Load Analysis ───────────────────────────────────────────────────────────

export function analyzeLoad(output: string): string {
  const lines: string[] = [];

  // Extract load averages from uptime output
  // "load average: 0.52, 0.58, 0.59"
  const loadMatch = output.match(/load average:\s*([\d.]+),?\s*([\d.]+),?\s*([\d.]+)/);
  if (!loadMatch) return "";

  const load1 = parseFloat(loadMatch[1]);
  const load5 = parseFloat(loadMatch[2]);
  const load15 = parseFloat(loadMatch[3]);

  // Extract CPU count from nproc or lscpu output
  let cpuCount = 1;
  const nprocMatch = output.match(/^(\d+)$/m);
  const lscpuMatch = output.match(/CPU\(s\):\s*(\d+)/);
  if (nprocMatch) cpuCount = parseInt(nprocMatch[1]);
  else if (lscpuMatch) cpuCount = parseInt(lscpuMatch[1]);

  // Also try /proc/cpuinfo count
  const procMatch = output.match(/processor\s*:\s*(\d+)/g);
  if (procMatch && procMatch.length > cpuCount) cpuCount = procMatch.length;

  lines.push(`\n${c.bold}${c.cyan}── Analysis ──${c.reset}`);
  lines.push(`  vCPUs: ${c.bold}${cpuCount}${c.reset}`);
  lines.push(`  Load:  ${c.bold}${load1}${c.reset} (1m)  ${load5} (5m)  ${load15} (15m)`);

  // Load ratio: load / cpuCount
  const ratio1 = load1 / cpuCount;
  const ratio5 = load5 / cpuCount;

  if (ratio1 > 2.0) {
    lines.push(`  ${c.red}⚠ CRITICAL: Load is ${ratio1.toFixed(1)}x your CPU capacity!${c.reset}`);
    lines.push(`  ${c.red}  System is severely overloaded. Processes are queuing.${c.reset}`);
  } else if (ratio1 > 1.0) {
    lines.push(`  ${c.yellow}⚠ HIGH: Load exceeds CPU count (${ratio1.toFixed(1)}x capacity).${c.reset}`);
    lines.push(`  ${c.yellow}  Some processes are waiting for CPU time.${c.reset}`);
  } else if (ratio1 > 0.7) {
    lines.push(`  ${c.yellow}⚠ MODERATE: ${(ratio1 * 100).toFixed(0)}% CPU utilization.${c.reset}`);
    lines.push(`  ${c.dim}  Approaching capacity — monitor closely.${c.reset}`);
  } else {
    lines.push(`  ${c.green}✓ OK: ${(ratio1 * 100).toFixed(0)}% CPU utilization. Healthy.${c.reset}`);
  }

  // Trend
  if (load1 > load15 * 1.5) {
    lines.push(`  ${c.yellow}↑ Load is trending UP (${load15} → ${load1}).${c.reset}`);
  } else if (load1 < load15 * 0.5) {
    lines.push(`  ${c.green}↓ Load is trending DOWN (${load15} → ${load1}).${c.reset}`);
  } else {
    lines.push(`  ${c.dim}→ Load is stable.${c.reset}`);
  }

  return lines.join("\n");
}

// ─── Disk Analysis ───────────────────────────────────────────────────────────

export interface DiskPartition {
  filesystem: string;
  size: string;
  used: string;
  available: string;
  usePercent: number;
  mountPoint: string;
}

export function analyzeDisk(output: string, specificPath?: string): string {
  const lines: string[] = [];
  const partitions = parseDfOutput(output);

  if (partitions.length === 0) return "";

  lines.push(`\n${c.bold}${c.cyan}── Analysis ──${c.reset}`);

  // If asking about a specific path, find the matching partition
  if (specificPath) {
    const match = findPartitionForPath(partitions, specificPath);
    if (match) {
      lines.push(`  Path ${c.bold}${specificPath}${c.reset} is on ${c.bold}${match.mountPoint}${c.reset}`);
      lines.push(`  ${formatPartitionHealth(match)}`);
      return lines.join("\n");
    } else {
      lines.push(`  ${c.yellow}Could not find partition for path: ${specificPath}${c.reset}`);
    }
  }

  // Overall analysis
  let criticalCount = 0;
  let warningCount = 0;

  // Filter to real filesystems (skip snap, tmpfs, etc.)
  const realPartitions = partitions.filter((p) =>
    !p.filesystem.startsWith("snap") &&
    !p.filesystem.startsWith("tmpfs") &&
    !p.filesystem.startsWith("none") &&
    !p.filesystem.startsWith("rootfs") &&
    p.mountPoint !== "/snap" &&
    !p.mountPoint.startsWith("/snap/") &&
    !p.mountPoint.includes("docker-desktop/cli-tools") &&
    !p.filesystem.startsWith("/dev/loop")
  );

  for (const p of realPartitions) {
    // Use absolute free space (GB) for thresholds — percentage is misleading on large drives
    // e.g. 97% on 2TB = 60GB free (fine), 95% on 100GB = 5GB free (critical)
    const freeGB = parseFloat(p.available.replace(/[^\d.]/g, ""));
    const freeUnit = p.available.replace(/[\d.]/g, "").trim().toUpperCase();
    const freeGBNorm = freeUnit.startsWith("T") ? freeGB * 1024 : freeUnit.startsWith("M") ? freeGB / 1024 : freeGB;

    if (freeGBNorm < 5) {
      lines.push(`  ${c.red}⚠ CRITICAL: ${p.mountPoint} has only ${p.available} free (${p.usePercent}% used)${c.reset}`);
      criticalCount++;
    } else if (freeGBNorm < 20 && p.usePercent >= 90) {
      lines.push(`  ${c.yellow}⚠ WARNING: ${p.mountPoint} has ${p.available} free (${p.usePercent}% used)${c.reset}`);
      warningCount++;
    } else if (p.usePercent >= 85) {
      lines.push(`  ${c.dim}  ${p.mountPoint}: ${p.usePercent}% used (${p.available} free)${c.reset}`);
    }
  }

  if (criticalCount === 0 && warningCount === 0) {
    lines.push(`  ${c.green}✓ All partitions healthy. No space issues.${c.reset}`);
  } else {
    if (criticalCount > 0) {
      lines.push(`  ${c.red}  ${criticalCount} partition(s) critically full!${c.reset}`);
    }
    if (warningCount > 0) {
      lines.push(`  ${c.yellow}  ${warningCount} partition(s) approaching full.${c.reset}`);
    }
    if (criticalCount > 0) {
      lines.push(`  ${c.yellow}${c.bold}  → Try "free up space" or "disk cleanup" to scan for reclaimable space.${c.reset}`);
      // WSL-specific: warn about I/O errors and need to restart WSL
      const platform = detectLocalPlatform();
      if (platform.isWSL) {
        const windowsDriveFull = realPartitions.some((p) => {
          if (!p.mountPoint.startsWith("/mnt/")) return false;
          const fGB = parseFloat(p.available.replace(/[^\d.]/g, ""));
          const fU = p.available.replace(/[\d.]/g, "").trim().toUpperCase();
          const freeNorm = fU.startsWith("T") ? fGB * 1024 : fU.startsWith("M") ? fGB / 1024 : fGB;
          return freeNorm < 5;
        });
        if (windowsDriveFull) {
          lines.push(`\n  ${c.red}${c.bold}  ⚠ WSL WARNING:${c.reset} Windows drive is critically full.`);
          lines.push(`  ${c.yellow}  WSL shares disk with Windows — I/O errors and instability are likely.${c.reset}`);
          lines.push(`  ${c.yellow}  Run "free up space" to clean and optionally restart WSL.${c.reset}`);
        }
      }
    } else {
      lines.push(`  ${c.dim}  Tip: Run "disk analysis" playbook for detailed breakdown.${c.reset}`);
    }
  }

  // Highlight largest partitions
  const sorted = [...realPartitions].sort((a, b) => b.usePercent - a.usePercent);
  if (sorted.length > 0 && !specificPath) {
    lines.push(`\n  ${c.bold}Top usage:${c.reset}`);
    for (const p of sorted.slice(0, 5)) {
      const bar = usageBar(p.usePercent);
      lines.push(`  ${bar} ${p.usePercent.toString().padStart(3)}% ${p.mountPoint} (${p.used}/${p.size})`);
    }
  }

  return lines.join("\n");
}

function parseDfOutput(output: string): DiskPartition[] {
  const partitions: DiskPartition[] = [];
  const lines = output.split("\n");

  for (const line of lines) {
    // Match df -h output: Filesystem  Size  Used  Avail  Use%  Mounted on
    const match = line.match(/^(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\d+)%\s+(.+)$/);
    if (match) {
      partitions.push({
        filesystem: match[1],
        size: match[2],
        used: match[3],
        available: match[4],
        usePercent: parseInt(match[5]),
        mountPoint: match[6].trim(),
      });
    }
  }

  return partitions;
}

function findPartitionForPath(partitions: DiskPartition[], path: string): DiskPartition | null {
  // Find the longest matching mount point
  const lower = path.toLowerCase();

  // Map common names to paths
  const aliases: Record<string, string[]> = {
    "documents": ["/home", "/mnt/c/Users", "~/Documents"],
    "downloads": ["/home", "/mnt/c/Users", "~/Downloads"],
    "my documents": ["/home", "/mnt/c/Users"],
    "home": ["/home"],
    "root": ["/"],
    "tmp": ["/tmp"],
    "var": ["/var"],
    "log": ["/var/log", "/var"],
    "www": ["/var/www"],
    "c drive": ["/mnt/c", "C:\\"],
    "d drive": ["/mnt/d", "D:\\"],
    "e drive": ["/mnt/e", "E:\\"],
    "f drive": ["/mnt/f", "F:\\"],
  };

  // Check aliases first
  for (const [alias, paths] of Object.entries(aliases)) {
    if (lower.includes(alias)) {
      for (const p of paths) {
        const match = partitions
          .filter((part) => p.startsWith(part.mountPoint) || part.mountPoint.startsWith(p))
          .sort((a, b) => b.mountPoint.length - a.mountPoint.length)[0];
        if (match) return match;
      }
    }
  }

  // Direct path match — find longest mount point that is a prefix
  const sorted = [...partitions].sort((a, b) => b.mountPoint.length - a.mountPoint.length);
  for (const p of sorted) {
    if (path.startsWith(p.mountPoint)) return p;
  }

  return null;
}

function formatPartitionHealth(p: DiskPartition): string {
  const fGB = parseFloat(p.available.replace(/[^\d.]/g, ""));
  const fU = p.available.replace(/[\d.]/g, "").trim().toUpperCase();
  const freeNorm = fU.startsWith("T") ? fGB * 1024 : fU.startsWith("M") ? fGB / 1024 : fGB;
  if (freeNorm < 5) return `${c.red}⚠ CRITICAL: Only ${p.available} free on ${p.size} total (${p.usePercent}% used).${c.reset}`;
  if (freeNorm < 20 && p.usePercent >= 90) return `${c.yellow}⚠ WARNING: ${p.available} free on ${p.size} total (${p.usePercent}% used).${c.reset}`;
  if (p.usePercent >= 70) return `${c.dim}Moderate: ${p.usePercent}% full. ${p.available} free on ${p.size} total.${c.reset}`;
  return `${c.green}✓ Healthy: ${p.usePercent}% used. ${p.available} free on ${p.size} total.${c.reset}`;
}

function usageBar(percent: number, width = 20): string {
  const filled = Math.round((percent / 100) * width);
  const empty = width - filled;
  const color = percent >= 95 ? c.red : percent >= 85 ? c.yellow : c.green;
  return `${color}${"█".repeat(filled)}${"░".repeat(empty)}${c.reset}`;
}

// ─── Memory Analysis ─────────────────────────────────────────────────────────

export function analyzeMemory(output: string): string {
  const lines: string[] = [];

  // Parse "free -h" output
  // Mem:   31Gi   15Gi   9.5Gi   9.8Mi   6.3Gi   15Gi
  const memMatch = output.match(/Mem:\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)/);
  const swapMatch = output.match(/Swap:\s+(\S+)\s+(\S+)\s+(\S+)/);

  if (!memMatch) return "";

  const total = memMatch[1];
  const used = memMatch[2];
  const free = memMatch[3];
  const available = memMatch[6];

  lines.push(`\n${c.bold}${c.cyan}── Analysis ──${c.reset}`);

  // Calculate percentage from raw values
  const totalGB = parseSize(total);
  const usedGB = parseSize(used);
  const availGB = parseSize(available);

  if (totalGB > 0) {
    const usedPercent = Math.round((usedGB / totalGB) * 100);
    const availPercent = Math.round((availGB / totalGB) * 100);

    lines.push(`  RAM: ${c.bold}${used}${c.reset} used of ${total} (${availPercent}% available)`);
    lines.push(`  ${usageBar(usedPercent)}`);

    if (usedPercent >= 95) {
      lines.push(`  ${c.red}⚠ CRITICAL: Memory nearly exhausted! OOM killer may activate.${c.reset}`);
    } else if (usedPercent >= 85) {
      lines.push(`  ${c.yellow}⚠ HIGH: Memory pressure. Consider scaling up or killing processes.${c.reset}`);
    } else if (usedPercent >= 70) {
      lines.push(`  ${c.dim}Moderate memory usage. Normal for most workloads.${c.reset}`);
    } else {
      lines.push(`  ${c.green}✓ Memory healthy.${c.reset}`);
    }
  }

  // Swap analysis
  if (swapMatch) {
    const swapTotal = swapMatch[1];
    const swapUsed = swapMatch[2];
    const swapTotalGB = parseSize(swapTotal);
    const swapUsedGB = parseSize(swapUsed);

    if (swapTotalGB > 0) {
      const swapPercent = Math.round((swapUsedGB / swapTotalGB) * 100);
      if (swapPercent > 50) {
        lines.push(`  ${c.yellow}⚠ Swap: ${swapUsed}/${swapTotal} used (${swapPercent}%). Heavy swapping degrades performance.${c.reset}`);
      } else if (swapUsedGB > 0) {
        lines.push(`  ${c.dim}Swap: ${swapUsed}/${swapTotal} used. Some swapping is normal.${c.reset}`);
      } else {
        lines.push(`  ${c.green}✓ No swap usage.${c.reset}`);
      }
    }
  }

  return lines.join("\n");
}

function parseSize(str: string): number {
  const match = str.match(/([\d.]+)(\w+)/);
  if (!match) return 0;
  const num = parseFloat(match[1]);
  const unit = match[2].toLowerCase();
  if (unit.startsWith("t")) return num * 1024;
  if (unit.startsWith("g")) return num;
  if (unit.startsWith("m")) return num / 1024;
  if (unit.startsWith("k")) return num / (1024 * 1024);
  return num;
}

// ─── Router ──────────────────────────────────────────────────────────────────

/**
 * Analyze command output based on intent and add commentary.
 * Returns empty string if no analysis applicable.
 */
export function analyzeOutput(intent: string, output: string, fields: Record<string, unknown>): string {
  switch (intent) {
    case "server.check_disk":
      return analyzeDisk(output, fields.target as string | undefined);
    case "server.check_memory":
      return analyzeMemory(output);
    case "server.uptime":
      return analyzeLoad(output);
    case "files.list":
      return analyzeDirectoryOutput(output);
    default:
      return "";
  }
}
