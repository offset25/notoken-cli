#!/usr/bin/env tsx
/**
 * Claude-powered auto-learning.
 *
 * Uses Claude CLI to:
 * 1. Read the current rules.json and intents.json structure
 * 2. Read the failure log (phrases that didn't match)
 * 3. Read the uncertainty log (phrases with low confidence)
 * 4. Analyze gaps and propose structured changes
 * 5. Let Claude request to see/grep specific files
 * 6. Validate and apply the changes
 *
 * Usage:
 *   npx tsx src/healing/claudeHealer.ts [--promote] [--dry-run]
 *   MYCLI_LLM_CLI=claude npm run heal:claude
 */

import { execSync, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { validatePatch } from "./ruleValidator.js";
import { promotePatch } from "./patchPromoter.js";
import { CONFIG_DIR, PACKAGE_ROOT } from "../utils/paths.js";
import { clearFailures, loadFailures } from "../utils/logger.js";
import { loadUncertaintyLog } from "../nlp/uncertainty.js";
import type { RulePatch } from "../types/rules.js";

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

async function main() {
  const args = process.argv.slice(2);
  const shouldPromote = args.includes("--promote");
  const dryRun = args.includes("--dry-run");
  const force = args.includes("--force");

  console.log(`${c.bold}${c.cyan}=== Claude Auto-Learning ====${c.reset}\n`);

  // Check Claude CLI
  try {
    execSync("command -v claude", { stdio: "pipe" });
  } catch {
    console.error(`${c.red}Claude CLI not found. Install it or set MYCLI_LLM_CLI=claude.${c.reset}`);
    process.exit(1);
  }

  // Gather context
  const failures = loadFailures();
  const uncertainty = loadUncertaintyLog();
  const rulesJson = readFileSync(resolve(CONFIG_DIR, "rules.json"), "utf-8");
  const intentsJson = readFileSync(resolve(CONFIG_DIR, "intents.json"), "utf-8");

  // Summarize intents (don't send the whole 70KB file)
  const intents = JSON.parse(intentsJson);
  const intentSummary = intents.intents.map((i: Record<string, unknown>) => ({
    name: i.name,
    synonyms: i.synonyms,
    description: i.description,
  }));

  if (failures.length === 0 && uncertainty.length === 0) {
    console.log(`${c.green}✓ No failures or uncertainty to fix.${c.reset}`);
    return;
  }

  console.log(`${c.dim}Failures: ${failures.length} | Uncertain phrases: ${uncertainty.length}${c.reset}\n`);

  // Build the prompt for Claude
  const prompt = buildHealerPrompt(failures, uncertainty, rulesJson, intentSummary);

  console.log(`${c.dim}Asking Claude to analyze...${c.reset}\n`);

  // Call Claude CLI
  const response = callClaude(prompt);
  if (!response) {
    console.error(`${c.red}Claude returned no response.${c.reset}`);
    return;
  }

  // Extract the JSON patch from Claude's response
  const patch = extractPatch(response);

  if (!patch) {
    // Claude might want to see a file first — check for requests
    const fileRequest = extractFileRequest(response);
    if (fileRequest) {
      console.log(`${c.cyan}Claude wants to see: ${fileRequest}${c.reset}`);
      const fileContent = readRequestedFile(fileRequest);

      // Follow up with the file content
      const followUp = `Here is the content of ${fileRequest}:\n\n${fileContent}\n\nNow based on this, provide the structured JSON patch as described.`;
      const response2 = callClaude(followUp);
      const patch2 = response2 ? extractPatch(response2) : null;

      if (patch2) {
        applyPatch(patch2, shouldPromote, dryRun, force);
      } else {
        console.log(`\n${c.bold}Claude's analysis:${c.reset}`);
        console.log(response2 ?? response);
      }
    } else {
      // Just show Claude's analysis
      console.log(`\n${c.bold}Claude's analysis:${c.reset}`);
      console.log(response);
    }
    return;
  }

  applyPatch(patch, shouldPromote, dryRun, force);
}

function buildHealerPrompt(
  failures: Array<{ rawText: string; timestamp: string; error?: string }>,
  uncertainty: Array<{ rawText: string; unknownTokens: string[]; overallConfidence: number }>,
  rulesJson: string,
  intentSummary: Array<{ name: string; synonyms: string[]; description: string }>
): string {
  const failureList = failures.slice(-20).map((f) => `  - "${f.rawText}"`).join("\n");
  const uncertainList = uncertainty.slice(-15).map((u) =>
    `  - "${u.rawText}" (conf: ${(u.overallConfidence * 100).toFixed(0)}%, unknown: ${u.unknownTokens.join(", ") || "none"})`
  ).join("\n");

  return `You are analyzing an NLP-based CLI tool that parses natural language into server operation commands.

## HOW THE SYSTEM WORKS

The CLI has two config files:

1. **rules.json** — contains environment aliases (prod, staging, dev) and service aliases (nginx, redis, api, etc.)
   These are used to extract entities from user input.

2. **intents.json** — each intent has:
   - "name": the intent identifier (e.g., "service.restart")
   - "synonyms": an array of phrases that trigger this intent via substring matching
   - "fields": what gets extracted (service, environment, path, etc.)
   - "command": the shell command template with {{field}} placeholders

   **The parser matches by finding the LONGEST synonym substring in the user's input.**
   So if user says "restart nginx on prod", and "restart" (7 chars) is a synonym for service.restart,
   it matches. If another intent had "restart nginx" (13 chars), that would win.

## CURRENT RULES.JSON
${rulesJson}

## CURRENT INTENTS (${intentSummary.length} total)
${JSON.stringify(intentSummary, null, 2)}

## FAILED PHRASES (these didn't match any intent)
${failureList || "  (none)"}

## UNCERTAIN PHRASES (matched but with low confidence or unknown tokens)
${uncertainList || "  (none)"}

## YOUR TASK

Analyze the failures and uncertainties. Propose a JSON patch to fix them.

You can:
1. Add new synonyms to existing intents (most common fix)
2. Add new service/environment aliases to rules.json
3. Suggest new intents if truly needed

**IMPORTANT**: Synonyms work by substring matching. A synonym like "check" will match ANY text containing "check".
Short synonyms can cause false positives. Prefer longer, more specific synonyms.

If you need to see a specific file to understand the system better, say:
"I need to see: <filepath>"

Otherwise, return a JSON patch in this format:
\`\`\`json
{
  "summary": "what this patch does",
  "confidence": 0.0-1.0,
  "changes": [
    { "type": "add_intent_synonym", "intent": "service.restart", "phrase": "recycle" },
    { "type": "add_env_alias", "canonical": "prod", "alias": "production-server" },
    { "type": "add_service_alias", "canonical": "nginx", "alias": "webserver" }
  ],
  "tests": [
    { "input": "recycle nginx on prod", "expectedIntent": "service.restart" },
    { "input": "random unrelated phrase", "shouldReject": true }
  ],
  "warnings": ["any concerns about these changes"]
}
\`\`\`

Be conservative. Only add changes that clearly fix the reported failures.`;
}

function callClaude(prompt: string): string | null {
  try {
    const result = execFileSync(
      "claude",
      ["-p", prompt, "--no-session-persistence", "--max-turns", "2",
       "--append-system-prompt", "IMPORTANT: Do NOT use any tools. Do NOT read files. All the context you need is in the prompt. Respond with ONLY the JSON patch object. No explanation, just JSON."],
      {
        encoding: "utf-8",
        timeout: 180_000,
        stdio: ["pipe", "pipe", "pipe"],
        cwd: PACKAGE_ROOT,
        maxBuffer: 10 * 1024 * 1024,
      }
    );

    return result.trim();
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message?: string };
    if (e.stdout && e.stdout.trim()) return e.stdout.trim();
    const msg = e.stderr ?? e.message ?? String(err);
    console.error(`${c.red}Claude error: ${msg.split("\n")[0]}${c.reset}`);
    return null;
  }
}

