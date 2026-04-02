import { loadIntents, getIntentDef } from "../utils/config.js";
import type { IntentDef } from "../types/intent.js";

export type { IntentDef };

export function getIntentCatalog(): IntentDef[] {
  return loadIntents();
}

export function getCatalogEntry(intentName: string): IntentDef | undefined {
  return getIntentDef(intentName);
}
