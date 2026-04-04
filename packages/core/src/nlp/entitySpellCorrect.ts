/**
 * Entity spell correction — "restart nignx" → "did you mean nginx?"
 *
 * Also does fuzzy entity matching:
 *   "the web server" → nginx (if nginx is the only web server in the graph)
 *   "the database" → mysql (if mysql is the only database)
 */

import { loadKnowledgeGraph, type GraphEntity } from "./knowledgeGraph.js";
import { loadRules } from "../utils/config.js";

// ─── Levenshtein distance ───────────────────────────────────────────────────

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  return dp[m][n];
}

// ─── Entity vocabulary ──────────────────────────────────────────────────────

let _entityVocab: Map<string, string> | null = null;

function getEntityVocab(): Map<string, string> {
  if (_entityVocab) return _entityVocab;
  _entityVocab = new Map();

  // From knowledge graph
  try {
    const g = loadKnowledgeGraph();
    for (const ent of Object.values(g.entities)) {
      _entityVocab.set(ent.name.toLowerCase(), ent.name);
      for (const alias of ent.aliases) _entityVocab.set(alias.toLowerCase(), ent.name);
    }
  } catch {}

  // From service aliases
  try {
    const rules = loadRules();
    for (const [svc, aliases] of Object.entries(rules.serviceAliases ?? {})) {
      _entityVocab.set(svc.toLowerCase(), svc);
      for (const alias of aliases) _entityVocab.set(alias.toLowerCase(), svc);
    }
  } catch {}

  return _entityVocab;
}

// ─── Public API ─────────────────────────────────────────────────────────────

export interface SpellSuggestion {
  original: string;
  suggested: string;
  distance: number;
  confidence: number;
}

/**
 * Check if a word is a misspelling of a known entity.
 * Returns suggestion if distance ≤ 2 and word length ≥ 4.
 */
export function suggestEntityCorrection(word: string): SpellSuggestion | null {
  if (word.length < 4) return null;
  const lower = word.toLowerCase();
  const vocab = getEntityVocab();

  // Exact match — no correction needed
  if (vocab.has(lower)) return null;

  let bestDist = Infinity;
  let bestMatch = "";

  for (const [known, canonical] of vocab) {
    if (Math.abs(known.length - lower.length) > 2) continue; // Skip if lengths too different
    const dist = levenshtein(lower, known);
    if (dist < bestDist && dist <= 2) {
      bestDist = dist;
      bestMatch = canonical;
    }
  }

  if (bestMatch && bestDist <= 2) {
    return {
      original: word,
      suggested: bestMatch,
      distance: bestDist,
      confidence: bestDist === 1 ? 0.9 : 0.7,
    };
  }
  return null;
}

/**
 * Correct entity misspellings in a full text.
 * Returns corrected text and list of corrections made.
 */
export function correctEntities(text: string): { corrected: string; corrections: SpellSuggestion[] } {
  const words = text.split(/\s+/);
  const corrections: SpellSuggestion[] = [];
  const correctedWords = words.map(word => {
    const suggestion = suggestEntityCorrection(word.replace(/[.,!?]/g, ""));
    if (suggestion) {
      corrections.push(suggestion);
      return word.replace(suggestion.original, suggestion.suggested);
    }
    return word;
  });

  return {
    corrected: correctedWords.join(" "),
    corrections,
  };
}

/**
 * Fuzzy entity description matching.
 * "the web server" → nginx (if nginx is the only service type entity)
 * "the database" → mysql (if there's only one database)
 */
export function resolveDescription(description: string): GraphEntity | null {
  try {
    const g = loadKnowledgeGraph();
    const lower = description.toLowerCase();

    // Type-based resolution
    const typeMap: Record<string, string> = {
      "web server": "service", "api server": "service", "app server": "service",
      "database": "database", "db": "database",
      "container": "container", "box": "server", "machine": "server",
    };

    for (const [desc, type] of Object.entries(typeMap)) {
      if (lower.includes(desc)) {
        const matches = Object.values(g.entities).filter(e => e.type === type);
        if (matches.length === 1) return matches[0]; // Only one of that type — must be it
      }
    }
  } catch {}
  return null;
}

/** Reset cached vocabulary (call after graph changes). */
export function resetEntityVocab(): void {
  _entityVocab = null;
}
