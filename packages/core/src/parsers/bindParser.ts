/**
 * BIND zone file parser.
 *
 * Parses DNS zone files and extracts:
 * - SOA record (primary NS, admin, serial, timers)
 * - A, AAAA, CNAME, MX, NS, TXT, SRV, PTR records
 * - $TTL, $ORIGIN directives
 */

export interface DnsRecord {
  name: string;
  ttl?: number;
  class: string;
  type: string;
  data: string;
  priority?: number;
  line: number;
}

export interface SoaRecord {
  primaryNS: string;
  adminEmail: string;
  serial: number;
  refresh: number;
  retry: number;
  expire: number;
  minimum: number;
}

export interface ZoneFile {
  origin?: string;
  defaultTTL?: number;
  soa?: SoaRecord;
  records: DnsRecord[];
}

/**
 * Parse a BIND zone file.
 */
export function parseZoneFile(content: string): ZoneFile {
  const lines = content.split("\n");
  const zone: ZoneFile = { records: [] };

  let currentName = "@";
  let inSOA = false;
  let soaBuffer = "";

  for (let i = 0; i < lines.length; i++) {
    let line = lines[i];

    // Strip comments
    const commentIdx = line.indexOf(";");
    if (commentIdx !== -1) line = line.slice(0, commentIdx);
    line = line.trimEnd();

    if (!line.trim()) continue;

    // $ORIGIN directive
    const originMatch = line.match(/^\$ORIGIN\s+(\S+)/i);
    if (originMatch) {
      zone.origin = originMatch[1];
      continue;
    }

    // $TTL directive
    const ttlMatch = line.match(/^\$TTL\s+(\S+)/i);
    if (ttlMatch) {
      zone.defaultTTL = parseTTL(ttlMatch[1]);
      continue;
    }

    // SOA record (may span multiple lines)
    if (line.toUpperCase().includes("SOA") && !inSOA) {
      inSOA = true;
      soaBuffer = line;
      if (line.includes(")")) {
        zone.soa = parseSOA(soaBuffer) ?? undefined;
        inSOA = false;
        soaBuffer = "";
      }
      continue;
    }

    if (inSOA) {
      soaBuffer += " " + line.trim();
      if (line.includes(")")) {
        zone.soa = parseSOA(soaBuffer) ?? undefined;
        inSOA = false;
        soaBuffer = "";
      }
      continue;
    }

    // Regular records
    const record = parseRecord(line, currentName, i + 1);
    if (record) {
      if (record.name !== "") currentName = record.name;
      else record.name = currentName;
      zone.records.push(record);
    }
  }

  return zone;
}

function parseRecord(line: string, currentName: string, lineNum: number): DnsRecord | null {
  const parts = line.trim().split(/\s+/);
  if (parts.length < 2) return null;

  let idx = 0;
  let name = "";
  let ttl: number | undefined;
  let cls = "IN";
  let type = "";
  let data = "";

  // First token: name or empty (continuation of previous name)
  if (line.match(/^\s/)) {
    name = "";
    idx = 0;
  } else {
    name = parts[0];
    idx = 1;
  }

  // Optional TTL (number)
  if (idx < parts.length && /^\d+[smhdwSMHDW]?$/.test(parts[idx])) {
    ttl = parseTTL(parts[idx]);
    idx++;
  }

  // Optional class (IN, CH, HS)
  if (idx < parts.length && /^(IN|CH|HS)$/i.test(parts[idx])) {
    cls = parts[idx].toUpperCase();
    idx++;
  }

  // Type
  if (idx < parts.length) {
    type = parts[idx].toUpperCase();
    idx++;
  }

  if (!type || type === "SOA") return null;

  // Data (rest of line)
  data = parts.slice(idx).join(" ");

  // Extract priority for MX and SRV
  let priority: number | undefined;
  if ((type === "MX" || type === "SRV") && /^\d+/.test(data)) {
    const pMatch = data.match(/^(\d+)\s+(.*)/);
    if (pMatch) {
      priority = Number(pMatch[1]);
      data = pMatch[2];
    }
  }

  return { name: name || currentName, ttl, class: cls, type, data, priority, line: lineNum };
}

function parseSOA(raw: string): SoaRecord | null {
  // Extract the parenthesized section
  const parts = raw.replace(/[()]/g, " ").split(/\s+/).filter(Boolean);

  // Find SOA keyword position
  const soaIdx = parts.findIndex((p) => p.toUpperCase() === "SOA");
  if (soaIdx === -1) return null;

  const afterSOA = parts.slice(soaIdx + 1);
  if (afterSOA.length < 7) return null;

  return {
    primaryNS: afterSOA[0],
    adminEmail: afterSOA[1],
    serial: Number(afterSOA[2]) || 0,
    refresh: parseTTL(afterSOA[3]),
    retry: parseTTL(afterSOA[4]),
    expire: parseTTL(afterSOA[5]),
    minimum: parseTTL(afterSOA[6]),
  };
}

function parseTTL(value: string): number {
  const num = parseInt(value, 10);
  if (isNaN(num)) return 0;
  const suffix = value.slice(String(num).length).toLowerCase();
  switch (suffix) {
    case "s": return num;
    case "m": return num * 60;
    case "h": return num * 3600;
    case "d": return num * 86400;
    case "w": return num * 604800;
    default: return num;
  }
}

/**
 * Format a zone file summary for display.
 */
export function formatZoneSummary(zone: ZoneFile): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m" };
  const lines: string[] = [];

  lines.push(`${c.bold}DNS Zone File${c.reset}`);
  if (zone.origin) lines.push(`  Origin: ${zone.origin}`);
  if (zone.defaultTTL) lines.push(`  Default TTL: ${zone.defaultTTL}s`);

  if (zone.soa) {
    lines.push(`\n  ${c.cyan}SOA:${c.reset}`);
    lines.push(`    Primary NS: ${zone.soa.primaryNS}`);
    lines.push(`    Admin: ${zone.soa.adminEmail}`);
    lines.push(`    Serial: ${zone.soa.serial}`);
  }

  // Group by type
  const byType = new Map<string, DnsRecord[]>();
  for (const r of zone.records) {
    const list = byType.get(r.type) ?? [];
    list.push(r);
    byType.set(r.type, list);
  }

  for (const [type, records] of byType) {
    lines.push(`\n  ${c.cyan}${type} records (${records.length}):${c.reset}`);
    for (const r of records.slice(0, 20)) {
      const pri = r.priority !== undefined ? ` [pri=${r.priority}]` : "";
      const ttl = r.ttl !== undefined ? ` TTL=${r.ttl}` : "";
      lines.push(`    ${r.name.padEnd(20)} → ${r.data}${pri}${c.dim}${ttl}${c.reset}`);
    }
    if (records.length > 20) lines.push(`    ${c.dim}... and ${records.length - 20} more${c.reset}`);
  }

  return lines.join("\n");
}
