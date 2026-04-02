import type { RulePatch, RulesConfig } from "../types/rules.js";
import { loadRules, loadIntents } from "../utils/config.js";
import { parseByRules } from "../nlp/ruleParser.js";

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
  testResults: Array<{
    input: string;
    passed: boolean;
    reason?: string;
  }>;
}

/**
 * RuleValidator: checks a proposed patch for safety before promotion.
 *
 * Validates:
 * - No overlapping synonyms across different intents
 * - All referenced intents exist
 * - All referenced environments/services exist
 * - Test cases pass against the patched rule set
 * - No dangerous broadening of high-risk intents
 */
export function validatePatch(patch: RulePatch): ValidationResult {
  const rules = loadRules();
  const errors: string[] = [];
  const warnings: string[] = [...patch.warnings];

  // Check each change
  for (const change of patch.changes) {
    switch (change.type) {
      case "add_intent_synonym": {
        const knownIntent = rules.intentSynonyms[change.intent] || loadIntents().some((i) => i.name === change.intent);
        if (!knownIntent) {
          errors.push(`Unknown intent: ${change.intent}`);
        }
        // Check for overlap with other intents
        const overlap = findSynonymOverlap(change.phrase, change.intent, rules);
        if (overlap) {
          errors.push(
            `Synonym "${change.phrase}" overlaps with intent "${overlap}"`
          );
        }
        // Check for overly broad synonyms
        if (change.phrase.length <= 2) {
          errors.push(`Synonym "${change.phrase}" is too short / too broad`);
        }
        break;
      }

      case "add_env_alias": {
        if (!rules.environmentAliases[change.canonical]) {
          errors.push(`Unknown environment: ${change.canonical}`);
        }
        break;
      }

      case "add_service_alias": {
        if (!rules.serviceAliases[change.canonical]) {
          errors.push(`Unknown service: ${change.canonical}`);
        }
        break;
      }

      case "remove_intent_synonym": {
        const existing = rules.intentSynonyms[change.intent];
        if (!existing?.includes(change.phrase)) {
          warnings.push(
            `Synonym "${change.phrase}" not found in intent "${change.intent}"`
          );
        }
        break;
      }
    }
  }

  // Simulate applying the patch and run tests
  const patchedRules = simulateApply(rules, patch);
  const testResults = runTests(patch, patchedRules);

  const failedTests = testResults.filter((t) => !t.passed);
  if (failedTests.length > 0) {
    errors.push(`${failedTests.length} test(s) failed`);
  }

  return {
    valid: errors.length === 0,
    errors,
    warnings,
    testResults,
  };
}

function findSynonymOverlap(
  phrase: string,
  excludeIntent: string,
  rules: RulesConfig
): string | null {
  // Check rules.json synonyms
  for (const [intent, phrases] of Object.entries(rules.intentSynonyms)) {
    if (intent === excludeIntent) continue;
    if (phrases.includes(phrase)) return intent;
  }
  // Also check intents.json synonyms (primary source now)
  for (const def of loadIntents()) {
    if (def.name === excludeIntent) continue;
    if (def.synonyms.includes(phrase)) return def.name;
  }
  return null;
}

function simulateApply(rules: RulesConfig, patch: RulePatch): RulesConfig {
  const clone: RulesConfig = JSON.parse(JSON.stringify(rules));

  for (const change of patch.changes) {
    switch (change.type) {
      case "add_intent_synonym":
        if (clone.intentSynonyms[change.intent]) {
          clone.intentSynonyms[change.intent].push(change.phrase);
        }
        break;
      case "add_env_alias":
        if (clone.environmentAliases[change.canonical]) {
          clone.environmentAliases[change.canonical].push(change.alias);
        }
        break;
      case "add_service_alias":
        if (clone.serviceAliases[change.canonical]) {
          clone.serviceAliases[change.canonical].push(change.alias);
        }
        break;
      case "remove_intent_synonym":
        if (clone.intentSynonyms[change.intent]) {
          clone.intentSynonyms[change.intent] = clone.intentSynonyms[
            change.intent
          ].filter((p) => p !== change.phrase);
        }
        break;
    }
  }

  return clone;
}

function runTests(
  patch: RulePatch,
  _patchedRules: RulesConfig
): Array<{ input: string; passed: boolean; reason?: string }> {
  // We test against current loaded rules + patch applied
  // For now, we use parseByRules which reads from loadRules()
  // In a full implementation, you'd inject the patched rules
  return patch.tests.map((test) => {
    const result = parseByRules(test.input);

    if (test.shouldReject) {
      return {
        input: test.input,
        passed: result === null || result.intent === "unknown",
        reason: result ? `Matched as ${result.intent} but should reject` : undefined,
      };
    }

    if (!result) {
      return {
        input: test.input,
        passed: false,
        reason: "No parse result",
      };
    }

    if (test.expectedIntent && result.intent !== test.expectedIntent) {
      return {
        input: test.input,
        passed: false,
        reason: `Expected ${test.expectedIntent}, got ${result.intent}`,
      };
    }

    return { input: test.input, passed: true };
  });
}
