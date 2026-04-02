import { writeFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { FailureLog } from "../types/rules.js";
import { LOG_DIR } from "./paths.js";

const FAILURE_LOG = resolve(LOG_DIR, "failures.json");

function ensureLogDir(): void {
  if (!existsSync(LOG_DIR)) {
    mkdirSync(LOG_DIR, { recursive: true });
  }
}

export function logFailure(entry: FailureLog): void {
  ensureLogDir();
  const existing = loadFailures();
  existing.push(entry);
  writeFileSync(FAILURE_LOG, JSON.stringify(existing, null, 2));
}

export function loadFailures(): FailureLog[] {
  if (!existsSync(FAILURE_LOG)) return [];
  const raw = readFileSync(FAILURE_LOG, "utf-8");
  return JSON.parse(raw);
}

export function clearFailures(): void {
  ensureLogDir();
  writeFileSync(FAILURE_LOG, "[]");
}

export function log(level: "info" | "warn" | "error", message: string): void {
  const prefix = level === "error" ? "ERROR" : level === "warn" ? "WARN" : "INFO";
  console.error(`[${prefix}] ${message}`);
}
