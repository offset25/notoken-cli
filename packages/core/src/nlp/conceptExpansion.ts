/**
 * Concept expansion module.
 *
 * Auto-expands concepts so the classifier catches more natural language
 * variations. Synonym clusters and domain mappings are stored in
 * config/concept-clusters.json so users can extend them.
 *
 * Main exports:
 *   - expandQuery(text)    — appends synonym keywords for scoring
 *   - findCluster(word)    — returns the cluster name a word belongs to
 *   - suggestIntents(word) — maps a concept cluster to likely intent domains
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";

// ─── Types ───────────────────────────────────────────────────────────────────

interface ClusterConfig {
  synonymClusters: Record<string, string[]>;
  domainConcepts: Record<string, string[]>;
}

// ─── Load config ─────────────────────────────────────────────────────────────

const __dirname = dirname(fileURLToPath(import.meta.url));
const CONFIG_PATH = resolve(__dirname, "../../config/concept-clusters.json");

let config: ClusterConfig;

function loadConfig(): ClusterConfig {
  const raw = readFileSync(CONFIG_PATH, "utf-8");
  return JSON.parse(raw) as ClusterConfig;
}

function getConfig(): ClusterConfig {
  if (!config) config = loadConfig();
  return config;
}

/** Force-reload config (useful after user edits the JSON). */
export function reloadConfig(): void {
  config = loadConfig();
}

// ─── Synonym lookup (built lazily) ──────────────────────────────────────────

/** Reverse index: synonym word → cluster name. Built once on first access. */
let reverseIndex: Map<string, string> | undefined;

function getReverseIndex(): Map<string, string> {
  if (reverseIndex) return reverseIndex;
  reverseIndex = new Map();
  const clusters = getConfig().synonymClusters;
  for (const [canonical, synonyms] of Object.entries(clusters)) {
    reverseIndex.set(canonical, canonical);
    for (const s of synonyms) {
      reverseIndex.set(s.toLowerCase(), canonical);
    }
  }
  return reverseIndex;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Find which cluster a word belongs to.
 * Returns the canonical cluster name, or undefined if no match.
 *
 *   findCluster("reboot")  → "restart"
 *   findCluster("hello")   → undefined
 */
export function findCluster(word: string): string | undefined {
  return getReverseIndex().get(word.toLowerCase());
}

/**
 * Expand a query by appending synonym keywords from every cluster
 * that matches a token in the text. The original text is preserved;
 * extra tokens are appended (space-separated) for scoring purposes.
 *
 *   expandQuery("reboot the server")
 *   → "reboot the server restart cycle reload bounce"
 */
export function expandQuery(text: string): string {
  const clusters = getConfig().synonymClusters;
  const idx = getReverseIndex();
  const tokens = text.toLowerCase().split(/\s+/);
  const seen = new Set<string>();
  const extras: string[] = [];

  for (const tok of tokens) {
    const cluster = idx.get(tok);
    if (!cluster || seen.has(cluster)) continue;
    seen.add(cluster);

    // Append canonical name + all synonyms that aren't already in the text
    const all = [cluster, ...clusters[cluster]];
    for (const w of all) {
      const lower = w.toLowerCase();
      if (!tokens.includes(lower)) extras.push(lower);
    }
  }

  return extras.length ? `${text} ${extras.join(" ")}` : text;
}

/**
 * Given a word, find its cluster, then return the intent domain patterns
 * whose concept list includes that cluster.
 *
 *   suggestIntents("reboot")
 *   → ["service.*", "docker.*"]   (domains that list "restart")
 *
 *   suggestIntents("hello")
 *   → []
 */
export function suggestIntents(word: string): string[] {
  const cluster = findCluster(word);
  if (!cluster) return [];

  const domains = getConfig().domainConcepts;
  const matches: string[] = [];
  for (const [pattern, concepts] of Object.entries(domains)) {
    if (concepts.includes(cluster)) matches.push(pattern);
  }
  return matches;
}

/**
 * Return all clusters that are relevant to a given intent domain.
 *
 *   clustersForDomain("docker.restart") → ["restart", "stop", "start", "show"]
 */
export function clustersForDomain(intentId: string): string[] {
  const domains = getConfig().domainConcepts;
  for (const [pattern, concepts] of Object.entries(domains)) {
    const re = new RegExp("^" + pattern.replace(/\./g, "\\.").replace(/\*/g, ".*") + "$");
    if (re.test(intentId)) return concepts;
  }
  return [];
}

/**
 * Get all synonyms for a cluster (including the canonical name).
 *
 *   clusterWords("restart") → ["restart", "reboot", "bounce", "cycle", "reload"]
 */
export function clusterWords(clusterName: string): string[] {
  const clusters = getConfig().synonymClusters;
  const syns = clusters[clusterName];
  if (!syns) return [];
  return [clusterName, ...syns];
}
