import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { RulesConfig } from "../types/rules.js";
import { IntentsConfig, type IntentDef } from "../types/intent.js";
import { CONFIG_DIR } from "./paths.js";
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