function extractPatch(response: string): RulePatch | null {
  // Try JSON code block
  const jsonMatch = response.match(/```json\s*([\s\S]*?)```/);
  if (jsonMatch) {
    try {
      const parsed = JSON.parse(jsonMatch[1].trim());
      if (parsed.changes && Array.isArray(parsed.changes)) {
        return { ...parsed, warnings: parsed.warnings ?? [] } as RulePatch;
      }
    } catch {}
  }

  // Try raw JSON
  const rawMatch = response.match(/\{[\s\S]*"changes"[\s\S]*\}/);
  if (rawMatch) {
    try {
      const parsed = JSON.parse(rawMatch[0]);
      if (parsed.changes) return { ...parsed, warnings: parsed.warnings ?? [] } as RulePatch;
    } catch {}
  }

  return null;
}

function extractFileRequest(response: string): string | null {
  const match = response.match(/I need to see:\s*(\S+)/i);
  if (match) return match[1];
  const match2 = response.match(/(?:show me|let me see|can I see|read)\s+(\S+\.\w+)/i);
  if (match2) return match2[1];
  return null;
}

function readRequestedFile(request: string): string {
  // Try relative to config dir, then project root, then absolute
  const candidates = [
    resolve(CONFIG_DIR, request),
    resolve(CONFIG_DIR, "..", request),
    request,
  ];

  for (const path of candidates) {
    if (existsSync(path)) {
      const content = readFileSync(path, "utf-8");
      // Truncate if huge
      if (content.length > 10000) {
        return content.slice(0, 10000) + `\n\n... (truncated, ${content.length} total chars)`;
      }
      return content;
    }
  }

  return `File not found: ${request}`;
}

