import { readFileSync, writeFileSync, copyFileSync } from "node:fs";
import { resolve } from "node:path";
import type { RulePatch } from "../types/rules.js";
import { RulesConfig } from "../types/rules.js";
import { getConfigDir, loadIntents } from "../utils/config.js";
import { validatePatch, type ValidationResult } from "./ruleValidator.js";

export interface PromotionResult {
  promoted: boolean;
  validation: ValidationResult;
  backupPath?: string;
  newVersion?: string;
}

/**
 * PatchPromoter: validates and applies a rule patch to the live config.
 *
 * Flow:
 * 1. Validate the patch
 * 2. If valid, back up current rules
 * 3. Apply changes to rules.json
 * 4. Bump version
 *
 * Options:
 * - force: skip validation (not recommended)
 * - dryRun: validate but don't write
 */
export function promotePatch(
  patch: RulePatch,
  options: { force?: boolean; dryRun?: boolean } = {}
): PromotionResult {
  const validation = validatePatch(patch);

  if (!validation.valid && !options.force) {
    return { promoted: false, validation };
  }

  if (validation.warnings.length > 0) {
    console.log("Warnings:");
    for (const w of validation.warnings) console.log(`  - ${w}`);
  }

  if (options.dryRun) {
    console.log("Dry run — patch is valid but not applied.");
    return { promoted: false, validation };
  }

  const configDir = getConfigDir();
  const rulesPath = resolve(configDir, "rules.json");
  const raw = readFileSync(rulesPath, "utf-8");
  const rules = RulesConfig.parse(JSON.parse(raw));

  // Backup
  const backupPath = resolve(configDir, `rules.backup.${Date.now()}.json`);
  copyFileSync(rulesPath, backupPath);

  // Also load intents.json for synonym changes (primary source now)
  const intentsPath = resolve(configDir, "intents.json");
  const intentsRaw = JSON.parse(readFileSync(intentsPath, "utf-8"));
  const intentsBackup = resolve(configDir, `intents.backup.${Date.now()}.json`);
  copyFileSync(intentsPath, intentsBackup);
  let intentsChanged = false;

  // Apply changes
  for (const change of patch.changes) {
    switch (change.type) {
      case "add_intent_synonym": {
        // Add to intents.json (primary)
        const intentDef = intentsRaw.intents?.find((i: Record<string, unknown>) => i.name === change.intent);
        if (intentDef && Array.isArray(intentDef.synonyms)) {
          if (!intentDef.synonyms.includes(change.phrase)) {
            intentDef.synonyms.push(change.phrase);
            intentsChanged = true;
          }
        }
        // Also add to rules.json if the intent exists there (backward compat)
        if (rules.intentSynonyms[change.intent]) {
          if (!rules.intentSynonyms[change.intent].includes(change.phrase)) {
            rules.intentSynonyms[change.intent].push(change.phrase);
          }
        }
        break;
      }

      case "add_env_alias":
        if (rules.environmentAliases[change.canonical]) {
          if (!rules.environmentAliases[change.canonical].includes(change.alias)) {
            rules.environmentAliases[change.canonical].push(change.alias);
          }
        }
        break;

      case "add_service_alias":
        if (rules.serviceAliases[change.canonical]) {
          if (!rules.serviceAliases[change.canonical].includes(change.alias)) {
            rules.serviceAliases[change.canonical].push(change.alias);
          }
        }
        break;

      case "remove_intent_synonym": {
        // Remove from intents.json
        const rmDef = intentsRaw.intents?.find((i: Record<string, unknown>) => i.name === change.intent);
        if (rmDef && Array.isArray(rmDef.synonyms)) {
          rmDef.synonyms = rmDef.synonyms.filter((s: string) => s !== change.phrase);
          intentsChanged = true;
        }
        // Also remove from rules.json
        if (rules.intentSynonyms[change.intent]) {
          rules.intentSynonyms[change.intent] = rules.intentSynonyms[change.intent].filter((p) => p !== change.phrase);
        }
        break;
      }
    }
  }

  // Write intents.json if changed
  if (intentsChanged) {
    writeFileSync(intentsPath, JSON.stringify(intentsRaw, null, 2) + "\n");
    console.log(`Intents updated. Backup: ${intentsBackup}`);
  }

  // Bump version
  const newVersion = bumpVersion(rules.version);
  rules.version = newVersion;

  // Write
  writeFileSync(rulesPath, JSON.stringify(rules, null, 2) + "\n");

  console.log(`Patch promoted. Rules updated to v${newVersion}`);
  console.log(`Backup saved: ${backupPath}`);

  return {
    promoted: true,
    validation,
    backupPath,
    newVersion,
  };
}

function bumpVersion(version: string): string {
  const parts = version.split(".").map(Number);
  parts[2] = (parts[2] ?? 0) + 1;
  return parts.join(".");
}
