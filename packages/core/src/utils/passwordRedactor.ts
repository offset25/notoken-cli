/**
 * Password Detection & Redaction.
 *
 * Detects passwords and secrets in user input and command output.
 * Uses heuristic analysis: entropy, character mix, proximity to auth keywords.
 * Confidence levels: high (0.9+), medium (0.7+), low (0.5+).
 * Redacts before storing in conversation history or logs.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export interface DetectedSecret {
  value: string;
  label: string;
  confidence: number; // 0.0 - 1.0
  start: number;
  end: number;
  reason: string;
}

// ── Explicit patterns (high confidence) ────────────────────────────────────

const EXPLICIT_PATTERNS: Array<{ pattern: RegExp; group: number; label: string; confidence: number; reason: string }> = [
  // "password xyz123", "pass: abc", "pw=secret"
  { pattern: /\b(?:password|passwd|pass|pw|passphrase)\s*[=:]\s*["']?(\S+)["']?/gi, group: 1, label: "password", confidence: 0.95, reason: "explicit password field" },
  { pattern: /\bpassword\s+(\S+)/gi, group: 1, label: "password", confidence: 0.9, reason: "follows 'password' keyword" },

  // "the password is xyz", "my password is abc"
  { pattern: /\b(?:the|my)\s+password\s+is\s+["']?(\S+)["']?/gi, group: 1, label: "password", confidence: 0.95, reason: "'the password is' pattern" },

  // "use password xyz", "with password abc"
  { pattern: /\b(?:use|with|using)\s+password\s+["']?(\S+)["']?/gi, group: 1, label: "password", confidence: 0.9, reason: "'use/with password' pattern" },

  // sshpass -p 'mypass'
  { pattern: /sshpass\s+-p\s+["']?(\S+?)["']?\s/gi, group: 1, label: "sshpass", confidence: 0.98, reason: "sshpass -p argument" },

  // API keys/tokens
  { pattern: /\b(?:api[_-]?key|token|secret|bearer)\s*[=:]\s*["']?(\S{8,})["']?/gi, group: 1, label: "api_key", confidence: 0.9, reason: "explicit api_key/token field" },

  // AWS access keys (very specific format)
  { pattern: /\b(AKIA[0-9A-Z]{16})\b/g, group: 1, label: "aws_access_key", confidence: 0.99, reason: "AWS access key format" },

  // Generic secrets in env assignments: SECRET_KEY=...
  { pattern: /\b[A-Z_]*(?:SECRET|PRIVATE|CREDENTIAL|AUTH)[A-Z_]*\s*=\s*["']?(\S{8,})["']?/gi, group: 1, label: "env_secret", confidence: 0.85, reason: "env var with SECRET/PRIVATE in name" },

  // Database connection strings: mysql://user:pass@host
  { pattern: /(?:mysql|postgres|postgresql|mongodb|redis|amqp):\/\/\w+:([^@]+)@/gi, group: 1, label: "db_password", confidence: 0.95, reason: "database connection string" },

  // SSH private key content
  { pattern: /(-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----)/g, group: 1, label: "private_key", confidence: 0.99, reason: "SSH private key block" },
];

// ── Username + password pair detection ─────────────────────────────────────

const AUTH_PAIR_PATTERNS: Array<{ pattern: RegExp; userGroup: number; passGroup: number; confidence: number }> = [
  // "user root password abc123"
  { pattern: /\buser(?:name)?\s+(\S+)\s+(?:password|pass|pw)\s+(\S+)/gi, userGroup: 1, passGroup: 2, confidence: 0.95 },
  // "login admin:secret123"
  { pattern: /\b(?:login|auth|connect)\s+(\S+):(\S+)/gi, userGroup: 1, passGroup: 2, confidence: 0.9 },
  // "root/mypassword" (user/pass shorthand)
  { pattern: /\b(\w+)\/(\S{6,})\s/gi, userGroup: 1, passGroup: 2, confidence: 0.6 },
  // "-u admin -p secret123"
  { pattern: /\-u\s+(\S+)\s+\-p\s+["']?(\S+?)["']?(?:\s|$)/gi, userGroup: 1, passGroup: 2, confidence: 0.95 },
];

// ── Heuristic password scoring ─────────────────────────────────────────────

/** Auth-context keywords that raise suspicion for nearby tokens */
const AUTH_KEYWORDS = new Set([
  "password", "passwd", "pass", "pw", "login", "auth", "authenticate",
  "credential", "secret", "user", "username", "ssh", "connect", "remote",
  "server", "host", "root", "admin", "sudo", "su",
]);

