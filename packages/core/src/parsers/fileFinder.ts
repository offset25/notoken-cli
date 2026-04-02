/**
 * Smart file finder.
 *
 * When a user asks about a specific file or config, searches known locations
 * by file type, service, and name. Works locally or remotely via SSH.
 *
 * Reads locations from config/file-hints.json so users can extend it.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runRemoteCommand, runLocalCommand } from "../execution/ssh.js";
import { CONFIG_DIR } from "../utils/paths.js";

const HINTS_FILE = resolve(CONFIG_DIR, "file-hints.json");

interface HintEntry { path: string; description: string }
interface HintCategory {
  aliases: string[];
  configs?: HintEntry[];
  logs?: HintEntry[];
  data?: HintEntry[];
  service?: string;
  parser?: string;
}

let cachedHints: Record<string, HintCategory> | null = null;

function loadHints(): Record<string, HintCategory> {
  if (cachedHints) return cachedHints;
  const raw = JSON.parse(readFileSync(HINTS_FILE, "utf-8"));
  delete raw._description;
  cachedHints = raw;
  return cachedHints!;
}

export interface FileLocation {
  path: string;
  description: string;
}

/**
 * Known file locations by category.
 * These are the standard/common paths on Linux systems.
 */
export const KNOWN_LOCATIONS: Record<string, FileLocation[]> = {
  // Nginx
  nginx: [
    { path: "/etc/nginx/nginx.conf", description: "Nginx main config" },
    { path: "/etc/nginx/conf.d/", description: "Nginx config directory" },
    { path: "/etc/nginx/sites-available/", description: "Nginx sites available" },
    { path: "/etc/nginx/sites-enabled/", description: "Nginx sites enabled" },
    { path: "/var/log/nginx/access.log", description: "Nginx access log" },
    { path: "/var/log/nginx/error.log", description: "Nginx error log" },
    { path: "/usr/share/nginx/html/", description: "Nginx default webroot" },
  ],

  // Apache
  apache: [
    { path: "/etc/apache2/apache2.conf", description: "Apache main config (Debian)" },
    { path: "/etc/httpd/conf/httpd.conf", description: "Apache main config (RHEL)" },
    { path: "/etc/apache2/sites-available/", description: "Apache sites available" },
    { path: "/etc/apache2/sites-enabled/", description: "Apache sites enabled" },
    { path: "/etc/httpd/conf.d/", description: "Apache config directory (RHEL)" },
    { path: "/var/log/apache2/access.log", description: "Apache access log (Debian)" },
    { path: "/var/log/apache2/error.log", description: "Apache error log (Debian)" },
    { path: "/var/log/httpd/access_log", description: "Apache access log (RHEL)" },
    { path: "/var/log/httpd/error_log", description: "Apache error log (RHEL)" },
    { path: "/var/www/html/", description: "Apache default webroot" },
  ],

  // System auth
  auth: [
    { path: "/etc/passwd", description: "User accounts" },
    { path: "/etc/shadow", description: "Password hashes" },
    { path: "/etc/group", description: "Group definitions" },
    { path: "/etc/sudoers", description: "Sudo rules" },
    { path: "/etc/sudoers.d/", description: "Sudo rules directory" },
    { path: "/etc/ssh/sshd_config", description: "SSH daemon config" },
    { path: "/etc/pam.d/", description: "PAM config directory" },
  ],

  // SSL/TLS
  ssl: [
    { path: "/etc/ssl/certs/", description: "System SSL certificates" },
    { path: "/etc/ssl/private/", description: "Private keys" },
    { path: "/etc/letsencrypt/live/", description: "Let's Encrypt certificates" },
    { path: "/etc/pki/tls/certs/", description: "PKI certificates (RHEL)" },
  ],

  // System
  system: [
    { path: "/etc/hostname", description: "Hostname" },
    { path: "/etc/hosts", description: "Hosts file" },
    { path: "/etc/resolv.conf", description: "DNS resolver config" },
    { path: "/etc/fstab", description: "Filesystem mounts" },
    { path: "/etc/crontab", description: "System crontab" },
    { path: "/etc/environment", description: "System environment variables" },
    { path: "/etc/sysctl.conf", description: "Kernel parameters" },
  ],

  // Network
  network: [
    { path: "/etc/network/interfaces", description: "Network interfaces (Debian)" },
    { path: "/etc/sysconfig/network-scripts/", description: "Network scripts (RHEL)" },
    { path: "/etc/netplan/", description: "Netplan config (Ubuntu)" },
    { path: "/etc/iptables/rules.v4", description: "iptables rules" },
    { path: "/etc/firewalld/", description: "Firewalld config" },
  ],

  // Database
  postgres: [
    { path: "/etc/postgresql/", description: "PostgreSQL config directory" },
    { path: "/var/lib/postgresql/", description: "PostgreSQL data" },
    { path: "/var/log/postgresql/", description: "PostgreSQL logs" },
  ],
  mysql: [
    { path: "/etc/mysql/my.cnf", description: "MySQL main config" },
    { path: "/etc/mysql/mysql.conf.d/", description: "MySQL config directory" },
    { path: "/var/log/mysql/", description: "MySQL logs" },
  ],
  redis: [
    { path: "/etc/redis/redis.conf", description: "Redis config" },
    { path: "/var/log/redis/", description: "Redis logs" },
  ],

  // Application
  env: [
    { path: ".env", description: "Local .env file" },
    { path: ".env.local", description: "Local overrides" },
    { path: ".env.production", description: "Production env" },
    { path: ".env.staging", description: "Staging env" },
    { path: ".env.development", description: "Development env" },
  ],

  // Docker
  docker: [
    { path: "/etc/docker/daemon.json", description: "Docker daemon config" },
    { path: "docker-compose.yml", description: "Docker Compose config" },
    { path: "docker-compose.yaml", description: "Docker Compose config" },
    { path: "Dockerfile", description: "Dockerfile" },
  ],

  // Systemd
  systemd: [
    { path: "/etc/systemd/system/", description: "Systemd unit files" },
    { path: "/usr/lib/systemd/system/", description: "System unit files" },
    { path: "/var/log/journal/", description: "Systemd journal logs" },
  ],

  // Logs
  logs: [
    { path: "/var/log/syslog", description: "System log (Debian)" },
    { path: "/var/log/messages", description: "System log (RHEL)" },
    { path: "/var/log/auth.log", description: "Auth log (Debian)" },
    { path: "/var/log/secure", description: "Auth log (RHEL)" },
    { path: "/var/log/kern.log", description: "Kernel log" },
    { path: "/var/log/dmesg", description: "Boot messages" },
  ],
};

