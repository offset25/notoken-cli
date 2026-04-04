#!/usr/bin/env node
/**
 * NoToken Service — runs the CLI as a background service/daemon.
 *
 * Usage:
 *   node service.js start          — start the service
 *   node service.js stop           — stop the service
 *   node service.js status         — check if running
 *   node service.js restart        — restart
 *   node service.js install        — install as systemd service
 *   node service.js uninstall      — remove systemd service
 *
 * The service:
 *   - Listens on a Unix socket or TCP port for commands
 *   - Executes notoken intents and returns results
 *   - Runs background monitors (Discord, OpenClaw health)
 *   - Provides a REST API for the desktop app
 *   - Logs to ~/.notoken/logs/service.log
 */

import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { parseIntent, executeIntent } from "notoken-core";

const NOTOKEN_HOME = resolve(homedir(), ".notoken");
const LOG_DIR = resolve(NOTOKEN_HOME, "logs");
const PID_FILE = resolve(NOTOKEN_HOME, "service.pid");
const PORT = parseInt(process.env.NOTOKEN_PORT ?? "18800");

// Ensure directories
if (!existsSync(LOG_DIR)) mkdirSync(LOG_DIR, { recursive: true });

function log(msg: string): void {
  const ts = new Date().toISOString();
  const line = `${ts} ${msg}\n`;
  process.stdout.write(line);
  try {
    const { appendFileSync } = require("node:fs") as typeof import("node:fs");
    appendFileSync(resolve(LOG_DIR, "service.log"), line);
  } catch {}
}

// ─── HTTP API Server ────────────────────────────────────────────────────────

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);
  const path = url.pathname;

  // CORS headers for desktop app
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") { res.writeHead(200); res.end(); return; }

  // Health check
  if (path === "/health") {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ ok: true, version: "1.7.0", uptime: process.uptime() }));
    return;
  }

  // Parse and execute a command
  if (path === "/api/run" && req.method === "POST") {
    try {
      const body = await readBody(req);
      const { command, dryRun } = JSON.parse(body);
      if (!command) { res.writeHead(400); res.end(JSON.stringify({ error: "missing 'command'" })); return; }

      log(`API: ${command}`);
      const parsed = await parseIntent(command);

      if (dryRun) {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ intent: parsed.intent, dryRun: true }));
        return;
      }

      if (parsed.intent.intent === "unknown") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ intent: parsed.intent, error: "unknown intent" }));
        return;
      }

      const result = await executeIntent(parsed.intent);
      res.writeHead(200, { "Content-Type": "application/json" });
      // Strip ANSI codes for API response
      const clean = result.replace(/\x1b\[[0-9;]*m/g, "");
      res.end(JSON.stringify({ intent: parsed.intent, result: clean }));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Parse only (no execution)
  if (path === "/api/parse" && (req.method === "POST" || req.method === "GET")) {
    try {
      let command: string;
      if (req.method === "GET") {
        command = url.searchParams.get("q") ?? "";
      } else {
        const body = await readBody(req);
        command = JSON.parse(body).command ?? "";
      }
      if (!command) { res.writeHead(400); res.end(JSON.stringify({ error: "missing command" })); return; }

      const parsed = await parseIntent(command);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(parsed));
    } catch (err) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: (err as Error).message }));
    }
    return;
  }

  // Status
  if (path === "/api/status") {
    const uptime = process.uptime();
    const memory = process.memoryUsage();
    res.writeHead(200, { "Content-Type": "application/json" });
    res.end(JSON.stringify({
      ok: true,
      version: "1.7.0",
      uptime: Math.round(uptime),
      memory: { rss: Math.round(memory.rss / 1024 / 1024), heap: Math.round(memory.heapUsed / 1024 / 1024) },
      pid: process.pid,
      port: PORT,
    }));
    return;
  }

  // 404
  res.writeHead(404, { "Content-Type": "application/json" });
  res.end(JSON.stringify({
    error: "not found",
    endpoints: [
      "GET  /health",
      "POST /api/run    { command, dryRun? }",
      "POST /api/parse  { command }",
      "GET  /api/parse?q=...",
      "GET  /api/status",
    ],
  }));
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

// ─── Service lifecycle ──────────────────────────────────────────────────────

function writePid(): void {
  writeFileSync(PID_FILE, String(process.pid));
}

function clearPid(): void {
  try { unlinkSync(PID_FILE); } catch {}
}

function getRunningPid(): number | null {
  try {
    const pid = parseInt(readFileSync(PID_FILE, "utf-8").trim());
    // Check if process is still alive
    process.kill(pid, 0);
    return pid;
  } catch {
    return null;
  }
}

