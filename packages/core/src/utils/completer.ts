/**
 * Tab-completion for notoken interactive mode.
 *
 * Builds a flat list of completable phrases from intents, meta commands,
 * service aliases, common verbs, and recent history.  Cached and rebuilt
 * every 60 seconds.
 */

import { loadIntents } from "./config.js";
import { loadRules } from "./config.js";
import { getRecentHistory } from "../context/history.js";

// ── Cache ───────────────────────────────────────────────────────────────────

let cached: string[] = [];
let lastBuilt = 0;
const CACHE_TTL = 60_000; // 60 s

const META_COMMANDS = [
  "/jobs", "/help", "/quit", "/output", "/kill",
  "/aliases", "/history",
];

const COMMON_VERBS = [
  "restart", "check", "show", "list", "install",
  "diagnose", "monitor",
];

/**
 * Build (or rebuild) the flat list of completable strings.
 */
export function buildCompletions(): string[] {
  const set = new Set<string>();

  // Meta commands
  for (const cmd of META_COMMANDS) set.add(cmd);

  // Common verbs
  for (const v of COMMON_VERBS) set.add(v);

  // Intent synonyms
  try {
    const intents = loadIntents();
    for (const intent of intents) {
      for (const syn of intent.synonyms ?? []) {
        set.add(syn.toLowerCase());
      }
    }
  } catch { /* config may not be loaded yet */ }

  // Service alias names
  try {
    const rules = loadRules();
    for (const [service, aliases] of Object.entries(rules.serviceAliases)) {
      set.add(service);
      for (const a of aliases) set.add(a.toLowerCase());
    }
  } catch { /* rules may not be loaded yet */ }

  // Recent commands from history
  try {
    const recent = getRecentHistory(20);
    for (const entry of recent) {
      if (entry.rawText) set.add(entry.rawText);
    }
  } catch { /* history may be empty */ }

  cached = [...set].sort();
  lastBuilt = Date.now();
  return cached;
}

/**
 * Readline-compatible completer function.
 *
 * Signature: (line: string) => [matches: string[], line: string]
 */
export function completeInput(line: string): [string[], string] {
  if (Date.now() - lastBuilt > CACHE_TTL || cached.length === 0) {
    buildCompletions();
  }

  const lower = line.toLowerCase();
  const hits = cached.filter((c) => c.toLowerCase().startsWith(lower));
  return [hits.length > 0 ? hits : cached, line];
}
