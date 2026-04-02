/**
 * Entity resolver with fuzzy matching.
 *
 * Resolves user-defined aliases like:
 *   "metroplex"     → 66.94.115.165
 *   "the 66 server" → 66.94.115.165 (IP fragment match)
 *   "66"            → guesses: "Did you mean metroplex (66.94.115.165)?"
 *
 * When guessing, always verbalizes so the user can correct.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ServerEntity {
  host: string;
  user?: string;
  port?: number;
  description?: string;
  aliases: string[];
}

export interface DatabaseEntity {
  type: "postgres" | "mysql" | "redis" | "mongo";
  host: string;
  port?: number;
  name: string;
  user?: string;
  aliases: string[];
}

export interface ServiceGroupEntity {
  description?: string;
  components: string[];
  aliases: string[];
}

export interface EntitiesConfig {
  servers: Record<string, ServerEntity>;
  databases: Record<string, DatabaseEntity>;
  services: Record<string, ServiceGroupEntity>;
}

export interface ResolvedEntity {
  name: string;
  type: "server" | "database" | "service";
  data: ServerEntity | DatabaseEntity | ServiceGroupEntity;
  confidence: "exact" | "alias" | "fuzzy" | "guess";
  matchedOn: string;
}

// ─── Config loading ──────────────────────────────────────────────────────────

const CONFIG_PATH = resolve(import.meta.url.replace("file://", "").replace(/\/[^/]+$/, ""), "../../config/entities.json");

let _cached: EntitiesConfig | null = null;

export function loadEntities(forceReload = false): EntitiesConfig {
  if (_cached && !forceReload) return _cached;

  // Try multiple paths
  const paths = [
    CONFIG_PATH,
    resolve(process.cwd(), "config/entities.json"),
    resolve(import.meta.url.replace("file://", "").replace(/dist\/.*$/, ""), "config/entities.json"),
  ];

  for (const p of paths) {
    if (existsSync(p)) {
      try {
        _cached = JSON.parse(readFileSync(p, "utf-8"));
        return _cached!;
      } catch {}
    }
  }

  _cached = { servers: {}, databases: {}, services: {} };
  return _cached;
}

function saveEntities(config: EntitiesConfig): void {
  const paths = [
    CONFIG_PATH,
    resolve(process.cwd(), "config/entities.json"),
  ];
  for (const p of paths) {
    if (existsSync(p) || existsSync(resolve(p, ".."))) {
      try {
        writeFileSync(p, JSON.stringify(config, null, 2) + "\n");
        _cached = config;
        return;
      } catch {}
    }
  }
}

// ─── Resolution ──────────────────────────────────────────────────────────────

/**
 * Resolve a user reference to an entity.
 * Returns the match and confidence level.
 * When guessing, includes a verbalized message.
 */
