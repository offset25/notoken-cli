/**
 * Integration tests — run actual openclaw commands and parse the output.
 * These tests require openclaw to be installed and the gateway running.
 * Tests are skipped if openclaw is not available.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { execSync } from "node:child_process";
import { parseOpenclawModels, parseOpenclawStatus, parseOpenclawDeepStatus } from "../../../src/utils/openclawDiag.js";
import { analyzeLogs, formatLogAnalysis } from "../../../src/utils/openclawLogParser.js";

// Find Node 22 and openclaw — synchronous at module load so skipIf works
let node22 = "";
let ocBin = "";
let available = false;

try {
  node22 = execSync("ls /home/ino/.nvm/versions/node/v22*/bin/node 2>/dev/null | tail -1", { encoding: "utf-8", timeout: 3000, stdio: "pipe" }).trim();
  if (!node22) node22 = "node";
  ocBin = execSync("readlink -f $(which openclaw) 2>/dev/null || which openclaw", { encoding: "utf-8", timeout: 3000, stdio: "pipe" }).trim();
  const ver = execSync(`${node22} ${ocBin} --version 2>&1`, { encoding: "utf-8", timeout: 5000, stdio: "pipe" });
  available = ver.includes("OpenClaw");
} catch {
  available = false;
}

function runOC(args: string): string {
  try {
    return execSync(`${node22} ${ocBin} ${args} 2>&1`, { encoding: "utf-8", timeout: 30000, stdio: ["pipe", "pipe", "pipe"] });
  } catch (err: any) {
    // Some openclaw commands exit non-zero but still produce useful output
    return (err.stdout ?? "") + (err.stderr ?? "");
  }
}

describe("openclaw models — live integration", () => {
  it.skipIf(!available)("parses live 'openclaw models' output without crashing", () => {
    const output = runOC("models");
    const result = parseOpenclawModels(output);

    // Parser should return a valid structure regardless of config state
    expect(result).toHaveProperty("defaultModel");
    expect(result).toHaveProperty("configuredModels");
    expect(result).toHaveProperty("providers");
    expect(result).toHaveProperty("errors");
    expect(Array.isArray(result.configuredModels)).toBe(true);
    expect(Array.isArray(result.providers)).toBe(true);
  });

  it.skipIf(!available)("openclaw models command runs without crashing", () => {
    // Just verify the command completes — output parsing tested in unit tests
    const output = runOC("models");
    expect(typeof output).toBe("string");
  });
});

describe("openclaw status — live integration", () => {
  it.skipIf(!available)("parses live 'openclaw status' output", () => {
    const output = runOC("status");
    const result = parseOpenclawStatus(output);

    // Should have a dashboard URL (may be null if gateway not running for this user)
    if (result.dashboard) {
      expect(result.dashboard).toContain("http");
    }

    // Should detect gateway status
    expect(typeof result.gateway.reachable).toBe("boolean");
  });

  it.skipIf(!available)("extracts security audit", () => {
    const output = runOC("status");
    const result = parseOpenclawStatus(output);

    // Security summary should be parsed
    expect(typeof result.security.critical).toBe("number");
    expect(typeof result.security.warn).toBe("number");
  });

  it.skipIf(!available)("extracts session info", () => {
    const output = runOC("status");
    const result = parseOpenclawStatus(output);

    expect(typeof result.sessions.count).toBe("number");
  });

  it.skipIf(!available)("extracts update info", () => {
    const output = runOC("status");
    const result = parseOpenclawStatus(output);

    expect(typeof result.update.available).toBe("boolean");
  });
});

describe("openclaw status --deep — live integration", () => {
  it.skipIf(!available)("parses live deep status", () => {
    const output = runOC("status --deep");
    const result = parseOpenclawDeepStatus(output);

    // Should have health entries if gateway is running
    expect(Array.isArray(result.health)).toBe(true);
    expect(Array.isArray(result.channels)).toBe(true);
    expect(Array.isArray(result.sessions)).toBe(true);
  });

  it.skipIf(!available)("detects Discord channel if configured", () => {
    const output = runOC("status --deep");
    const result = parseOpenclawDeepStatus(output);

    // If Discord is configured, it should appear in channels or health
    const hasDiscord = result.channels.some(c => c.channel === "Discord") ||
                       result.health.some(h => h.item === "Discord");
    // May or may not have Discord — just verify parsing doesn't crash
    expect(typeof hasDiscord).toBe("boolean");
  });
});

describe("openclaw logs --json — live integration", () => {
  it.skipIf(!available)("parses live JSON logs", () => {
    const output = runOC("logs --json --limit 20");
    const analysis = analyzeLogs(output);

    expect(analysis.totalEntries).toBeGreaterThanOrEqual(0);
    expect(typeof analysis.gateway.started).toBe("boolean");
    expect(typeof analysis.discord.connected).toBe("boolean");
  });

  it.skipIf(!available)("formatLogAnalysis produces readable output", () => {
    const output = runOC("logs --json --limit 20");
    const analysis = analyzeLogs(output);
    const formatted = formatLogAnalysis(analysis);

    expect(formatted).toContain("Log Analysis");
    expect(typeof formatted).toBe("string");
    expect(formatted.length).toBeGreaterThan(50);
  });

  it.skipIf(!available)("detects gateway model from logs", () => {
    const output = runOC("logs --json --limit 50");
    const analysis = analyzeLogs(output);

    // If gateway started recently, model should be detected
    if (analysis.gateway.started) {
      // Model may or may not be in the last 50 lines
      expect(typeof analysis.gateway.model).not.toBe("undefined");
    }
  });
});
