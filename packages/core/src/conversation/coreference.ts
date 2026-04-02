import type { Conversation, ConversationTurn, KnowledgeNode } from "./store.js";
import { getLastEntity, getRecentTurns } from "./store.js";
import type { DynamicIntent } from "../types/intent.js";

/**
 * Coreference resolver.
 *
 * Resolves pronouns and references like:
 *   "do it again"          → repeat last command
 *   "same but on prod"     → last command with environment changed
 *   "that service"         → most recent service entity
 *   "it"                   → most recent object/service
 *   "do that on staging"   → last intent with env=staging
 *   "restart it"           → restart + most recent service
 *   "check the same one"   → most recent service/target
 */

// Patterns that signal a reference to a previous turn
const REPEAT_PATTERNS = [
  /^(do it|do that|run it|run that|same thing|again|repeat|redo|re-?run|try again|retry|one more time|run again|do it again|try that again|go again|try it now|try now|try it|let.?s try|give it another|another try)\b/i,
  /^same\b/i,
];

const PRONOUN_PATTERNS: Array<{ pattern: RegExp; refType: "service" | "environment" | "path" | "any"; offset?: number }> = [
  { pattern: /\bit\b/i, refType: "any" },
  { pattern: /\bthat service\b/i, refType: "service" },
  { pattern: /\bthat server\b/i, refType: "service" },
  { pattern: /\bthe same (one|service|server|thing)\b/i, refType: "service" },
  { pattern: /\bthat (file|path|directory)\b/i, refType: "path" },
  { pattern: /\bthere\b/i, refType: "environment" },
  { pattern: /\bthat (env|environment|box|machine)\b/i, refType: "environment" },
  // "the other" — refers to the second-most-recent entity (not the one we just acted on)
  { pattern: /\bthe other (one|service|server|thing)\b/i, refType: "service", offset: 1 },
  { pattern: /\bthe other (env|environment|box|machine|server)\b/i, refType: "environment", offset: 1 },
  { pattern: /\bthe other\b/i, refType: "any", offset: 1 },
  { pattern: /\bnot that one\b/i, refType: "any", offset: 1 },
  { pattern: /\bnot this one\b/i, refType: "any", offset: 1 },
  { pattern: /\bno not this one\b/i, refType: "any", offset: 1 },
  { pattern: /\bno not that one\b/i, refType: "any", offset: 1 },
  { pattern: /\bnot that\b/i, refType: "any", offset: 1 },
  { pattern: /\bthe previous one\b/i, refType: "any", offset: 1 },
  { pattern: /\bthe one before\b/i, refType: "any", offset: 1 },
  { pattern: /\bthe first one\b/i, refType: "any", offset: 1 },
];

const OVERRIDE_PATTERNS: Array<{ pattern: RegExp; field: string }> = [
  { pattern: /\bbut (?:on|in) (\w+)\b/i, field: "environment" },
  { pattern: /\binstead (?:on|in) (\w+)\b/i, field: "environment" },
  { pattern: /\bon (\w+) instead\b/i, field: "environment" },
  { pattern: /\bbut (?:for|with) (\w+)\b/i, field: "service" },
  { pattern: /\binstead (?:of )?(\w+)\b/i, field: "service" },
];

export interface CoreferenceResult {
  /** The resolved text after pronoun replacement */
  resolvedText: string;
  /** Whether this is a repeat/reference to a previous command */
  isReference: boolean;
  /** The intent to use (from previous turn if reference) */
  resolvedIntent?: DynamicIntent;
  /** What was resolved and how */
  resolutions: Array<{
    original: string;
    resolved: string;
    source: "last_turn" | "knowledge_tree" | "pronoun";
  }>;
}

/**
 * Resolve coreferences in user input using conversation history.
 */
