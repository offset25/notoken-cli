import type { ParsedCommand } from "../types/intent.js";
import { parseByRules } from "./ruleParser.js";
import { parseByLLM } from "./llmParser.js";
import { disambiguate } from "./disambiguate.js";
import { logFailure } from "../utils/logger.js";
import { lookupUnknownNouns } from "./wikidata.js";

export async function parseIntent(rawText: string): Promise<ParsedCommand> {
  // Stage 1: deterministic rule parser
  const ruleResult = parseByRules(rawText);
  if (ruleResult && ruleResult.confidence >= 0.7) {
    return disambiguate(ruleResult);
  }

  // Stage 2: LLM fallback
  const llmResult = await parseByLLM(rawText);
  if (llmResult && llmResult.confidence >= 0.5) {
    return disambiguate(llmResult);
  }

  // Stage 3: if rule parser had a low-confidence result, use it anyway
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
