import { describe, it, expect } from "vitest";
import { parseLogLine, analyzeLogs, formatLogAnalysis } from "../../../src/utils/openclawLogParser.js";

describe("parseLogLine", () => {
  it("parses a valid JSON log line", () => {
    const line = '{"type":"log","time":"2026-04-04T16:18:09.199-07:00","level":"info","subsystem":"gateway","message":"gateway started"}';
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("log");
    expect(entry!.level).toBe("info");
    expect(entry!.subsystem).toBe("gateway");
    expect(entry!.message).toBe("gateway started");
  });

  it("parses meta line", () => {
    const line = '{"type":"meta","file":"/tmp/openclaw/log.log","cursor":1000,"size":1000}';
    const entry = parseLogLine(line);
    expect(entry).not.toBeNull();
    expect(entry!.type).toBe("meta");
  });

  it("returns null for invalid JSON", () => {
    expect(parseLogLine("not json")).toBeNull();
    expect(parseLogLine("")).toBeNull();
  });
});

describe("analyzeLogs", () => {
  const sampleLogs = [
    '{"type":"log","time":"2026-04-04T16:18:09.000-07:00","level":"info","message":"listening on ws://127.0.0.1:18789"}',
    '{"type":"log","time":"2026-04-04T16:18:10.000-07:00","level":"info","message":"agent model: openai-codex/gpt-5.4"}',
    '{"type":"log","time":"2026-04-04T16:18:11.000-07:00","level":"info","subsystem":"gateway/channels/discord","message":"starting provider (@NTBot-2445)"}',
    '{"type":"log","time":"2026-04-04T16:18:12.000-07:00","level":"info","subsystem":"gateway/channels/discord","message":"discord client initialized as 123 (NTBot-2445); awaiting gateway readiness"}',
    '{"type":"log","time":"2026-04-04T16:18:20.000-07:00","level":"info","message":"⇄ res ✓ health 47ms conn=abc id=def"}',
  ].join("\n");

  it("detects gateway started and listening", () => {
    const analysis = analyzeLogs(sampleLogs);
    expect(analysis.gateway.started).toBe(true);
    expect(analysis.gateway.listening).toBe(true);
    expect(analysis.gateway.port).toBe(18789);
  });

  it("detects agent model", () => {
    const analysis = analyzeLogs(sampleLogs);
    expect(analysis.gateway.model).toBe("openai-codex/gpt-5.4");
  });

  it("detects Discord bot name", () => {
    const analysis = analyzeLogs(sampleLogs);
    expect(analysis.discord.botName).toBe("NTBot-2445");
  });

  it("counts total entries", () => {
    const analysis = analyzeLogs(sampleLogs);
    expect(analysis.totalEntries).toBe(5);
  });

  it("extracts time range", () => {
    const analysis = analyzeLogs(sampleLogs);
    expect(analysis.timeRange).not.toBeNull();
    expect(analysis.timeRange!.start).toContain("16:18:09");
    expect(analysis.timeRange!.end).toContain("16:18:20");
  });

  it("detects successful requests", () => {
    const analysis = analyzeLogs(sampleLogs);
    const successEvents = analysis.events.filter(e => e.type === "request.success");
    expect(successEvents.length).toBeGreaterThan(0);
  });

  it("detects rate limiting", () => {
    const rateLimitLog = '{"type":"log","time":"2026-04-04T16:18:30.000-07:00","level":"warn","message":"rate limited by discord status=429"}';
    const analysis = analyzeLogs(rateLimitLog);
    expect(analysis.discord.rateLimited).toBe(true);
  });

  it("detects error 4014", () => {
    const error4014Log = '{"type":"log","time":"2026-04-04T16:18:30.000-07:00","level":"error","message":"discord error code 4014 privileged intents"}';
    const analysis = analyzeLogs(error4014Log);
    expect(analysis.discord.error4014).toBe(true);
  });

  it("detects token refresh failure", () => {
    const refreshLog = '{"type":"log","time":"2026-04-04T16:18:30.000-07:00","level":"error","message":"Token refresh failed: 401 refresh_token_reused"}';
    const analysis = analyzeLogs(refreshLog);
    expect(analysis.auth.refreshFailed).toBe(true);
  });

  it("returns empty analysis for empty input", () => {
    const analysis = analyzeLogs("");
    expect(analysis.totalEntries).toBe(0);
    expect(analysis.timeRange).toBeNull();
  });
});

describe("formatLogAnalysis", () => {
  it("returns a formatted string", () => {
    const analysis = analyzeLogs("");
    const formatted = formatLogAnalysis(analysis);
    expect(formatted).toContain("Log Analysis");
    expect(typeof formatted).toBe("string");
  });

  it("shows gateway status", () => {
    const log = '{"type":"log","time":"T","level":"info","message":"listening on ws://127.0.0.1:18789"}';
    const formatted = formatLogAnalysis(analyzeLogs(log));
    expect(formatted).toContain("running");
  });

  it("shows 'no errors' for clean logs", () => {
    const log = '{"type":"log","time":"T","level":"info","message":"all good"}';
    const formatted = formatLogAnalysis(analyzeLogs(log));
    expect(formatted).toContain("No errors");
  });
});
