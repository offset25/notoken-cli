import { describe, it, expect } from "vitest";
import { detectSecrets, redactSecrets, containsSecrets, redactForHistory, extractAndRedact } from "../../../src/utils/passwordRedactor.js";

// ── Explicit pattern detection (high confidence) ───────────────────────────

describe("explicit password detection", () => {
  it("detects 'password xyz123' (keyword + value)", () => {
    const secrets = detectSecrets("add ssh login for prod user root password abc123xyz");
    const pw = secrets.find(s => s.label === "password");
    expect(pw).toBeTruthy();
    expect(pw!.value).toBe("abc123xyz");
    expect(pw!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detects password=value format", () => {
    const secrets = detectSecrets("password=mysecret123");
    expect(secrets.some(s => s.value === "mysecret123" && s.confidence >= 0.9)).toBe(true);
  });

  it("detects 'the password is X'", () => {
    const secrets = detectSecrets("the password is hunter2abc");
    expect(secrets.some(s => s.value === "hunter2abc" && s.confidence >= 0.9)).toBe(true);
  });

  it("detects 'use password X'", () => {
    const secrets = detectSecrets("connect using password Tr0ub4dor");
    expect(secrets.some(s => s.value === "Tr0ub4dor" && s.confidence >= 0.9)).toBe(true);
  });

  it("detects sshpass -p", () => {
    const secrets = detectSecrets('sshpass -p "mypass99" ssh root@host');
    const s = secrets.find(s => s.label === "sshpass");
    expect(s).toBeTruthy();
    expect(s!.confidence).toBeGreaterThanOrEqual(0.95);
  });

  it("detects database connection string passwords", () => {
    const secrets = detectSecrets("postgres://admin:s3cretP4ss@db.example.com/mydb");
    const s = secrets.find(s => s.label === "db_password");
    expect(s).toBeTruthy();
    expect(s!.value).toBe("s3cretP4ss");
    expect(s!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detects API keys", () => {
    const secrets = detectSecrets("api_key=sk-ant-abc123456789abcdef");
    expect(secrets.some(s => s.label === "api_key" && s.confidence >= 0.9)).toBe(true);
  });

  it("detects private key content", () => {
    const key = "-----BEGIN RSA PRIVATE KEY-----\nMIIEowIBAAKCAQEA\n-----END RSA PRIVATE KEY-----";
    const secrets = detectSecrets(key);
    expect(secrets.some(s => s.label === "private_key" && s.confidence >= 0.95)).toBe(true);
  });

  it("detects AWS access key format", () => {
    const secrets = detectSecrets("AKIAIOSFODNN7EXAMPLE");
    expect(secrets.some(s => s.label === "aws_access_key" && s.confidence >= 0.95)).toBe(true);
  });
});

// ── Username + password pair detection ─────────────────────────────────────

describe("username+password pair detection", () => {
  it("detects 'user root password abc123'", () => {
    const secrets = detectSecrets("add ssh login for prod user root password abc123xy");
    const pw = secrets.find(s => s.reason?.includes("pair") || s.label === "password");
    expect(pw).toBeTruthy();
    expect(pw!.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("detects '-u admin -p secret123'", () => {
    const secrets = detectSecrets("mysql -u admin -p secret123 mydb");
    expect(secrets.some(s => s.value === "secret123" && s.confidence >= 0.9)).toBe(true);
  });

  it("detects 'login admin:pass123'", () => {
    const secrets = detectSecrets("login admin:s3cret99");
    expect(secrets.some(s => s.value === "s3cret99")).toBe(true);
  });
});

// ── Heuristic detection (confidence-based) ─────────────────────────────────

describe("heuristic password detection", () => {
  it("detects password-like string near auth keywords", () => {
    // "xK9$mP2q" near "ssh login" should be flagged
    const secrets = detectSecrets("ssh login to prod xK9mP2qZ");
    const heuristic = secrets.find(s => s.label === "heuristic_password");
    expect(heuristic).toBeTruthy();
    expect(heuristic!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("higher confidence for mixed char types", () => {
    // Mixed upper, lower, digits = more password-like
    const s1 = detectSecrets("ssh connect user admin Abc123Xyz");
    const h1 = s1.find(s => s.value === "Abc123Xyz");
    expect(h1).toBeTruthy();
    expect(h1!.confidence).toBeGreaterThanOrEqual(0.5);
  });

  it("does NOT flag plain words near auth keywords", () => {
    // "nginx" near "restart" shouldn't be flagged
    const secrets = detectSecrets("restart nginx on production server");
    expect(secrets).toHaveLength(0);
  });

  it("does NOT flag file paths", () => {
    const secrets = detectSecrets("ssh connect using key /home/user/.ssh/id_ed25519");
    expect(secrets.filter(s => s.value.startsWith("/"))).toHaveLength(0);
  });

  it("does NOT flag common words even near auth keywords", () => {
    const secrets = detectSecrets("user root password default");
    // "default" is in false positives list
    expect(secrets.filter(s => s.value === "default")).toHaveLength(0);
  });
});

// ── Confidence scoring ─────────────────────────────────────────────────────

describe("confidence scoring", () => {
  it("explicit patterns have highest confidence (>= 0.9)", () => {
    const secrets = detectSecrets("password=MyS3cret!");
    expect(secrets[0]?.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("heuristic detections have lower confidence (< 0.9)", () => {
    const secrets = detectSecrets("ssh connect host prod Abc123Xyz");
    const heuristic = secrets.find(s => s.label === "heuristic_password");
    if (heuristic) {
      expect(heuristic.confidence).toBeLessThan(0.9);
    }
  });

  it("each secret has a reason field", () => {
    const secrets = detectSecrets("password=test123abc");
    expect(secrets.every(s => s.reason && s.reason.length > 0)).toBe(true);
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
    const result = redactSecrets("password=abc12345 token=xyz789longtoken");
    expect(result).not.toContain("abc12345");
    expect(result).not.toContain("xyz789longtoken");
  });

  it("passes through clean text unchanged", () => {
    const clean = "restart nginx on production server";
    expect(redactSecrets(clean)).toBe(clean);
  });

  it("respects confidence threshold", () => {
    const text = "password=definitelyAPassword123";
    // High threshold — only high-confidence matches
    expect(redactSecrets(text, 0.9)).toContain("[REDACTED:");
    // Any detection at default threshold
    expect(redactSecrets(text)).toContain("[REDACTED:");
  });
});

// ── containsSecrets ────────────────────────────────────────────────────────

describe("containsSecrets", () => {
  it("returns true for text with password", () => {
    expect(containsSecrets("password myS3cret")).toBe(true);
  });

  it("returns false for clean text", () => {
    expect(containsSecrets("restart nginx")).toBe(false);
  });

  it("respects threshold", () => {
    expect(containsSecrets("password=abc123xyz", 0.9)).toBe(true);
    expect(containsSecrets("restart nginx", 0.1)).toBe(false);
  });
});

// ── redactForHistory ───────────────────────────────────────────────────────

describe("redactForHistory", () => {
  it("redacts entire lines containing secrets", () => {
    const input = "setting up server\npassword=secret123abc\ndone";
    const result = redactForHistory(input);
    expect(result).not.toContain("secret123abc");
    expect(result).toContain("[REDACTED");
    expect(result).toContain("setting up server");
    expect(result).toContain("done");
  });

  it("includes confidence in redaction notice", () => {
    const result = redactForHistory("password=myS3cret!");
    expect(result).toMatch(/\d+%/); // Shows confidence percentage
  });
});

// ── extractAndRedact ───────────────────────────────────────────────────────

describe("extractAndRedact", () => {
  it("extracts password and returns redacted text with confidence", () => {
    const { password, redacted, confidence } = extractAndRedact("add ssh login for prod user root password myPass99x");
    expect(password).toBe("myPass99x");
    expect(redacted).not.toContain("myPass99x");
    expect(redacted).toContain("prod");
    expect(confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("returns null password when none found", () => {
    const { password, redacted, confidence } = extractAndRedact("add ssh login for prod user root");
    expect(password).toBeNull();
    expect(redacted).toBe("add ssh login for prod user root");
    expect(confidence).toBe(0);
  });

  it("picks highest-confidence password when multiple detected", () => {
    const { password, confidence } = extractAndRedact("password=explicit123 near ssh login heuristicAbc1");
    expect(password).toBe("explicit123");
    expect(confidence).toBeGreaterThanOrEqual(0.9);
  });
});

// ── Intent routing (unchanged) ─────────────────────────────────────────────

describe("SSH intent routing", () => {
  it('"add ssh login" → ssh.add_credential', async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("add ssh login for prod");
    expect(result.intent.intent).toBe("ssh.add_credential");
  });

  it('"show ssh credentials" → ssh.list_credentials', async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("show ssh credentials");
    expect(result.intent.intent).toBe("ssh.list_credentials");
  });

  it('"generate ssh key" → ssh.generate_key', async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("generate ssh key for prod");
    expect(result.intent.intent).toBe("ssh.generate_key");
  });

  it('"copy ssh key to prod" → ssh.copy_key', async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("copy ssh key to prod");
    expect(result.intent.intent).toBe("ssh.copy_key");
  });

  it('"show ssh config" → ssh.config_list', async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("show ssh config");
    expect(result.intent.intent).toBe("ssh.config_list");
  });

  it('"remove ssh credentials" → ssh.remove_credential', async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("remove ssh credentials for prod");
    expect(result.intent.intent).toBe("ssh.remove_credential");
  });

  it('"set ssh passphrase" → ssh.set_passphrase', async () => {
    const { parseIntent } = await import("../../../src/nlp/parseIntent.js");
    const result = await parseIntent("set ssh passphrase");
    expect(result.intent.intent).toBe("ssh.set_passphrase");
  });
});