export function resolveEntity(input: string): ResolvedEntity | null {
  const lower = input.toLowerCase().trim();
  const entities = loadEntities();

  // 1. Exact name match
  for (const [name, server] of Object.entries(entities.servers)) {
    if (lower === name.toLowerCase()) {
      return { name, type: "server", data: server, confidence: "exact", matchedOn: name };
    }
  }
  for (const [name, db] of Object.entries(entities.databases)) {
    if (lower === name.toLowerCase()) {
      return { name, type: "database", data: db, confidence: "exact", matchedOn: name };
    }
  }
  for (const [name, svc] of Object.entries(entities.services)) {
    if (lower === name.toLowerCase()) {
      return { name, type: "service", data: svc, confidence: "exact", matchedOn: name };
    }
  }

  // 2. Alias match
  for (const [name, svc] of Object.entries(entities.services)) {
    for (const alias of svc.aliases) {
      if (lower === alias.toLowerCase() || lower.includes(alias.toLowerCase())) {
        return { name, type: "service", data: svc, confidence: "alias", matchedOn: alias };
      }
    }
  }
  for (const [name, server] of Object.entries(entities.servers)) {
    for (const alias of server.aliases) {
      if (lower === alias.toLowerCase() || lower.includes(alias.toLowerCase())) {
        return { name, type: "server", data: server, confidence: "alias", matchedOn: alias };
      }
    }
  }
  for (const [name, db] of Object.entries(entities.databases)) {
    for (const alias of db.aliases) {
      if (lower === alias.toLowerCase() || lower.includes(alias.toLowerCase())) {
        return { name, type: "database", data: db, confidence: "alias", matchedOn: alias };
      }
    }
  }

  // 3. IP fragment match — "66" matches host containing "66", "197" matches "197"
  const ipMatch = lower.match(/\b(\d{1,3})\b/);
  if (ipMatch) {
    const fragment = ipMatch[1];
    const matches: Array<{ name: string; server: ServerEntity }> = [];
    for (const [name, server] of Object.entries(entities.servers)) {
      const octets = server.host.split(".");
      if (octets.some((o) => o === fragment) || server.host.includes(fragment)) {
        matches.push({ name, server });
      }
    }
    if (matches.length === 1) {
      return {
        name: matches[0].name,
        type: "server",
        data: matches[0].server,
        confidence: "fuzzy",
        matchedOn: `IP contains "${fragment}"`,
      };
    }
    if (matches.length > 1) {
      // Multiple matches — return the first as a guess
      return {
        name: matches[0].name,
        type: "server",
        data: matches[0].server,
        confidence: "guess",
        matchedOn: `IP contains "${fragment}" (${matches.length} matches)`,
      };
    }
  }

  // 4. Partial name match — "metro" matches "metroplex"
  for (const [name, server] of Object.entries(entities.servers)) {
    if (name.toLowerCase().startsWith(lower) || lower.startsWith(name.toLowerCase())) {
      return { name, type: "server", data: server, confidence: "fuzzy", matchedOn: `partial name "${input}"` };
    }
  }
  for (const [name, db] of Object.entries(entities.databases)) {
    if (name.toLowerCase().startsWith(lower) || lower.startsWith(name.toLowerCase())) {
      return { name, type: "database", data: db, confidence: "fuzzy", matchedOn: `partial name "${input}"` };
    }
  }

  return null;
}

/**
 * Format a resolution result with verbalization.
 * For exact/alias matches: silent (just uses it).
 * For fuzzy/guess: tells the user what it's assuming.
 */
export function verbalizeResolution(resolved: ResolvedEntity): string {
  if (resolved.confidence === "exact") return "";
  if (resolved.confidence === "alias") {
    return `${c.dim}(${resolved.matchedOn} → ${resolved.name})${c.reset}`;
  }
  if (resolved.confidence === "fuzzy") {
    const host = (resolved.data as ServerEntity).host ?? "";
    return `${c.yellow}Assuming "${resolved.name}" (${host}) — matched on ${resolved.matchedOn}${c.reset}`;
  }
  if (resolved.confidence === "guess") {
    const host = (resolved.data as ServerEntity).host ?? "";
    return `${c.yellow}${c.bold}Best guess: "${resolved.name}" (${host})${c.reset} — ${c.yellow}${resolved.matchedOn}. Say "no" or "stop" to cancel.${c.reset}`;
  }
  return "";
}

/**
 * Get related service components for a service group.
 * E.g. "openclaw" → ["openclaw-gateway", "matrix-synapse", "mautrix-telegram", ...]
 */
export function getRelatedComponents(serviceName: string): string[] {
  const entities = loadEntities();
  // Check if it's a service group
  for (const [name, svc] of Object.entries(entities.services)) {
    if (name === serviceName || svc.aliases.includes(serviceName.toLowerCase())) {
      return svc.components;
    }
  }
  return [];
}

// ─── Entity management ───────────────────────────────────────────────────────

/**
 * Add or update a server entity.
 */
export function defineServer(name: string, host: string, user?: string, description?: string, aliases?: string[]): string {
  const entities = loadEntities();

  // Auto-generate aliases from IP
  const autoAliases: string[] = [];
  const octets = host.split(".");
  if (octets.length === 4) {
    autoAliases.push(`the ${octets[0]} server`, `${octets[0]} server`, `${octets[0]} box`);
    autoAliases.push(`the ${octets[3]} server`, `${octets[3]} server`, `${octets[3]} box`);
  }

  entities.servers[name] = {
    host,
    user,
    description,
    aliases: [...new Set([...(aliases ?? []), ...autoAliases])],
  };

  saveEntities(entities);
  return `${c.green}✓${c.reset} Defined server ${c.bold}${name}${c.reset} → ${host}${description ? ` (${description})` : ""}`;
}

/**
 * Add or update a database entity.
 */
