/**
 * Semantic NLP layer — powered by compromise.
 *
 * Uses compromise for:
 * - Tokenization
 * - POS tagging (Verb, Noun, Adjective, Preposition, etc.)
 * - Normalization and root form extraction
 * - Sentence/clause structure
 *
 * Layers on top:
 * - Domain entity recognition (services, environments, paths)
 * - Adjacent keyboard typo correction
 * - Dependency parsing (SVO + prepositional)
 * - Concept graph builder
 * - Knowledge graph for entity relationships
 */

import nlp from "compromise";

// ─── Adjacent Keyboard Map ──────────────────────────────────────────────────

const KEYBOARD_ADJACENCY: Record<string, string[]> = {
  q: ["w", "a", "s"],
  w: ["q", "e", "a", "s", "d"],
  e: ["w", "r", "s", "d", "f"],
  r: ["e", "t", "d", "f", "g"],
  t: ["r", "y", "f", "g", "h"],
  y: ["t", "u", "g", "h", "j"],
  u: ["y", "i", "h", "j", "k"],
  i: ["u", "o", "j", "k", "l"],
  o: ["i", "p", "k", "l"],
  p: ["o", "l"],
  a: ["q", "w", "s", "z", "x"],
  s: ["q", "w", "e", "a", "d", "z", "x", "c"],
  d: ["w", "e", "r", "s", "f", "x", "c", "v"],
  f: ["e", "r", "t", "d", "g", "c", "v", "b"],
  g: ["r", "t", "y", "f", "h", "v", "b", "n"],
  h: ["t", "y", "u", "g", "j", "b", "n", "m"],
  j: ["y", "u", "i", "h", "k", "n", "m"],
  k: ["u", "i", "o", "j", "l", "m"],
  l: ["i", "o", "p", "k"],
  z: ["a", "s", "x"],
  x: ["a", "s", "d", "z", "c"],
  c: ["s", "d", "f", "x", "v"],
  v: ["d", "f", "g", "c", "b"],
  b: ["f", "g", "h", "v", "n"],
  n: ["g", "h", "j", "b", "m"],
  m: ["h", "j", "k", "n"],
};

export function keyboardDistance(a: string, b: string): number {
  const la = a.toLowerCase();
  const lb = b.toLowerCase();
  const m = la.length;
  const n = lb.length;

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (la[i - 1] === lb[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        const isAdjacent = KEYBOARD_ADJACENCY[la[i - 1]]?.includes(lb[j - 1]);
        const subCost = isAdjacent ? 0.5 : 1;
        dp[i][j] = Math.min(
          dp[i - 1][j] + 1,
          dp[i][j - 1] + 1,
          dp[i - 1][j - 1] + subCost
        );
      }
    }
  }

  return dp[m][n];
}

export function fuzzyMatch(
  word: string,
  candidates: string[],
  maxDistance = 2
): { match: string; distance: number } | null {
  let best: { match: string; distance: number } | null = null;

  for (const candidate of candidates) {
    const dist = keyboardDistance(word, candidate);
    if (dist <= maxDistance && (!best || dist < best.distance)) {
      best = { match: candidate, distance: dist };
    }
  }

  return best;
}

// ─── Token Types ─────────────────────────────────────────────────────────────

export type TokenTag =
  | "VERB"
  | "NOUN"
  | "PATH"
  | "ENV"
  | "SERVICE"
  | "NUMBER"
  | "PREP"
  | "DET"
  | "ADJ"
  | "ADV"
  | "CONJ"
  | "UNKNOWN";

export interface Token {
  text: string;
  tag: TokenTag;
  index: number;
  normalized?: string;
  /** POS tags from compromise */
  compromiseTags?: string[];
  /** Root/infinitive form from compromise */
  root?: string;
}

// ─── Compromise Integration ──────────────────────────────────────────────────

interface CompromiseTerm {
  text: string;
  tags: string[];
  normal: string;
  root?: string;
  index: [number, number];
}

// Words that compromise misclassifies for CLI usage
const FORCE_PREPOSITION = new Set(["to", "from", "into", "onto"]);

// Domain verbs that compromise may tag as nouns
const DOMAIN_VERBS = new Set([
  "restart", "bounce", "reload", "recycle", "kick", "deploy", "release", "ship",
  "push", "promote", "rollback", "revert", "undo", "tail", "watch", "show",
  "check", "search", "grep", "find", "locate", "list", "kill", "stop",
  "terminate", "copy", "move", "delete", "remove", "create", "add", "modify",
  "ping", "connect", "login", "ssh", "stash", "commit", "stage", "fetch",
  "merge", "rebase", "reset", "checkout", "pull", "clone", "diff", "status",
]);

