import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { DATA_DIR } from "../utils/paths.js";

/**
 * Secret manager.
 *
 * Detects passwords, tokens, and secrets in conversation text.
 * Replaces them with <password.UUID> placeholders in stored conversations.
 * Secrets live only in memory unless the user explicitly saves them.
 */

// In-memory secret store (never persisted unless user asks)
const secretStore = new Map<string, string>();

// Patterns that look like secrets
const SECRET_PATTERNS: Array<{ pattern: RegExp; label: string }> = [
  // Explicit password flags
  { pattern: /(?:--password|--pass|-p)\s+(\S+)/i, label: "password" },
  { pattern: /(?:password|passwd|pass)\s*[=:]\s*(\S+)/i, label: "password" },

  // API keys / tokens
  { pattern: /(?:api[_-]?key|token|secret|auth)\s*[=:]\s*(\S+)/i, label: "api_key" },
  { pattern: /\b(sk-[a-zA-Z0-9]{20,})\b/, label: "api_key" },
  { pattern: /\b(ghp_[a-zA-Z0-9]{36,})\b/, label: "github_token" },
  { pattern: /\b(glpat-[a-zA-Z0-9\-_]{20,})\b/, label: "gitlab_token" },

  // SSH private key content
  { pattern: /(-----BEGIN (?:RSA |EC |DSA )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |DSA )?PRIVATE KEY-----)/, label: "private_key" },

  // Generic high-entropy strings that look like secrets (32+ chars, mixed case + digits)
  { pattern: /\b([A-Za-z0-9+\/]{32,}={0,2})\b/, label: "possible_secret" },

  // Connection strings with passwords
  { pattern: /:\/\/([^:]+):([^@]+)@/i, label: "connection_password" },
];

export interface RedactionResult {
  /** Text with secrets replaced by placeholders */
  redactedText: string;
  /** Number of secrets found */
  secretCount: number;
  /** The placeholder IDs created */
  placeholders: Array<{ id: string; label: string }>;
}

/**
 * Scan text for secrets and replace with placeholders.
 * Secrets are stored in memory only.
 */
export function redactSecrets(text: string): RedactionResult {
  let redacted = text;
  const placeholders: Array<{ id: string; label: string }> = [];

  for (const { pattern, label } of SECRET_PATTERNS) {
    // Skip the generic high-entropy pattern for short texts
    if (label === "possible_secret" && text.length < 50) continue;

    const match = redacted.match(pattern);
    if (!match) continue;

    // For connection strings, redact just the password part (group 2)
    const secretValue = match[2] ?? match[1];
    if (!secretValue || secretValue.length < 6) continue;

    // Don't redact common words that happen to match
    if (isCommonWord(secretValue)) continue;

    const id = `<${label}.${randomUUID().slice(0, 8)}>`;
    secretStore.set(id, secretValue);
    redacted = redacted.replace(secretValue, id);
    placeholders.push({ id, label });
  }

  return {
    redactedText: redacted,
    secretCount: placeholders.length,
    placeholders,
  };
}

/**
 * Retrieve a secret from memory by placeholder ID.
 */
export function getSecret(placeholderId: string): string | undefined {
  return secretStore.get(placeholderId);
}

/**
 * List all secret placeholder IDs in memory.
 */
export function listSecrets(): Array<{ id: string; preview: string }> {
  return Array.from(secretStore.entries()).map(([id, value]) => ({
    id,
    preview: value.slice(0, 4) + "****",
  }));
}

/**
 * Save secrets to a file (only when user explicitly asks).
 */
export function saveSecretsToFile(filepath?: string): string {
  const file = filepath ?? resolve(DATA_DIR, `secrets_${Date.now()}.json`);
  const dir = dirname(file);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });

  const data: Record<string, string> = {};
  for (const [id, value] of secretStore.entries()) {
    data[id] = value;
  }

  writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
  return file;
}

/**
 * Load secrets from a previously saved file back into memory.
 */
export function loadSecretsFromFile(filepath: string): number {
  if (!existsSync(filepath)) return 0;
  const data = JSON.parse(readFileSync(filepath, "utf-8")) as Record<string, string>;
  let count = 0;
  for (const [id, value] of Object.entries(data)) {
    secretStore.set(id, value);
    count++;
  }
  return count;
}

/**
 * Clear all secrets from memory.
 */
export function clearSecrets(): void {
  secretStore.clear();
}

/**
 * Resolve placeholders back to real values (for execution only, not storage).
 */
export function resolvePlaceholders(text: string): string {
  let resolved = text;
  for (const [id, value] of secretStore.entries()) {
    resolved = resolved.replaceAll(id, value);
  }
  return resolved;
}

function isCommonWord(value: string): boolean {
  const common = new Set([
    "password", "secret", "token", "admin", "root", "localhost",
    "default", "staging", "production", "develop", "master", "main",
  ]);
  return common.has(value.toLowerCase());
}
