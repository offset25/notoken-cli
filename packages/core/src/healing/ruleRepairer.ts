import type { FailureLog, RulePatch } from "../types/rules.js";
import { loadFailures } from "../utils/logger.js";
import { buildRulesFromExamples } from "./ruleBuilder.js";

/**
 * RuleRepairer: reads the failure log and proposes patches to fix unmatched inputs.
 *
 * It batches recent failures, deduplicates, and sends them to the RuleBuilder
 * which uses an LLM to propose structured changes.
 */
export async function repairFromFailures(
  maxFailures = 20
): Promise<RulePatch | null> {
  const failures = loadFailures();
  if (failures.length === 0) {
    console.log("No failures to repair.");
    return null;
  }

  // Deduplicate by rawText, take the most recent N
  const unique = deduplicateFailures(failures);
  const batch = unique.slice(-maxFailures);

  console.log(`Repairing from ${batch.length} unique failure(s)...`);
  const examples = batch.map((f) => f.rawText);

  return buildRulesFromExamples(examples);
}

function deduplicateFailures(failures: FailureLog[]): FailureLog[] {
  const seen = new Map<string, FailureLog>();
  for (const f of failures) {
    const key = f.rawText.trim().toLowerCase();
    seen.set(key, f); // keep latest
  }
  return Array.from(seen.values());
}