/**
 * Use compromise to get rich POS tagging and normalization,
 * then overlay domain-specific entity detection and typo correction.
 *
 * Pre-processes input to protect path-like tokens (e.g. /var/log)
 * from being split by compromise's tokenizer.
 */
export function tokenize(
  text: string,
  knownServices: string[],
  knownEnvironments: string[]
): Token[] {
  // Pre-process: extract path-like tokens before compromise gets them
  const pathMap = new Map<string, string>();
  let processed = text;
  const pathRegex = /\/[a-zA-Z0-9_.\/\-]+/g;
  let pathIdx = 0;
  for (const match of text.matchAll(pathRegex)) {
    const placeholder = `PATHPLACEHOLDER${pathIdx}`;
    pathMap.set(placeholder.toLowerCase(), match[0]);
    processed = processed.replace(match[0], placeholder);
    pathIdx++;
  }

  // Also protect dotfiles like nginx.conf, app.log
  const dotfileRegex = /\b([a-zA-Z0-9_-]+\.[a-zA-Z0-9]+)\b/g;
  let dotIdx = 0;
  for (const match of processed.matchAll(dotfileRegex)) {
    // Don't protect common words with periods (e.g., "Mr.", "Dr.")
    if (match[1].includes("/")) continue;
    const placeholder = `DOTFILE${dotIdx}`;
    pathMap.set(placeholder.toLowerCase(), match[1]);
    processed = processed.replace(match[1], placeholder);
    dotIdx++;
  }

  const doc = nlp(processed);
  const json = doc.json() as Array<{ terms: CompromiseTerm[] }>;
  if (!json.length || !json[0].terms) return [];

  const terms = json[0].terms;
  const tokens: Token[] = [];

  // Also get verb root forms from compromise
  const verbs = doc.verbs().toInfinitive().json() as Array<{ terms: CompromiseTerm[] }>;
  const verbRoots = new Map<string, string>();
  for (const sentence of verbs) {
    for (const term of sentence.terms) {
      if (term.tags.includes("Verb")) {
        verbRoots.set(term.normal, term.text.toLowerCase());
      }
    }
  }

  for (let i = 0; i < terms.length; i++) {
    const term = terms[i];
    let word = term.normal || term.text.toLowerCase();
    const compromiseTags = term.tags;

    // Restore path placeholders
    const restoredPath = pathMap.get(word);
    if (restoredPath) {
      word = restoredPath.toLowerCase();
      tokens.push({ text: word, tag: "PATH", index: i, compromiseTags });
      continue;
    }

    // Determine our tag using compromise POS + domain knowledge
    let tag: TokenTag;
    let normalized: string | undefined;
    let root: string | undefined;

    // Force common CLI prepositions that compromise misclassifies
    if (FORCE_PREPOSITION.has(word)) {
      tag = "PREP";
    } else if (word.includes("/") || (word.includes(".") && !compromiseTags.includes("Verb"))) {
      // Domain-specific overrides first (paths, services, envs)
      tag = "PATH";
    } else if (knownEnvironments.includes(word)) {
      tag = "ENV";
    } else if (knownServices.includes(word)) {
      tag = "SERVICE";
    } else if (/^\d+$/.test(word)) {
      tag = "NUMBER";
    } else if (DOMAIN_VERBS.has(word)) {
      // Domain verbs override compromise — "tail", "grep", etc. are verbs in our context
      tag = "VERB";
      root = word;
    } else if (compromiseTags.includes("Verb") || compromiseTags.includes("Infinitive") || compromiseTags.includes("Imperative")) {
      tag = "VERB";
      root = verbRoots.get(word) ?? word;
    } else if (compromiseTags.includes("Preposition")) {
      tag = "PREP";
    } else if (compromiseTags.includes("Determiner")) {
      tag = "DET";
    } else if (compromiseTags.includes("Conjunction")) {
      tag = "CONJ";
    } else if (compromiseTags.includes("Adjective") || compromiseTags.includes("Comparable") || compromiseTags.includes("Superlative")) {
      tag = "ADJ";
    } else if (compromiseTags.includes("Adverb")) {
      tag = "ADV";
    } else if (compromiseTags.includes("Noun") || compromiseTags.includes("Singular") || compromiseTags.includes("Plural")) {
      // It's a noun — check if it fuzzy-matches a service or env
      const serviceMatch = fuzzyMatch(word, knownServices, 1.5);
      if (serviceMatch) {
        tag = "SERVICE";
        normalized = serviceMatch.match;
      } else {
        const envMatch = fuzzyMatch(word, knownEnvironments, 1.5);
        if (envMatch) {
          tag = "ENV";
          normalized = envMatch.match;
        } else {
          tag = "NOUN";
        }
      }
    } else {
      // Unknown POS — try fuzzy matching
      const serviceMatch = fuzzyMatch(word, knownServices, 1.5);
      if (serviceMatch) {
        tag = "SERVICE";
        normalized = serviceMatch.match;
      } else {
        const envMatch = fuzzyMatch(word, knownEnvironments, 1.5);
        if (envMatch) {
          tag = "ENV";
          normalized = envMatch.match;
        } else {
          tag = "UNKNOWN";
        }
      }
    }

    tokens.push({
      text: word,
      tag,
      index: i,
      normalized,
      compromiseTags,
      root,
    });
  }

  return tokens;
}

