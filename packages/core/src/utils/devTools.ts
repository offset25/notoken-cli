/**
 * Developer utility tools — JSON, regex, encoding, hashing, UUID, timestamps, diff.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";

// ── JSON ──

export function formatJson(input: string): { formatted: string; valid: boolean; error?: string } {
  try {
    const parsed = JSON.parse(input);
    return { formatted: JSON.stringify(parsed, null, 2), valid: true };
  } catch (e: any) {
    return { formatted: input, valid: false, error: e.message };
  }
}

export function validateJson(input: string): { valid: boolean; error?: string; parsed?: unknown } {
  try {
    const parsed = JSON.parse(input);
    return { valid: true, parsed };
  } catch (e: any) {
    return { valid: false, error: e.message };
  }
}

// ── Regex ──

export function testRegex(
  pattern: string,
  testString: string,
  flags = "g",
): { matches: RegExpMatchArray[]; count: number; groups: Record<string, string>[] } {
  const re = new RegExp(pattern, flags);
  const matches: RegExpMatchArray[] = [];
  const groups: Record<string, string>[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(testString)) !== null) {
    matches.push([...m] as unknown as RegExpMatchArray);
    if (m.groups) groups.push({ ...m.groups });
    if (!re.global) break;
  }
  return { matches, count: matches.length, groups };
}

// ── Base64 ──

export function encodeBase64(input: string): string {
  return Buffer.from(input, "utf-8").toString("base64");
}

export function decodeBase64(input: string): string {
  return Buffer.from(input, "base64").toString("utf-8");
}

// ── URL Encoding ──

export function encodeUrl(input: string): string {
  return encodeURIComponent(input);
}

export function decodeUrl(input: string): string {
  return decodeURIComponent(input);
}

// ── Hashing ──

type HashAlgo = "md5" | "sha1" | "sha256";

export function hashString(input: string, algo: HashAlgo = "sha256"): string {
  return createHash(algo).update(input, "utf-8").digest("hex");
}

export async function hashFile(filepath: string, algo: HashAlgo = "sha256"): Promise<string> {
  const buf = await readFile(filepath);
  return createHash(algo).update(buf).digest("hex");
}

// ── UUID ──

export function generateUuid(): string {
  return randomUUID();
}

// ── Timestamps ──

export function convertUnixTimestamp(ts: number | string): {
  unix: number;
  iso: string;
  utc: string;
  local: string;
} {
  const num = typeof ts === "string" ? Number(ts) : ts;
  // Auto-detect seconds vs milliseconds
  const ms = num > 1e12 ? num : num * 1000;
  const d = new Date(ms);
  return {
    unix: Math.floor(ms / 1000),
    iso: d.toISOString(),
    utc: d.toUTCString(),
    local: d.toString(),
  };
}

// ── Simple Word-Level Diff ──

export function diffStrings(a: string, b: string): { added: string[]; removed: string[]; diff: string } {
  const wordsA = a.split(/\s+/).filter(Boolean);
  const wordsB = b.split(/\s+/).filter(Boolean);

  const setA = new Set(wordsA);
  const setB = new Set(wordsB);

  const removed = wordsA.filter((w) => !setB.has(w));
  const added = wordsB.filter((w) => !setA.has(w));

  // Build a simple inline diff display
  const lines: string[] = [];
  if (removed.length) lines.push(`- ${removed.join(" ")}`);
  if (added.length) lines.push(`+ ${added.join(" ")}`);
  if (!removed.length && !added.length) lines.push("(no differences)");

  return { added, removed, diff: lines.join("\n") };
}
