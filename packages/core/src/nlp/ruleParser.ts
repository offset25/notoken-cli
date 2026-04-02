import type { DynamicIntent, EnvironmentName, IntentDef } from "../types/intent.js";
import { loadRules, loadIntents } from "../utils/config.js";
import { normalizePath } from "../utils/wslPaths.js";

export function parseByRules(rawText: string): DynamicIntent | null {
  const rules = loadRules();
  const intents = loadIntents();
  const text = rawText.trim().toLowerCase();

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

  for (const def of intents) {
    for (const phrase of def.synonyms) {
      if (text.includes(phrase)) {
        if (!best || phrase.length > best.length) {
          best = { def, matchedPhrase: phrase, length: phrase.length };
        }
      }
    }
  }

  return best ? { def: best.def, matchedPhrase: best.matchedPhrase } : null;
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
