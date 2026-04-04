/**
 * Bookmarks — save / list / retrieve / remove named commands.
 *
 * Stored in ~/.notoken/bookmarks.json as a simple { name: command } map.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";

const home = process.env.HOME ?? process.env.USERPROFILE ?? ".";
const dir = resolve(home, ".notoken");
const file = resolve(dir, "bookmarks.json");

function load(): Record<string, string> {
  if (!existsSync(file)) return {};
  try { return JSON.parse(readFileSync(file, "utf-8")); } catch { return {}; }
}

function save(data: Record<string, string>): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(file, JSON.stringify(data, null, 2), "utf-8");
}

/** Save a command under a bookmark name. */
export function saveBookmark(name: string, command: string): void {
  const bk = load();
  bk[name] = command;
  save(bk);
}

/** List all bookmarks as a formatted string. */
export function listBookmarks(): string {
  const bk = load();
  const keys = Object.keys(bk);
  if (keys.length === 0) return "No bookmarks saved.";
  return keys.map((k) => `  ${k}  →  ${bk[k]}`).join("\n");
}

/** Get the command for a bookmark (or undefined). */
export function getBookmark(name: string): string | undefined {
  return load()[name];
}

/** Remove a bookmark by name. Returns true if it existed. */
export function removeBookmark(name: string): boolean {
  const bk = load();
  if (!(name in bk)) return false;
  delete bk[name];
  save(bk);
  return true;
}
