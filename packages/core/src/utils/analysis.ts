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
    !p.mountPoint.startsWith("/snap/")
  );

  for (const p of realPartitions) {
    if (p.usePercent >= 95) {
      lines.push(`  ${c.red}⚠ CRITICAL: ${p.mountPoint} is ${p.usePercent}% full (${p.available} free)${c.reset}`);
      criticalCount++;
    } else if (p.usePercent >= 85) {
      lines.push(`  ${c.yellow}⚠ WARNING: ${p.mountPoint} is ${p.usePercent}% full (${p.available} free)${c.reset}`);
      warningCount++;
    } else if (p.usePercent >= 70) {
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
    lines.push(`  ${c.dim}  Tip: Run "disk analysis" playbook for detailed breakdown.${c.reset}`);
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
    "c drive": ["/mnt/c"],
    "d drive": ["/mnt/d"],
    "e drive": ["/mnt/e"],
    "f drive": ["/mnt/f"],
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
  if (p.usePercent >= 95) return `${c.red}⚠ CRITICAL: ${p.usePercent}% full! Only ${p.available} free on ${p.size} total.${c.reset}`;
  if (p.usePercent >= 85) return `${c.yellow}⚠ WARNING: ${p.usePercent}% full. ${p.available} free on ${p.size} total.${c.reset}`;
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

// ─── Cron Analysis ──────────────────────────────────────────────────────────

export function analyzeCron(output: string): string {
  const lines: string[] = [];

  // Count user cron entries
  const userCronSection = output.split("System Crons")[0] ?? output;
  const cronLines = userCronSection.split("\n").filter(l =>
    l.trim() && !l.startsWith("#") && !l.startsWith("===") && !l.startsWith("(no")
    && /^[\d*\/,\-]/.test(l.trim())
  );

  // Count system cron files
  const sysCronSection = output.split("System Crons")[1]?.split("Cron Directories")[0] ?? "";
  const sysCronFiles = sysCronSection.split("\n").filter(l =>
    l.trim() && !l.startsWith("total") && !l.startsWith("===") && !l.startsWith("(")
    && /^[d-]/.test(l.trim())
  );

  // Count systemd timers
  const timerSection = output.split("Systemd Timers")[1] ?? "";
  const timers = timerSection.split("\n").filter(l =>
    l.trim() && l.includes(".timer") && !l.startsWith("===")
  );

  lines.push(`\n${c.bold}${c.cyan}── Analysis ──${c.reset}`);
  lines.push(`  User cron jobs: ${c.bold}${cronLines.length}${c.reset}`);
  if (sysCronFiles.length > 0) lines.push(`  System cron files: ${c.bold}${sysCronFiles.length}${c.reset}`);
  if (timers.length > 0) lines.push(`  Systemd timers: ${c.bold}${timers.length}${c.reset}`);

  // Analyze frequency of cron jobs
  const frequencies: Record<string, number> = { "every minute": 0, "hourly": 0, "daily": 0, "weekly": 0, "monthly": 0, "custom": 0 };
  for (const line of cronLines) {
    const parts = line.trim().split(/\s+/);
    if (parts.length < 5) continue;
    const [min, hour, dom, mon, dow] = parts;
    if (min === "*" && hour === "*") frequencies["every minute"]++;
    else if (min !== "*" && hour === "*") frequencies["hourly"]++;
    else if (min !== "*" && hour !== "*" && dom === "*" && dow === "*") frequencies["daily"]++;
    else if (dow !== "*" && dow !== "0-6") frequencies["weekly"]++;
    else if (dom !== "*") frequencies["monthly"]++;
    else frequencies["custom"]++;
  }

  const active = Object.entries(frequencies).filter(([, v]) => v > 0);
  if (active.length > 0) {
    lines.push(`\n  ${c.bold}Schedule breakdown:${c.reset}`);
    for (const [freq, count] of active) {
      const warn = freq === "every minute" ? ` ${c.yellow}⚠ high frequency${c.reset}` : "";
      lines.push(`    ${count}x ${freq}${warn}`);
    }
  }

  if (cronLines.length === 0 && timers.length === 0) {
    lines.push(`  ${c.dim}No scheduled tasks found.${c.reset}`);
  }

  return lines.join("\n");
}

// ─── Uptime Analysis ────────────────────────────────────────────────────────

export function analyzeUptime(output: string): string {
  const lines: string[] = [];

  // Parse uptime string: "up 45 days, 3:22" or "up 3 min"
  const uptimeMatch = output.match(/up\s+(.+?)(?:,\s*\d+\s*user|$)/m);
  if (uptimeMatch) {
    const uptimeStr = uptimeMatch[1].trim().replace(/,$/, "");
    lines.push(`\n${c.bold}${c.cyan}── Uptime Analysis ──${c.reset}`);
    lines.push(`  Running for: ${c.bold}${uptimeStr}${c.reset}`);

    // Parse days
    const daysMatch = uptimeStr.match(/(\d+)\s*days?/);
    const days = daysMatch ? parseInt(daysMatch[1]) : 0;

    if (days > 365) {
      lines.push(`  ${c.yellow}⚠ Server has been up ${days} days — consider security patches and kernel updates.${c.reset}`);
    } else if (days > 90) {
      lines.push(`  ${c.dim}Long uptime (${days} days) — check if pending updates need a reboot.${c.reset}`);
    } else if (days < 1) {
      lines.push(`  ${c.yellow}⚠ Recently rebooted — check if this was intentional.${c.reset}`);
    } else {
      lines.push(`  ${c.green}✓ Normal uptime.${c.reset}`);
    }
  }

  // Include load analysis
  const loadAnalysis = analyzeLoad(output);
  if (loadAnalysis) lines.push(loadAnalysis);

  // Parse memory from free -h output
  const memMatch = output.match(/Mem:\s+(\S+)\s+(\S+)\s+(\S+)/);
  if (memMatch) {
    const [, total, used, free] = memMatch;
    lines.push(`\n  ${c.bold}Memory:${c.reset} ${used} used / ${total} total (${free} free)`);

    const totalGb = parseMemoryValue(total);
    const usedGb = parseMemoryValue(used);
    if (totalGb > 0) {
      const pct = (usedGb / totalGb) * 100;
      if (pct > 90) {
        lines.push(`  ${c.red}⚠ CRITICAL: ${pct.toFixed(0)}% memory used!${c.reset}`);
      } else if (pct > 75) {
        lines.push(`  ${c.yellow}⚠ HIGH: ${pct.toFixed(0)}% memory used.${c.reset}`);
      } else {
        lines.push(`  ${c.green}✓ Memory OK (${pct.toFixed(0)}% used).${c.reset}`);
      }
    }
  }

  return lines.join("\n");
}

function parseMemoryValue(str: string): number {
  const match = str.match(/([\d.]+)([KMGT]?i?)/i);
  if (!match) return 0;
  const val = parseFloat(match[1]);
  const unit = (match[2] || "").toUpperCase();
  if (unit.startsWith("T")) return val * 1024;
  if (unit.startsWith("G")) return val;
  if (unit.startsWith("M")) return val / 1024;
  if (unit.startsWith("K")) return val / (1024 * 1024);
  return val;
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
      return analyzeUptime(output);
    case "cron.list":
      return analyzeCron(output);
    case "files.list":
      return analyzeDirectoryOutput(output);
    default:
      return "";
  }
}
