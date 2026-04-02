import type { ParsedCommand } from "../types/intent.js";
import { parseByRules } from "./ruleParser.js";
import { parseByLLM } from "./llmParser.js";
import { disambiguate } from "./disambiguate.js";
import { logFailure } from "../utils/logger.js";

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

  // Stage 4: unknown — log the failure for auto-learning
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
    fields: { reason: "No supported intent matched" },
  });
}
