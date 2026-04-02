import { runRemoteCommand, runLocalCommand } from "../execution/ssh.js";
import type { DynamicIntent, IntentDef } from "../types/intent.js";
import { getIntentDef } from "../utils/config.js";

/**
 * Fuzzy file resolver.
 *
 * When an intent has fuzzyResolve fields, this attempts to find the actual
 * file path on the target server using a combination of:
 * - exact match
 * - find by filename
 * - find by partial name (fuzzy)
 * - locate database
 *
 * Returns the intent with resolved file paths in the fields.
 */
export async function resolveFuzzyFields(
  intent: DynamicIntent
): Promise<DynamicIntent> {
  const def = getIntentDef(intent.intent);
  if (!def?.fuzzyResolve || def.fuzzyResolve.length === 0) return intent;

  const env = (intent.fields.environment as string) ?? "dev";
  const execution = def.execution;
  const fields = { ...intent.fields };

  for (const fieldName of def.fuzzyResolve) {
    const rawValue = fields[fieldName] as string | undefined;
    if (!rawValue) continue;

    // If it already looks like an absolute path, keep it
    if (rawValue.startsWith("/")) continue;

    const resolved = await fuzzyFindFile(rawValue, env, execution);
    if (resolved) {
      fields[fieldName] = resolved;
    }
  }

  return { ...intent, fields };
}

async function fuzzyFindFile(
  filename: string,
  environment: string,
  execution: "remote" | "local"
): Promise<string | null> {
  const run = execution === "local" ? runLocalCommand : (cmd: string) => runRemoteCommand(environment, cmd);

  // Strategy 1: find by exact name in common locations
  const searchPaths = ["/etc", "/var/log", "/var", "/srv", "/opt", "/tmp", "/root", "/home"];
  const findCmd = `find ${searchPaths.join(" ")} -maxdepth 4 -name '${sanitizeForShell(filename)}' 2>/dev/null | head -10`;

  try {
    const result = (await run(findCmd)).trim();
    if (result) {
      const matches = result.split("\n").filter(Boolean);
      if (matches.length === 1) return matches[0];
      if (matches.length > 1) {
        // Return best match — prefer shorter path (closer to root of search)
        return rankMatches(filename, matches);
      }
    }
  } catch {}

  // Strategy 2: fuzzy — find by partial name
  const baseName = filename.replace(/\.[^.]+$/, ""); // strip extension
  const fuzzyCmd = `find ${searchPaths.join(" ")} -maxdepth 4 -iname '*${sanitizeForShell(baseName)}*' 2>/dev/null | head -10`;

  try {
    const result = (await run(fuzzyCmd)).trim();
    if (result) {
      const matches = result.split("\n").filter(Boolean);
      if (matches.length > 0) {
        return rankMatches(filename, matches);
      }
    }
  } catch {}

  // Strategy 3: locate (if available)
  try {
    const result = (await run(`locate -i '${sanitizeForShell(filename)}' 2>/dev/null | head -10`)).trim();
    if (result) {
      const matches = result.split("\n").filter(Boolean);
      if (matches.length > 0) {
        return rankMatches(filename, matches);
      }
    }
  } catch {}

  return null;
}

/**
 * Rank file path matches by similarity to the query.
 * Prefers: exact basename match > shorter path > alphabetical
 */
function rankMatches(query: string, matches: string[]): string {
  const queryLower = query.toLowerCase();

  const scored = matches.map((m) => {
    const basename = m.split("/").pop()?.toLowerCase() ?? "";
    let score = 0;

    // Exact basename match
    if (basename === queryLower) score += 100;
    // Basename starts with query
    else if (basename.startsWith(queryLower)) score += 50;
    // Basename contains query
    else if (basename.includes(queryLower)) score += 25;

    // Prefer shorter paths (more specific location)
    score -= m.split("/").length;

    return { path: m, score };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored[0].path;
}

function sanitizeForShell(value: string): string {
  // Strip anything that isn't alphanumeric, dot, dash, underscore, star
  return value.replace(/[^a-zA-Z0-9._*\-]/g, "");
}
