#!/usr/bin/env node

import { execSync, spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const SRC = resolve(ROOT, "src");
const DIST = resolve(ROOT, "dist");
const CONFIG = resolve(ROOT, "config");
const LOGS = resolve(ROOT, "logs");

// ─── Colors ──────────────────────────────────────────────────────────────────

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

function print(msg) { console.log(msg); }
function ok(msg) { print(`${c.green}✓${c.reset} ${msg}`); }
function warn(msg) { print(`${c.yellow}⚠${c.reset} ${msg}`); }
function err(msg) { print(`${c.red}✗${c.reset} ${msg}`); }
function header(msg) { print(`\n${c.bold}${c.cyan}${msg}${c.reset}`); }
function dim(msg) { print(`${c.dim}${msg}${c.reset}`); }

// ─── Commands ────────────────────────────────────────────────────────────────

function ensureDeps() {
  if (!existsSync(resolve(ROOT, "node_modules"))) {
    header("Installing dependencies...");
    execSync("npm install", { cwd: ROOT, stdio: "inherit" });
    ok("Dependencies installed.");
  }
}

function build() {
  ensureDeps();
  header("Building...");
  try {
    execSync("npx tsc", { cwd: ROOT, stdio: "inherit" });
    ok("Build successful. Output in dist/");
    return true;
  } catch {
    err("Build failed.");
    return false;
  }
}

function run(args) {
  ensureDeps();
  const child = spawn("npx", ["tsx", resolve(SRC, "index.ts"), ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  child.on("close", (code) => {
    if (code !== 0) process.exitCode = code;
  });
  return child;
}

function heal(args) {
  ensureDeps();
  const child = spawn("npx", ["tsx", resolve(SRC, "healing", "runHealer.ts"), ...args], {
    cwd: ROOT,
    stdio: "inherit",
  });
  child.on("close", (code) => {
    if (code !== 0) process.exitCode = code;
  });
  return child;
}

function link() {
  ensureDeps();
  if (!build()) return;
  header("Linking globally...");
  try {
    execSync("npm link", { cwd: ROOT, stdio: "inherit" });
    ok("Linked. You can now run: mycli \"restart nginx on prod\"");
  } catch {
    err("Link failed. Try with sudo: sudo node service.js link");
  }
}

function status() {
  header("mycli status");

  // deps
  if (existsSync(resolve(ROOT, "node_modules"))) {
    ok("Dependencies installed");
  } else {
    warn("Dependencies not installed — run: node service.js install");
  }

  // build
  if (existsSync(resolve(DIST, "index.js"))) {
    ok("Built (dist/index.js exists)");
  } else {
    warn("Not built — run: node service.js build");
  }

  // config
  const rulesPath = resolve(CONFIG, "rules.json");
  if (existsSync(rulesPath)) {
    const rules = JSON.parse(readFileSync(rulesPath, "utf-8"));
    ok(`Rules v${rules.version}`);
    dim(`  Environments: ${Object.keys(rules.environmentAliases).join(", ")}`);
    dim(`  Services: ${Object.keys(rules.serviceAliases).join(", ")}`);
  } else {
    warn("No rules.json found");
  }

  // intents
  const intentsPath = resolve(CONFIG, "intents.json");
  if (existsSync(intentsPath)) {
    const config = JSON.parse(readFileSync(intentsPath, "utf-8"));
    const names = config.intents.map((i) => i.name);
    ok(`${names.length} intents registered`);
    dim(`  ${names.join(", ")}`);
  } else {
    warn("No intents.json found");
  }

  // failures
  const failPath = resolve(LOGS, "failures.json");
  if (existsSync(failPath)) {
    const failures = JSON.parse(readFileSync(failPath, "utf-8"));
    if (failures.length > 0) {
      warn(`${failures.length} unresolved failure(s) in logs/failures.json`);
      dim("  Run: node service.js heal");
    } else {
      ok("No failures logged");
    }
  } else {
    ok("No failure log yet");
  }

  // LLM config
  if (process.env.MYCLI_LLM_ENDPOINT) {
    ok(`LLM endpoint: ${process.env.MYCLI_LLM_ENDPOINT}`);
  } else {
    dim("  LLM fallback not configured (set MYCLI_LLM_ENDPOINT)");
  }

  print("");
}

function showFailures() {
  const failPath = resolve(LOGS, "failures.json");
  if (!existsSync(failPath)) {
    ok("No failures logged yet.");
    return;
  }
  const failures = JSON.parse(readFileSync(failPath, "utf-8"));
  if (failures.length === 0) {
    ok("No failures.");
    return;
  }
  header(`${failures.length} logged failure(s):`);
  for (const f of failures) {
    print(`  ${c.dim}${f.timestamp}${c.reset}  "${c.yellow}${f.rawText}${c.reset}"  ${f.error ?? ""}`);
  }
  print(`\nRun ${c.cyan}node service.js heal${c.reset} to propose fixes.`);
}

function clearFailures() {
  const failPath = resolve(LOGS, "failures.json");
  if (existsSync(failPath)) {
    writeFileSync(failPath, "[]");
    ok("Failure log cleared.");
  } else {
    ok("Nothing to clear.");
  }
}

function test(phrases) {
  if (phrases.length === 0) {
    phrases = [
      "restart nginx on prod",
      "bounce redis in production",
      "check disk usage on staging",
      "show memory on prod",
      "tail api logs in staging",
      "deploy main to staging",
      "rollback deploy on prod",
      "show docker containers on dev",
      "something completely unknown",
    ];
  }

  header("Testing parser against phrases:\n");
  ensureDeps();

  for (const phrase of phrases) {
    try {
      const result = execSync(
        `npx tsx ${resolve(SRC, "index.ts")} ${JSON.stringify(phrase)} --dry-run --json`,
        { cwd: ROOT, encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"] }
      );
      const parsed = JSON.parse(result);
      const intent = parsed.intent?.intent ?? "?";
      const conf = parsed.intent?.confidence ?? 0;
      const confPct = (conf * 100).toFixed(0);
      const color = conf >= 0.7 ? c.green : conf >= 0.5 ? c.yellow : c.red;
      print(`  ${color}${confPct.padStart(3)}%${c.reset}  ${intent.padEnd(20)}  "${phrase}"`);
    } catch {
      print(`  ${c.red}FAIL${c.reset}  ${"".padEnd(20)}  "${phrase}"`);
    }
  }
  print("");
}

async function interactive() {
  ensureDeps();
  // Pass through any flags (--auto-heal, etc.)
  const flags = process.argv.slice(2).filter((a) => a.startsWith("--"));
  const child = spawn("npx", ["tsx", resolve(SRC, "index.ts"), ...flags], {
    cwd: ROOT,
    stdio: "inherit",
  });
  await new Promise((res) => child.on("close", res));
}

// ─── CLI ─────────────────────────────────────────────────────────────────────

const [command, ...rest] = process.argv.slice(2);

switch (command) {
  case "build":
    build();
    break;

  case "install":
    header("Installing dependencies...");
    execSync("npm install", { cwd: ROOT, stdio: "inherit" });
    ok("Done.");
    break;

  case "run":
    run(rest);
    break;

  case "link":
    link();
    break;

  case "heal":
    heal(rest);
    break;

  case "status":
    status();
    break;

  case "test":
    test(rest);
    break;

  case "failures":
    showFailures();
    break;

  case "clear-failures":
    clearFailures();
    break;

  case "interactive":
  case "i":
    await interactive();
    break;

  case "help":
  case "--help":
  case "-h":
    print(`
${c.bold}mycli${c.reset} — NLP-based server operations CLI

${c.bold}Usage:${c.reset}
  ${c.cyan}node service.js${c.reset}                    Start interactive mode (default)
  ${c.cyan}node service.js${c.reset} run <args>         One-shot command
  ${c.cyan}node service.js${c.reset} build              Compile TypeScript
  ${c.cyan}node service.js${c.reset} test [phrases]     Test the parser
  ${c.cyan}node service.js${c.reset} status             Project health
  ${c.cyan}node service.js${c.reset} heal [flags]       Self-healing (--promote, --force)
  ${c.cyan}node service.js${c.reset} heal:claude        Claude-powered self-healing
  ${c.cyan}node service.js${c.reset} failures           List parse failures
  ${c.cyan}node service.js${c.reset} clear-failures     Clear failure log
  ${c.cyan}node service.js${c.reset} install            Install dependencies
  ${c.cyan}node service.js${c.reset} link               Build + npm link globally
  ${c.cyan}node service.js${c.reset} help               This help

${c.bold}Examples:${c.reset}
  node service.js
  node service.js run "restart nginx on prod" --dry-run
  node service.js test "bounce cache on live"
  MYCLI_LLM_CLI=claude node service.js
`);
    break;

  case "heal:claude":
    ensureDeps();
    spawn("npx", ["tsx", resolve(SRC, "healing", "claudeHealer.ts"), ...rest], {
      cwd: ROOT,
      stdio: "inherit",
    });
    break;

  default:
    // No command = interactive (the default)
    await interactive();
    break;
}
