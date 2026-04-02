import type { DynamicIntent } from "../types/intent.js";
import { getIntentDef } from "../utils/config.js";

export function validateIntent(intent: DynamicIntent): string[] {
  const def = getIntentDef(intent.intent);
  if (!def) return [];

  const errors: string[] = [];

  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    if (fieldDef.required && intent.fields[fieldName] === undefined) {
      errors.push(`Missing required field: ${fieldName}`);
    }
  }

  // Check allowlist if defined
  if (def.allowlist && def.allowlist.length > 0) {
    for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
      if (fieldDef.type === "service" && intent.fields[fieldName]) {
        const value = intent.fields[fieldName] as string;
        if (!def.allowlist.includes(value)) {
          errors.push(`${fieldName} "${value}" is not in the allowlist: ${def.allowlist.join(", ")}`);
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
