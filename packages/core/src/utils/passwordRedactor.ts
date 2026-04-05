/**
 * Password Detection & Redaction.
 *
 * Detects passwords and secrets in user input and command output.
 * Redacts them before storing in conversation history or logs.
 * Never stores passwords in plaintext — only in the encrypted vault.
 */

// ── Password patterns ──────────────────────────────────────────────────────

const PASSWORD_PATTERNS: Array<{ pattern: RegExp; group: number; label: string }> = [
  // Explicit password fields: "password xyz123", "pass: abc", "pw=secret"
  { pattern: /\b(?:password|passwd|pass|pw|passphrase)\s*[=:]\s*["']?(\S+)["']?/gi, group: 1, label: "password" },
  { pattern: /\bpassword\s+(\S+)/gi, group: 1, label: "password" },

  // SSH/auth patterns: "sshpass -p 'mypass'", "-p mypass"
  { pattern: /sshpass\s+-p\s+["']?(\S+?)["']?\s/gi, group: 1, label: "sshpass" },

  // API keys/tokens: "ANTHROPIC_API_KEY=sk-...", "token=abc123"
  { pattern: /\b(?:api[_-]?key|token|secret|bearer)\s*[=:]\s*["']?(\S{8,})["']?/gi, group: 1, label: "api_key" },

  // AWS keys
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, group: 1, label: "aws_access_key" },
  { pattern: /\b([0-9a-zA-Z/+]{40})\b/g, group: 1, label: "possible_aws_secret" },

  // Generic secrets in env-like assignments: "SECRET_KEY=..."
  { pattern: /\b[A-Z_]*(?:SECRET|PRIVATE|CREDENTIAL|AUTH)[A-Z_]*\s*=\s*["']?(\S{8,})["']?/gi, group: 1, label: "env_secret" },

  // Database connection strings with passwords: "mysql://user:pass@host"
  { pattern: /(?:mysql|postgres|mongodb|redis):\/\/\w+:([^@]+)@/gi, group: 1, label: "db_password" },

  // SSH private key content
  { pattern: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g, group: 1, label: "private_key" },
];

// Words that look like passwords when they follow certain keywords
const PASSWORD_CONTEXT_PATTERNS = [
  /\b(?:the\s+password\s+is|my\s+password\s+is|password\s+is)\s+["']?(\S+)["']?/gi,
  /\b(?:use|with|using)\s+password\s+["']?(\S+)["']?/gi,
  /\b(?:login|auth|authenticate)\s+(?:with\s+)?["']?(\S{6,})["']?(?:\s|$)/gi,
];

// ── Detection ──────────────────────────────────────────────────────────────

export interface DetectedSecret {
  value: string;
  label: string;
  start: number;
  end: number;
}

/**
 * Detect potential passwords/secrets in text.
 * Returns array of detected secrets with their positions.
 */
export function detectSecrets(text: string): DetectedSecret[] {
  const secrets: DetectedSecret[] = [];
  const seen = new Set<string>();

  for (const { pattern, group, label } of PASSWORD_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[group];
      if (value && value.length >= 4 && !seen.has(value)) {
        // Skip common false positives
        if (isFalsePositive(value, label)) continue;
        seen.add(value);
        const start = match.index + match[0].indexOf(value);
        secrets.push({ value, label, start, end: start + value.length });
      }
    }
  }

  for (const pattern of PASSWORD_CONTEXT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[1];
      if (value && value.length >= 4 && !seen.has(value)) {
        if (isFalsePositive(value, "context_password")) continue;
        seen.add(value);
        const start = match.index + match[0].indexOf(value);
        secrets.push({ value, label: "password", start, end: start + value.length });
      }
    }
  }

  return secrets;
}

/**
 * Check if a detected "secret" is a false positive.
 */
function isFalsePositive(value: string, label: string): boolean {
  // Common words that aren't passwords
  const commonWords = new Set([
    "password", "secret", "token", "admin", "root", "user", "test",
    "example", "default", "null", "none", "empty", "undefined",
    "localhost", "true", "false", "yes", "no",
  ]);
  if (commonWords.has(value.toLowerCase())) return true;

  // Skip URLs, file paths
  if (value.startsWith("http") || value.startsWith("/") || value.startsWith("~")) return true;

  // Skip very short values for non-explicit patterns
  if (value.length < 6 && label !== "password" && label !== "sshpass") return true;

  // Skip if it's all the same character
  if (/^(.)\1+$/.test(value)) return true;

  return false;
}

// ── Redaction ──────────────────────────────────────────────────────────────

/**
 * Redact detected secrets in text, replacing with [REDACTED].
 */
export function redactSecrets(text: string): string {
  const secrets = detectSecrets(text);
  if (secrets.length === 0) return text;

  // Sort by position descending so replacements don't shift indices
  secrets.sort((a, b) => b.start - a.start);

  let result = text;
  for (const secret of secrets) {
    const replacement = `[REDACTED:${secret.label}]`;
    result = result.substring(0, secret.start) + replacement + result.substring(secret.end);
  }
  return result;
}

/**
 * Check if text contains any potential secrets.
 */
export function containsSecrets(text: string): boolean {
  return detectSecrets(text).length > 0;
}

/**
 * Redact for conversation history — more aggressive, replaces entire
 * password-containing lines with a redaction notice.
 */
export function redactForHistory(text: string): string {
  const secrets = detectSecrets(text);
  if (secrets.length === 0) return text;

  const lines = text.split("\n");
  const redactedLines = lines.map(line => {
    const lineSecrets = secrets.filter(s => {
      const lineStart = text.indexOf(line);
      return s.start >= lineStart && s.start < lineStart + line.length;
    });
    if (lineSecrets.length > 0) {
      return `[REDACTED — contained ${lineSecrets.map(s => s.label).join(", ")}]`;
    }
    return line;
  });
  return redactedLines.join("\n");
}

/**
 * Extract password from user input and return the redacted version.
 * Used by SSH credential handlers to safely capture passwords
 * without storing them in conversation history.
 */
export function extractAndRedact(text: string): { password: string | null; redacted: string } {
  const secrets = detectSecrets(text);
  const passwordSecret = secrets.find(s => s.label === "password" || s.label === "sshpass" || s.label === "context_password");

  return {
    password: passwordSecret?.value ?? null,
    redacted: redactSecrets(text),
  };
}