// ─── Dependency Parsing ──────────────────────────────────────────────────────

export interface Dependency {
  head: Token;
  dependent: Token;
  relation: "subject" | "object" | "modifier" | "location" | "destination" | "source" | "quantity";
}

export function parseDependencies(tokens: Token[]): Dependency[] {
  const deps: Dependency[] = [];
  const verb = tokens.find((t) => t.tag === "VERB");
  if (!verb) return deps;

  const afterVerb = tokens.filter((t) => t.index > verb.index);
  const beforeVerb = tokens.filter((t) => t.index < verb.index);

  for (const t of beforeVerb) {
    if (t.tag === "NOUN" || t.tag === "SERVICE") {
      deps.push({ head: verb, dependent: t, relation: "subject" });
    }
  }

  for (let i = 0; i < afterVerb.length; i++) {
    const token = afterVerb[i];
    const next = afterVerb[i + 1];

    if (token.tag === "PREP" && next) {
      if (token.text === "to" || token.text === "into") {
        deps.push({ head: verb, dependent: next, relation: "destination" });
        i++;
      } else if (token.text === "from") {
        deps.push({ head: verb, dependent: next, relation: "source" });
        i++;
      } else if (token.text === "on" || token.text === "in" || token.text === "at") {
        deps.push({ head: verb, dependent: next, relation: "location" });
        i++;
      }
    } else if (token.tag === "SERVICE" || token.tag === "NOUN" || token.tag === "PATH") {
      deps.push({ head: verb, dependent: token, relation: "object" });
    } else if (token.tag === "NUMBER") {
      deps.push({ head: verb, dependent: token, relation: "quantity" });
    } else if (token.tag === "ADJ" && next) {
      deps.push({ head: next, dependent: token, relation: "modifier" });
    }
  }

  return deps;
}

// ─── Concept Graph ───────────────────────────────────────────────────────────

export interface ConceptNode {
  id: string;
  label: string;
  type: "action" | "entity" | "property" | "location" | "quantity";
  aliases: string[];
}

export interface ConceptEdge {
  from: string;
  to: string;
  relation: "acts_on" | "located_at" | "has_property" | "quantity_of" | "destination" | "source";
}

export interface ConceptGraph {
  nodes: ConceptNode[];
  edges: ConceptEdge[];
}

export function buildConceptGraph(tokens: Token[], deps: Dependency[]): ConceptGraph {
  const nodes: ConceptNode[] = [];
  const edges: ConceptEdge[] = [];
  const seen = new Set<string>();

  function addNode(token: Token, type: ConceptNode["type"]): string {
    const id = `${token.tag}_${token.normalized ?? token.text}`;
    if (!seen.has(id)) {
      seen.add(id);
      nodes.push({
        id,
        label: token.normalized ?? token.text,
        type,
        aliases: token.normalized ? [token.text] : [],
      });
    }
    return id;
  }

  const verb = tokens.find((t) => t.tag === "VERB");
  if (verb) addNode(verb, "action");

  for (const token of tokens) {
    if (token.tag === "SERVICE" || token.tag === "NOUN") addNode(token, "entity");
    if (token.tag === "ENV") addNode(token, "location");
    if (token.tag === "PATH") addNode(token, "entity");
    if (token.tag === "NUMBER") addNode(token, "quantity");
    if (token.tag === "ADJ") addNode(token, "property");
  }

  for (const dep of deps) {
    const fromId = `${dep.head.tag}_${dep.head.normalized ?? dep.head.text}`;
    const toId = `${dep.dependent.tag}_${dep.dependent.normalized ?? dep.dependent.text}`;

    let relation: ConceptEdge["relation"];
    switch (dep.relation) {
      case "object":
      case "subject":
        relation = "acts_on";
        break;
      case "location":
        relation = "located_at";
        break;
      case "destination":
        relation = "destination";
        break;
      case "source":
        relation = "source";
        break;
      case "quantity":
        relation = "quantity_of";
        break;
      case "modifier":
        relation = "has_property";
        break;
    }

    edges.push({ from: fromId, to: toId, relation });
  }

  return { nodes, edges };
}