/** Score how "password-like" a string is based on character composition */
function passwordLikelihood(value: string): number {
  if (value.length < 4) return 0;
  if (value.length > 128) return 0;

  let score = 0;

  // Character type diversity (passwords mix types)
  const hasLower = /[a-z]/.test(value);
  const hasUpper = /[A-Z]/.test(value);
  const hasDigit = /[0-9]/.test(value);
  const hasSpecial = /[^a-zA-Z0-9]/.test(value);
  const typeCount = [hasLower, hasUpper, hasDigit, hasSpecial].filter(Boolean).length;

  if (typeCount >= 3) score += 0.4;        // Strong: 3+ char types
  else if (typeCount === 2) score += 0.2;   // Moderate: 2 char types
  else score -= 0.1;                        // Weak: single type (probably not a password)

  // Length scoring — passwords are typically 6-32 chars
  if (value.length >= 8 && value.length <= 32) score += 0.15;
  else if (value.length >= 6) score += 0.1;

  // Entropy-like check — no repeating patterns
  const unique = new Set(value).size;
  const ratio = unique / value.length;
  if (ratio > 0.6) score += 0.15;          // High variety
  else if (ratio < 0.3) score -= 0.2;      // Low variety (probably not a password)

  // Bonus: contains digits mixed with letters (very common in passwords)
  if (hasDigit && (hasLower || hasUpper)) score += 0.1;

  // Penalty: looks like a word, path, URL, or command
  if (/^[a-z]+$/i.test(value)) score -= 0.3;               // All letters (probably a word)
  if (value.startsWith("/") || value.startsWith("~")) score -= 0.5;  // File path
  if (value.startsWith("http")) score -= 0.5;               // URL
  if (value.includes(".") && !hasDigit) score -= 0.2;       // Domain/filename
  if (/^\d+$/.test(value)) score -= 0.2;                    // All digits (port/count)
  if (/^(true|false|yes|no|null|none|localhost|root|admin|user|test|dev|prod|staging)$/i.test(value)) score -= 0.5;

  return Math.max(0, Math.min(1, score));
}

/** Check if a word near index `pos` in `text` is an auth keyword */
function hasNearbyAuthKeyword(text: string, pos: number, range = 60): boolean {
  const start = Math.max(0, pos - range);
  const end = Math.min(text.length, pos + range);
  const nearby = text.substring(start, end).toLowerCase();
  for (const kw of AUTH_KEYWORDS) {
    if (nearby.includes(kw)) return true;
  }
  return false;
}

// ── Common false positives ─────────────────────────────────────────────────

const FALSE_POSITIVES = new Set([
  "password", "secret", "token", "admin", "root", "user", "test",
  "example", "default", "null", "none", "empty", "undefined",
  "localhost", "true", "false", "yes", "no", "nginx", "apache",
  "docker", "ubuntu", "debian", "centos", "prod", "staging", "dev",
]);

function isFalsePositive(value: string): boolean {
  if (FALSE_POSITIVES.has(value.toLowerCase())) return true;
  if (value.startsWith("http") || value.startsWith("/") || value.startsWith("~")) return true;
  if (/^(.)\1+$/.test(value)) return true;  // All same char
  if (value.length < 4) return true;
  return false;
}

// ── Main detection ─────────────────────────────────────────────────────────

/**
 * Detect potential passwords/secrets in text.
 * Returns array of detected secrets with confidence scores.
 */
