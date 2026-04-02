/**
 * File permissions module.
 *
 * Understands Unix permission model:
 * - Octal (755, 644, 600)
 * - Symbolic (rwxr-xr-x, u+x, g-w)
 * - Ownership (user:group)
 * - Special bits (setuid, setgid, sticky)
 * - Access checks (can I read/write/execute this?)
 *
 * Works locally via stat, remotely via SSH.
 */

import { statSync, accessSync, constants } from "node:fs";
import { runRemoteCommand, runLocalCommand } from "../execution/ssh.js";

export interface FilePermissions {
  path: string;
  exists: boolean;
  mode: string;
  octal: string;
  owner: string;
  group: string;
  size: number;
  type: "file" | "directory" | "symlink" | "other";
  readable: boolean;
  writable: boolean;
  executable: boolean;
  setuid: boolean;
  setgid: boolean;
  sticky: boolean;
  humanReadable: string;
}

/**
 * Get permissions for a local file.
 */
export function getLocalPermissions(filePath: string): FilePermissions {
  try {
    const stat = statSync(filePath);
    const mode = stat.mode;
    const octal = (mode & 0o7777).toString(8).padStart(4, "0");
    const symbolic = modeToSymbolic(mode);

    let readable = false;
    let writable = false;
    let executable = false;
    try { accessSync(filePath, constants.R_OK); readable = true; } catch {}
    try { accessSync(filePath, constants.W_OK); writable = true; } catch {}
    try { accessSync(filePath, constants.X_OK); executable = true; } catch {}

    return {
      path: filePath,
      exists: true,
      mode: symbolic,
      octal,
      owner: String(stat.uid),
      group: String(stat.gid),
      size: stat.size,
      type: stat.isDirectory() ? "directory" : stat.isSymbolicLink() ? "symlink" : stat.isFile() ? "file" : "other",
      readable,
      writable,
      executable,
      setuid: !!(mode & 0o4000),
      setgid: !!(mode & 0o2000),
      sticky: !!(mode & 0o1000),
      humanReadable: formatPermissions({ octal, mode: symbolic, owner: String(stat.uid), group: String(stat.gid), readable, writable, executable }),
    };
  } catch {
    return {
      path: filePath,
      exists: false,
      mode: "",
      octal: "",
      owner: "",
      group: "",
      size: 0,
      type: "other",
      readable: false,
      writable: false,
      executable: false,
      setuid: false,
      setgid: false,
      sticky: false,
      humanReadable: "File not found",
    };
  }
}

/**
 * Get permissions for a remote file via SSH.
 */
