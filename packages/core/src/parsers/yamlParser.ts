import YAML from "yaml";

/**
 * Parse YAML content into a JS object.
 */
export function parseYaml(content: string): unknown {
  return YAML.parse(content);
}

/**
 * Get a nested value from parsed YAML using dot-notation path.
 * e.g., getYamlValue(data, "server.port") → 8080
 */
export function getYamlValue(data: unknown, path: string): unknown {
  const parts = path.split(".");
  let current: unknown = data;

  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }

  return current;
}

/**
 * List all leaf paths in a YAML structure.
 */
export function listYamlPaths(data: unknown, prefix = ""): string[] {
  const paths: string[] = [];

  if (data === null || data === undefined || typeof data !== "object") {
    return paths;
  }

  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i++) {
      const key = prefix ? `${prefix}[${i}]` : `[${i}]`;
      if (typeof data[i] === "object" && data[i] !== null) {
        paths.push(...listYamlPaths(data[i], key));
      } else {
        paths.push(key);
      }
    }
  } else {
    for (const [key, value] of Object.entries(data)) {
      const fullKey = prefix ? `${prefix}.${key}` : key;
      if (typeof value === "object" && value !== null) {
        paths.push(...listYamlPaths(value, fullKey));
      } else {
        paths.push(fullKey);
      }
    }
  }

  return paths;
}