function startService(): void {
  const existing = getRunningPid();
  if (existing) {
    console.log(`NoToken service already running (PID ${existing})`);
    return;
  }

  const server = createServer(handleRequest);
  server.listen(PORT, "127.0.0.1", () => {
    writePid();
    log(`NoToken service started on http://127.0.0.1:${PORT} (PID ${process.pid})`);
    console.log(`\x1b[32m✓\x1b[0m NoToken service started on port ${PORT}`);
    console.log(`  PID: ${process.pid}`);
    console.log(`  API: http://127.0.0.1:${PORT}/api/run`);
    console.log(`  Health: http://127.0.0.1:${PORT}/health`);
  });

  // Graceful shutdown
  process.on("SIGTERM", () => { log("SIGTERM received"); clearPid(); process.exit(0); });
  process.on("SIGINT", () => { log("SIGINT received"); clearPid(); process.exit(0); });
  process.on("exit", clearPid);
}

function stopService(): void {
  const pid = getRunningPid();
  if (!pid) {
    console.log("NoToken service is not running.");
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
    clearPid();
    console.log(`\x1b[32m✓\x1b[0m NoToken service stopped (PID ${pid})`);
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Failed to stop: ${(err as Error).message}`);
  }
}

function showStatus(): void {
  const pid = getRunningPid();
  if (pid) {
    console.log(`\x1b[32m✓\x1b[0m NoToken service running (PID ${pid}, port ${PORT})`);
    // Check health
    try {
      const resp = execSync(`curl -sf http://127.0.0.1:${PORT}/health 2>/dev/null`, { encoding: "utf-8", timeout: 3000 });
      const data = JSON.parse(resp);
      console.log(`  Uptime: ${Math.round(data.uptime)}s`);
    } catch {
      console.log(`  \x1b[33m⚠\x1b[0m Health check failed — service may be unresponsive`);
    }
  } else {
    console.log(`\x1b[2m○\x1b[0m NoToken service is not running.`);
    console.log(`  Start: notoken service start`);
  }
}

function installSystemd(): void {
  const nodePath = process.execPath;
  const servicePath = resolve(__dirname, "service.js");
  const unit = `[Unit]
Description=NoToken CLI Service
After=network.target

[Service]
Type=simple
ExecStart=${nodePath} ${servicePath} start
Restart=on-failure
RestartSec=5
Environment=NODE_ENV=production
Environment=NOTOKEN_PORT=${PORT}
WorkingDirectory=${homedir()}
User=${process.env.USER ?? "root"}

[Install]
WantedBy=multi-user.target
`;

  const unitPath = "/etc/systemd/system/notoken.service";
  try {
    writeFileSync(unitPath, unit);
    execSync("systemctl daemon-reload", { stdio: "pipe" });
    execSync("systemctl enable notoken", { stdio: "pipe" });
    console.log(`\x1b[32m✓\x1b[0m NoToken service installed at ${unitPath}`);
    console.log(`  Start: sudo systemctl start notoken`);
    console.log(`  Status: sudo systemctl status notoken`);
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Failed to install: ${(err as Error).message}`);
    console.error(`  Try with sudo: sudo node ${servicePath} install`);
  }
}

function uninstallSystemd(): void {
  try {
    execSync("systemctl stop notoken 2>/dev/null", { stdio: "pipe" });
    execSync("systemctl disable notoken 2>/dev/null", { stdio: "pipe" });
    unlinkSync("/etc/systemd/system/notoken.service");
    execSync("systemctl daemon-reload", { stdio: "pipe" });
    console.log(`\x1b[32m✓\x1b[0m NoToken service uninstalled.`);
  } catch (err) {
    console.error(`\x1b[31m✗\x1b[0m Failed: ${(err as Error).message}`);
  }
}

// ─── CLI ────────────────────────────────────────────────────────────────────

const command = process.argv[2];

switch (command) {
  case "start": startService(); break;
  case "stop": stopService(); break;
  case "status": showStatus(); break;
  case "restart": stopService(); setTimeout(startService, 1000); break;
  case "install": installSystemd(); break;
  case "uninstall": uninstallSystemd(); break;
  default:
    console.log(`NoToken Service

Usage:
  notoken service start       Start the service daemon
  notoken service stop        Stop the service
  notoken service status      Check if running
  notoken service restart     Restart the service
  notoken service install     Install as systemd service
  notoken service uninstall   Remove systemd service

API Endpoints (port ${PORT}):
  GET  /health                Health check
  POST /api/run               Execute a command { command: "restart nginx" }
  POST /api/parse             Parse without executing { command: "restart nginx" }
  GET  /api/parse?q=...       Parse via query string
  GET  /api/status            Service status and metrics`);
}
