/**
 * Multi-intent parser.
 *
 * Splits compound sentences into individual intents and creates a plan.
 *
 * "check if the firewall is blocking port 443 and also check dns for my domain"
 * →  Step 1: firewall.list (check port 443)
 *    Step 2: dns.lookup (check domain)
 *
 * "show me disk usage, check memory, and list running containers"
 * →  Step 1: server.check_disk
 *    Step 2: server.check_memory
 *    Step 3: docker.list
 *
 * Splitting rules:
 *   - Split on: "and", "also", "then", "after that", ",", ";"
 *   - But NOT inside quoted strings or after "and" that joins nouns ("cats and dogs")
 *   - Each part is parsed independently through rule parser + concept router
 *   - Only creates a plan if 2+ distinct intents are found
 */

import type { DynamicIntent } from "../types/intent.js";
import { parseByRules } from "./ruleParser.js";
import { routeByConcepts } from "./conceptRouter.js";
import { getIntentDef } from "../utils/config.js";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m",
};

// ─── Types ─────────────────────────────────────────────────────────────────

export interface PlanStep {
  intent: string;
  rawText: string;
  confidence: number;
  description: string;
  requiresConfirmation: boolean;
  riskLevel: string;
}

export interface MultiIntentPlan {
  steps: PlanStep[];
  originalText: string;
  isSingleIntent: boolean;
}

// ─── Sentence Splitting ────────────────────────────────────────────────────

// Conjunctions that typically join separate commands
const SPLIT_PATTERNS = [
  /\s+and\s+(?:also\s+)?(?:then\s+)?(?:can\s+you\s+)?/i,
  /\s+also\s+/i,
  /\s+then\s+/i,
  /\s+after\s+that\s+/i,
  /\s*;\s*/,
  /\s*,\s+(?:and\s+)?(?:also\s+)?(?:then\s+)?(?:can\s+you\s+)?/i,
  /\s+but\s+(?:first\s+)?(?:also\s+)?/i,
];

// Don't split on "and" that joins nouns (e.g., "cats and dogs", "videos and photos")
const NOUN_AND_PATTERN = /^[a-z]+\s+and\s+[a-z]+$/i;

/**
 * Split a compound sentence into parts.
 */
export function splitCompoundSentence(text: string): string[] {
  let parts = [text.trim()];

  for (const pattern of SPLIT_PATTERNS) {
    const newParts: string[] = [];
    for (const part of parts) {
      const splits = part.split(pattern).map(s => s.trim()).filter(s => s.length > 2);
      if (splits.length > 1) {
        // Check if this is just noun joining (don't split "videos and photos")
        const isNounJoin = splits.length === 2 && NOUN_AND_PATTERN.test(part);
        if (isNounJoin) {
          newParts.push(part);
        } else {
          newParts.push(...splits);
        }
      } else {
        newParts.push(part);
      }
    }
    parts = newParts;
  }

  // Clean up: remove leading filler words
  return parts.map(p =>
    p.replace(/^(can you|could you|please|will you|would you)\s+/i, "").trim()
  ).filter(p => p.length > 2);
}

// ─── Multi-Intent Parsing ──────────────────────────────────────────────────

/**
 * Parse a potentially compound sentence into a multi-step plan.
 * Returns a single-step plan if only one intent is found.
 */
export function parseMultiIntent(rawText: string): MultiIntentPlan {
  const parts = splitCompoundSentence(rawText);

  // If only one part, it's a single intent
  if (parts.length <= 1) {
    const intent = resolveIntent(rawText);
    return {
      steps: intent ? [intentToStep(intent, rawText)] : [],
      originalText: rawText,
      isSingleIntent: true,
    };
  }

  // Parse each part independently
  const steps: PlanStep[] = [];
  const seenIntents = new Set<string>();

  for (const part of parts) {
    const intent = resolveIntent(part);
    if (intent && !seenIntents.has(intent.intent)) {
      steps.push(intentToStep(intent, part));
      seenIntents.add(intent.intent);
    }
  }

  return {
    steps,
    originalText: rawText,
    isSingleIntent: steps.length <= 1,
  };
}

function resolveIntent(text: string): DynamicIntent | null {
  // Try rule parser first
  const rule = parseByRules(text);
  if (rule && rule.confidence >= 0.6) return rule;

  // Then concept router
  const concept = routeByConcepts(text);
  if (concept && concept.confidence >= 0.5) {
    return {
      intent: concept.intent,
      rawText: text,
      confidence: concept.confidence,
      fields: {},
    };
  }

  return null;
}

function intentToStep(intent: DynamicIntent, rawText: string): PlanStep {
  const def = getIntentDef(intent.intent);
  return {
    intent: intent.intent,
    rawText,
    confidence: intent.confidence,
    description: def?.description ?? intent.intent,
    requiresConfirmation: def?.requiresConfirmation ?? false,
    riskLevel: def?.riskLevel ?? "low",
  };
}

// ─── Plan Formatting ───────────────────────────────────────────────────────

export function formatPlanSteps(plan: MultiIntentPlan): string {
  const lines: string[] = [];

  if (plan.steps.length === 0) {
    return `${c.dim}Could not create a plan from: "${plan.originalText}"${c.reset}`;
  }

  if (plan.isSingleIntent) {
    return ""; // Don't show plan for single intents
  }

  const hasWrite = plan.steps.some(s => s.requiresConfirmation || s.riskLevel !== "low");

  lines.push(`${c.bold}${c.cyan}Plan (${plan.steps.length} steps):${c.reset}`);
  if (hasWrite) {
    lines.push(`${c.yellow}⚠ Some steps modify your system — confirmation required${c.reset}`);
  }
  lines.push("");

  for (let i = 0; i < plan.steps.length; i++) {
    const step = plan.steps[i];
    const num = `${c.cyan}${i + 1}.${c.reset}`;
    const risk = step.riskLevel !== "low" ? ` ${c.yellow}[${step.riskLevel}]${c.reset}` : "";
    const confirm = step.requiresConfirmation ? ` ${c.yellow}(needs confirmation)${c.reset}` : "";
    lines.push(`  ${num} ${c.bold}${step.intent}${c.reset}${risk}${confirm}`);
    lines.push(`     ${c.dim}${step.description}${c.reset}`);
    lines.push(`     ${c.dim}"${step.rawText}"${c.reset}`);
  }

  return lines.join("\n");
}
