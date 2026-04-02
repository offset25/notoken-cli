import {
  parseIntent, executeIntent, validateIntent, isDangerous, getRiskLevel,
  formatParsedCommand, formatVerbose, formatExplain,
  llmFallback, formatLLMFallback, isLLMConfigured, disambiguate,
  type DynamicIntent,
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
    console.error("Could not determine intent. Logged for auto-learning.");
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

  if (options.dryRun) {
    console.log(`[dry-run] Would execute: ${parsed.intent.intent} (risk: ${getRiskLevel(parsed.intent)})`);
    return;
  }

  if (isDangerous(parsed.intent) && !options.yes) {
    const ok = await askForConfirmation(`Execute ${parsed.intent.intent}? (risk: ${getRiskLevel(parsed.intent)})`);
    if (!ok) { console.log("Cancelled."); return; }
  }

  const result = await executeIntent(parsed.intent);
  console.log(result);
}
