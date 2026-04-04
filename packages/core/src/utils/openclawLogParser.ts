/**
 * OpenClaw Log Parser — understand what's happening from openclaw logs.
 *
 * Parses JSON log lines from `openclaw logs --json` and extracts
 * meaningful events for diagnostics, monitoring, and troubleshooting.
 */

export interface LogEntry {
  type: "log" | "meta";
  time: string;
  level: "info" | "warn" | "error" | "debug";
  subsystem?: string;
  message: string;
}

export interface LogAnalysis {
  /** Total log entries analyzed */
  totalEntries: number;
  /** Time range of logs */
  timeRange: { start: string; end: string } | null;
  /** Key events extracted */
  events: Array<{ time: string; type: string; message: string; severity: "info" | "warn" | "error" }>;
  /** Discord connection status */
  discord: { connected: boolean; botName: string | null; lastEvent: string | null; rateLimited: boolean; error4014: boolean };
  /** Gateway health */
  gateway: { started: boolean; listening: boolean; port: number | null; model: string | null };
  /** Auth issues */
  auth: { errors: string[]; refreshFailed: boolean; tokenExpired: boolean };
  /** Errors and warnings */
  errors: string[];
  warnings: string[];
}

/**
 * Parse a single JSON log line.
 */
export function parseLogLine(line: string): LogEntry | null {
  try {
    const parsed = JSON.parse(line);
    if (parsed.type === "meta") return { type: "meta", time: "", level: "info", message: `Log file: ${parsed.file}` };
    return {
      type: "log",
      time: parsed.time ?? "",
      level: (parsed.level ?? "info") as LogEntry["level"],
      subsystem: parsed.subsystem,
      message: parsed.message ?? "",
    };
  } catch {
    return null;
  }
}

/**
 * Analyze a batch of log lines and extract meaningful events.
 */
export function analyzeLogs(logText: string): LogAnalysis {
  const lines = logText.split("\n").filter(l => l.trim());
  const entries = lines.map(parseLogLine).filter((e): e is LogEntry => e !== null && e.type === "log");

  const result: LogAnalysis = {
    totalEntries: entries.length,
    timeRange: null,
    events: [],
    discord: { connected: false, botName: null, lastEvent: null, rateLimited: false, error4014: false },
    gateway: { started: false, listening: false, port: null, model: null },
    auth: { errors: [], refreshFailed: false, tokenExpired: false },
    errors: [],
    warnings: [],
  };

  if (entries.length > 0) {
    result.timeRange = { start: entries[0].time, end: entries[entries.length - 1].time };
  }

  for (const entry of entries) {
    const msg = entry.message;

    // Gateway events
    if (msg.includes("listening on")) {
      result.gateway.started = true;
      result.gateway.listening = true;
      const portMatch = msg.match(/:(\d+)/);
      if (portMatch) result.gateway.port = parseInt(portMatch[1]);
      result.events.push({ time: entry.time, type: "gateway.start", message: "Gateway started", severity: "info" });
    }
    if (msg.includes("agent model:")) {
      const modelMatch = msg.match(/agent model:\s*(\S+)/);
      if (modelMatch) result.gateway.model = modelMatch[1];
    }

    // Discord events
    if (msg.includes("logged in to discord") || msg.includes("discord client ready")) {
      result.discord.connected = true;
      result.discord.lastEvent = "connected";
      result.events.push({ time: entry.time, type: "discord.connected", message: "Discord bot connected", severity: "info" });
    }
    if (msg.includes("awaiting gateway readiness")) {
      result.discord.lastEvent = "awaiting";
      const botMatch = msg.match(/\((\S+)\)/);
      if (botMatch) result.discord.botName = botMatch[1];
    }
    if (msg.includes("starting provider")) {
      const botMatch = msg.match(/@(\S+)\)/);
      if (botMatch) result.discord.botName = botMatch[1];
    }
    if (msg.includes("rate limit") || msg.includes("status=429")) {
      result.discord.rateLimited = true;
      result.discord.lastEvent = "rate_limited";
      result.events.push({ time: entry.time, type: "discord.rate_limited", message: "Discord rate limited", severity: "warn" });
    }
    if (msg.includes("4014")) {
      result.discord.error4014 = true;
      result.events.push({ time: entry.time, type: "discord.error_4014", message: "Discord privileged intents error", severity: "error" });
    }

    // Auth events
    if (msg.includes("Token refresh failed") || msg.includes("refresh_token_reused")) {
      result.auth.refreshFailed = true;
      result.auth.errors.push(msg.substring(0, 100));
      result.events.push({ time: entry.time, type: "auth.refresh_failed", message: "Token refresh failed", severity: "error" });
    }
    if (msg.includes("unauthorized") || msg.includes("token missing") || msg.includes("token expired")) {
      result.auth.tokenExpired = true;
      result.auth.errors.push(msg.substring(0, 100));
    }

    // Model events
    if (msg.includes("warmup failed")) {
      result.events.push({ time: entry.time, type: "model.warmup_failed", message: msg.substring(0, 100), severity: "error" });
    }
    if (msg.includes("model fallback")) {
      result.events.push({ time: entry.time, type: "model.fallback", message: msg.substring(0, 100), severity: "warn" });
    }

    // Agent events
    if (msg.includes("lane task error")) {
      result.events.push({ time: entry.time, type: "agent.error", message: msg.substring(0, 100), severity: "error" });
    }
    if (msg.includes("⇄ res ✓")) {
      // Successful request
      const durMatch = msg.match(/(\d+ms)/);
      result.events.push({ time: entry.time, type: "request.success", message: `Request OK${durMatch ? ` (${durMatch[1]})` : ""}`, severity: "info" });
    }
    if (msg.includes("⇄ res ✗")) {
      result.events.push({ time: entry.time, type: "request.error", message: msg.substring(0, 100), severity: "error" });
    }

    // Collect errors and warnings
    if (entry.level === "error") result.errors.push(msg.substring(0, 120));
    if (entry.level === "warn") result.warnings.push(msg.substring(0, 120));
  }

  return result;
}

