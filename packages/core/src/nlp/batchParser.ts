/**
 * Batch Parser — detect and expand batch commands.
 *
 * "restart nginx, redis, and mysql on prod"
 *   → 3 intents: restart nginx on prod, restart redis on prod, restart mysql on prod
 *
 * "check disk on prod, staging, and dev"
 *   → 3 intents: check disk on prod, check disk on staging, check disk on dev
 *
 * "stop containers api, worker, and scheduler"
 *   → 3 intents: stop container api, stop container worker, stop container scheduler
 */

export interface BatchExpansion {
  isBatch: boolean;
  commands: string[];
  original: string;
}

// Patterns for comma-separated lists with "and"
const LIST_PATTERN = /^(.+?)\s+([\w-]+(?:\s*,\s*[\w-]+)*\s*(?:,?\s*and\s+[\w-]+))\s*(.*)$/i;

/**
 * Detect if input contains a batch/list of targets and expand.
 */
export function expandBatch(rawText: string): BatchExpansion {
  const text = rawText.trim();

  // Pattern: "verb targets, target2, and target3 modifier"
  // E.g., "restart nginx, redis, and mysql on prod"
  const match = text.match(LIST_PATTERN);
  if (!match) return { isBatch: false, commands: [text], original: text };

  const prefix = match[1].trim(); // "restart"
  const listPart = match[2].trim(); // "nginx, redis, and mysql"
  const suffix = match[3].trim(); // "on prod"

  // Parse the comma/and-separated list
  const items = listPart
    .replace(/\s+and\s+/gi, ", ")
    .split(/\s*,\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  // Need at least 2 items for it to be a batch
  if (items.length < 2) return { isBatch: false, commands: [text], original: text };

  // Verify these look like service/entity names (not random words)
  const looksLikeEntities = items.every(item =>
    /^[\w][\w.-]*$/.test(item) && item.length >= 2 && item.length <= 30
  );

  if (!looksLikeEntities) return { isBatch: false, commands: [text], original: text };

  // Expand: "restart X on prod" for each item
  const commands = items.map(item =>
    `${prefix} ${item}${suffix ? ` ${suffix}` : ""}`
  );

  return { isBatch: true, commands, original: text };
}

/**
 * Also handle "on X, Y, and Z" pattern:
 * "check disk on prod, staging, and dev"
 */
export function expandEnvironmentBatch(rawText: string): BatchExpansion {
  const text = rawText.trim();

  // Pattern: "command on env1, env2, and env3"
  const match = text.match(/^(.+?)\s+on\s+([\w-]+(?:\s*,\s*[\w-]+)*\s*(?:,?\s*and\s+[\w-]+))$/i);
  if (!match) return { isBatch: false, commands: [text], original: text };

  const command = match[1].trim();
  const envPart = match[2].trim();

  const envs = envPart
    .replace(/\s+and\s+/gi, ", ")
    .split(/\s*,\s*/)
    .map(s => s.trim())
    .filter(s => s.length > 0);

  if (envs.length < 2) return { isBatch: false, commands: [text], original: text };

  const commands = envs.map(env => `${command} on ${env}`);
  return { isBatch: true, commands, original: text };
}

/**
 * Try both batch patterns and return the first match.
 */
export function detectBatch(rawText: string): BatchExpansion {
  // Try environment batch first ("check disk on prod, staging, and dev")
  const envBatch = expandEnvironmentBatch(rawText);
  if (envBatch.isBatch) return envBatch;

  // Then try entity batch ("restart nginx, redis, and mysql")
  return expandBatch(rawText);
}
