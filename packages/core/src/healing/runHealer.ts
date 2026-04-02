#!/usr/bin/env tsx
/**
 * Standalone healer script.
 *
 * Reads the failure log, asks the LLM to propose fixes, validates,
 * and optionally promotes the patch.
 *
 * Usage:
 *   npx tsx src/healing/runHealer.ts [--promote] [--force] [--dry-run]
 */

import { repairFromFailures } from "./ruleRepairer.js";
import { validatePatch } from "./ruleValidator.js";
import { promotePatch } from "./patchPromoter.js";
import { clearFailures } from "../utils/logger.js";

async function main() {
  const args = process.argv.slice(2);
  const shouldPromote = args.includes("--promote");
  const force = args.includes("--force");
  const dryRun = args.includes("--dry-run");

  console.log("=== Auto-Learning Rule Repairer ===\n");

  const patch = await repairFromFailures();
  if (!patch) {
    console.log("No patch generated.");
    return;
  }

  console.log("\n--- Proposed Patch ---");
  console.log(`Summary: ${patch.summary}`);
  console.log(`Confidence: ${(patch.confidence * 100).toFixed(0)}%`);
  console.log(`Changes: ${patch.changes.length}`);
  for (const c of patch.changes) {
    console.log(`  [${c.type}] ${JSON.stringify(c)}`);
  }

  console.log(`\nTests: ${patch.tests.length}`);
  for (const t of patch.tests) {
    const label = t.shouldReject ? "REJECT" : t.expectedIntent ?? "?";
    console.log(`  "${t.input}" => ${label}`);
  }

  if (patch.warnings.length > 0) {
    console.log(`\nWarnings:`);
    for (const w of patch.warnings) console.log(`  - ${w}`);
  }

  console.log("\n--- Validation ---");
  const validation = validatePatch(patch);
  console.log(`Valid: ${validation.valid}`);

  if (validation.errors.length > 0) {
    console.log("Errors:");
    for (const e of validation.errors) console.log(`  - ${e}`);
  }

  console.log("Test results:");
  for (const t of validation.testResults) {
    console.log(`  ${t.passed ? "PASS" : "FAIL"} "${t.input}"${t.reason ? ` (${t.reason})` : ""}`);
  }

  if (shouldPromote) {
    console.log("\n--- Promoting ---");
    const result = promotePatch(patch, { force, dryRun });
    if (result.promoted) {
      console.log("Patch applied successfully.");
      clearFailures();
      console.log("Failure log cleared.");
    } else {
      console.log("Patch not promoted.");
    }
  } else {
    console.log("\nRun with --promote to apply this patch.");
  }
}

main().catch((err) => {
  console.error("Healer error:", err);
  process.exit(1);
});
