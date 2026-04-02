import type { DynamicIntent } from "../../../src/types/intent.js";

export function buildIntent(overrides: Partial<DynamicIntent> = {}): DynamicIntent {
  return {
    intent: "service.restart",
    confidence: 0.9,
    rawText: "restart nginx on prod",
    fields: { service: "nginx", environment: "prod" },
    ...overrides,
  };
}
