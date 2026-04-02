import type { ParsedCommand } from "../types/intent.js";
import { parseByRules } from "./ruleParser.js";
import { parseByLLM } from "./llmParser.js";
import { disambiguate } from "./disambiguate.js";
import { logFailure } from "../utils/logger.js";
import { lookupUnknownNouns } from "./wikidata.js";
import { routeByConcepts } from "./conceptRouter.js";
import { parseMultiIntent, type MultiIntentPlan } from "./multiIntent.js";
import { isAffirmation, consumePendingAction } from "../conversation/pendingActions.js";

/** Result from parseIntent — may contain a multi-step plan */
export type { MultiIntentPlan };

export async function parseIntent(rawText: string): Promise<ParsedCommand & { plan?: MultiIntentPlan }> {
  // Stage -1: check if user is affirming a pending action ("ok", "try it", "do it")
  if (isAffirmation(rawText)) {
    const pending = consumePendingAction();
    if (pending) {
      if (pending.type === "intent") {
        // Re-parse the suggested action
        const reParsed = parseByRules(pending.action);
        if (reParsed && reParsed.confidence >= 0.5) {
          return disambiguate(reParsed);
        }
      }
      // For command type or failed re-parse, treat as the action text
      return disambiguate({
        intent: pending.action.includes(".") ? pending.action : "unknown",
        rawText: pending.action,
        confidence: 0.8,
        fields: pending.fields ?? {},
      });
    }
  }

  // Stage 0: check for compound sentences (multi-intent)
  // "check disk and show me containers and list crontabs"
  const multiPlan = parseMultiIntent(rawText);
  if (!multiPlan.isSingleIntent && multiPlan.steps.length >= 2) {
    // Return the first step as the primary intent, attach the full plan
    const firstStep = multiPlan.steps[0];
    const result = disambiguate({
      intent: firstStep.intent,
      rawText,
      confidence: firstStep.confidence,
      fields: {},
    });
    return { ...result, plan: multiPlan };
  }

  // Stage 1: deterministic rule parser (synonym matching + spell correction)
  const ruleResult = parseByRules(rawText);
  if (ruleResult && ruleResult.confidence >= 0.7) {
    return disambiguate(ruleResult);
  }

  // Stage 2: concept router — understands topics/domains, not just phrases
  // Handles: "is this offline or cloud", "check my crontabs", etc.
  const conceptResult = routeByConcepts(rawText);
  if (conceptResult && conceptResult.confidence >= 0.6) {
    return disambiguate({
      intent: conceptResult.intent,
      rawText,
      confidence: conceptResult.confidence,
      fields: {},
    });
  }

  // Stage 3: LLM fallback
  const llmResult = await parseByLLM(rawText);
  if (llmResult && llmResult.confidence >= 0.5) {
    return disambiguate(llmResult);
  }

  // Stage 4: if rule parser had a low-confidence result, use it anyway
  if (ruleResult) {
    return disambiguate(ruleResult);
  }

  // Stage 4: check if the input looks like a "what is X" knowledge query
  // If it contains unknown nouns, try Wikidata lookup and route to knowledge.lookup
  const looksLikeQuestion = /^(what|who|tell|define|explain|info|facts|learn)\b/i.test(rawText.trim());
  if (looksLikeQuestion) {
    const topic = rawText.replace(/^(what|who)\s+(is|are|was|were)\s+/i, "")
      .replace(/^(tell me about|define|explain|info about|facts about|learn about)\s+/i, "")
      .replace(/\?$/, "").trim();
    if (topic.length >= 2) {
      return disambiguate({
        intent: "knowledge.lookup",
        rawText,
        confidence: 0.6,
        fields: { topic },
      });
    }
  }

  // Stage 5: for completely unknown input, try to identify unknown nouns via Wikidata
  // and attach the context to the unknown result so the user gets useful info
  const words = rawText.toLowerCase().split(/\s+/);
  let wikiContext: string | undefined;
  try {
    const entities = await lookupUnknownNouns(words);
    if (entities.length > 0) {
      wikiContext = entities.map(e => `${e.label}: ${e.description}`).join("; ");
    }
  } catch {}

  // Stage 6: unknown — log the failure for auto-learning
  logFailure({
    rawText,
    timestamp: new Date().toISOString(),
    parsedIntent: null,
    confidence: 0,
    error: "No parser matched",
  });

  return disambiguate({
    intent: "unknown",
    rawText,
    confidence: 0,
    fields: {
      reason: "No supported intent matched",
      ...(wikiContext ? { wikiContext } : {}),
    },
  });
}
