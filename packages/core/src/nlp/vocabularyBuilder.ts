/**
 * Vocabulary Builder — learns vocabulary from Wikidata lookups.
 *
 * After every successful Wikidata entity lookup, this module:
 *   1. Extracts instanceOf labels and maps them to intent domains
 *   2. Collects aliases as synonyms for future matching
 *   3. Adds related concepts to the concept router map
 *   4. Persists learned vocabulary to ~/.notoken/learned-vocabulary.json
 *
 * On startup, loads learned vocabulary and merges it into the
 * concept router's CONCEPT_DOMAINS so future queries benefit.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { USER_HOME } from "../utils/paths.js";
import { mergeConceptDomains } from "./conceptRouter.js";
import type { WikiEntity } from "./wikidata.js";

const VOCAB_FILE = resolve(USER_HOME, "learned-vocabulary.json");

// ─── Types ────────────────────────────────────────────────────────────────

export interface LearnedVocabulary {
  /** Maps an entity label (lowercase) to its known aliases/synonyms. */
  concepts: Record<string, string[]>;
  /** Maps an instanceOf label (lowercase) to intent domain strings. */
  domainMappings: Record<string, string[]>;
  /** ISO timestamp of last update. */
  learnedAt: string;
}

// ─── Default domain mapping rules ─────────────────────────────────────────
// When we encounter an instanceOf label from Wikidata, map it to likely
// intent domains. This is the heuristic that turns Wikidata types into
// actionable routing information.

const INSTANCE_OF_TO_DOMAINS: Record<string, string[]> = {
  // Software / services
  "web server":              ["service.status", "service.restart"],
  "reverse proxy":           ["service.status", "service.restart"],
  "http server":             ["service.status", "service.restart"],
  "web framework":           ["knowledge.lookup"],
  "application server":      ["service.status", "service.restart"],
  "database management system": ["service.status", "service.restart"],
  "relational database management system": ["service.status", "service.restart"],
  "nosql database":          ["service.status", "service.restart"],
  "message broker":          ["service.status", "service.restart"],
  "caching system":          ["service.status", "service.restart"],
  "search engine software":  ["service.status", "service.restart"],

  // Container / orchestration
  "container orchestrator":  ["docker.ps", "docker.restart"],
  "containerization":        ["docker.ps", "docker.restart"],
  "container platform":      ["docker.ps", "docker.restart"],

  // Programming languages
  "programming language":    ["knowledge.lookup"],
  "scripting language":      ["knowledge.lookup"],
  "markup language":         ["knowledge.lookup"],

  // Operating systems
  "operating system":        ["system.kernel", "system.hostname"],
  "linux distribution":      ["system.kernel", "package.audit"],

  // Networking
  "network protocol":        ["network.connections", "network.ports"],
  "communication protocol":  ["network.connections"],

  // Version control
  "version control system":  ["git.status", "git.branch"],

  // Package management
  "package manager":         ["package.audit"],

  // General software
  "free software":           ["knowledge.lookup"],
  "open-source software":    ["knowledge.lookup"],
  "software":                ["knowledge.lookup"],
};

// ─── In-memory state ──────────────────────────────────────────────────────

let vocabulary: LearnedVocabulary = {
  concepts: {},
  domainMappings: {},
  learnedAt: new Date().toISOString(),
};

let loaded = false;

// ─── Persistence ──────────────────────────────────────────────────────────

function readVocabFile(): LearnedVocabulary | null {
  try {
    if (existsSync(VOCAB_FILE)) {
      const raw = JSON.parse(readFileSync(VOCAB_FILE, "utf-8"));
      if (raw && typeof raw === "object" && raw.concepts && raw.domainMappings) {
        return raw as LearnedVocabulary;
      }
    }
  } catch { /* corrupted file — start fresh */ }
  return null;
}

function saveVocabFile(): void {
  try {
    mkdirSync(USER_HOME, { recursive: true });
    vocabulary.learnedAt = new Date().toISOString();
    writeFileSync(VOCAB_FILE, JSON.stringify(vocabulary, null, 2));
  } catch { /* best-effort persistence */ }
}

// ─── Core logic ───────────────────────────────────────────────────────────

/**
 * Enrich vocabulary from a Wikidata entity.
 *
 * Called after every successful Wikidata lookup. Extracts:
 *   - instanceOf labels → domain mappings
 *   - aliases → concept synonyms
 *   - related concepts → concept router entries
 */