export function defineDatabase(name: string, type: DatabaseEntity["type"], host: string, dbName: string, user?: string, aliases?: string[]): string {
  const entities = loadEntities();
  entities.databases[name] = { type, host, name: dbName, user, aliases: aliases ?? [] };
  saveEntities(entities);
  return `${c.green}✓${c.reset} Defined database ${c.bold}${name}${c.reset} → ${type}://${host}/${dbName}`;
}

/**
 * List all defined entities.
 */
export function listEntities(): string {
  const entities = loadEntities();
  const lines: string[] = [];

  lines.push(`\n${c.bold}${c.cyan}── Defined Entities ──${c.reset}\n`);

  const servers = Object.entries(entities.servers);
  if (servers.length > 0) {
    lines.push(`  ${c.bold}Servers:${c.reset}`);
    for (const [name, s] of servers) {
      lines.push(`    ${c.cyan}${name}${c.reset} → ${c.bold}${s.user ? s.user + "@" : ""}${s.host}${c.reset}${s.description ? `  ${c.dim}${s.description}${c.reset}` : ""}`);
      if (s.aliases.length > 0) {
        lines.push(`      ${c.dim}aliases: ${s.aliases.join(", ")}${c.reset}`);
      }
    }
  }

  const dbs = Object.entries(entities.databases);
  if (dbs.length > 0) {
    lines.push(`\n  ${c.bold}Databases:${c.reset}`);
    for (const [name, d] of dbs) {
      lines.push(`    ${c.cyan}${name}${c.reset} → ${d.type}://${d.host}/${d.name}${d.user ? ` (${d.user})` : ""}`);
      if (d.aliases.length > 0) {
        lines.push(`      ${c.dim}aliases: ${d.aliases.join(", ")}${c.reset}`);
      }
    }
  }

  const svcs = Object.entries(entities.services);
  if (svcs.length > 0) {
    lines.push(`\n  ${c.bold}Service Groups:${c.reset}`);
    for (const [name, s] of svcs) {
      lines.push(`    ${c.cyan}${name}${c.reset}${s.description ? `  ${c.dim}${s.description}${c.reset}` : ""}`);
      if (s.components.length > 0) {
        lines.push(`      ${c.bold}components:${c.reset} ${s.components.join(", ")}`);
      }
      if (s.aliases.length > 0) {
        lines.push(`      ${c.dim}aliases: ${s.aliases.join(", ")}${c.reset}`);
      }
    }
  }

  if (servers.length === 0 && dbs.length === 0 && svcs.length === 0) {
    lines.push(`  ${c.dim}No entities defined yet.${c.reset}`);
    lines.push(`  ${c.dim}Define one: "metroplex is the 66.94.115.165 server"${c.reset}`);
  }

  return lines.join("\n");
}

/**
 * Try to learn a new entity from natural language.
 * "metroplex is 66.94.115.165" → defineServer("metroplex", "66.94.115.165")
 * "astrotrain is the 197 server at 197.168.1.10" → defineServer(...)
 */
export function learnEntity(rawText: string): string | null {
  const lower = rawText.toLowerCase();

  // "<name> is <ip>" or "<name> is the <ip> server"
  const serverMatch = lower.match(/^(\w+)\s+is\s+(?:the\s+)?(?:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})(?:\s+server)?|(?:the\s+)?(\d{1,3})\s+server)/);
  if (serverMatch) {
    const name = serverMatch[1];
    const fullIp = serverMatch[2];
    const partialIp = serverMatch[3];

    if (fullIp) {
      return defineServer(name, fullIp);
    }
    if (partialIp) {
      // Partial IP — store as a pattern
      return defineServer(name, `*.*.*.${partialIp}`, undefined, `Server with IP ending in ${partialIp}`, [`the ${partialIp} server`, `${partialIp} server`]);
    }
  }

  // "<name> is a <type> database at <host>"
  const dbMatch = lower.match(/^(\w+)\s+is\s+(?:a\s+)?(postgres|mysql|redis|mongo)\w*\s+(?:database|db)\s+(?:at\s+)?(\S+)?/);
  if (dbMatch) {
    const name = dbMatch[1];
    const type = dbMatch[2] as DatabaseEntity["type"];
    const host = dbMatch[3] ?? "localhost";
    return defineDatabase(name, type, host, name);
  }

  return null;
}