export async function getRemotePermissions(filePath: string, environment: string): Promise<FilePermissions> {
  try {
    const result = await runRemoteCommand(environment,
      `stat -c '%A %a %U %G %s %F' ${filePath} 2>/dev/null || echo 'NOT_FOUND'`
    );

    if (result.trim() === "NOT_FOUND") {
      return {
        path: filePath, exists: false, mode: "", octal: "", owner: "", group: "",
        size: 0, type: "other", readable: false, writable: false, executable: false,
        setuid: false, setgid: false, sticky: false, humanReadable: "File not found on remote",
      };
    }

    const parts = result.trim().split(" ");
    const symbolic = parts[0] ?? "";
    const octal = parts[1] ?? "";
    const owner = parts[2] ?? "";
    const group = parts[3] ?? "";
    const size = Number(parts[4]) || 0;
    const fileType = parts.slice(5).join(" ").toLowerCase();

    // Check access
    const accessCheck = await runRemoteCommand(environment,
      `test -r ${filePath} && echo R || echo -; test -w ${filePath} && echo W || echo -; test -x ${filePath} && echo X || echo -`
    );
    const accessParts = accessCheck.trim().split("\n");
    const readable = accessParts[0] === "R";
    const writable = accessParts[1] === "W";
    const executable = accessParts[2] === "X";

    const type: FilePermissions["type"] =
      fileType.includes("directory") ? "directory" :
      fileType.includes("symbolic") ? "symlink" :
      fileType.includes("regular") ? "file" : "other";

    return {
      path: filePath,
      exists: true,
      mode: symbolic,
      octal,
      owner,
      group,
      size,
      type,
      readable,
      writable,
      executable,
      setuid: symbolic.includes("s") && symbolic[3] === "s",
      setgid: symbolic.includes("s") && symbolic[6] === "s",
      sticky: symbolic.includes("t"),
      humanReadable: formatPermissions({ octal, mode: symbolic, owner, group, readable, writable, executable }),
    };
  } catch (err) {
    return {
      path: filePath, exists: false, mode: "", octal: "", owner: "", group: "",
      size: 0, type: "other", readable: false, writable: false, executable: false,
      setuid: false, setgid: false, sticky: false,
      humanReadable: `Error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

/**
 * Check if we have the needed access before an operation.
 * Returns an error message if access is denied, or null if OK.
 */
export function checkAccessForIntent(intent: string, perms: FilePermissions): string | null {
  if (!perms.exists) return `File not found: ${perms.path}`;

  switch (intent) {
    case "file.parse":
    case "env.get":
    case "logs.tail":
    case "logs.search":
    case "archive.list":
      if (!perms.readable) return `Permission denied: cannot read ${perms.path} (owner: ${perms.owner}, mode: ${perms.octal})`;
      break;

    case "files.copy":
    case "files.move":
    case "files.remove":
    case "env.set":
      if (!perms.writable) return `Permission denied: cannot write ${perms.path} (owner: ${perms.owner}, mode: ${perms.octal}). Try with sudo?`;
      break;
  }

  return null;
}

/**
 * Parse a permission change request from natural language.
 *
 * Understands:
 *   "make readable"          → chmod a+r
 *   "make executable"        → chmod +x
 *   "set 755"                → chmod 755
 *   "set read only"          → chmod 444
 *   "owner only"             → chmod 700
 *   "give group write"       → chmod g+w
 *   "remove others execute"  → chmod o-x
 *   "secure"                 → chmod 600
 *   "world readable"         → chmod 644
 */
export function parsePermissionRequest(text: string): { mode: string; explanation: string } | null {
  const lower = text.toLowerCase();

  // Octal directly specified
  const octalMatch = lower.match(/\b([0-7]{3,4})\b/);
  if (octalMatch) {
    return { mode: octalMatch[1], explanation: `Set permissions to ${octalMatch[1]} (${octalToSymbolic(octalMatch[1])})` };
  }

  // Named presets
  const presets: Record<string, { mode: string; explanation: string }> = {
    "executable": { mode: "+x", explanation: "Add execute permission for all" },
    "make executable": { mode: "+x", explanation: "Add execute permission for all" },
    "read only": { mode: "444", explanation: "Read-only for everyone" },
    "readonly": { mode: "444", explanation: "Read-only for everyone" },
    "secure": { mode: "600", explanation: "Read/write for owner only (secure)" },
    "private": { mode: "600", explanation: "Read/write for owner only" },
    "owner only": { mode: "700", explanation: "Full access for owner only" },
    "world readable": { mode: "644", explanation: "Owner read/write, others read" },
    "world writable": { mode: "666", explanation: "Read/write for everyone (dangerous!)" },
    "script": { mode: "755", explanation: "Owner full, others read/execute (typical for scripts)" },
    "config": { mode: "644", explanation: "Owner read/write, others read (typical for configs)" },
    "secret": { mode: "600", explanation: "Owner read/write only (for secrets, keys)" },
    "key": { mode: "600", explanation: "Owner read/write only (for SSH keys)" },
    "web": { mode: "755", explanation: "Owner full, web-server readable" },
    "www-data": { mode: "755", explanation: "Owner full, web-server readable" },
    "no access": { mode: "000", explanation: "No access for anyone" },
    "full access": { mode: "777", explanation: "Full access for everyone (dangerous!)" },
  };

  for (const [key, value] of Object.entries(presets)) {
    if (lower.includes(key)) return value;
  }

  // Symbolic patterns
  if (lower.includes("give") || lower.includes("add")) {
    if (lower.includes("read")) return { mode: "+r", explanation: "Add read permission" };
    if (lower.includes("write")) return { mode: "+w", explanation: "Add write permission" };
    if (lower.includes("execute") || lower.includes("exec")) return { mode: "+x", explanation: "Add execute permission" };
  }

  if (lower.includes("remove") || lower.includes("take away") || lower.includes("deny")) {
    if (lower.includes("read")) return { mode: "-r", explanation: "Remove read permission" };
    if (lower.includes("write")) return { mode: "-w", explanation: "Remove write permission" };
    if (lower.includes("execute") || lower.includes("exec")) return { mode: "-x", explanation: "Remove execute permission" };
  }

  return null;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function modeToSymbolic(mode: number): string {
  const types: Record<number, string> = { 0o140000: "s", 0o120000: "l", 0o100000: "-", 0o040000: "d", 0o060000: "b", 0o020000: "c", 0o010000: "p" };
  const fileType = Object.entries(types).find(([mask]) => (mode & Number(mask)) === Number(mask));
  const prefix = fileType?.[1] ?? "?";

  const perms = (m: number, shift: number, special: number, specialChar: string): string => {
    const r = (m >> (shift + 2)) & 1 ? "r" : "-";
    const w = (m >> (shift + 1)) & 1 ? "w" : "-";
    const x = (m >> shift) & 1;
    const s = (m & special) !== 0;
    const xChar = s ? (x ? specialChar : specialChar.toUpperCase()) : (x ? "x" : "-");
    return r + w + xChar;
  };

  return prefix +
    perms(mode, 6, 0o4000, "s") +
    perms(mode, 3, 0o2000, "s") +
    perms(mode, 0, 0o1000, "t");
}

function octalToSymbolic(octal: string): string {
  const num = parseInt(octal, 8);
  return modeToSymbolic(0o100000 | num).slice(1); // strip file type prefix
}

function formatPermissions(info: { octal: string; mode: string; owner: string; group: string; readable: boolean; writable: boolean; executable: boolean }): string {
  const access: string[] = [];
  if (info.readable) access.push("read");
  if (info.writable) access.push("write");
  if (info.executable) access.push("execute");
  return `${info.mode} (${info.octal}) owner=${info.owner} group=${info.group} | You can: ${access.join(", ") || "nothing"}`;
}

/**
 * Format full permissions display.
 */
export function formatPermissionsDisplay(perms: FilePermissions): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", red: "\x1b[31m", yellow: "\x1b[33m" };

  if (!perms.exists) return `${c.red}Not found: ${perms.path}${c.reset}`;

  const access = [
    perms.readable ? `${c.green}read${c.reset}` : `${c.red}no read${c.reset}`,
    perms.writable ? `${c.green}write${c.reset}` : `${c.red}no write${c.reset}`,
    perms.executable ? `${c.green}execute${c.reset}` : `${c.dim}no execute${c.reset}`,
  ].join(", ");

  const special: string[] = [];
  if (perms.setuid) special.push(`${c.yellow}SETUID${c.reset}`);
  if (perms.setgid) special.push(`${c.yellow}SETGID${c.reset}`);
  if (perms.sticky) special.push(`${c.yellow}STICKY${c.reset}`);

  const lines = [
    `${c.bold}${perms.path}${c.reset}`,
    `  Type:        ${perms.type}`,
    `  Permissions: ${perms.mode} (${perms.octal})`,
    `  Owner:       ${perms.owner}:${perms.group}`,
    `  Size:        ${formatSize(perms.size)}`,
    `  Your access: ${access}`,
  ];

  if (special.length > 0) {
    lines.push(`  Special:     ${special.join(", ")}`);
  }

  return lines.join("\n");
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1048576) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1073741824) return `${(bytes / 1048576).toFixed(1)} MB`;
  return `${(bytes / 1073741824).toFixed(1)} GB`;
}