/**
 * Format log analysis for display.
 */
export function formatLogAnalysis(analysis: LogAnalysis): string {
  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
  const lines: string[] = [];

  lines.push(`\n${c.bold}${c.cyan}── OpenClaw Log Analysis ──${c.reset}\n`);
  lines.push(`  ${c.dim}${analysis.totalEntries} log entries${analysis.timeRange ? ` (${analysis.timeRange.start} → ${analysis.timeRange.end})` : ""}${c.reset}`);

  // Gateway
  lines.push(`\n  ${c.bold}Gateway:${c.reset} ${analysis.gateway.listening ? `${c.green}✓ running${c.reset}` : `${c.red}✗ not running${c.reset}`}${analysis.gateway.model ? ` | model: ${analysis.gateway.model}` : ""}`);

  // Discord
  if (analysis.discord.botName) {
    const discordStatus = analysis.discord.connected ? `${c.green}✓ connected` :
      analysis.discord.rateLimited ? `${c.yellow}⏳ rate limited` :
      analysis.discord.error4014 ? `${c.red}✗ intents error (4014)` :
      `${c.yellow}⏳ ${analysis.discord.lastEvent ?? "connecting"}`;
    lines.push(`  ${c.bold}Discord:${c.reset} ${discordStatus}${c.reset} (@${analysis.discord.botName})`);
  }

  // Auth
  if (analysis.auth.errors.length > 0) {
    lines.push(`\n  ${c.bold}Auth Issues:${c.reset}`);
    for (const err of analysis.auth.errors.slice(0, 3)) {
      lines.push(`    ${c.red}✗${c.reset} ${err}`);
    }
  }

  // Key events
  const keyEvents = analysis.events.filter(e => e.severity !== "info").slice(-10);
  if (keyEvents.length > 0) {
    lines.push(`\n  ${c.bold}Recent Issues:${c.reset}`);
    for (const event of keyEvents) {
      const icon = event.severity === "error" ? `${c.red}✗` : `${c.yellow}⚠`;
      const time = event.time.split("T")[1]?.split(".")[0] ?? "";
      lines.push(`    ${icon}${c.reset} ${c.dim}${time}${c.reset} ${event.message}`);
    }
  }

  // Summary
  if (analysis.errors.length === 0 && analysis.warnings.length === 0) {
    lines.push(`\n  ${c.green}✓ No errors or warnings in recent logs.${c.reset}`);
  } else {
    lines.push(`\n  ${c.dim}${analysis.errors.length} error(s), ${analysis.warnings.length} warning(s)${c.reset}`);
  }

  return lines.join("\n");
}
