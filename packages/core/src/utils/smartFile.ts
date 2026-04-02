/**
 * Smart file output.
 *
 * - Checks file size before reading
 * - Shows a sample (head + tail) if file is large (>100 lines / >50KB)
 * - Searches within a file for a term and shows matches with context
 * - Detects file type and syntax-highlights key parts
 */

import { runLocalCommand } from "../execution/ssh.js";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

const MAX_LINES = 80;
const MAX_BYTES = 50 * 1024; // 50KB

export interface FileInfo {
  path: string;
  exists: boolean;
  sizeBytes: number;
  sizeHuman: string;
  lineCount: number;
  isBig: boolean;
  type: string;
}

/**
 * Get file info (size, line count) before reading.
 */
export async function getFileInfo(
  path: string,
  isRemote: boolean,
  environment?: string
): Promise<FileInfo> {
  const run = isRemote
    ? async (cmd: string) => {
        const { runRemoteCommand } = await import("../execution/ssh.js");
        return runRemoteCommand(environment!, cmd);
      }
    : runLocalCommand;

  try {
    const info = await run(
      `stat -c '%s' ${path} 2>/dev/null && wc -l < ${path} 2>/dev/null && file -b ${path} 2>/dev/null`
    );
    const parts = info.trim().split("\n");
    const sizeBytes = parseInt(parts[0]) || 0;
    const lineCount = parseInt(parts[1]) || 0;
    const type = parts[2] ?? "unknown";

    return {
      path,
      exists: true,
      sizeBytes,
      sizeHuman: formatBytes(sizeBytes),
      lineCount,
      isBig: lineCount > MAX_LINES || sizeBytes > MAX_BYTES,
      type,
    };
  } catch {
    return {
      path,
      exists: false,
      sizeBytes: 0,
      sizeHuman: "0 B",
      lineCount: 0,
      isBig: false,
      type: "unknown",
    };
  }
}

/**
 * Read a file smartly — full content if small, sampled if large.
 */
export async function smartRead(
  path: string,
  isRemote: boolean,
  environment?: string
): Promise<string> {
  const run = isRemote
    ? async (cmd: string) => {
        const { runRemoteCommand } = await import("../execution/ssh.js");
        return runRemoteCommand(environment!, cmd);
      }
    : runLocalCommand;

  const info = await getFileInfo(path, isRemote, environment);

  if (!info.exists) {
    return `${c.red}File not found: ${path}${c.reset}`;
  }

  const lines: string[] = [];

  lines.push(`${c.bold}${path}${c.reset} — ${info.sizeHuman}, ${info.lineCount} lines (${info.type})`);
  lines.push("");

  if (!info.isBig) {
    // Small file — show everything
    const content = await run(`cat ${path}`);
    lines.push(numberLines(content.trimEnd()));
  } else {
    // Large file — show sample
    lines.push(`${c.yellow}⚠ Large file (${info.lineCount} lines, ${info.sizeHuman}). Showing sample.${c.reset}`);
    lines.push("");

    // Head
    lines.push(`${c.cyan}── First 30 lines ──${c.reset}`);
    const head = await run(`head -30 ${path}`);
    lines.push(numberLines(head.trimEnd()));

    // Tail
    lines.push("");
    lines.push(`${c.dim}... (${info.lineCount - 60} lines omitted) ...${c.reset}`);
    lines.push("");
    lines.push(`${c.cyan}── Last 30 lines ──${c.reset}`);
    const tail = await run(`tail -30 ${path}`);
    const tailStart = Math.max(1, info.lineCount - 29);
    lines.push(numberLines(tail.trimEnd(), tailStart));

    lines.push("");
    lines.push(`${c.dim}Tip: "search <term> in ${path}" to find specific content.${c.reset}`);
  }

  return lines.join("\n");
}

/**
 * Search within a file for a term and show matches with context.
 */
export async function smartSearch(
  path: string,
  query: string,
  isRemote: boolean,
  environment?: string,
  contextLines = 3
): Promise<string> {
  const run = isRemote
    ? async (cmd: string) => {
        const { runRemoteCommand } = await import("../execution/ssh.js");
        return runRemoteCommand(environment!, cmd);
      }
    : runLocalCommand;

  const info = await getFileInfo(path, isRemote, environment);
  if (!info.exists) {
    return `${c.red}File not found: ${path}${c.reset}`;
  }

  const lines: string[] = [];

  // Run grep with context
  const safeQuery = query.replace(/['"]/g, "");
  try {
    const result = await run(
      `grep -n -i -C ${contextLines} --color=never '${safeQuery}' ${path} 2>/dev/null | head -100`
    );

    if (!result.trim()) {
      lines.push(`${c.yellow}No matches for "${query}" in ${path}${c.reset}`);
      return lines.join("\n");
    }

    // Count total matches
    const matchCount = await run(`grep -c -i '${safeQuery}' ${path} 2>/dev/null`);
    const count = parseInt(matchCount.trim()) || 0;

    lines.push(`${c.bold}${path}${c.reset} — ${count} match(es) for "${c.cyan}${query}${c.reset}"`);
    lines.push("");

    // Format the grep output — highlight matches
    for (const line of result.split("\n")) {
      if (line === "--") {
        // Grep separator between groups
        lines.push(`${c.dim}  ---${c.reset}`);
        continue;
      }

      // Line format from grep -n: "42:content" or "42-context"
      const matchLine = line.match(/^(\d+)([:|-])(.*)$/);
      if (matchLine) {
        const lineNum = matchLine[1].padStart(5);
        const isMatch = matchLine[2] === ":";
        const content = matchLine[3];

        if (isMatch) {
          // Highlight the matched term
          const highlighted = content.replace(
            new RegExp(`(${escapeRegex(safeQuery)})`, "gi"),
            `${c.bold}${c.red}$1${c.reset}`
          );
          lines.push(`  ${c.green}${lineNum}${c.reset} │ ${highlighted}`);
        } else {
          lines.push(`  ${c.dim}${lineNum}${c.reset} │ ${c.dim}${content}${c.reset}`);
        }
      } else if (line.trim()) {
        lines.push(`       │ ${line}`);
      }
    }

    if (count > 20) {
      lines.push("");
      lines.push(`${c.dim}Showing first matches. Total: ${count}. Narrow your search for more specific results.${c.reset}`);
    }
  } catch {
    lines.push(`${c.yellow}No matches for "${query}" in ${path}${c.reset}`);
  }

  return lines.join("\n");
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function numberLines(content: string, startLine = 1): string {
  return content
    .split("\n")
    .map((line, i) => {
      const num = String(startLine + i).padStart(5);
      return `  ${c.dim}${num}${c.reset} │ ${line}`;
    })
    .join("\n");
}

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
