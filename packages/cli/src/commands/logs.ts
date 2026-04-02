/**
 * notoken logs <service>
 *
 * Quick access to service logs:
 *   notoken logs nginx        — Tail nginx error log
 *   notoken logs api          — Tail api application log
 *   notoken logs docker <ctr> — Docker container logs
 *   notoken logs system       — System log (syslog/messages)
 *   notoken logs auth         — Auth log
 *   notoken logs              — Show available log sources
 */

import { execSync } from "node:child_process";

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

const LOG_SOURCES: Record<string, { paths: string[]; description: string }> = {
  nginx: {
    paths: ["/var/log/nginx/error.log", "/var/log/nginx/access.log"],
    description: "Nginx web server logs",
  },
  apache: {
    paths: ["/var/log/apache2/error.log", "/var/log/httpd/error_log"],
    description: "Apache web server logs",
  },
  api: {
    paths: ["/var/log/api/app.log", "/var/log/app/api.log"],
    description: "API application logs",
  },
  system: {
    paths: ["/var/log/syslog", "/var/log/messages"],
    description: "System log",
  },
  auth: {
    paths: ["/var/log/auth.log", "/var/log/secure"],
    description: "Authentication log",
  },
  kernel: {
    paths: ["/var/log/kern.log"],
    description: "Kernel messages",
  },
  postgres: {
    paths: ["/var/log/postgresql/postgresql.log", "/var/log/postgresql/*.log"],
    description: "PostgreSQL logs",
  },
  redis: {
    paths: ["/var/log/redis/redis-server.log"],
    description: "Redis server logs",
  },
  mysql: {
    paths: ["/var/log/mysql/error.log", "/var/log/mysql/*.log"],
    description: "MySQL/MariaDB logs",
  },
  docker: {
    paths: [],  // handled separately via docker logs
    description: "Docker container logs (specify container name)",
  },
  journal: {
    paths: [],  // handled via journalctl
    description: "Systemd journal (all services)",
  },
};

export async function runLogs(args: string[]): Promise<void> {
  const source = args[0];
  const extra = args.slice(1).join(" ");
  const lines = 50;

  if (!source) {
    console.log(`${c.bold}notoken logs${c.reset} <service> [options]\n`);
    for (const [key, src] of Object.entries(LOG_SOURCES)) {
      console.log(`  ${c.cyan}${key.padEnd(12)}${c.reset} ${src.description}`);
    }
    console.log(`\n${c.dim}Tails the last ${lines} lines. Shows first accessible log file.${c.reset}`);
    return;
  }

  // Docker container logs
  if (source === "docker") {
    const container = extra || "";
    if (!container) {
      console.log(`${c.bold}Running containers:${c.reset}`);
      try {
        const ps = execSync("docker ps --format '{{.Names}}\\t{{.Status}}'", { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] });
        console.log(ps);
        console.log(`${c.dim}Usage: notoken logs docker <container-name>${c.reset}`);
      } catch {
        console.error(`${c.red}Docker not running or not installed.${c.reset}`);
      }
      return;
    }
    try {
      execSync(`docker logs --tail ${lines} -f ${container}`, { stdio: "inherit", timeout: 0 });
    } catch {
      console.error(`${c.red}Could not get logs for container: ${container}${c.reset}`);
    }
    return;
  }

  // Journalctl
  if (source === "journal") {
    const unit = extra ? `-u ${extra}` : "";
    try {
      execSync(`journalctl ${unit} -n ${lines} --no-pager`, { stdio: "inherit" });
    } catch {
      console.error(`${c.red}journalctl not available.${c.reset}`);
    }
    return;
  }

  // File-based logs
  const logSource = LOG_SOURCES[source];
  if (!logSource) {
    // Try as a journalctl unit
    console.log(`${c.dim}Unknown source "${source}", trying journalctl -u ${source}...${c.reset}`);
    try {
      execSync(`journalctl -u ${source} -n ${lines} --no-pager`, { stdio: "inherit" });
    } catch {
      console.error(`${c.red}No logs found for: ${source}${c.reset}`);
    }
    return;
  }

  // Find first existing log file
  for (const path of logSource.paths) {
    try {
      execSync(`test -f ${path}`, { stdio: "pipe" });
      console.log(`${c.bold}${path}${c.reset}\n`);
      execSync(`tail -${lines} ${path}`, { stdio: "inherit" });
      return;
    } catch {
      continue;
    }
  }

  // Fallback to journalctl for the service
  console.log(`${c.dim}No log files found, trying journalctl...${c.reset}`);
  try {
    execSync(`journalctl -u ${source} -n ${lines} --no-pager`, { stdio: "inherit" });
  } catch {
    console.error(`${c.red}No logs found for: ${source}${c.reset}`);
  }
}