// ─── High-level NLP Utilities ────────────────────────────────────────────────

/**
 * Extract verbs in their root/infinitive form using compromise.
 */
export function extractVerbs(text: string): string[] {
  const doc = nlp(text);
  const verbs = doc.verbs().toInfinitive();
  return verbs.out("array") as string[];
}

/**
 * Extract nouns using compromise.
 */
export function extractNouns(text: string): string[] {
  const doc = nlp(text);
  return doc.nouns().out("array") as string[];
}

/**
 * Normalize text — lowercase, expand contractions, normalize whitespace.
 */
export function normalizeText(text: string): string {
  const doc = nlp(text);
  // Expand contractions: don't → do not
  doc.contractions().expand();
  return doc.text("normal");
}

/**
 * Get sentence structure analysis from compromise.
 */
export function analyzeSentence(text: string): {
  verbs: string[];
  nouns: string[];
  adjectives: string[];
  prepositions: string[];
  isQuestion: boolean;
  isNegative: boolean;
  tense: string;
} {
  const doc = nlp(text);

  return {
    verbs: doc.verbs().toInfinitive().out("array") as string[],
    nouns: doc.nouns().out("array") as string[],
    adjectives: doc.adjectives().out("array") as string[],
    prepositions: (doc.match("#Preposition").out("array") as string[]),
    isQuestion: doc.questions().length > 0,
    isNegative: doc.has("#Negative"),
    tense: detectTense(doc),
  };
}

function detectTense(doc: ReturnType<typeof nlp>): string {
  if (doc.has("#PastTense")) return "past";
  if (doc.has("#FutureTense")) return "future";
  if (doc.has("#Imperative")) return "imperative";
  return "present";
}

// ─── Semantic Parse Result ───────────────────────────────────────────────────

export interface SemanticParse {
  tokens: Token[];
  dependencies: Dependency[];
  graph: ConceptGraph;
  action?: string;
  actionRoot?: string;
  entities: Array<{ text: string; type: string; normalized?: string }>;
  location?: string;
  destination?: string;
  source?: string;
  quantity?: number;
  sentence: ReturnType<typeof analyzeSentence>;
}

export function semanticParse(
  text: string,
  knownServices: string[],
  knownEnvironments: string[]
): SemanticParse {
  const tokens = tokenize(text, knownServices, knownEnvironments);
  const dependencies = parseDependencies(tokens);
  const graph = buildConceptGraph(tokens, dependencies);
  const sentence = analyzeSentence(text);

  const actionToken = tokens.find((t) => t.tag === "VERB");
  const entities = tokens
    .filter((t) => ["SERVICE", "NOUN", "PATH"].includes(t.tag))
    .map((t) => ({ text: t.text, type: t.tag, normalized: t.normalized }));

  const locationDep = dependencies.find((d) => d.relation === "location");
  const destDep = dependencies.find((d) => d.relation === "destination");
  const srcDep = dependencies.find((d) => d.relation === "source");
  const qtyDep = dependencies.find((d) => d.relation === "quantity");

  return {
    tokens,
    dependencies,
    graph,
    action: actionToken?.normalized ?? actionToken?.text,
    actionRoot: actionToken?.root ?? sentence.verbs[0],
    entities,
    location: locationDep?.dependent.normalized ?? locationDep?.dependent.text,
    destination: destDep?.dependent.normalized ?? destDep?.dependent.text,
    source: srcDep?.dependent.normalized ?? srcDep?.dependent.text,
    quantity: qtyDep ? Number(qtyDep.dependent.text) : undefined,
    sentence,
  };
}
