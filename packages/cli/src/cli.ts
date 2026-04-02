import {
  parseIntent, executeIntent, validateIntent, isDangerous, getRiskLevel,
  formatParsedCommand, formatVerbose, formatExplain,
  llmFallback, formatLLMFallback, isLLMConfigured, disambiguate,
  formatPlanSteps,
  type DynamicIntent, type MultiIntentPlan,
} from "notoken-core";

// askForConfirmation is CLI-specific, keep local
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

async function askForConfirmation(message: string): Promise<boolean> {
  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return /^y(es)?$/i.test(answer.trim());
  } finally {
    rl.close();
  }
}

export async function runCli(
  rawText: string,
  options: { dryRun?: boolean; json?: boolean; yes?: boolean; verbose?: boolean; explain?: boolean } = {}
): Promise<void> {
  let parsed = await parseIntent(rawText);

  // If unknown and LLM configured, try LLM fallback
  if (parsed.intent.intent === "unknown" && isLLMConfigured()) {
    console.error("\x1b[2mAsking LLM for help...\x1b[0m");
    const fallbackResult = await llmFallback(rawText, {});

    if (fallbackResult?.understood && fallbackResult.suggestedIntents.length > 0) {
      console.log(formatLLMFallback(fallbackResult));
      console.log();

      const best = fallbackResult.suggestedIntents[0];
      const llmIntent: DynamicIntent = {
        intent: best.intent,
        confidence: best.confidence,
        rawText,
        fields: best.fields as Record<string, unknown>,
      };
      parsed = disambiguate(llmIntent);

      if (fallbackResult.todoSteps && fallbackResult.todoSteps.length > 1 && options.dryRun) {
        return;
      }
    }
  }

  // Output
  if (options.json) {
    console.log(JSON.stringify(parsed, null, 2));
    if (options.dryRun) return;
  } else if (options.explain) {
    console.log(formatExplain(parsed, rawText));
    console.log();
    if (options.dryRun) return;
  } else if (options.verbose) {
    console.log(formatVerbose(parsed));
    console.log();
  } else {
    console.log(formatParsedCommand(parsed));
    console.log();
  }

  const errors = validateIntent(parsed.intent);
  if (errors.length > 0) {
    console.error("Validation failed:");
    for (const err of errors) console.error(`  - ${err}`);
    process.exitCode = 1;
    return;
  }

  if (parsed.intent.intent === "unknown") {
    console.error("Could not determine intent. Logged for adaptive rules.");
    process.exitCode = 1;
    return;
  }

  if (parsed.needsClarification) {
    console.error("Clarification needed — please be more specific.");
    if (parsed.missingFields.length > 0) {
      console.error(`  Missing: ${parsed.missingFields.join(", ")}`);
    }
    for (const a of parsed.ambiguousFields) {
      console.error(`  ${a.field}: did you mean ${a.candidates.join(" or ")}?`);
    }
    process.exitCode = 1;
    return;
  }

  // Multi-step plan execution
  const plan = (parsed as { plan?: MultiIntentPlan }).plan;
  if (plan && !plan.isSingleIntent && plan.steps.length >= 2) {
    console.log(formatPlanSteps(plan));
    if (options.dryRun) {
      console.log("\n[dry-run] Would execute all steps above.");
      return;
    }
  }

  if (options.dryRun) {
    console.log(`[dry-run] Would execute: ${parsed.intent.intent} (risk: ${getRiskLevel(parsed.intent)})`);
    return;
  }

  // Multi-step plan: execute all steps
  if (plan && !plan.isSingleIntent && plan.steps.length >= 2) {
    // Check if any steps require confirmation
    const hasWrite = plan.steps.some(s => s.requiresConfirmation || s.riskLevel !== "low");
    if (hasWrite && !options.yes) {
      const ok = await askForConfirmation("\nProceed with this plan?");
      if (!ok) { console.log("Cancelled."); return; }
    } else if (!options.yes) {
      const ok = await askForConfirmation("\nRun all steps?");
      if (!ok) { console.log("Cancelled."); return; }
    }

    // Execute each step
    for (let i = 0; i < plan.steps.length; i++) {
      const step = plan.steps[i];
      console.log(`\n\x1b[36m━━ Step ${i + 1}/${plan.steps.length}: ${step.intent} ━━\x1b[0m`);

      // For dangerous steps, confirm individually
      if (step.requiresConfirmation && step.riskLevel === "high" && !options.yes) {
        const ok = await askForConfirmation(`  Execute ${step.intent}? (risk: ${step.riskLevel})`);
        if (!ok) { console.log("  Skipped."); continue; }
      }

      try {
        const stepIntent: DynamicIntent = {
          intent: step.intent,
          rawText: step.rawText,
          confidence: step.confidence,
          fields: {},
        };
        const stepResult = await executeIntent(stepIntent);
        console.log(stepResult);
      } catch (err) {
        console.error(`\x1b[31m✗ Step ${i + 1} failed: ${err instanceof Error ? err.message : err}\x1b[0m`);
      }
    }
    console.log(`\n\x1b[32m✓ Plan complete (${plan.steps.length} steps)\x1b[0m`);
    return;
  }

  if (isDangerous(parsed.intent) && !options.yes) {
    const ok = await askForConfirmation(`Execute ${parsed.intent.intent}? (risk: ${getRiskLevel(parsed.intent)})`);
    if (!ok) { console.log("Cancelled."); return; }
  }

  const result = await executeIntent(parsed.intent);
  console.log(result);
}
