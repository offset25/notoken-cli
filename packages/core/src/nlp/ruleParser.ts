import type { DynamicIntent, EnvironmentName, IntentDef } from "../types/intent.js";
import { loadRules, loadIntents } from "../utils/config.js";
import { normalizePath } from "../utils/wslPaths.js";

export function parseByRules(rawText: string): DynamicIntent | null {
  const rules = loadRules();
  const intents = loadIntents();
  const text = rawText.trim().toLowerCase();

  // Pre-check: status queries → notoken.status (not knowledge.lookup or service.status)
  if (/^(what is |what's |show |check |give me )?(the )?(system |computer |machine |notoken )?status( of)?( this| the| my)?( machine| computer| system| server)?[?.!]?$/.test(text)
      || /^(how is |how's )?(this |the |my )?(system|machine|computer|server) doing/.test(text)
      || /^system status$/.test(text)) {
    const statusDef = intents.find(i => i.name === "notoken.status");
    if (statusDef) return { intent: "notoken.status", confidence: 0.95, rawText, fields: {} };
  }

  // Pre-check: "can you generate an image" → ai.generate_image (not ai.image_status)
  if (/^(can you|could you|are you able to|do you)\s+(generate|create|make|draw)\s+(an?\s+)?(image|picture|photo|art)/i.test(text)) {
    return { intent: "ai.generate_image", confidence: 0.9, rawText, fields: {} };
  }

  // Pre-check: "cd /path" → shell cd (change directory)
  const cdMatch = text.match(/^cd\s+(\/\S+|~\S*|\.\S*)$/);
  if (cdMatch) {
    return { intent: "shell.cd", confidence: 0.95, rawText, fields: { path: cdMatch[1] } };
  }

  // Pre-check: "what is in my documents/folder/drive" → dir.list
  const whatIsInMatch = text.match(/^(?:what is |what's |show me what(?:'s| is) )in (?:my |the |this )?(.*?)(?:\?|$)/);
  if (whatIsInMatch) {
    const target = whatIsInMatch[1].trim();
    // Resolve common folder names
    const folderMap: Record<string, string> = {
      "documents": process.platform === "win32" ? "%USERPROFILE%\\Documents" : "~/Documents",
      "documents folder": process.platform === "win32" ? "%USERPROFILE%\\Documents" : "~/Documents",
      "downloads": process.platform === "win32" ? "%USERPROFILE%\\Downloads" : "~/Downloads",
      "downloads folder": process.platform === "win32" ? "%USERPROFILE%\\Downloads" : "~/Downloads",
      "desktop": process.platform === "win32" ? "%USERPROFILE%\\Desktop" : "~/Desktop",
      "home": "~",
      "home folder": "~",
      "home directory": "~",
      "root": "/",
      "root folder": "/",
      "root c drive": "/mnt/c/",
      "c drive": "/mnt/c/",
      "d drive": "/mnt/d/",
      "e drive": "/mnt/e/",
    };
    const path = folderMap[target] ?? target;
    if (target.includes("drive")) {
      return { intent: "disk.scan", confidence: 0.9, rawText, fields: { path } };
    }
    return { intent: "dir.list", confidence: 0.9, rawText, fields: { path } };
  }

  // Pre-check: "what projects are on this drive" → project.scan
  if (/\bwhat projects\b.*\b(on|in)\b.*\b(this|the|my|c|d)\b/.test(text)) {
    return { intent: "project.scan", confidence: 0.9, rawText, fields: { path: "." } };
  }

  // Pre-check: "what's on this drive" / "show me whats on this drive" → disk.scan
  if (/\b(what.?s|show me what.?s|what is) on (this|the|my|c|d) drive\b/.test(text)
      || /\bshow me (this|the|my) drive\b/.test(text)) {
    return { intent: "disk.scan", confidence: 0.9, rawText, fields: {} };
  }

  // Pre-check: "what files" / "what are files in this folder" → dir.list or project.detect
  if (/^(what are |what's in |show me |list |show )(the )?(files|contents)( in| of)?( this| the| my| current)?( folder| directory| dir| project)?[?.!]?$/.test(text)
      || /^(show me |list )(project |all )?files$/.test(text)) {
    const isDirList = text.includes("folder") || text.includes("directory") || text.includes("dir");
    const intentName = isDirList ? "dir.list" : "project.detect";
    return { intent: intentName, confidence: 0.9, rawText, fields: { path: "." } };
  }

  // Pre-check: "how is openclaw doing" / "how is discord doing" → *.status
  const howIsMatch = text.match(/^how(?:'s| is| are) (openclaw|claw|discord|ollama|notoken) (?:doing|going|running|working)/);
  if (howIsMatch) {
    const target = howIsMatch[1] === "claw" ? "openclaw" : howIsMatch[1];
    const intentName = target === "notoken" ? "notoken.status" : `${target}.status`;
    return { intent: intentName, confidence: 0.9, rawText, fields: {} };
  }

  // Match intent by synonyms defined in intents.json
  const matched = matchIntent(text, intents);
  if (!matched) return null;

  const { def, matchedPhrase } = matched;

  // Extract fields based on the intent's field definitions
  const fields: Record<string, unknown> = {};
  let allRequiredFound = true;

  // First pass: extract typed fields (environment, service, number, branch)
  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    let value: unknown = undefined;

    switch (fieldDef.type) {
      case "environment":
        value = extractEnvironment(text, rules.environmentAliases);
        break;
      case "service":
        value = extractService(text, rules.serviceAliases, matchedPhrase);
        break;
      case "number":
        value = extractNumber(text);
        break;
      case "branch":
        value = extractBranch(text);
        break;
    }

    if (value !== undefined) {
      fields[fieldName] = value;
    }
  }

  // Second pass: extract string fields using context-aware extraction
  const stringFields = Object.entries(def.fields).filter(([, fd]) => fd.type === "string");
  if (stringFields.length > 0) {
    const extracted = extractStringFields(rawText, text, matchedPhrase, stringFields.map(([n]) => n), fields);
    for (const [k, v] of Object.entries(extracted)) {
      if (v !== undefined) fields[k] = v;
    }
  }

  // Apply defaults for missing fields
  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    if (fields[fieldName] === undefined && fieldDef.default !== undefined) {
      fields[fieldName] = fieldDef.default;
    }
    if (fields[fieldName] === undefined && fieldDef.required) {
      allRequiredFound = false;
    }
  }

  // Resolve logPaths if the intent uses them
  if (def.logPaths && fields.service) {
    const logPath = def.logPaths[fields.service as string];
    if (logPath) fields.logPath = logPath;
  }

  // Confidence scoring
  let confidence = 0.7;
  if (allRequiredFound) confidence += 0.15;
  if (matchedPhrase.length > 4) confidence += 0.05;
  confidence = Math.min(confidence, 0.95);

  return {
    intent: def.name,
    confidence,
    rawText,
    fields,
  };
}

/**
 * Extract string fields from natural language using preposition patterns.
 *
 * Handles patterns like:
 *   "copy nginx.conf to /root"       → source=nginx.conf, destination=/root
 *   "move app.log to /backup"        → source=app.log, destination=/backup
 *   "grep error in /var/log"         → query=error, path=/var/log
 *   "find *.conf in /etc"            → pattern=*.conf, path=/etc
 */
function extractStringFields(
  rawText: string,
  lowerText: string,
  matchedPhrase: string,
  fieldNames: string[],
  alreadyExtracted: Record<string, unknown>
): Record<string, string | undefined> {
  const result: Record<string, string | undefined> = {};

  // Remove the matched intent phrase and known extracted values from text
  let remaining = lowerText.replace(matchedPhrase, " ");
  for (const [, v] of Object.entries(alreadyExtracted)) {
    if (typeof v === "string") {
      remaining = remaining.replace(v, " ");
    }
  }
  remaining = remaining.replace(/\s+/g, " ").trim();

  // Strip filler words that aren't meaningful field values
  remaining = remaining.replace(/^(can you |could you |would you |please |hey |yo |just )+/i, "").trim();
  remaining = remaining.replace(/\b(please|for me|for errors|for issues)\b/gi, "").trim();
  remaining = remaining.replace(/\s+/g, " ").trim();

  // Check for quoted strings first
  const quoted = rawText.match(/["']([^"']+)["']/g);
  if (quoted) {
    for (let i = 0; i < Math.min(quoted.length, fieldNames.length); i++) {
      result[fieldNames[i]] = quoted[i].replace(/["']/g, "");
    }
    return result;
  }

  // For source/destination patterns (copy X to Y, move X to Y)
  if (fieldNames.includes("source") && fieldNames.includes("destination")) {
    const toMatch = remaining.match(/(.+?)\s+to\s+(.+)/);
    if (toMatch) {
      result.source = extractPathOrFilename(toMatch[1].trim());
      result.destination = extractPathOrFilename(toMatch[2].trim());
      return result;
    }
  }

  // For query/path patterns (grep X in Y, search X in Y, Y for X)
  if (fieldNames.includes("query") && fieldNames.includes("path")) {
    // "X in Y"
    const inMatch = remaining.match(/(.+?)\s+in\s+(.+)/);
    if (inMatch) {
      result.query = inMatch[1].trim().replace(/^(for|the)\s+/, "");
      result.path = extractPathOrFilename(inMatch[2].trim());
      return result;
    }
    // "Y for X" (path first, query second)
    const forMatch = remaining.match(/(.+?)\s+for\s+(.+)/);
    if (forMatch) {
      const left = forMatch[1].trim();
      const right = forMatch[2].trim();
      // If left looks like a path, it's path+query. Otherwise query+path.
      if (left.includes("/") || left.includes(".")) {
        result.path = extractPathOrFilename(left);
        result.query = right.replace(/^(the)\s+/, "");
      } else {
        result.query = left.replace(/^(the)\s+/, "");
        result.path = extractPathOrFilename(right);
      }
      return result;
    }
    // Split by path-like token: anything with / or . is path, rest is query
    const words = remaining.split(/\s+/).filter((w) => !isStopWord(w));
    const pathWord = words.find((w) => w.includes("/") || (w.includes(".") && w.length > 3));
    if (pathWord) {
      result.path = pathWord;
      result.query = words.filter((w) => w !== pathWord).join(" ") || undefined;
      return result;
    }
    if (words.length > 0) {
      result.query = words[0];
    }
    return result;
  }

  // For pattern/path patterns (find X in Y)
  if (fieldNames.includes("pattern") && fieldNames.includes("path")) {
    const inMatch = remaining.match(/(.+?)\s+in\s+(.+)/);
    if (inMatch) {
      result.pattern = extractPathOrFilename(inMatch[1].trim());
      result.path = extractPathOrFilename(inMatch[2].trim());
      return result;
    }
  }

  // For single target field (delete X, kill X)
  if (fieldNames.length === 1) {
    const words = remaining.split(/\s+/).filter((w) => !isStopWord(w));
    const pathLike = words.find((w) => w.includes("/") || w.includes("."));
    result[fieldNames[0]] = pathLike ?? words[0];
    return result;
  }

  // Generic: assign remaining words to fields in order
  const words = remaining.split(/\s+/).filter((w) => !isStopWord(w));
  for (let i = 0; i < Math.min(words.length, fieldNames.length); i++) {
    result[fieldNames[i]] = words[i];
  }

  return result;
}

function extractPathOrFilename(text: string): string {
  const cleaned = text.replace(/^(the|this|that|a|an|file|directory|dir|folder)\s+/gi, "").trim();
  const words = cleaned.split(/\s+/);
  // Find the most path-like word (Linux or Windows paths)
  const pathWord = words.find((w) =>
    w.includes("/") || w.includes("\\") || w.includes(".") || /^[A-Za-z]:/.test(w)
  );
  const result = pathWord ?? words[0] ?? cleaned;
  // Normalize Windows paths to Linux in WSL
  return normalizePath(result);
}

function isStopWord(word: string): boolean {
  return ["the", "a", "an", "this", "that", "on", "in", "at", "for", "from", "with", "of", "file", "files"].includes(word);
}

function matchIntent(
  text: string,
  intents: IntentDef[]
): { def: IntentDef; matchedPhrase: string } | null {
  let best: { def: IntentDef; matchedPhrase: string; length: number } | null = null;

  // Pass 1: exact substring match (fast path)
  for (const def of intents) {
    for (const phrase of def.synonyms) {
      if (text.includes(phrase)) {
        if (!best || phrase.length > best.length) {
          best = { def, matchedPhrase: phrase, length: phrase.length };
        }
      }
    }
  }

  if (best) return { def: best.def, matchedPhrase: best.matchedPhrase };

  // Pass 2: fuzzy/spell-corrected match — correct typos in user input
  // then retry matching. Only for single/double-word synonyms to avoid
  // false positives on long phrases.
  const corrected = spellCorrectText(text, intents);
  if (corrected !== text) {
    for (const def of intents) {
      for (const phrase of def.synonyms) {
        if (corrected.includes(phrase)) {
          if (!best || phrase.length > best.length) {
            best = { def, matchedPhrase: phrase, length: phrase.length };
          }
        }
      }
    }
  }

  return best ? { def: best.def, matchedPhrase: best.matchedPhrase } : null;
}

/**
 * Spell-correct text by replacing unknown words with the closest known synonym word.
 * Uses Levenshtein distance with a max edit distance of 2.
 */
function spellCorrectText(text: string, intents: IntentDef[]): string {
  // Build vocabulary from all synonyms
  const vocab = new Set<string>();
  for (const def of intents) {
    for (const phrase of def.synonyms) {
      for (const word of phrase.split(/\s+/)) {
        if (word.length >= 3) vocab.add(word);
      }
    }
  }

  const words = text.split(/\s+/);
  let changed = false;
  const correctedWords = words.map(word => {
    if (word.length < 3) return word;
    if (vocab.has(word)) return word; // already a known word

    // Find closest vocabulary word
    let bestWord = word;
    let bestDist = Infinity;
    const maxDist = word.length <= 4 ? 1 : 2;

    for (const candidate of vocab) {
      // Quick length check — edit distance can't be less than length difference
      if (Math.abs(candidate.length - word.length) > maxDist) continue;
      const dist = editDistance(word, candidate);
      if (dist <= maxDist && dist < bestDist) {
        bestDist = dist;
        bestWord = candidate;
      }
    }

    if (bestWord !== word) changed = true;
    return bestWord;
  });

  return changed ? correctedWords.join(" ") : text;
}

function editDistance(a: string, b: string): number {
  const m = a.length, n = b.length;
  if (m === 0) return n;
  if (n === 0) return m;
  const dp: number[] = Array.from({ length: n + 1 }, (_, i) => i);
  for (let i = 1; i <= m; i++) {
    let prev = dp[0];
    dp[0] = i;
    for (let j = 1; j <= n; j++) {
      const tmp = dp[j];
      dp[j] = a[i - 1] === b[j - 1] ? prev : 1 + Math.min(prev, dp[j], dp[j - 1]);
      prev = tmp;
    }
  }
  return dp[n];
}

function extractEnvironment(
  text: string,
  aliases: Record<string, string[]>
): EnvironmentName | undefined {
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`);
      if (pattern.test(text)) return canonical as EnvironmentName;
    }
  }
  return undefined;
}

function extractService(
  text: string,
  aliases: Record<string, string[]>,
  intentPhrase: string
): string | undefined {
  const cleaned = text.replace(intentPhrase, " ").trim();
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`);
      if (pattern.test(cleaned)) return canonical;
    }
  }
  for (const [canonical, aliasList] of Object.entries(aliases)) {
    for (const alias of aliasList) {
      const pattern = new RegExp(`\\b${escapeRegex(alias)}\\b`);
      if (pattern.test(text)) return canonical;
    }
  }
  return undefined;
}

function extractNumber(text: string): number | undefined {
  const match = text.match(/\b(\d+)\b/);
  return match ? Number(match[1]) : undefined;
}

function extractBranch(text: string): string | undefined {
  const match = text.match(/\b(main|master|develop|release\/[a-z0-9._-]+)\b/);
  return match?.[1];
}

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
