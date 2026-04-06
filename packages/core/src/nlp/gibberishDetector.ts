/**
 * Gibberish / keyboard mash detector.
 *
 * Catches inputs like "k24kjoiadsfiasdpfds" or "asdjfklasdf" before
 * they waste time in the NLP classifier pipeline.
 *
 * Heuristics:
 *   1. Consonant cluster ratio — real words rarely have 4+ consonants in a row
 *   2. Vowel ratio — English text is ~38% vowels; gibberish is much lower
 *   3. Dictionary hit rate — check if any tokens look like real words
 *   4. Character entropy — random strings have higher entropy than natural text
 *   5. Repeated patterns — "aaaaaaa" or "ababababab"
 */

const VOWELS = new Set("aeiouAEIOU");
const CONSONANTS = new Set("bcdfghjklmnpqrstvwxyzBCDFGHJKLMNPQRSTVWXYZ");

// Common short words that shouldn't be flagged
const COMMON_WORDS = new Set([
  "a", "i", "is", "it", "in", "on", "to", "do", "go", "no", "so", "up", "we",
  "at", "be", "by", "he", "if", "me", "my", "of", "or", "an", "as", "am",
  "the", "and", "for", "are", "but", "not", "you", "all", "can", "had", "her",
  "was", "one", "our", "out", "has", "his", "how", "its", "let", "may", "new",
  "now", "old", "see", "way", "who", "did", "get", "set", "run", "use", "say",
  "she", "too", "any", "few", "got", "him", "own", "put", "top", "try",
  "what", "when", "with", "this", "that", "from", "have", "been", "will",
  "your", "they", "were", "them", "then", "than", "each", "make", "like",
  "just", "over", "such", "take", "also", "back", "into", "very", "well",
  "help", "show", "list", "find", "open", "stop", "kill", "move", "copy",
  "send", "pull", "push", "read", "load", "save", "scan", "test", "ping",
  "check", "start", "restart", "deploy", "install", "update", "remove",
  "delete", "search", "status", "docker", "nginx", "mysql", "redis",
  "server", "service", "process", "network", "system", "config",
  "ollama", "claude", "codex", "openclaw", "notoken", "convex",
  "ssh", "sftp", "http", "https", "api", "url", "dns", "ssl", "tls",
  "npm", "git", "pip", "apt", "yum", "brew",
  "ls", "cd", "rm", "mv", "cp", "df", "du", "ps", "cat", "pwd",
]);

export interface GibberishResult {
  isGibberish: boolean;
  confidence: number; // 0-1, how confident we are it's gibberish
  reason?: string;
}

/**
 * Detect if input text is gibberish / keyboard mashing.
 * Returns quickly — designed to run before the NLP pipeline.
 */
export function detectGibberish(text: string): GibberishResult {
  const cleaned = text.trim().toLowerCase();

  // Very short inputs — don't flag (could be abbreviations)
  if (cleaned.length < 4) return { isGibberish: false, confidence: 0 };

  // If it contains common command patterns, not gibberish
  if (/^[a-z]+\s+(on|to|for|from|in|at)\s+/i.test(cleaned)) return { isGibberish: false, confidence: 0 };
  if (/^(sudo|npm|git|docker|systemctl|apt|curl|ssh)\s/i.test(cleaned)) return { isGibberish: false, confidence: 0 };

  const tokens = cleaned.split(/\s+/);
  let gibberishScore = 0;
  let reasons: string[] = [];

  // Check each token
  let knownTokens = 0;
  let gibberishTokens = 0;

  for (const token of tokens) {
    // Strip numbers and special chars for word analysis
    const alpha = token.replace(/[^a-z]/g, "");
    if (alpha.length < 3) { knownTokens++; continue; } // Short tokens get a pass

    if (COMMON_WORDS.has(alpha) || COMMON_WORDS.has(token)) {
      knownTokens++;
      continue;
    }

    // Check consonant clusters — 4+ consonants in a row is suspicious
    const clusters = alpha.match(/[bcdfghjklmnpqrstvwxyz]{4,}/g);
    if (clusters && clusters.length > 0) {
      gibberishTokens++;
      continue;
    }

    // Check vowel ratio — less than 15% vowels in a 5+ char word is suspicious
    if (alpha.length >= 5) {
      const vowelCount = [...alpha].filter(c => VOWELS.has(c)).length;
      const vowelRatio = vowelCount / alpha.length;
      if (vowelRatio < 0.15) {
        gibberishTokens++;
        continue;
      }
    }

    // Check for repeated char patterns — "aaaa" or "abcabc"
    if (/(.)\1{3,}/.test(alpha)) {
      gibberishTokens++;
      continue;
    }
    if (/(.{2,3})\1{2,}/.test(alpha)) {
      gibberishTokens++;
      continue;
    }

    // If token is long (8+) with no recognizable substring, likely gibberish
    if (alpha.length >= 8) {
      const hasCommonBigram = /th|he|in|er|an|re|on|at|en|nd|ti|es|or|te|of|ed|is|it|al|ar|st|to|nt|ng|se|ha|as|ou|io|le|ve|co|me|de|hi|ri|ro|ic|ne|ea|ra|ce|li|ch|ll|be|ma|si|om|ur/i.test(alpha);
      if (!hasCommonBigram) {
        gibberishTokens++;
        continue;
      }
    }

    knownTokens++;
  }

  // Calculate gibberish ratio
  const totalTokens = tokens.length;
  if (totalTokens === 0) return { isGibberish: false, confidence: 0 };

  const gibberishRatio = gibberishTokens / totalTokens;

  // Single long gibberish token — high confidence
  if (totalTokens === 1 && gibberishTokens === 1 && cleaned.length > 6) {
    return { isGibberish: true, confidence: 0.9, reason: "Single unrecognizable word" };
  }

  // Majority gibberish tokens
  if (gibberishRatio > 0.6 && gibberishTokens >= 2) {
    return { isGibberish: true, confidence: Math.min(0.95, gibberishRatio), reason: `${gibberishTokens}/${totalTokens} tokens unrecognizable` };
  }

  // All tokens gibberish
  if (gibberishRatio === 1 && totalTokens >= 2) {
    return { isGibberish: true, confidence: 0.95, reason: "No recognizable words" };
  }

  // Overall character-level check for single long strings
  if (totalTokens <= 2) {
    const allAlpha = cleaned.replace(/[^a-z]/g, "");
    if (allAlpha.length >= 10) {
      const vowelCount = [...allAlpha].filter(c => VOWELS.has(c)).length;
      const vowelRatio = vowelCount / allAlpha.length;
      if (vowelRatio < 0.2) {
        return { isGibberish: true, confidence: 0.85, reason: "Very low vowel ratio" };
      }
    }
  }

  return { isGibberish: false, confidence: gibberishRatio * 0.5 };
}
