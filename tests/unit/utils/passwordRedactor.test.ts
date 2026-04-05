import { describe, it, expect } from "vitest";
import { detectSecrets, redactSecrets, containsSecrets, redactForHistory, extractAndRedact } from "../../../packages/core/src/utils/passwordRedactor.js";

// ── Detection ──────────────────────────────────────────────────────────────

describe("password detection", () => {
  it("detects explicit password field", () => {
    const secrets = detectSecrets("add ssh login for prod user root password abc123");
    expect(secrets.length).toBeGreaterThan(0);
    expect(secrets[0].value).toBe("abc123");
    expect(secrets[0].label).toBe("password");
  });

  it("detects password=value format", () => {
    const secrets = detectSecrets("password=mysecret123");
    expect(secrets.some(s => s.value === "mysecret123")).toBe(true);
  });

  it("detects password: value format", () => {
    const secrets = detectSecrets('pass: "hunter2"');
    expect(secrets.some(s => s.value.includes("hunter2"))).toBe(true);
  });

  it("detects sshpass -p", () => {
    const secrets = detectSecrets('sshpass -p "mypass" ssh root@host');
    expect(secrets.some(s => s.label === "sshpass")).toBe(true);
  });

  it("detects API keys in env var format", () => {
    const secrets = detectSecrets("api_key=sk-ant-abc123456789abcdef");
    expect(secrets.some(s => s.label === "api_key")).toBe(true);
  });

  it("detects database connection strings", () => {
    const secrets = detectSecrets("postgres://admin:secretpass@db.example.com/mydb");
    expect(secrets.some(s => s.label === "db_password")).toBe(true);
    expect(secrets.some(s => s.value === "secretpass")).toBe(true);
  });

  it("detects 'the password is xyz'", () => {
    const secrets = detectSecrets("the password is hunter2abc");
    expect(secrets.some(s => s.value === "hunter2abc")).toBe(true);
  });

  it("detects private key content", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const secrets = detectSecrets(key);
    expect(secrets.some(s => s.label === "private_key")).toBe(true);
  });

  it("ignores false positives — common words", () => {
    const secrets = detectSecrets("password is password");
    // "password" the word itself should be filtered
    expect(secrets.filter(s => s.value === "password")).toHaveLength(0);
  });

  it("ignores URLs", () => {
    const secrets = detectSecrets("password https://example.com");
    expect(secrets.filter(s => s.value.startsWith("http"))).toHaveLength(0);
  });

  it("returns empty for clean input", () => {
    expect(detectSecrets("restart nginx on prod")).toHaveLength(0);
    expect(detectSecrets("check disk space")).toHaveLength(0);
    expect(detectSecrets("list docker containers")).toHaveLength(0);
  });
});

// ── Redaction ──────────────────────────────────────────────────────────────

describe("password redaction", () => {
  it("redacts passwords from text", () => {
    const result = redactSecrets("add ssh login for prod user root password mySecret123");
    expect(result).not.toContain("mySecret123");
    expect(result).toContain("[REDACTED:");
    expect(result).toContain("prod");
    expect(result).toContain("root");
  });

  it("redacts multiple secrets", () => {
    const result = redactSecrets("password=abc123 token=xyz789long");
    expect(result).not.toContain("abc123");
    expect(result).not.toContain("xyz789long");
  });

  it("passes through clean text unchanged", () => {
    const clean = "restart nginx on production server";
    expect(redactSecrets(clean)).toBe(clean);
  });
});

// ── containsSecrets ────────────────────────────────────────────────────────

describe("containsSecrets", () => {
  it("returns true for text with password", () => {
    expect(containsSecrets("password mySecret")).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(containsSecrets("restart nginx")).toBe(false);
  });
});

// ── redactForHistory ───────────────────────────────────────────────────────

describe("redactForHistory", () => {
  it("redacts entire lines containing secrets", () => {
    const input = "setting up server\npassword=secret123\ndone";
    const result = redactForHistory(input);
    expect(result).not.toContain("secret123");
    expect(result).toContain("[REDACTED");
    expect(result).toContain("setting up server");
    expect(result).toContain("done");
  });
});

// ── extractAndRedact ───────────────────────────────────────────────────────

describe("extractAndRedact", () => {
  it("extracts password and returns redacted text", () => {
    const { password, redacted } = extractAndRedact("add ssh login for prod user root password myPass99");
    expect(password).toBe("myPass99");
    expect(redacted).not.toContain("myPass99");
    expect(redacted).toContain("prod");
  });

  it("returns null password when none found", () => {
    const { password, redacted } = extractAndRedact("add ssh login for prod user root");
    expect(password).toBeNull();
    expect(redacted).toBe("add ssh login for prod user root");
  });
});

// ── Intent routing ─────────────────────────────────────────────────────────

describe("SSH intent routing", () => {
  it('"add ssh login" → ssh.add_credential', async () => {
    const { parseIntent } = await import("../../../packages/core/src/nlp/parseIntent.js");
    const result = await parseIntent("add ssh login for prod");
    expect(result.intent.intent).toBe("ssh.add_credential");
  });

  it('"show ssh credentials" → ssh.list_credentials', async () => {
    const { parseIntent } = await import("../../../packages/core/src/nlp/parseIntent.js");
    const result = await parseIntent("show ssh credentials");
    expect(result.intent.intent).toBe("ssh.list_credentials");
  });

  it('"generate ssh key" → ssh.generate_key', async () => {
    const { parseIntent } = await import("../../../packages/core/src/nlp/parseIntent.js");
    const result = await parseIntent("generate ssh key for prod");
    expect(result.intent.intent).toBe("ssh.generate_key");
  });

  it('"copy ssh key to prod" → ssh.copy_key', async () => {
    const { parseIntent } = await import("../../../packages/core/src/nlp/parseIntent.js");
    const result = await parseIntent("copy ssh key to prod");
    expect(result.intent.intent).toBe("ssh.copy_key");
  });

  it('"show ssh config" → ssh.config_list', async () => {
    const { parseIntent } = await import("../../../packages/core/src/nlp/parseIntent.js");
    const result = await parseIntent("show ssh config");
    expect(result.intent.intent).toBe("ssh.config_list");
  });

  it('"remove ssh credentials" → ssh.remove_credential', async () => {
    const { parseIntent } = await import("../../../packages/core/src/nlp/parseIntent.js");
    const result = await parseIntent("remove ssh credentials for prod");
    expect(result.intent.intent).toBe("ssh.remove_credential");
  });

  it('"set ssh passphrase" → ssh.set_passphrase', async () => {
    const { parseIntent } = await import("../../../packages/core/src/nlp/parseIntent.js");
    const result = await parseIntent("set ssh passphrase");
    expect(result.intent.intent).toBe("ssh.set_passphrase");
  });
});
