/**
 * Apache config parser.
 *
 * Parses httpd.conf / apache2.conf and vhost configs.
 * Handles: <VirtualHost>, <Directory>, <Location>, directives.
 */

export interface ApacheDirective {
  name: string;
  value: string;
  line: number;
}

export interface ApacheBlock {
  tag: string;
  args: string;
  directives: ApacheDirective[];
  blocks: ApacheBlock[];
  line: number;
}

export interface ApacheConfig {
  directives: ApacheDirective[];
  blocks: ApacheBlock[];
  vhosts: ApacheVHost[];
}

export interface ApacheVHost {
  address: string;
  serverName?: string;
  serverAlias: string[];
  documentRoot?: string;
  errorLog?: string;
  customLog?: string;
  ssl: boolean;
  sslCertificate?: string;
  sslCertificateKey?: string;
  locations: Array<{ path: string; directives: ApacheDirective[] }>;
  directories: Array<{ path: string; directives: ApacheDirective[] }>;
}

/**
 * Parse Apache config content.
 */
export function parseApache(content: string): ApacheConfig {
  const lines = content.split("\n");
  const { directives, blocks } = parseApacheBlock(lines, 0, lines.length);
  const vhosts = extractVHosts(blocks);

  return { directives, blocks, vhosts };
}

function parseApacheBlock(
  lines: string[],
  start: number,
  end: number
): { directives: ApacheDirective[]; blocks: ApacheBlock[] } {
  const directives: ApacheDirective[] = [];
  const blocks: ApacheBlock[] = [];
  let i = start;

  while (i < end) {
    const line = lines[i].trim();

    if (!line || line.startsWith("#")) {
      i++;
      continue;
    }

    // Block opening: <VirtualHost *:80>, <Directory /var/www>
    const openMatch = line.match(/^<(\w+)\s*(.*?)>$/);
    if (openMatch) {
      const tag = openMatch[1];
      const args = openMatch[2] ?? "";
      const closeTag = `</${tag}>`;

      // Find matching closing tag
      let j = i + 1;
      let depth = 1;
      while (j < end && depth > 0) {
        const l = lines[j].trim();
        if (l.match(new RegExp(`^<${tag}\\b`))) depth++;
        if (l === closeTag || l.toLowerCase() === closeTag.toLowerCase()) depth--;
        if (depth > 0) j++;
      }

      const inner = parseApacheBlock(lines, i + 1, j);
      blocks.push({
        tag,
        args,
        directives: inner.directives,
        blocks: inner.blocks,
        line: i + 1,
      });

      i = j + 1;
      continue;
    }

    // Closing tag (handled by the block parser above)
    if (line.startsWith("</")) {
      i++;
      continue;
    }

    // Directive: ServerName example.com
    const parts = line.match(/^(\S+)\s+(.*)/);
    if (parts) {
      directives.push({ name: parts[1], value: parts[2], line: i + 1 });
    } else {
      directives.push({ name: line, value: "", line: i + 1 });
    }

    i++;
  }

  return { directives, blocks };
}

function extractVHosts(blocks: ApacheBlock[]): ApacheVHost[] {
  return blocks
    .filter((b) => b.tag.toLowerCase() === "virtualhost")
    .map((block) => {
      const vhost: ApacheVHost = {
        address: block.args,
        serverAlias: [],
        ssl: false,
        locations: [],
        directories: [],
      };

      for (const d of block.directives) {
        switch (d.name.toLowerCase()) {
          case "servername":
            vhost.serverName = d.value;
            break;
          case "serveralias":
            vhost.serverAlias.push(...d.value.split(/\s+/));
            break;
          case "documentroot":
            vhost.documentRoot = d.value;
            break;
          case "errorlog":
            vhost.errorLog = d.value;
            break;
          case "customlog":
            vhost.customLog = d.value.split(/\s+/)[0];
            break;
          case "sslengine":
            vhost.ssl = d.value.toLowerCase() === "on";
            break;
          case "sslcertificatefile":
            vhost.sslCertificate = d.value;
            vhost.ssl = true;
            break;
          case "sslcertificatekeyfile":
            vhost.sslCertificateKey = d.value;
            break;
        }
      }

      for (const sub of block.blocks) {
        const tag = sub.tag.toLowerCase();
        if (tag === "location") {
          vhost.locations.push({ path: sub.args, directives: sub.directives });
        }
        if (tag === "directory") {
          vhost.directories.push({ path: sub.args, directives: sub.directives });
        }
      }

      return vhost;
    });
}

/**
 * Format an Apache config summary for display.
 */
export function formatApacheSummary(config: ApacheConfig): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m", yellow: "\x1b[33m" };
  const lines: string[] = [];

  lines.push(`${c.bold}Apache Config Summary${c.reset}`);
  lines.push(`  ${config.vhosts.length} VirtualHost(s)\n`);

  for (const vh of config.vhosts) {
    const sslLabel = vh.ssl ? ` ${c.green}[SSL]${c.reset}` : "";
    lines.push(`  ${c.cyan}<VirtualHost ${vh.address}>${c.reset}${sslLabel}`);
    if (vh.serverName) lines.push(`    ServerName: ${c.bold}${vh.serverName}${c.reset}`);
    if (vh.serverAlias.length) lines.push(`    ServerAlias: ${vh.serverAlias.join(", ")}`);
    if (vh.documentRoot) lines.push(`    DocumentRoot: ${vh.documentRoot}`);
    if (vh.errorLog) lines.push(`    ErrorLog: ${vh.errorLog}`);

    for (const loc of vh.locations) {
      lines.push(`    ${c.dim}<Location ${loc.path}>${c.reset}`);
    }
    for (const dir of vh.directories) {
      lines.push(`    ${c.dim}<Directory ${dir.path}>${c.reset}`);
    }
    lines.push("");
  }

  return lines.join("\n");
}
