import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { RulesConfig } from "../types/rules.js";
import { IntentsConfig, type IntentDef } from "../types/intent.js";
import { CONFIG_DIR, USER_HOME } from "./paths.js";
import { pluginRegistry } from "../plugins/registry.js";

let cachedRules: RulesConfig | null = null;
let cachedIntents: IntentsConfig | null = null;

export function loadRules(forceReload = false): RulesConfig {
  if (cachedRules && !forceReload) return cachedRules;
  const raw = readFileSync(resolve(CONFIG_DIR, "rules.json"), "utf-8");
  cachedRules = RulesConfig.parse(JSON.parse(raw));

  // Merge plugin aliases into rules
  const pluginServices = pluginRegistry.getAllServiceAliases();
  for (const [service, aliases] of Object.entries(pluginServices)) {
    if (!cachedRules.serviceAliases[service]) {
      cachedRules.serviceAliases[service] = aliases;
    } else {
      for (const alias of aliases) {
        if (!cachedRules.serviceAliases[service].includes(alias)) {
          cachedRules.serviceAliases[service].push(alias);
        }
      }
    }
  }

  return cachedRules;
}

export function loadIntents(forceReload = false): IntentDef[] {
  if (cachedIntents && !forceReload) return cachedIntents.intents;
  const raw = readFileSync(resolve(CONFIG_DIR, "intents.json"), "utf-8");
  cachedIntents = IntentsConfig.parse(JSON.parse(raw));

  // Merge plugin intents
  const pluginIntents = pluginRegistry.getAllIntents();
  for (const pi of pluginIntents) {
    // Don't add duplicates
    if (!cachedIntents.intents.find((i) => i.name === pi.name)) {
      cachedIntents.intents.push(pi as unknown as IntentDef);
    }
  }

  // Merge user custom intents from ~/.notoken/custom-intents.json
  const customFile = resolve(USER_HOME, "custom-intents.json");
  if (existsSync(customFile)) {
    try {
      const customRaw = readFileSync(customFile, "utf-8");
      const customData = JSON.parse(customRaw);
      const customIntents: unknown[] = customData.intents ?? [];
      for (const ci of customIntents) {
        const entry = ci as Record<string, unknown>;
        // Build a full IntentDef with sensible defaults for user-defined intents
        const def: IntentDef = {
          name: entry.name as string,
          description: (entry.description as string) ?? "",
          synonyms: (entry.synonyms as string[]) ?? [],
          fields: (entry.fields as IntentDef["fields"]) ?? {},
          command: (entry.command as string) ?? "",
          execution: (entry.execution as "local" | "remote") ?? "local",
          requiresConfirmation: (entry.requiresConfirmation as boolean) ?? true,
          riskLevel: (entry.riskLevel as "low" | "medium" | "high") ?? "medium",
          examples: (entry.examples as string[]) ?? (entry.synonyms as string[]) ?? [],
        };
        if (!cachedIntents!.intents.find((i) => i.name === def.name)) {
          cachedIntents!.intents.push(def);
        }
      }
    } catch {
      // Silently ignore malformed custom intents file
    }
  }

  return cachedIntents.intents;
}

export function getIntentDef(name: string): IntentDef | undefined {
  return loadIntents().find((i) => i.name === name);
}

export function loadHosts(): Record<string, { host: string; description: string }> {
  const raw = readFileSync(resolve(CONFIG_DIR, "hosts.json"), "utf-8");
  return JSON.parse(raw);
}

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export { CONFIG_DIR, DATA_DIR, LOG_DIR, PACKAGE_ROOT, USER_HOME } from "./paths.js";
