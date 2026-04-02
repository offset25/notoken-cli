import { z } from "zod";

export const SynonymEntry = z.object({
  intent: z.string(),
  phrases: z.array(z.string()),
});

export const AliasEntry = z.object({
  canonical: z.string(),
  aliases: z.array(z.string()),
});

export const RulesConfig = z.object({
  version: z.string(),
  intentSynonyms: z.record(z.array(z.string())),
  environmentAliases: z.record(z.array(z.string())),
  serviceAliases: z.record(z.array(z.string())),
});
export type RulesConfig = z.infer<typeof RulesConfig>;

export const RulePatchChange = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("add_intent_synonym"),
    intent: z.string(),
    phrase: z.string(),
  }),
  z.object({
    type: z.literal("add_env_alias"),
    canonical: z.string(),
    alias: z.string(),
  }),
  z.object({
    type: z.literal("add_service_alias"),
    canonical: z.string(),
    alias: z.string(),
  }),
  z.object({
    type: z.literal("remove_intent_synonym"),
    intent: z.string(),
    phrase: z.string(),
  }),
]);
export type RulePatchChange = z.infer<typeof RulePatchChange>;

export const RulePatchTestCase = z.object({
  input: z.string(),
  expectedIntent: z.string().optional(),
  expectedFields: z.record(z.unknown()).optional(),
  shouldReject: z.boolean().optional(),
});
export type RulePatchTestCase = z.infer<typeof RulePatchTestCase>;

export const RulePatch = z.object({
  summary: z.string(),
  confidence: z.number(),
  changes: z.array(RulePatchChange),
  tests: z.array(RulePatchTestCase),
  warnings: z.array(z.string()),
});
export type RulePatch = z.infer<typeof RulePatch>;

export interface FailureLog {
  rawText: string;
  timestamp: string;
  parsedIntent: string | null;
  confidence: number;
  error?: string;
}
