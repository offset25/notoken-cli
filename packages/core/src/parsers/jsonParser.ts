/**
 * JSON parser with path-based access.
 */

export function parseJson(content: string): unknown {
  return JSON.parse(content);
}

/**
 * Get a nested value using dot-notation or bracket path.
 * e.g., getJsonValue(data, "users[0].name")
 */
export function getJsonValue(data: unknown, path: string): unknown {
  const parts = path.match(/[^.[\]]+/g);
  if (!parts) return undefined;

  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }

    if (Array.isArray(current)) {
      const idx = Number(part);
      if (isNaN(idx)) return undefined;
      current = current[idx];
    } else {
      current = (current as Record<string, unknown>)[part];
    }
  }

  return current;
}

/**
 * Search JSON for keys matching a pattern.
 */
export function searchJsonKeys(data: unknown, pattern: string, prefix = ""): Array<{ path: string; value: unknown }> {
  const results: Array<{ path: string; value: unknown }> = [];
  const lower = pattern.toLowerCase();

  if (data === null || data === undefined || typeof data !== "object") return results;

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      results.push(...searchJsonKeys(data[i], pattern, `${prefix}[${i}]`));
    }
  } else {
    for (const [key, value] of Object.entries(data)) {
      const fullPath = prefix ? `${prefix}.${key}` : key;
      if (key.toLowerCase().includes(lower)) {
        results.push({ path: fullPath, value });
      }
      if (typeof value === "object" && value !== null) {
        results.push(...searchJsonKeys(value, pattern, fullPath));
      }
    }
  }

  return results;
}
