/**
 * Build intent vectors from intents.json.
 *
 * Generates config/intent-vectors.json with TF-IDF vectors
 * for each intent, computed from synonyms + examples + description.
 *
 * Run: node scripts/build-vectors.mjs
 */

import { readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, "..");

const intents = JSON.parse(readFileSync(resolve(ROOT, "packages/core/config/intents.json"), "utf-8")).intents;

// ─── Tokenizer ───────────────────────────────────────────────────────────────

const STOP_WORDS = new Set([
  "a", "an", "the", "is", "it", "in", "on", "to", "for", "of", "and", "or",
  "my", "me", "i", "we", "you", "do", "does", "did", "be", "am", "are", "was",
  "were", "been", "being", "have", "has", "had", "this", "that", "these",
  "those", "what", "which", "who", "whom", "how", "where", "when", "why",
  "not", "no", "but", "if", "so", "at", "by", "with", "from", "up", "out",
  "can", "could", "would", "should", "will", "shall", "may", "might",
  "just", "about", "all", "also", "each", "every", "some", "any", "please",
]);

function tokenize(text) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9_.\-\/]/g, " ")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

// ─── Build corpus ────────────────────────────────────────────────────────────

// Collect all text for each intent
const intentDocs = intents.map((intent) => {
  const texts = [
    intent.description,
    ...intent.synonyms,
    ...intent.examples,
    intent.name.replace(/\./g, " "),
  ];
  const tokens = texts.flatMap((t) => tokenize(t));
  return { name: intent.name, tokens };
});

// Build document frequency (how many intents contain each term)
const df = new Map();
for (const doc of intentDocs) {
  const unique = new Set(doc.tokens);
  for (const term of unique) {
    df.set(term, (df.get(term) ?? 0) + 1);
  }
}

const N = intentDocs.length;

// ─── Compute TF-IDF vectors ─────────────────────────────────────────────────

// Get the full vocabulary (only terms that appear in 2+ intents are less useful,
// but terms unique to 1 intent are very discriminative)
const vocab = [...df.keys()].sort();
const vocabIndex = new Map(vocab.map((v, i) => [v, i]));

console.log(`Intents: ${N}`);
console.log(`Vocabulary: ${vocab.length} terms`);

const vectors = {};

for (const doc of intentDocs) {
  // Term frequency
  const tf = new Map();
  for (const token of doc.tokens) {
    tf.set(token, (tf.get(token) ?? 0) + 1);
  }

  // TF-IDF: tf * log(N / df)
  // Only store non-zero entries (sparse vector)
  const sparse = {};
  let magnitude = 0;

  for (const [term, count] of tf) {
    const idf = Math.log(N / (df.get(term) ?? 1));
    const tfidf = count * idf;
    if (tfidf > 0) {
      const idx = vocabIndex.get(term);
      if (idx !== undefined) {
        sparse[idx] = Math.round(tfidf * 1000) / 1000; // 3 decimal places
        magnitude += tfidf * tfidf;
      }
    }
  }

  // Normalize to unit vector
  magnitude = Math.sqrt(magnitude);
  if (magnitude > 0) {
    for (const idx of Object.keys(sparse)) {
      sparse[idx] = Math.round((sparse[idx] / magnitude) * 1000) / 1000;
    }
  }

  vectors[doc.name] = sparse;
}

// ─── Write output ────────────────────────────────────────────────────────────

const output = {
  version: "1.0",
  builtAt: new Date().toISOString(),
  intentCount: N,
  vocabSize: vocab.length,
  vocab,
  vectors,
};

const outPath = resolve(ROOT, "packages/core/config/intent-vectors.json");
writeFileSync(outPath, JSON.stringify(output));

// Show stats
const totalEntries = Object.values(vectors).reduce((s, v) => s + Object.keys(v).length, 0);
const fileSize = Buffer.byteLength(JSON.stringify(output));
console.log(`Sparse entries: ${totalEntries} (avg ${Math.round(totalEntries / N)} per intent)`);
console.log(`Output: ${outPath} (${(fileSize / 1024).toFixed(1)} KB)`);
console.log("Done.");
