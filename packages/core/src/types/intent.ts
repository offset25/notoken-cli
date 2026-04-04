import { z } from "zod";

export const EnvironmentName = z.enum(["local", "dev", "staging", "prod"]);
export type EnvironmentName = z.infer<typeof EnvironmentName>;

// Dynamic intent — fields come from config, not hardcoded schemas
export const DynamicIntent = z.object({
  intent: z.string(),
  confidence: z.number().min(0).max(1),
  rawText: z.string(),
  fields: z.record(z.unknown()),
});
export type DynamicIntent = z.infer<typeof DynamicIntent>;

export interface ParsedCommand {
  intent: DynamicIntent;
  missingFields: string[];
  ambiguousFields: Array<{
    field: string;
    candidates: string[];
  }>;
  needsClarification: boolean;
}

// Intent definition loaded from config/intents.json
export const FieldDef = z.object({
  type: z.enum(["string", "number", "service", "environment", "branch"]),
  required: z.boolean(),
  default: z.unknown().optional(),
});
export type FieldDef = z.infer<typeof FieldDef>;

export const IntentDef = z.object({
  name: z.string(),
  description: z.string(),
  synonyms: z.array(z.string()),
  fields: z.record(FieldDef),
  command: z.string(),
  commandWindows: z.string().optional(),
  execution: z.enum(["remote", "local"]),
  requiresConfirmation: z.boolean(),
  riskLevel: z.enum(["low", "medium", "high"]),
  allowlist: z.array(z.string()).optional(),
  logPaths: z.record(z.string()).optional(),
  fuzzyResolve: z.array(z.string()).optional(),
  examples: z.array(z.string()),
});
export type IntentDef = z.infer<typeof IntentDef>;

export const IntentsConfig = z.object({
  intents: z.array(IntentDef),
});
export type IntentsConfig = z.infer<typeof IntentsConfig>;