export function detectSecrets(text: string): DetectedSecret[] {
  const secrets: DetectedSecret[] = [];
  const seen = new Set<string>();

  // 1. Explicit patterns (high confidence)
  for (const { pattern, group, label, confidence, reason } of EXPLICIT_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[group];
      if (value && !isFalsePositive(value) && !seen.has(value)) {
        seen.add(value);
        const start = match.index + match[0].indexOf(value);
        secrets.push({ value, label, confidence, start, end: start + value.length, reason });
      }
    }
  }

  // 2. Username+password pairs
  for (const { pattern, passGroup, confidence } of AUTH_PAIR_PATTERNS) {
    pattern.lastIndex = 0;
    let match;
    while ((match = pattern.exec(text)) !== null) {
      const value = match[passGroup];
      if (value && !isFalsePositive(value) && !seen.has(value)) {
        seen.add(value);
        const start = match.index + match[0].indexOf(value);
        secrets.push({ value, label: "password", confidence, start, end: start + value.length, reason: "username+password pair" });
      }
    }
  }

  // 3. Heuristic: scan tokens near auth keywords for password-like strings
  const words = text.split(/\s+/);
  let pos = 0;
  for (const word of words) {
    const wordStart = text.indexOf(word, pos);
    pos = wordStart + word.length;

    // Skip already detected
    if (seen.has(word)) continue;

    // Skip if it's an auth keyword itself
    if (AUTH_KEYWORDS.has(word.toLowerCase())) continue;

    // Score the word
    const likelihood = passwordLikelihood(word);
    if (likelihood < 0.3) continue;

    // Check for nearby auth context
    const nearAuth = hasNearbyAuthKeyword(text, wordStart);
    if (!nearAuth) continue;

    // Combine: password-like + near auth keywords = suspicious
    const confidence = Math.min(0.85, likelihood + (nearAuth ? 0.3 : 0));
    if (confidence >= 0.5 && !isFalsePositive(word)) {
      seen.add(word);
      secrets.push({
        value: word, label: "heuristic_password", confidence,
        start: wordStart, end: wordStart + word.length,
        reason: `password-like (score:${likelihood.toFixed(2)}) near auth keywords`,
      });
    }
  }

  return secrets;
}

// ── Redaction ──────────────────────────────────────────────────────────────

/** Minimum confidence to redact (skip low-confidence guesses) */
const REDACT_THRESHOLD = 0.5;

/**
 * Redact detected secrets in text, replacing with [REDACTED].
 */
export function redactSecrets(text: string, threshold = REDACT_THRESHOLD): string {
  const secrets = detectSecrets(text).filter(s => s.confidence >= threshold);
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
 * Check if text contains any potential secrets above threshold.
 */
export function containsSecrets(text: string, threshold = REDACT_THRESHOLD): boolean {
  return detectSecrets(text).some(s => s.confidence >= threshold);
}

/**
 * Redact for conversation history — more aggressive, replaces entire
 * password-containing lines with a redaction notice.
 */
export function redactForHistory(text: string): string {
  const secrets = detectSecrets(text).filter(s => s.confidence >= 0.5);
  if (secrets.length === 0) return text;

  const lines = text.split("\n");
  const redactedLines = lines.map(line => {
    const lineSecrets = secrets.filter(s => {
      const lineStart = text.indexOf(line);
      return s.start >= lineStart && s.start < lineStart + line.length;
    });
    if (lineSecrets.length > 0) {
      return `[REDACTED — contained ${lineSecrets.map(s => `${s.label}(${(s.confidence * 100).toFixed(0)}%)`).join(", ")}]`;
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
export function extractAndRedact(text: string): { password: string | null; redacted: string; confidence: number } {
  const secrets = detectSecrets(text);
  // Find the highest-confidence password-type secret
  const passwordSecret = secrets
    .filter(s => ["password", "sshpass", "heuristic_password", "db_password"].includes(s.label))
    .sort((a, b) => b.confidence - a.confidence)[0];

  return {
    password: passwordSecret?.value ?? null,
    redacted: redactSecrets(text),
    confidence: passwordSecret?.confidence ?? 0,
  };
}