// Aliases for category lookup
const CATEGORY_ALIASES: Record<string, string> = {
  httpd: "apache", http: "apache", web: "nginx",
  pg: "postgres", postgresql: "postgres", database: "postgres", db: "postgres",
  cache: "redis",
  ssh: "auth", users: "auth", passwd: "auth", shadow: "auth",
  certs: "ssl", certificates: "ssl", tls: "ssl", "lets-encrypt": "ssl", letsencrypt: "ssl",
  firewall: "network", iptables: "network", netplan: "network",
  compose: "docker", container: "docker",
  journal: "systemd", services: "systemd",
  syslog: "logs", "auth.log": "logs",
  dotenv: "env", environment: "env",
};

/**
 * Find files for a given query (service name, file type, or filename).
 * Reads from config/file-hints.json.
 */
export function findKnownLocations(query: string): FileLocation[] {
  const lower = query.toLowerCase();
  const hints = loadHints();

  // Find the matching category
  let category: HintCategory | undefined;

  // Direct name match
  if (hints[lower]) category = hints[lower];

  // Alias match
  if (!category) {
    for (const cat of Object.values(hints)) {
      if (cat.aliases?.some((a) => a === lower)) {
        category = cat;
        break;
      }
    }
  }

  if (category) {
    const results: FileLocation[] = [];
    for (const group of [category.configs, category.logs, category.data]) {
      if (group) results.push(...group);
    }
    return results;
  }

  // Fuzzy search across all categories
  const results: FileLocation[] = [];
  for (const cat of Object.values(hints)) {
    for (const group of [cat.configs, cat.logs, cat.data]) {
      if (!group) continue;
      for (const loc of group) {
        if (loc.path.toLowerCase().includes(lower) || loc.description.toLowerCase().includes(lower)) {
          results.push(loc);
        }
      }
    }
  }
  return results;
}

/**
 * Get the recommended parser type for a service.
 */
export function getParserForService(service: string): string {
  const hints = loadHints();
  const cat = hints[service.toLowerCase()];
  return cat?.parser ?? "text";
}

/**
 * Search for a file on a remote server.
 */
export async function searchRemoteFile(
  query: string,
  environment: string,
  execution: "remote" | "local" = "remote"
): Promise<string[]> {
  const run = execution === "local" ? runLocalCommand : (cmd: string) => runRemoteCommand(environment, cmd);

  // First check known locations
  const known = findKnownLocations(query);
  const knownPaths = known.map((k) => k.path);

  // Check which known paths exist
  if (knownPaths.length > 0) {
    const checkCmd = knownPaths.map((p) => `test -e ${p} && echo ${p}`).join("; ");
    try {
      const result = (await run(checkCmd)).trim();
      if (result) return result.split("\n").filter(Boolean);
    } catch {}
  }

  // Fall back to find
  const searchDirs = ["/etc", "/var/log", "/var/www", "/srv", "/opt", "/home"];
  const sanitized = query.replace(/[^a-zA-Z0-9._*\-]/g, "");
  const findCmd = `find ${searchDirs.join(" ")} -maxdepth 4 -iname '*${sanitized}*' 2>/dev/null | head -20`;

  try {
    const result = (await run(findCmd)).trim();
    return result ? result.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}
