import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  storeCredential, getCredential, listCredentials, removeCredential, removeAllCredentials,
  hasPassword, getPasswordWarnings, generateKeyPair, listKeys,
  addConfigEntry, removeConfigEntry, listConfigEntries,
  setMasterPassphrase, verifyMasterPassphrase, hasMasterPassphrase,
} from "../../../src/utils/sshCredentials.js";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const VAULT_PATH = resolve(homedir(), ".notoken", "ssh-vault.json");
let backupVault: string | null = null;

beforeEach(() => {
  // Backup existing vault
  if (existsSync(VAULT_PATH)) {
    backupVault = readFileSync(VAULT_PATH, "utf-8");
  }
  // Start clean
  removeAllCredentials();
});

afterEach(() => {
  // Restore vault
  if (backupVault) {
    const { writeFileSync } = require("node:fs");
    writeFileSync(VAULT_PATH, backupVault);
    backupVault = null;
  }
});

// ── Credential CRUD ──────────────────────────────────────────────────────────

describe("SSH credential storage", () => {
  it("stores and retrieves a credential with password", () => {
    const { id } = storeCredential({ host: "testhost", user: "admin", password: "secret123" });
    expect(id).toBeTruthy();

    const cred = getCredential("testhost");
    expect(cred).not.toBeNull();
    expect(cred!.host).toBe("testhost");
    expect(cred!.user).toBe("admin");
    expect(cred!.password).toBe("secret123");
  });

  it("stores credential with key path (no password)", () => {
    storeCredential({ host: "keyhost", user: "deploy", keyPath: "/home/user/.ssh/id_ed25519" });
    const cred = getCredential("keyhost");
    expect(cred!.keyPath).toBe("/home/user/.ssh/id_ed25519");
    expect(cred!.password).toBeUndefined();
  });

  it("warns when storing password", () => {
    const { warning } = storeCredential({ host: "pwhost", user: "root", password: "pass123" });
    expect(warning).toContain("SSH keys");
  });

  it("replaces existing credential for same host", () => {
    storeCredential({ host: "duphost", user: "old", password: "old123" });
    storeCredential({ host: "duphost", user: "new", password: "new456" });
    const creds = listCredentials();
    expect(creds.filter(c => c.host === "duphost")).toHaveLength(1);
    expect(getCredential("duphost")!.user).toBe("new");
    expect(getCredential("duphost")!.password).toBe("new456");
  });

  it("lists all credentials", () => {
    storeCredential({ host: "a", user: "u1" });
    storeCredential({ host: "b", user: "u2", password: "p" });
    storeCredential({ host: "c", user: "u3", keyPath: "/k" });
    const list = listCredentials();
    expect(list).toHaveLength(3);
    expect(list.find(c => c.host === "b")!.hasPassword).toBe(true);
    expect(list.find(c => c.host === "c")!.hasKey).toBe(true);
  });

  it("removes a credential", () => {
    storeCredential({ host: "rm-test", user: "u" });
    expect(removeCredential("rm-test")).toBe(true);
    expect(getCredential("rm-test")).toBeNull();
  });

  it("remove returns false for nonexistent host", () => {
    expect(removeCredential("nonexistent")).toBe(false);
  });

  it("removes all credentials", () => {
    storeCredential({ host: "a", user: "u" });
    storeCredential({ host: "b", user: "u" });
    const count = removeAllCredentials();
    expect(count).toBe(2);
    expect(listCredentials()).toHaveLength(0);
  });

  it("hasPassword returns true only when password stored", () => {
    storeCredential({ host: "withpw", user: "u", password: "pw" });
    storeCredential({ host: "nopw", user: "u" });
    expect(hasPassword("withpw")).toBe(true);
    expect(hasPassword("nopw")).toBe(false);
  });

  it("tracks usage count", () => {
    storeCredential({ host: "usage-test", user: "u" });
    getCredential("usage-test");
    getCredential("usage-test");
    getCredential("usage-test");
    const cred = getCredential("usage-test");
    expect(cred!.useCount).toBeGreaterThanOrEqual(3);
  });
});

// ── Encryption ──────────────────────────────────────────────────────────────

describe("SSH vault encryption", () => {
  it("password is encrypted at rest (not plaintext in vault)", () => {
    storeCredential({ host: "enc-test", user: "u", password: "supersecret" });
    const raw = readFileSync(VAULT_PATH, "utf-8");
    expect(raw).not.toContain("supersecret");
    expect(raw).toContain("encryptedPassword");
  });

  it("master passphrase changes encryption", () => {
    setMasterPassphrase("mymaster");
    storeCredential({ host: "master-test", user: "u", password: "pw123" });
    expect(verifyMasterPassphrase("mymaster")).toBe(true);
    expect(verifyMasterPassphrase("wrong")).toBe(false);
    expect(hasMasterPassphrase()).toBe(true);
    // Decrypt with correct passphrase
    expect(getCredential("master-test")!.password).toBe("pw123");
  });
});

// ── Password warnings ──────────────────────────────────────────────────────

describe("SSH password warnings", () => {
  it("warns about stored passwords", () => {
    storeCredential({ host: "pw1", user: "u", password: "p" });
    const warnings = getPasswordWarnings();
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings.some(w => w.includes("stored passwords"))).toBe(true);
  });

  it("warns about missing master passphrase", () => {
    removeAllCredentials(); // clears master hash too
    storeCredential({ host: "pw2", user: "u", password: "p" });
    const warnings = getPasswordWarnings();
    expect(warnings.some(w => w.includes("No master passphrase"))).toBe(true);
  });

  it("no warnings when using keys only", () => {
    storeCredential({ host: "keyonly", user: "u", keyPath: "/k" });
    const warnings = getPasswordWarnings();
    // Only the master passphrase warning (no password warnings)
    expect(warnings.every(w => !w.includes("stored passwords"))).toBe(true);
  });
});

// ── SSH config management ──────────────────────────────────────────────────

describe("SSH config management", () => {
  it("adds and lists config entry", () => {
    addConfigEntry({ host: "test-cfg", hostname: "10.0.0.1", user: "admin" });
    const entries = listConfigEntries();
    const entry = entries.find(e => e.host === "test-cfg");
    expect(entry).toBeTruthy();
    expect(entry!.hostname).toBe("10.0.0.1");
    expect(entry!.user).toBe("admin");
  });

  it("removes config entry", () => {
    addConfigEntry({ host: "rm-cfg", hostname: "10.0.0.2", user: "u" });
    expect(removeConfigEntry("rm-cfg")).toBe(true);
    expect(listConfigEntries().find(e => e.host === "rm-cfg")).toBeUndefined();
  });

  it("replaces existing config entry", () => {
    addConfigEntry({ host: "dup-cfg", hostname: "10.0.0.1", user: "old" });
    addConfigEntry({ host: "dup-cfg", hostname: "10.0.0.2", user: "new" });
    const entries = listConfigEntries().filter(e => e.host === "dup-cfg");
    expect(entries).toHaveLength(1);
    expect(entries[0].hostname).toBe("10.0.0.2");
  });
});
