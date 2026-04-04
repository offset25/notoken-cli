import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { USER_HOME } from "./paths.js";

const ALIASES_FILE = resolve(USER_HOME, "aliases.json");

function ensureDir(): void {
  if (!existsSync(USER_HOME)) mkdirSync(USER_HOME, { recursive: true });
}

export function loadAliases(): Record<string, string> {
  try {
    const raw = readFileSync(ALIASES_FILE, "utf-8");
    return JSON.parse(raw);
  } catch {
    return {};
  }
}

export function resolveAlias(text: string): string {
  const aliases = loadAliases();
  return aliases[text] ?? text;
}

export function saveAlias(name: string, command: string): void {
  ensureDir();
  const aliases = loadAliases();
  aliases[name] = command;
  writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2) + "\n", "utf-8");
}

export function removeAlias(name: string): boolean {
  const aliases = loadAliases();
  if (!(name in aliases)) return false;
  delete aliases[name];
  ensureDir();
  writeFileSync(ALIASES_FILE, JSON.stringify(aliases, null, 2) + "\n", "utf-8");
  return true;
}

export function listAliases(): Record<string, string> {
  return loadAliases();
}
