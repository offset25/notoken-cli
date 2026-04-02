/**
 * Wikidata Knowledge Base.
 *
 * When the NLP parser encounters unknown nouns, queries Wikidata to:
 *   1. Identify what the entity is (person, software, company, concept)
 *   2. Pull key facts (description, instance-of, subclass-of)
 *   3. Build semantic relationships (related topics, categories)
 *   4. Cache results locally for offline use
 *
 * Uses the Wikidata REST API (no auth needed).
 * Results are cached in ~/.notoken/wikidata-cache.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { USER_HOME } from "../utils/paths.js";
import { enrichVocabularyFromWiki } from "./vocabularyBuilder.js";

const CACHE_FILE = resolve(USER_HOME, "wikidata-cache.json");
const CACHE_TTL = 7 * 24 * 3600_000; // 7 days
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";
const SEARCH_URL = "https://www.wikidata.org/w/api.php?action=wbsearchentities&format=json&language=en&limit=3&search=";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};

// ─── Types ─────────────────────────────────────────────────────────────────

export interface WikiEntity {
  id: string;           // Q-number (e.g. Q15206305)
  label: string;        // Human name
  description: string;  // Short description
  aliases: string[];    // Alternative names
  instanceOf: string[]; // What it is (e.g. "programming language", "web framework")
  subclassOf: string[]; // Parent categories
  related: string[];    // Related entities
  url: string;          // Wikidata URL
  wikipedia?: string;   // Wikipedia URL
  cachedAt: string;
}

export interface WikiLookupResult {
  found: boolean;
  entity?: WikiEntity;
  suggestions?: Array<{ id: string; label: string; description: string }>;
  error?: string;
}

// ─── Cache ─────────────────────────────────────────────────────────────────

interface CacheEntry {
  entity: WikiEntity;
  timestamp: number;
}

let cache: Record<string, CacheEntry> = {};

function loadCache(): void {
  try {
    if (existsSync(CACHE_FILE)) {
      cache = JSON.parse(readFileSync(CACHE_FILE, "utf-8"));
    }
  } catch { cache = {}; }
}

function saveCache(): void {
  try {
    mkdirSync(USER_HOME, { recursive: true });
    // Prune expired entries
    const now = Date.now();
    for (const [key, entry] of Object.entries(cache)) {
      if (now - entry.timestamp > CACHE_TTL) delete cache[key];
    }
    writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {}
}

function getCached(key: string): WikiEntity | null {
  loadCache();
  const entry = cache[key.toLowerCase()];
  if (!entry) return null;
  if (Date.now() - entry.timestamp > CACHE_TTL) return null;
  return entry.entity;
}

function setCache(key: string, entity: WikiEntity): void {
  cache[key.toLowerCase()] = { entity, timestamp: Date.now() };
  saveCache();
}

// ─── API ───────────────────────────────────────────────────────────────────

async function fetchJson(url: string): Promise<unknown> {
  try {
    const response = await fetch(url, {
      signal: AbortSignal.timeout(8000),
      headers: { "User-Agent": "NoToken-CLI/1.0 (https://notoken.sh)" },
    });
    if (!response.ok) return null;
    return response.json();
  } catch { return null; }
}

/**
 * Search Wikidata for an entity by name.
 */
export async function searchWikidata(query: string): Promise<WikiLookupResult> {
  // Check cache first
  const cached = getCached(query);
  if (cached) return { found: true, entity: cached };

  // Search Wikidata
  const searchData = await fetchJson(`${SEARCH_URL}${encodeURIComponent(query)}`) as {
    search?: Array<{ id: string; label: string; description: string; url: string }>;
  } | null;

  if (!searchData?.search?.length) {
    return { found: false, error: "No results found on Wikidata" };
  }

  const suggestions = searchData.search.map(s => ({
    id: s.id, label: s.label, description: s.description,
  }));

  // Fetch full entity data for top result
  const topId = searchData.search[0].id;
  const entity = await fetchEntity(topId, searchData.search[0].label, searchData.search[0].description);

  if (entity) {
    setCache(query, entity);
    // Enrich vocabulary from this lookup for future NLP matching
    try { enrichVocabularyFromWiki(entity); } catch {}
    return { found: true, entity, suggestions };
  }

  return { found: false, suggestions };
}

/**
 * Fetch full entity details from Wikidata by Q-number.
 */
