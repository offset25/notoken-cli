import type { ParsedCommand } from "../types/intent.js";
import { parseByRules } from "./ruleParser.js";
import { parseByLLM } from "./llmParser.js";
import { disambiguate } from "./disambiguate.js";
import { logFailure } from "../utils/logger.js";
import { classifyMulti } from "./multiClassifier.js";
import { lookupUnknownNouns } from "./wikidata.js";
import { routeByConcepts } from "./conceptRouter.js";
import { parseMultiIntent, type MultiIntentPlan } from "./multiIntent.js";
import { isAffirmation, consumePendingAction, isRedirectingPendingAction } from "../conversation/pendingActions.js";

/** Result from parseIntent — may contain a multi-step plan */
export type { MultiIntentPlan };

export async function parseIntent(rawText: string): Promise<ParsedCommand & { plan?: MultiIntentPlan }> {
  // Stage -1a: check if user is redirecting a pending action ("put it on F drive")
  const redirect = isRedirectingPendingAction(rawText);
  if (redirect) {
    consumePendingAction();
    // Re-parse with the new location context
    const reParsed = parseByRules(redirect);
    if (reParsed && reParsed.confidence >= 0.5) return disambiguate(reParsed);
    // Fall through to normal parsing with the redirected text
    rawText = redirect;
  }

  // Stage -1b: check if user is affirming a pending action ("ok", "try it", "do it")
  if (isAffirmation(rawText)) {
    const pending = consumePendingAction();
    if (pending) {
      if (pending.type === "intent") {
        const reParsed = parseByRules(pending.action);
        if (reParsed && reParsed.confidence >= 0.5) {
          return disambiguate(reParsed);
        }
      }
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
    // Check if one step is just a location modifier (not a real separate command)
    // "do it offline and put files on D drive" → single intent with drive modifier
    const locationStep = multiPlan.steps.find(s =>
      /\b(put|place|install|store)\b.*\b(on|in|at)\s+[a-z]\s*drive\b/i.test(s.rawText)
      || /\b(on|in|at)\s+\/\S+/i.test(s.rawText)
    );
    const actionStep = multiPlan.steps.find(s => s !== locationStep);

    if (locationStep && actionStep && multiPlan.steps.length === 2) {
      // Merge: use the action step's intent but the full original text
      // so the executor can extract the drive from "on D drive"
      const result = disambiguate({
        intent: actionStep.intent,
        rawText, // full original text
        confidence: actionStep.confidence,
        fields: {},
      });
      return result; // single intent, no plan
    }

    // Real multi-intent plan
    const firstStep = multiPlan.steps[0];
    const result = disambiguate({
      intent: firstStep.intent,
      rawText, // full original text
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

  // Stage 2.5: multi-classifier (synonym + semantic + vector + fuzzy voting)
  const multiResult = classifyMulti(rawText);
  if (multiResult.best && multiResult.best.score >= 0.6 && !multiResult.ambiguous) {
    const mFields = ruleResult?.fields ?? {};
    return disambiguate({
      intent: multiResult.best.intent,
      rawText,
      confidence: Math.min(0.95, multiResult.best.score),
      fields: mFields,
    });
  }

  // Stage 2.75: semantic similarity — catches paraphrases that exact matching misses
  try {
    const { findSimilarIntents } = await import("./semanticSimilarity.js");
    const similar = findSimilarIntents(rawText, 3);
    if (similar.length > 0 && similar[0].score >= 0.4) {
      // Only use if it's clearly the best match (gap > 0.1 from second)
      const gap = similar.length > 1 ? similar[0].score - similar[1].score : 1;
      if (gap > 0.08 || similar[0].score >= 0.6) {
        return disambiguate({
          intent: similar[0].intent,
          rawText,
          confidence: Math.min(0.85, similar[0].score + 0.3),
          fields: {},
        });
      }
    }
  } catch { /* semantic similarity not available */ }

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
