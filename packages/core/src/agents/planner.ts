import nlp from "compromise";
import { parseByRules } from "../nlp/ruleParser.js";
import { loadIntents } from "../utils/config.js";

/**
 * Goal planner.
 *
 * Breaks complex multi-step requests into a sequence of tasks.
 *
 * Handles patterns like:
 *   "check if api is down and restart it"
 *   "deploy to staging then check the logs"
 *   "show disk, check memory, and tail logs on prod"
 *   "restart nginx on prod and then rollback if it fails"
 *   "copy the config to /backup and restart nginx"
 */

export interface PlanStep {
  id: number;
  rawText: string;
  intent: string | null;
  fields: Record<string, unknown>;
  confidence: number;
  /** Condition for execution */
  condition?: "always" | "if_success" | "if_failure";
  /** Step IDs this step depends on */
  dependsOn: number[];
  status: "pending" | "running" | "completed" | "failed" | "skipped";
  result?: string;
  error?: string;
}

export interface ExecutionPlan {
  originalText: string;
  steps: PlanStep[];
  isMultiStep: boolean;
}

// Conjunctions and sequencing words that split multi-step commands
const SPLIT_PATTERNS = [
  /\band then\b/i,
  /\bthen\b/i,
  /\bafter that\b/i,
  /\bfollowed by\b/i,
  /\bnext\b/i,
  /,\s*(?:and\s+)?/,
  /\band\b/i,
];

// Conditional patterns
const CONDITIONAL_PATTERNS: Array<{ pattern: RegExp; condition: "if_success" | "if_failure" }> = [
  { pattern: /\bif (?:it |that )?(?:works|succeeds|passes|is up|is running)\b/i, condition: "if_success" },
  { pattern: /\bif (?:it |that )?(?:fails|breaks|is down|crashes|errors)\b/i, condition: "if_failure" },
  { pattern: /\botherwise\b/i, condition: "if_failure" },
  { pattern: /\bif not\b/i, condition: "if_failure" },
];

/**
 * Analyze text and determine if it's a multi-step request.
 * If so, break it into a plan.
 */
export function createPlan(rawText: string): ExecutionPlan {
  const clauses = splitIntoClauses(rawText);

  if (clauses.length <= 1) {
    // Single step — still create a plan for consistency
    const parsed = parseByRules(rawText);
    return {
      originalText: rawText,
      isMultiStep: false,
      steps: [{
        id: 1,
        rawText,
        intent: parsed?.intent ?? null,
        fields: parsed?.fields ?? {},
        confidence: parsed?.confidence ?? 0,
        condition: "always",
        dependsOn: [],
        status: "pending",
      }],
    };
  }

  // Multi-step: parse each clause
  const steps: PlanStep[] = [];
  let lastEntityContext: Record<string, unknown> = {};

  for (let i = 0; i < clauses.length; i++) {
    const clause = clauses[i];
    const condition = detectCondition(clause.text);

    // Inherit entities from previous steps for coreference
    let textToParse = clause.text;

    // Replace "it" with last known service
    if (/\bit\b/i.test(textToParse) && lastEntityContext.service) {
      textToParse = textToParse.replace(/\bit\b/i, lastEntityContext.service as string);
    }

    const parsed = parseByRules(textToParse);

    // Carry forward environment and service context
    const fields = { ...parsed?.fields ?? {} };
    if (!fields.environment && lastEntityContext.environment) {
      fields.environment = lastEntityContext.environment;
    }
    if (!fields.service && lastEntityContext.service) {
      fields.service = lastEntityContext.service;
    }

    const step: PlanStep = {
      id: i + 1,
      rawText: clause.original,
      intent: parsed?.intent ?? null,
      fields,
      confidence: parsed?.confidence ?? 0,
      condition: condition ?? (i === 0 ? "always" : "if_success"),
      dependsOn: i > 0 ? [i] : [],
      status: "pending",
    };

    steps.push(step);

    // Update entity context for next step
    if (fields.service) lastEntityContext.service = fields.service;
    if (fields.environment) lastEntityContext.environment = fields.environment;
    if (fields.target) lastEntityContext.target = fields.target;
  }

  return {
    originalText: rawText,
    isMultiStep: true,
    steps,
  };
}

