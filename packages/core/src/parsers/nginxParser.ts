/**
 * Nginx config parser.
 *
 * Parses nginx.conf and site configs into structured blocks.
 * Handles: server blocks, location blocks, upstream, directives.
 */

export interface NginxDirective {
  name: string;
  args: string[];
  line: number;
}

export interface NginxBlock {
  type: string;
  args: string[];
  directives: NginxDirective[];
  blocks: NginxBlock[];
  line: number;
}

export interface NginxConfig {
  directives: NginxDirective[];
  blocks: NginxBlock[];
  servers: NginxServerBlock[];
}

export interface NginxServerBlock {
  listen: string[];
  serverName: string[];
  root?: string;
  index?: string;
  locations: Array<{
    path: string;
    proxyPass?: string;
    root?: string;
    tryFiles?: string;
    directives: NginxDirective[];
  }>;
  ssl: boolean;
  sslCertificate?: string;
  sslCertificateKey?: string;
}

/**
 * Parse nginx config content.
 */
export function parseNginx(content: string): NginxConfig {
  const lines = content.split("\n");
  const { directives, blocks } = parseBlock(lines, 0, lines.length);
  const servers = extractServers(blocks);

  return { directives, blocks, servers };
}

function parseBlock(
  lines: string[],
  start: number,
  end: number
): { directives: NginxDirective[]; blocks: NginxBlock[] } {
  const directives: NginxDirective[] = [];
  const blocks: NginxBlock[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i].trim();

    // Skip comments and empty lines
    if (!line || line.startsWith("#")) {
      i++;
      continue;
    }

    // Block opening: "server {", "location /api {"
    if (line.includes("{")) {
      const beforeBrace = line.split("{")[0].trim();
      const parts = beforeBrace.split(/\s+/);
      const blockType = parts[0] ?? "";
      const blockArgs = parts.slice(1);

      // Find matching closing brace
      let depth = 1;
      let j = i + 1;
      while (j < end && depth > 0) {
        const l = lines[j].trim();
        for (const ch of l) {
          if (ch === "{") depth++;
          if (ch === "}") depth--;
        }
        if (depth > 0) j++;
        else break;
      }

      // Recursively parse the block content
      const inner = parseBlock(lines, i + 1, j);
      blocks.push({
        type: blockType,
        args: blockArgs,
        directives: inner.directives,
        blocks: inner.blocks,
        line: i + 1,
      });

      i = j + 1;
      continue;
    }

    // Closing brace (shouldn't happen at this level but handle gracefully)
    if (line === "}") {
      i++;
      continue;
    }

    // Directive: "worker_processes auto;"
    if (line.endsWith(";")) {
      const stripped = line.slice(0, -1).trim();
      const parts = stripped.split(/\s+/);
      directives.push({
        name: parts[0] ?? "",
        args: parts.slice(1),
        line: i + 1,
      });
    }

    i++;
  }

  return { directives, blocks };
}

function extractServers(blocks: NginxBlock[]): NginxServerBlock[] {
  const servers: NginxServerBlock[] = [];

  for (const block of blocks) {
    if (block.type === "http") {
      servers.push(...extractServers(block.blocks));
    }

    if (block.type === "server") {
      const server: NginxServerBlock = {
        listen: [],
        serverName: [],
        locations: [],
        ssl: false,
      };

      for (const d of block.directives) {
        switch (d.name) {
          case "listen":
            server.listen.push(d.args.join(" "));
            if (d.args.some((a) => a === "ssl")) server.ssl = true;
            break;
          case "server_name":
            server.serverName.push(...d.args);
            break;
          case "root":
            server.root = d.args[0];
            break;
          case "index":
            server.index = d.args.join(" ");
            break;
          case "ssl_certificate":
            server.sslCertificate = d.args[0];
            server.ssl = true;
            break;
          case "ssl_certificate_key":
            server.sslCertificateKey = d.args[0];
            break;
        }
      }

      for (const loc of block.blocks.filter((b) => b.type === "location")) {
        const location: NginxServerBlock["locations"][0] = {
          path: loc.args.join(" "),
          directives: loc.directives,
        };
        for (const d of loc.directives) {
          if (d.name === "proxy_pass") location.proxyPass = d.args[0];
          if (d.name === "root") location.root = d.args[0];
          if (d.name === "try_files") location.tryFiles = d.args.join(" ");
        }
        server.locations.push(location);
      }

      servers.push(server);
    }
  }

  return servers;
}

/**
 * Format an nginx config summary for display.
 */
export function formatNginxSummary(config: NginxConfig): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m" };
  const lines: string[] = [];

  lines.push(`${c.bold}Nginx Config Summary${c.reset}`);
  lines.push(`  ${config.servers.length} server block(s)\n`);

  for (const server of config.servers) {
    const names = server.serverName.join(", ") || "(default)";
    const listen = server.listen.join(", ");
    const sslLabel = server.ssl ? ` ${c.green}[SSL]${c.reset}` : "";

    lines.push(`  ${c.cyan}server${c.reset} ${c.bold}${names}${c.reset}${sslLabel}`);
    lines.push(`    listen: ${listen}`);
    if (server.root) lines.push(`    root: ${server.root}`);

    for (const loc of server.locations) {
      const proxy = loc.proxyPass ? ` → ${c.yellow}${loc.proxyPass}${c.reset}` : "";
      lines.push(`    ${c.dim}location${c.reset} ${loc.path}${proxy}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
