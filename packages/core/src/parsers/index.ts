/**
 * File parser system.
 *
 * Detects file type and delegates to the right parser.
 * Supports: passwd, shadow, .env, yaml, json, generic text.
 */

import { readFileSync, existsSync } from "node:fs";
import { extname, basename } from "node:path";
import { parsePasswd, type PasswdEntry } from "./passwd.js";
import { parseShadow, type ShadowEntry } from "./shadow.js";
import { parseEnvFile, type EnvEntry } from "./envFile.js";
import { parseYaml } from "./yamlParser.js";
import { parseJson } from "./jsonParser.js";
import { parseNginx, formatNginxSummary } from "./nginxParser.js";
import { parseApache, formatApacheSummary } from "./apacheParser.js";
import { parseZoneFile, formatZoneSummary } from "./bindParser.js";

export type FileType = "passwd" | "shadow" | "env" | "yaml" | "json" | "nginx" | "apache" | "bind" | "text" | "unknown";

export interface ParsedFile {
  path: string;
  type: FileType;
  raw: string;
  data: unknown;
  summary: string;
  entries?: number;
}

/**
 * Detect file type from path and content.
 */
export function detectFileType(filePath: string, content?: string): FileType {
  const name = basename(filePath);
  const ext = extname(filePath).toLowerCase();

  if (name === "passwd" || filePath.includes("/etc/passwd")) return "passwd";
  if (name === "shadow" || filePath.includes("/etc/shadow")) return "shadow";
  if (name === ".env" || name.startsWith(".env.") || ext === ".env") return "env";
  if (ext === ".yml" || ext === ".yaml") return "yaml";
  if (ext === ".json") return "json";
  if (filePath.includes("nginx") && (ext === ".conf" || ext === "")) return "nginx";
  if ((filePath.includes("apache") || filePath.includes("httpd")) && (ext === ".conf" || ext === "")) return "apache";
  if ((filePath.includes("bind") || filePath.includes("named") || filePath.includes("/zones/")) && ext === ".zone") return "bind";
  if (filePath.includes("db.") && filePath.includes("/bind")) return "bind";

  // Content-based detection
  if (content) {
    const firstLine = content.split("\n")[0] ?? "";
    // passwd format: user:x:uid:gid:...
    if (/^\w+:[x*!]:?\d+:\d+:/.test(firstLine)) return "passwd";
    // shadow format: user:$hash:...
    if (/^\w+:[\$!*]/.test(firstLine)) return "shadow";
    // env format: KEY=VALUE
    if (/^[A-Z_][A-Z0-9_]*=/.test(firstLine)) return "env";
    // json
    if (firstLine.trim().startsWith("{") || firstLine.trim().startsWith("[")) return "json";
    // yaml
    if (firstLine.trim().startsWith("---") || /^\w+:\s/.test(firstLine)) return "yaml";
  }

  return "text";
}

/**
 * Parse a file and return structured data.
 */
export function parseFile(filePath: string): ParsedFile {
  if (!existsSync(filePath)) {
    return { path: filePath, type: "unknown", raw: "", data: null, summary: `File not found: ${filePath}` };
  }

  const raw = readFileSync(filePath, "utf-8");
  const type = detectFileType(filePath, raw);

  switch (type) {
    case "passwd": {
      const entries = parsePasswd(raw);
      return {
        path: filePath, type, raw, data: entries,
        summary: `${entries.length} user(s)`,
        entries: entries.length,
      };
    }

    case "shadow": {
      const entries = parseShadow(raw);
      return {
        path: filePath, type, raw, data: entries,
        summary: `${entries.length} shadow entries`,
        entries: entries.length,
      };
    }

    case "env": {
      const entries = parseEnvFile(raw);
      return {
        path: filePath, type, raw, data: entries,
        summary: `${entries.length} variable(s)`,
        entries: entries.length,
      };
    }

    case "yaml": {
      const data = parseYaml(raw);
      const keys = typeof data === "object" && data ? Object.keys(data) : [];
      return {
        path: filePath, type, raw, data,
        summary: `YAML with ${keys.length} top-level key(s)`,
      };
    }

    case "json": {
      const data = parseJson(raw);
      const keys = typeof data === "object" && data && !Array.isArray(data) ? Object.keys(data) : [];
      const count = Array.isArray(data) ? data.length : keys.length;
      return {
        path: filePath, type, raw, data,
        summary: `JSON with ${count} ${Array.isArray(data) ? "item(s)" : "key(s)"}`,
      };
    }

    case "nginx": {
      const config = parseNginx(raw);
      return {
        path: filePath, type, raw, data: config,
        summary: `Nginx config with ${config.servers.length} server block(s)`,
      };
    }

    case "apache": {
      const config = parseApache(raw);
      return {
        path: filePath, type, raw, data: config,
        summary: `Apache config with ${config.vhosts.length} VirtualHost(s)`,
      };
    }

    case "bind": {
      const zoneData = parseZoneFile(raw);
      return {
        path: filePath, type, raw, data: zoneData,
        summary: `DNS zone with ${zoneData.records.length} record(s)`,
      };
    }

    default:
      return {
        path: filePath, type: "text", raw, data: raw,
        summary: `${raw.split("\n").length} line(s)`,
      };
  }
}

/**
 * Format a parsed file for display.
 */
export function formatParsedFile(parsed: ParsedFile): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m" };
  const lines: string[] = [];

  lines.push(`${c.bold}${parsed.path}${c.reset} (${parsed.type}) — ${parsed.summary}`);
  lines.push("");

  switch (parsed.type) {
    case "passwd": {
      const entries = parsed.data as PasswdEntry[];
      for (const e of entries.slice(0, 20)) {
        lines.push(`  ${c.cyan}${e.username}${c.reset} uid=${e.uid} gid=${e.gid} home=${e.home} shell=${e.shell}`);
      }
      if (entries.length > 20) lines.push(`  ${c.dim}... and ${entries.length - 20} more${c.reset}`);
      break;
    }

    case "shadow": {
      const entries = parsed.data as ShadowEntry[];
      for (const e of entries.slice(0, 20)) {
        const status = e.locked ? "locked" : e.hasPassword ? "has password" : "no password";
        lines.push(`  ${c.cyan}${e.username}${c.reset} ${status} lastChanged=${e.lastChanged ?? "?"}`);
      }
      break;
    }

    case "env": {
      const entries = parsed.data as EnvEntry[];
      for (const e of entries) {
        const val = e.isSecret ? `${c.yellow}****${c.reset}` : e.value;
        lines.push(`  ${c.cyan}${e.key}${c.reset}=${val}`);
      }
      break;
    }

    case "nginx":
      lines.push(formatNginxSummary(parsed.data as ReturnType<typeof parseNginx>));
      break;

    case "apache":
      lines.push(formatApacheSummary(parsed.data as ReturnType<typeof parseApache>));
      break;

    case "bind":
      lines.push(formatZoneSummary(parsed.data as ReturnType<typeof parseZoneFile>));
      break;

    case "yaml":
    case "json":
      lines.push(JSON.stringify(parsed.data, null, 2).split("\n").slice(0, 30).join("\n"));
      break;

    default:
      lines.push(parsed.raw.split("\n").slice(0, 20).join("\n"));
      break;
  }

  return lines.join("\n");
}