export function resolveCoreferences(
  rawText: string,
  conv: Conversation
): CoreferenceResult {
  const resolutions: CoreferenceResult["resolutions"] = [];
  let resolvedText = rawText;
  let isReference = false;
  let resolvedIntent: DynamicIntent | undefined;

  const recentTurns = getRecentTurns(conv, 5);
  const lastUserTurn = recentTurns[recentTurns.length - 1];

  // 0. Check for "the other thing" / "try the other thing" — second-to-last command
  const otherThingPattern = /^(?:try |do |run )?the other (?:thing|one|command)\b/i;
  if (otherThingPattern.test(rawText.trim())) {
    isReference = true;
    const prevTurn = recentTurns[recentTurns.length - 2];
    if (prevTurn?.intent && prevTurn.fields) {
      resolvedIntent = {
        intent: prevTurn.intent,
        confidence: 0.8,
        rawText,
        fields: { ...prevTurn.fields },
      };
      resolvedText = prevTurn.rawText;
      resolutions.push({
        original: rawText,
        resolved: prevTurn.rawText,
        source: "last_turn",
      });
    }
    return { resolvedText, isReference, resolvedIntent, resolutions };
  }

  // 1. Check for full repeat patterns ("do it again", "same thing")
  for (const pattern of REPEAT_PATTERNS) {
    if (pattern.test(rawText.trim())) {
      isReference = true;

      if (lastUserTurn?.intent && lastUserTurn.fields) {
        // Check for override modifiers ("same but on prod")
        const overrides = extractOverrides(rawText);
        const fields = { ...lastUserTurn.fields, ...overrides };

        resolvedIntent = {
          intent: lastUserTurn.intent,
          confidence: 0.85,
          rawText,
          fields,
        };

        resolvedText = lastUserTurn.rawText;
        resolutions.push({
          original: rawText,
          resolved: lastUserTurn.rawText,
          source: "last_turn",
        });

        for (const [key, value] of Object.entries(overrides)) {
          resolutions.push({
            original: `override: ${key}`,
            resolved: String(value),
            source: "last_turn",
          });
        }
      }

      return { resolvedText, isReference, resolvedIntent, resolutions };
    }
  }

  // 2. Resolve pronouns ("restart it", "check that service", "the other one")
  for (const { pattern, refType, offset } of PRONOUN_PATTERNS) {
    const match = rawText.match(pattern);
    if (!match) continue;

    let resolved: KnowledgeNode | undefined;

    if (offset && offset > 0) {
      // "the other" — get the Nth entity (skip the most recent)
      const candidates = refType === "any"
        ? [...conv.knowledgeTree].sort((a, b) => b.lastMentioned - a.lastMentioned)
        : conv.knowledgeTree.filter(n => n.type === refType).sort((a, b) => b.lastMentioned - a.lastMentioned);
      resolved = candidates[offset]; // offset=1 means second-most-recent
    } else if (refType === "any") {
      // "it" → most recent service, then most recent entity
      resolved = getLastEntity(conv, "service")
        ?? getLastEntity(conv, "path")
        ?? getLastEntity(conv, "container");
    } else {
      resolved = getLastEntity(conv, refType);
    }

    if (resolved) {
      resolvedText = resolvedText.replace(match[0], resolved.entity);
      resolutions.push({
        original: match[0],
        resolved: resolved.entity,
        source: "knowledge_tree",
      });
    }
  }

  // 3. Check for override modifiers in non-repeat contexts
  // "restart nginx but on staging" → already has "restart nginx", just override env
  const overrides = extractOverrides(rawText);
  if (Object.keys(overrides).length > 0) {
    // Clean the override phrases from the text
    for (const { pattern } of OVERRIDE_PATTERNS) {
      resolvedText = resolvedText.replace(pattern, "").trim();
    }
  }

  return { resolvedText, isReference, resolvedIntent, resolutions };
}

/**
 * Extract field overrides from phrases like "but on prod", "instead on staging".
 */
function extractOverrides(text: string): Record<string, string> {
  const overrides: Record<string, string> = {};

  for (const { pattern, field } of OVERRIDE_PATTERNS) {
    const match = text.match(pattern);
    if (match?.[1]) {
      overrides[field] = match[1];
    }
  }

  return overrides;
}

/**
 * Extract entities from parsed fields for conversation tracking.
 */
export function extractEntitiesFromFields(
  fields: Record<string, unknown>
): Array<{ text: string; type: "service" | "environment" | "path" | "user" | "branch" | "container" | "unknown" }> {
  const entities: Array<{ text: string; type: "service" | "environment" | "path" | "user" | "branch" | "container" | "unknown" }> = [];

  const typeMap: Record<string, "service" | "environment" | "path" | "user" | "branch" | "container"> = {
    service: "service",
    environment: "environment",
    path: "path",
    source: "path",
    destination: "path",
    target: "path",
    username: "user",
    branch: "branch",
    container: "container",
  };

  for (const [key, value] of Object.entries(fields)) {
    if (value && typeof value === "string" && value.length > 0) {
      const type = typeMap[key] ?? "unknown";
      entities.push({ text: value, type });
    }
  }

  return entities;
}