/**
 * Split a complex sentence into individual action clauses.
 */
function splitIntoClauses(text: string): Array<{ text: string; original: string }> {
  // Use compromise to detect sentence/clause boundaries first
  const doc = nlp(text);
  const sentences = doc.sentences().out("array") as string[];

  if (sentences.length > 1) {
    return sentences.map((s) => ({ text: cleanClause(s), original: s }));
  }

  // Single sentence — try splitting on conjunctions
  let remaining = text;
  const parts: string[] = [];

  for (const pattern of SPLIT_PATTERNS) {
    const split = remaining.split(pattern).filter((s) => s.trim().length > 0);
    if (split.length > 1) {
      parts.push(...split);
      remaining = "";
      break;
    }
  }

  if (parts.length === 0) {
    return [{ text: cleanClause(text), original: text }];
  }

  return parts.map((p) => ({ text: cleanClause(p), original: p.trim() }));
}

function cleanClause(text: string): string {
  // Remove leading conjunctions and conditional phrases
  return text
    .replace(/^(and then|then|and|but|or|after that|followed by|next)\s+/i, "")
    .replace(/\bif (?:it |that )?(?:works|succeeds|passes|fails|breaks|is down|is up)\s*/i, "")
    .replace(/\botherwise\s*/i, "")
    .trim();
}

function detectCondition(text: string): "if_success" | "if_failure" | undefined {
  for (const { pattern, condition } of CONDITIONAL_PATTERNS) {
    if (pattern.test(text)) return condition;
  }
  return undefined;
}

/**
 * Format a plan for display.
 */
export function formatPlan(plan: ExecutionPlan): string {
  const c = {
    reset: "\x1b[0m",
    bold: "\x1b[1m",
    dim: "\x1b[2m",
    green: "\x1b[32m",
    yellow: "\x1b[33m",
    red: "\x1b[31m",
    cyan: "\x1b[36m",
  };

  const lines: string[] = [];

  if (plan.isMultiStep) {
    lines.push(`${c.bold}Execution Plan${c.reset} (${plan.steps.length} steps):`);
  } else {
    lines.push(`${c.bold}Single-step command:${c.reset}`);
  }

  lines.push("");

  for (const step of plan.steps) {
    const statusIcon =
      step.status === "completed" ? `${c.green}✓${c.reset}` :
      step.status === "failed" ? `${c.red}✗${c.reset}` :
      step.status === "running" ? `${c.yellow}⟳${c.reset}` :
      step.status === "skipped" ? `${c.dim}⊘${c.reset}` :
      `${c.dim}○${c.reset}`;

    const intentLabel = step.intent ?? `${c.red}unknown${c.reset}`;
    const condLabel = step.condition === "if_success" ? `${c.dim}(if previous succeeds)${c.reset}` :
                      step.condition === "if_failure" ? `${c.yellow}(if previous fails)${c.reset}` : "";

    lines.push(`  ${statusIcon} Step ${step.id}: ${c.cyan}${intentLabel}${c.reset} ${condLabel}`);
    lines.push(`    ${c.dim}"${step.rawText}"${c.reset}`);

    const fields = Object.entries(step.fields).filter(([, v]) => v !== undefined);
    if (fields.length > 0) {
      lines.push(`    ${fields.map(([k, v]) => `${k}=${v}`).join(", ")}`);
    }

    if (step.result) {
      lines.push(`    ${c.green}Result: ${step.result.split("\n")[0]}${c.reset}`);
    }
    if (step.error) {
      lines.push(`    ${c.red}Error: ${step.error}${c.reset}`);
    }
  }

  return lines.join("\n");
}
