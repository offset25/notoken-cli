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
  options: { dryRun?: boolean; json?: boolean; yes?: boolean; verbose?: boolean; explain?: boolean; outputFile?: string } = {}
): Promise<void> {
  // Check for retry/decline patterns
  const retryPattern = /^(try again|try it again|retry|try it now|try now|try it|do it again|run it again|run again|one more time|again|redo|re-?run|go again|let.?s try again|yes|yeah|yep|ok|sure|go ahead|do it|yes please|y|ye|ya|yea|affirmative|proceed)\s*$/i;
  const declinePattern = /^(n|no|nah|nope|cancel|stop|nevermind|never mind|forget it|skip)\s*$/i;

  if (declinePattern.test(rawText.trim())) {
    console.log(`\x1b[2mOK, cancelled. What would you like to do instead?\x1b[0m`);
    return;
  }
  if (retryPattern.test(rawText.trim())) {
    try {
      const { getOrCreateConversation, getRecentTurns } = await import("notoken-core");
      const conv = getOrCreateConversation(process.cwd());
      const recent = getRecentTurns(conv, 5);
      const lastCmd = recent.reverse().find((t: any) => t.intent && t.intent !== "unknown");
      if (lastCmd?.rawText) {
        console.log(`\x1b[1m\x1b[36mOK, trying again:\x1b[0m \x1b[1m${lastCmd.rawText}\x1b[0m \x1b[2m— that's what we did last time. Press Esc to cancel.\x1b[0m`);
        rawText = lastCmd.rawText;
      } else {
        console.log(`\x1b[33mNothing to retry — no previous command found.\x1b[0m`);
        return;
      }
    } catch { /* no conversation store available */ }
  }

  // ── Context injection BEFORE parsing ──
  // If the input is an ambiguous verb ("diagnose", "fix it", "check", "restart")
  // and the conversation has an active entity focus, inject the target so the
  // parser can resolve it to the right intent (e.g. "diagnose" → "diagnose discord").
  let contextAnnouncement = "";
  try {
    const { getOrCreateConversation, getEntityFocus } = await import("notoken-core");
    const conv = getOrCreateConversation(process.cwd());
    const trimmed = rawText.trim().toLowerCase();
    const ambiguous = /^(diagnose|fix|check|troubleshoot|repair|restart|start|stop|status|update)\s*(it|this|that)?$/i;
    if (ambiguous.test(trimmed)) {
      const focus = getEntityFocus(conv);
      if (focus) {
        const verb = trimmed.replace(/\s+(it|this|that)$/i, "");
        rawText = `${verb} ${focus.entityId}`;
        contextAnnouncement = `\x1b[2m  → ${verb} targeting \x1b[1m${focus.entityId}\x1b[0m\x1b[2m (based on conversation)\x1b[0m\n\x1b[2m    Say "not that" or specify a different target\x1b[0m`;
      }
    }
  } catch { /* conversation store not available */ }

  let parsed = await parseIntent(rawText);

  // Show context announcement after parsing (so user sees it before execution output)
  if (contextAnnouncement) console.log(contextAnnouncement);

  // Record to conversation store (so "try again" works)
  try {
    const { getOrCreateConversation, addUserTurn } = await import("notoken-core");
    const conv = getOrCreateConversation(process.cwd());
    addUserTurn(conv, rawText, parsed.intent.intent, parsed.intent.confidence, parsed.intent.fields as Record<string, unknown>);
  } catch { /* conversation store not available */ }

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
