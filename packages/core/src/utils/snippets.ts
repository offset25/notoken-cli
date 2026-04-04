/**
 * Snippets — save, list, read, and run code snippets.
 *
 * Each snippet is a file under ~/.notoken/snippets/<name>.<ext>
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { resolve, extname, basename } from "node:path";
import { execSync } from "node:child_process";

const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
const dir = resolve(home, ".notoken", "snippets");

function ensureDir(): void { mkdirSync(dir, { recursive: true }); }

function extFor(lang?: string): string {
  if (!lang) return ".sh";
  const map: Record<string, string> = { bash: ".sh", sh: ".sh", node: ".js", javascript: ".js", python: ".py", ts: ".ts", typescript: ".ts" };
  return map[lang.toLowerCase()] ?? `.${lang}`;
}

/** Save a code snippet. */
export function saveSnippet(name: string, code: string, language?: string): void {
  ensureDir();
  writeFileSync(resolve(dir, `${name}${extFor(language)}`), code, "utf-8");
}

/** List saved snippets. */
export function listSnippets(): string {
  ensureDir();
  const files = readdirSync(dir);
  if (files.length === 0) return "No snippets saved.";
  return files.map((f) => `  ${basename(f, extname(f))}  (${extname(f).slice(1)})`).join("\n");
}

/** Read a snippet by name (matches any extension). */
export function getSnippet(name: string): string | undefined {
  ensureDir();
  const hit = readdirSync(dir).find((f) => basename(f, extname(f)) === name);
  return hit ? readFileSync(resolve(dir, hit), "utf-8") : undefined;
}

/** Run a snippet, auto-detecting interpreter from extension. */
export function runSnippet(name: string): string {
  ensureDir();
  const hit = readdirSync(dir).find((f) => basename(f, extname(f)) === name);
  if (!hit) return `Snippet "${name}" not found.`;
  const fp = resolve(dir, hit);
  const ext = extname(hit);
  const runners: Record<string, string> = { ".sh": "bash", ".js": "node", ".py": "python3", ".ts": "npx tsx" };
  const runner = runners[ext] ?? "bash";
  try { return execSync(`${runner} "${fp}"`, { encoding: "utf-8", timeout: 30_000 }).trim(); }
  catch (e: any) { return `Error: ${e.message?.split("\n")[0] ?? e}`; }
}
