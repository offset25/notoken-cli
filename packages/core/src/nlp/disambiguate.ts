import type { DynamicIntent, ParsedCommand } from "../types/intent.js";
import { getIntentDef } from "../utils/config.js";
import { loadRules } from "../utils/config.js";

const CONFIDENCE_THRESHOLD = 0.6;

export function disambiguate(intent: DynamicIntent): ParsedCommand {
  const def = getIntentDef(intent.intent);
  const missingFields: string[] = [];
  const ambiguousFields: Array<{ field: string; candidates: string[] }> = [];

  if (def) {
    for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
      if (fieldDef.required && intent.fields[fieldName] === undefined) {
        missingFields.push(fieldName);
      }
    }

    // Check for ambiguous service references
    for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
      if (fieldDef.type === "service" && intent.fields[fieldName]) {
        const candidates = findServiceCandidates(intent.fields[fieldName] as string);
        if (candidates.length > 1) {
          ambiguousFields.push({ field: fieldName, candidates });
        }
      }
    }
  }

  const needsClarification =
    missingFields.length > 0 ||
    ambiguousFields.length > 0 ||
    intent.confidence < CONFIDENCE_THRESHOLD;

  return {
    intent,
    missingFields,
    ambiguousFields,
    needsClarification,
  };
}

function findServiceCandidates(input: string): string[] {
  const rules = loadRules();
  const matches: string[] = [];

  for (const [canonical, aliases] of Object.entries(rules.serviceAliases)) {
    for (const alias of aliases) {
      if (alias.includes(input) || input.includes(alias)) {
        matches.push(canonical);
        break;
      }
    }
  }

  return matches;
}