async function fetchEntity(qid: string, label: string, description: string): Promise<WikiEntity | null> {
  const url = `${WIKIDATA_API}?action=wbgetentities&format=json&ids=${qid}&props=labels|descriptions|aliases|claims|sitelinks&languages=en`;
  const data = await fetchJson(url) as {
    entities?: Record<string, {
      labels?: Record<string, { value: string }>;
      descriptions?: Record<string, { value: string }>;
      aliases?: Record<string, Array<{ value: string }>>;
      claims?: Record<string, Array<{ mainsnak: { datavalue?: { value: { id?: string; "numeric-id"?: number } | string } } }>>;
      sitelinks?: Record<string, { url: string; title: string }>;
    }>;
  } | null;

  if (!data?.entities?.[qid]) return null;

  const e = data.entities[qid];
  const claims = e.claims ?? {};

  // Extract instance-of (P31) and subclass-of (P279) labels
  const instanceOf = await resolveClaimLabels(claims["P31"]);
  const subclassOf = await resolveClaimLabels(claims["P279"]);

  // Get related entities from "part of" (P361), "has use" (P366), "field of work" (P101)
  const relatedClaims = [
    ...(claims["P361"] ?? []),  // part of
    ...(claims["P366"] ?? []),  // has use
    ...(claims["P101"] ?? []),  // field of work
    ...(claims["P1535"] ?? []), // used by
  ];
  const related = await resolveClaimLabels(relatedClaims);

  const aliases = (e.aliases?.en ?? []).map(a => a.value).slice(0, 10);
  const wikipedia = e.sitelinks?.enwiki?.url;

  return {
    id: qid,
    label: e.labels?.en?.value ?? label,
    description: e.descriptions?.en?.value ?? description,
    aliases,
    instanceOf,
    subclassOf,
    related,
    url: `https://www.wikidata.org/wiki/${qid}`,
    wikipedia,
    cachedAt: new Date().toISOString(),
  };
}

async function resolveClaimLabels(
  claims?: Array<{ mainsnak: { datavalue?: { value: { id?: string } | string } } }>
): Promise<string[]> {
  if (!claims?.length) return [];

  const qids: string[] = [];
  for (const c of claims.slice(0, 8)) {
    const val = c.mainsnak?.datavalue?.value;
    if (typeof val === "object" && val && "id" in val && val.id) {
      qids.push(val.id);
    }
  }

  if (qids.length === 0) return [];

  // Batch fetch labels
  const url = `${WIKIDATA_API}?action=wbgetentities&format=json&ids=${qids.join("|")}&props=labels&languages=en`;
  const data = await fetchJson(url) as {
    entities?: Record<string, { labels?: Record<string, { value: string }> }>;
  } | null;

  if (!data?.entities) return [];

  return qids
    .map(q => data.entities?.[q]?.labels?.en?.value)
    .filter((l): l is string => !!l);
}

// ─── Formatting ────────────────────────────────────────────────────────────

export function formatWikiEntity(entity: WikiEntity): string {
  const lines: string[] = [];

  lines.push(`${c.bold}${c.cyan}${entity.label}${c.reset}`);
  lines.push(`${c.dim}${entity.description}${c.reset}\n`);

  if (entity.instanceOf.length > 0) {
    lines.push(`  ${c.bold}Type:${c.reset} ${entity.instanceOf.join(", ")}`);
  }
  if (entity.subclassOf.length > 0) {
    lines.push(`  ${c.bold}Category:${c.reset} ${entity.subclassOf.join(", ")}`);
  }
  if (entity.aliases.length > 0) {
    lines.push(`  ${c.bold}Also known as:${c.reset} ${entity.aliases.join(", ")}`);
  }
  if (entity.related.length > 0) {
    lines.push(`  ${c.bold}Related:${c.reset} ${entity.related.join(", ")}`);
  }

  lines.push("");
  if (entity.wikipedia) {
    lines.push(`  ${c.dim}Wikipedia: ${entity.wikipedia}${c.reset}`);
  }
  lines.push(`  ${c.dim}Wikidata: ${entity.url}${c.reset}`);

  return lines.join("\n");
}

export function formatWikiSuggestions(suggestions: Array<{ id: string; label: string; description: string }>): string {
  const lines: string[] = [];
  lines.push(`${c.bold}Did you mean:${c.reset}\n`);
  for (const s of suggestions) {
    lines.push(`  ${c.cyan}${s.label}${c.reset} — ${c.dim}${s.description}${c.reset}`);
  }
  return lines.join("\n");
}

// ─── Integration with NLP ──────────────────────────────────────────────────

/**
 * Look up unknown nouns via Wikidata.
 * Called when the parser can't match an intent and has unknown words.
 */
export async function lookupUnknownNouns(words: string[]): Promise<WikiEntity[]> {
  const results: WikiEntity[] = [];
  // Filter to likely nouns (capitalized, or multi-char words not in common stop words)
  const candidates = words.filter(w =>
    w.length >= 3 &&
    !STOP_WORDS.has(w.toLowerCase())
  );

  for (const word of candidates.slice(0, 3)) {
    const result = await searchWikidata(word);
    if (result.found && result.entity) {
      results.push(result.entity);
    }
  }

  return results;
}

const STOP_WORDS = new Set([
  "the", "a", "an", "is", "are", "was", "were", "be", "been", "being",
  "have", "has", "had", "do", "does", "did", "will", "would", "shall",
  "should", "may", "might", "must", "can", "could", "and", "but", "or",
  "if", "then", "else", "when", "where", "how", "what", "which", "who",
  "that", "this", "these", "those", "it", "its", "my", "your", "his",
  "her", "our", "their", "not", "no", "yes", "all", "any", "each",
  "every", "some", "many", "much", "more", "most", "very", "just",
  "about", "above", "after", "again", "before", "below", "between",
  "both", "down", "during", "for", "from", "here", "in", "into",
  "of", "off", "on", "out", "over", "own", "same", "so", "than",
  "then", "there", "through", "to", "too", "under", "until", "up",
  "with", "check", "show", "get", "list", "find", "run", "start",
  "stop", "restart", "install", "please", "help", "me", "tell",
]);
