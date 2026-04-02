import type { DynamicIntent } from "../types/intent.js";
import { getIntentDef, loadRules } from "../utils/config.js";

export function validateIntent(intent: DynamicIntent): string[] {
  const def = getIntentDef(intent.intent);
  if (!def) return [];

  const errors: string[] = [];

  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    if (fieldDef.required && intent.fields[fieldName] === undefined) {
      errors.push(`Missing required field: ${fieldName}`);
    }
  }

  // Check allowlist — services from rules.json serviceAliases are always allowed
  if (def.allowlist && def.allowlist.length > 0) {
    const rules = loadRules();
    const knownServices = new Set([...def.allowlist, ...Object.keys(rules.serviceAliases)]);
    for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
      if (fieldDef.type === "service" && intent.fields[fieldName]) {
        const value = intent.fields[fieldName] as string;
        if (!knownServices.has(value)) {
          errors.push(`${fieldName} "${value}" is not in the allowlist: ${[...knownServices].join(", ")}`);
        }
      }
    }
  }

  return errors;
}

export function isDangerous(intent: DynamicIntent): boolean {
  const def = getIntentDef(intent.intent);
  return def?.requiresConfirmation ?? false;
}

export function getRiskLevel(intent: DynamicIntent): "low" | "medium" | "high" {
  const def = getIntentDef(intent.intent);
  return def?.riskLevel ?? "low";
}