function applyPatch(patch: RulePatch, shouldPromote: boolean, dryRun: boolean, force = false): void {
  console.log(`\n${c.bold}--- Proposed Patch ---${c.reset}`);
  console.log(`${c.cyan}Summary:${c.reset} ${patch.summary}`);
  console.log(`${c.cyan}Confidence:${c.reset} ${(patch.confidence * 100).toFixed(0)}%`);
  console.log(`${c.cyan}Changes:${c.reset} ${patch.changes.length}`);

  for (const change of patch.changes) {
    switch (change.type) {
      case "add_intent_synonym":
        console.log(`  ${c.green}+${c.reset} synonym "${change.phrase}" → ${change.intent}`);
        break;
      case "add_env_alias":
        console.log(`  ${c.green}+${c.reset} env alias "${change.alias}" → ${change.canonical}`);
        break;
      case "add_service_alias":
        console.log(`  ${c.green}+${c.reset} service alias "${change.alias}" → ${change.canonical}`);
        break;
      case "remove_intent_synonym":
        console.log(`  ${c.red}-${c.reset} remove synonym "${change.phrase}" from ${change.intent}`);
        break;
    }
  }

  if (patch.tests.length > 0) {
    console.log(`\n${c.cyan}Tests:${c.reset} ${patch.tests.length}`);
    for (const t of patch.tests) {
      const label = t.shouldReject ? `${c.red}REJECT${c.reset}` : `${c.green}${t.expectedIntent}${c.reset}`;
      console.log(`  "${t.input}" → ${label}`);
    }
  }

  if (patch.warnings.length > 0) {
    console.log(`\n${c.yellow}Warnings:${c.reset}`);
    for (const w of patch.warnings) console.log(`  - ${w}`);
  }

  // Validate
  console.log(`\n${c.bold}--- Validation ---${c.reset}`);
  const validation = validatePatch(patch);
  console.log(`Valid: ${validation.valid ? `${c.green}yes${c.reset}` : `${c.red}no${c.reset}`}`);

  if (validation.errors.length > 0) {
    for (const e of validation.errors) console.log(`  ${c.red}✗ ${e}${c.reset}`);
  }

  for (const t of validation.testResults) {
    console.log(`  ${t.passed ? `${c.green}✓${c.reset}` : `${c.red}✗${c.reset}`} "${t.input}"${t.reason ? ` (${t.reason})` : ""}`);
  }

  if (shouldPromote) {
    console.log(`\n${c.bold}--- Promoting ---${c.reset}`);
    const result = promotePatch(patch, { force, dryRun });
    if (result.promoted) {
      console.log(`${c.green}✓ Patch applied. Rules updated to v${result.newVersion}${c.reset}`);
      clearFailures();
      console.log(`${c.green}✓ Failure log cleared.${c.reset}`);
    } else {
      console.log(`${c.yellow}Patch not promoted.${c.reset}`);
    }
  } else {
    console.log(`\n${c.dim}Run with --promote to apply. Add --dry-run for safe preview.${c.reset}`);
  }
}

main().catch((err) => {
  console.error(`${c.red}Healer error:${c.reset}`, err.message ?? err);
  process.exit(1);
});
