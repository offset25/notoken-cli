/**
 * .env file parser and writer.
 *
 * Reads KEY=VALUE pairs, detects secrets, supports comments.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";

export interface EnvEntry {
  key: string;
  value: string;
  comment?: string;
  isSecret: boolean;
  line: number;
}

// Keys that likely contain secrets
const SECRET_KEY_PATTERNS = [
  /password/i, /passwd/i, /secret/i, /token/i, /api[_-]?key/i,
  /private[_-]?key/i, /auth/i, /credential/i, /access[_-]?key/i,
  /connection[_-]?string/i, /db[_-]?pass/i,
];

/**
 * Parse .env file content into entries.
 */
export function parseEnvFile(content: string): EnvEntry[] {
  const entries: EnvEntry[] = [];
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (!line || line.startsWith("#")) continue;

    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)=(.*)$/);
    if (!match) continue;

    const key = match[1];
    let value = match[2];

    // Strip surrounding quotes
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }

    // Strip inline comment
    let comment: string | undefined;
    const commentMatch = value.match(/\s+#\s*(.*)$/);
    if (commentMatch && !value.startsWith('"')) {
      comment = commentMatch[1];
      value = value.slice(0, value.indexOf(commentMatch[0]));
    }

    const isSecret = SECRET_KEY_PATTERNS.some((p) => p.test(key));

    entries.push({ key, value, comment, isSecret, line: i + 1 });
  }

  return entries;
}

/**
 * Get the value of a specific key.
 */
export function getEnvValue(entries: EnvEntry[], key: string): string | undefined {
  return entries.find((e) => e.key === key)?.value;
}

/**
 * Set or update a key in env entries. Returns new content string.
 */
export function setEnvValue(
  content: string,
  key: string,
  value: string,
  comment?: string
): string {
  const lines = content.split("\n");
  const pattern = new RegExp(`^${key}=`);
  const newLine = comment ? `${key}=${value} # ${comment}` : `${key}=${value}`;

  for (let i = 0; i < lines.length; i++) {
    if (pattern.test(lines[i].trim())) {
      lines[i] = newLine;
      return lines.join("\n");
    }
  }

  // Key not found — append
  lines.push(newLine);
  return lines.join("\n");
}

/**
 * Read, modify, and write back an .env file.
 */
export function updateEnvFile(filePath: string, key: string, value: string, comment?: string): void {
  const content = existsSync(filePath) ? readFileSync(filePath, "utf-8") : "";
  const updated = setEnvValue(content, key, value, comment);
  writeFileSync(filePath, updated);
}

/**
 * Generate a smart variable name based on purpose and topic.
 *
 * Examples:
 *   ("database", "password", "staging") → DB_STAGING_PASSWORD
 *   ("api", "key", "prod")             → API_PROD_KEY
 *   ("redis", "url", undefined)        → REDIS_URL
 *   ("smtp", "password", "prod")       → SMTP_PROD_PASSWORD
 *   ("aws", "secret", "production")    → AWS_PROD_SECRET
 */
export function generateEnvName(
  topic: string,
  purpose: string,
  environment?: string
): string {
  const parts: string[] = [];

  // Topic aliases
  const topicMap: Record<string, string> = {
    database: "DB", db: "DB", postgres: "DB", postgresql: "DB", mysql: "DB", mongo: "DB",
    redis: "REDIS", cache: "REDIS",
    api: "API", rest: "API",
    smtp: "SMTP", email: "SMTP", mail: "SMTP",
    aws: "AWS", s3: "AWS_S3", gcp: "GCP", azure: "AZURE",
    jwt: "JWT", auth: "AUTH", oauth: "OAUTH",
    stripe: "STRIPE", twilio: "TWILIO", sendgrid: "SENDGRID",
    github: "GITHUB", gitlab: "GITLAB",
    docker: "DOCKER", k8s: "K8S", kubernetes: "K8S",
    sentry: "SENTRY", datadog: "DATADOG",
    app: "APP", server: "SERVER", node: "NODE",
  };

  parts.push(topicMap[topic.toLowerCase()] ?? topic.toUpperCase().replace(/[^A-Z0-9]/g, "_"));

  // Environment in the middle
  if (environment) {
    const envMap: Record<string, string> = {
      production: "PROD", prod: "PROD",
      staging: "STAGING", stage: "STAGING",
      development: "DEV", dev: "DEV",
      test: "TEST", local: "LOCAL",
    };
    parts.push(envMap[environment.toLowerCase()] ?? environment.toUpperCase());
  }

  // Purpose aliases
  const purposeMap: Record<string, string> = {
    password: "PASSWORD", pass: "PASSWORD", passwd: "PASSWORD",
    key: "KEY", apikey: "KEY", "api-key": "KEY", "api_key": "KEY",
    secret: "SECRET", "secret-key": "SECRET_KEY",
    token: "TOKEN", "access-token": "ACCESS_TOKEN",
    url: "URL", uri: "URL", endpoint: "URL", host: "HOST",
    port: "PORT",
    user: "USER", username: "USER",
    name: "NAME",
    connection: "CONNECTION_STRING", "connection-string": "CONNECTION_STRING",
    region: "REGION",
    bucket: "BUCKET",
  };

  parts.push(purposeMap[purpose.toLowerCase()] ?? purpose.toUpperCase().replace(/[^A-Z0-9]/g, "_"));

  return parts.join("_");
}