export function enrichVocabularyFromWiki(entity: WikiEntity): void {
  ensureLoaded();

  const label = entity.label.toLowerCase();
  const existingAliases = vocabulary.concepts[label] ?? [];
  const newAliases = new Set(existingAliases);

  // 1. Collect aliases as synonyms
  for (const alias of entity.aliases) {
    const lower = alias.toLowerCase();
    if (lower !== label) {
      newAliases.add(lower);
    }
  }

  // 2. Add instanceOf labels as synonyms too (they describe what it is)
  for (const inst of entity.instanceOf) {
    const lower = inst.toLowerCase();
    if (lower !== label) {
      newAliases.add(lower);
    }
  }

  vocabulary.concepts[label] = [...newAliases];

  // 3. Map instanceOf labels to intent domains
  const entityDomains = new Set<string>();

  for (const inst of entity.instanceOf) {
    const lower = inst.toLowerCase();

    // Check our built-in heuristic mapping
    const mapped = INSTANCE_OF_TO_DOMAINS[lower];
    if (mapped) {
      for (const d of mapped) entityDomains.add(d);

      // Persist the mapping so it's available next time
      if (!vocabulary.domainMappings[lower]) {
        vocabulary.domainMappings[lower] = [...mapped];
      }
    }

    // Also check previously learned domain mappings
    const learned = vocabulary.domainMappings[lower];
    if (learned) {
      for (const d of learned) entityDomains.add(d);
    }
  }

  // 4. Merge into concept router: entity label + aliases → discovered domains
  const domainsArray = [...entityDomains];
  if (domainsArray.length > 0) {
    // Map the entity label itself
    mergeConceptDomains({ [label]: domainsArray });

    // Map each alias to the same domains
    for (const alias of newAliases) {
      mergeConceptDomains({ [alias]: domainsArray });
    }
  }

  // 5. Add related concepts to concept router with the same domains (lower weight)
  if (domainsArray.length > 0) {
    for (const rel of entity.related) {
      const lower = rel.toLowerCase();
      mergeConceptDomains({ [lower]: domainsArray });
    }
  }

  // Persist
  saveVocabFile();
}

/**
 * Load learned vocabulary from disk and merge into the concept router.
 *
 * Should be called on startup so that previously learned vocabulary
 * is available for intent routing from the first query.
 */
export function loadLearnedVocabulary(): void {
  const saved = readVocabFile();
  if (saved) {
    vocabulary = saved;
  }

  // Merge all learned concepts into the concept router
  const toMerge: Record<string, string[]> = {};

  for (const [label, aliases] of Object.entries(vocabulary.concepts)) {
    // Determine domains for this label from domain mappings
    const domains = resolveDomains(label, aliases);
    if (domains.length > 0) {
      toMerge[label] = domains;
      for (const alias of aliases) {
        toMerge[alias] = domains;
      }
    }
  }

  if (Object.keys(toMerge).length > 0) {
    mergeConceptDomains(toMerge);
  }

  loaded = true;
}

/**
 * Get the current enriched concepts map (merged vocabulary).
 *
 * Returns a combined view of hardcoded concepts and learned vocabulary.
 */
export function getEnrichedConcepts(): LearnedVocabulary {
  ensureLoaded();
  return {
    concepts: { ...vocabulary.concepts },
    domainMappings: { ...vocabulary.domainMappings },
    learnedAt: vocabulary.learnedAt,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function ensureLoaded(): void {
  if (!loaded) {
    loadLearnedVocabulary();
  }
}

/**
 * Resolve domains for a concept by checking its instanceOf-style labels
 * against both the built-in heuristic map and learned domain mappings.
 */
function resolveDomains(label: string, aliases: string[]): string[] {
  const domains = new Set<string>();

  // Check if the label itself is a known instanceOf category
  const directMap = INSTANCE_OF_TO_DOMAINS[label] ?? vocabulary.domainMappings[label];
  if (directMap) {
    for (const d of directMap) domains.add(d);
  }

  // Check aliases — some may be instanceOf labels
  for (const alias of aliases) {
    const aliasMap = INSTANCE_OF_TO_DOMAINS[alias] ?? vocabulary.domainMappings[alias];
    if (aliasMap) {
      for (const d of aliasMap) domains.add(d);
    }
  }

  return [...domains];
}
