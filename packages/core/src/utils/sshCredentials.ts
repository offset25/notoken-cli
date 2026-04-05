/**
 * SSH Credential Management — secure storage, key management, config.
 *
 * Credentials encrypted at rest with master passphrase.
 * Warns users to prefer SSH keys over passwords.
 * Manages ~/.ssh/config entries and key pairs.
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, chmodSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { createHash, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { execSync } from "node:child_process";

const SSH_DIR = resolve(homedir(), ".ssh");
const VAULT_PATH = resolve(homedir(), ".notoken", "ssh-vault.json");
const VAULT_DIR = resolve(homedir(), ".notoken");

// ── Types ───────────────────────────────────────────────────────────────────

interface StoredCredential {
  id: string;
  host: string;
  hostname: string;
  user: string;
  port: number;
  encryptedPassword?: string;
  salt?: string;
  iv?: string;
  keyPath?: string;
  proxyJump?: string;
  addedAt: string;
  lastUsed?: string;
  useCount: number;
}

interface Vault {
  version: number;
  masterHash?: string;
  credentials: StoredCredential[];
}

// ── Encryption helpers ──────────────────────────────────────────────────────

function deriveKey(passphrase: string, salt: string): Buffer {
  return createHash("sha256").update(passphrase + salt).digest();
}

function encrypt(text: string, passphrase: string): { encrypted: string; salt: string; iv: string } {
  const salt = randomBytes(16).toString("hex");
  const iv = randomBytes(16);
  const key = deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(text, "utf-8", "hex");
  encrypted += cipher.final("hex");
  return { encrypted, salt, iv: iv.toString("hex") };
}

function decrypt(encrypted: string, passphrase: string, salt: string, iv: string): string {
  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv("aes-256-cbc", key, Buffer.from(iv, "hex"));
  let decrypted = decipher.update(encrypted, "hex", "utf-8");
  decrypted += decipher.final("utf-8");
  return decrypted;
}

// ── Vault persistence ───────────────────────────────────────────────────────

function loadVault(): Vault {
  if (existsSync(VAULT_PATH)) {
    try { return JSON.parse(readFileSync(VAULT_PATH, "utf-8")); } catch {}
  }
  return { version: 1, credentials: [] };
}

function saveVault(vault: Vault): void {
  if (!existsSync(VAULT_DIR)) mkdirSync(VAULT_DIR, { recursive: true });
  writeFileSync(VAULT_PATH, JSON.stringify(vault, null, 2));
  try { chmodSync(VAULT_PATH, 0o600); } catch {}
}

// ── Master hash ─────────────────────────────────────────────────────────────

let _masterPassphrase: string | null = null;

export function setMasterPassphrase(passphrase: string): void {
  _masterPassphrase = passphrase;
  const vault = loadVault();
  vault.masterHash = createHash("sha256").update(passphrase + "notoken-vault").digest("hex");
  saveVault(vault);
}

export function verifyMasterPassphrase(passphrase: string): boolean {
  const vault = loadVault();
  if (!vault.masterHash) return true; // No master set yet
  const hash = createHash("sha256").update(passphrase + "notoken-vault").digest("hex");
  if (hash === vault.masterHash) { _masterPassphrase = passphrase; return true; }
  return false;
}

export function hasMasterPassphrase(): boolean {
  return !!loadVault().masterHash;
}

// ── Credential CRUD ─────────────────────────────────────────────────────────

export function storeCredential(opts: { host: string; hostname?: string; user: string; password?: string; keyPath?: string; port?: number; proxyJump?: string }): { id: string; warning?: string } {
  const vault = loadVault();
  const id = `${opts.host}_${Date.now().toString(36)}`;

  const cred: StoredCredential = {
    id,
    host: opts.host,
    hostname: opts.hostname ?? opts.host,
    user: opts.user,
    port: opts.port ?? 22,
    keyPath: opts.keyPath,
    proxyJump: opts.proxyJump,
    addedAt: new Date().toISOString(),
    useCount: 0,
  };

  // Encrypt password if provided
  let warning: string | undefined;
  if (opts.password) {
    const passphrase = _masterPassphrase ?? "notoken-default-key";
    const { encrypted, salt, iv } = encrypt(opts.password, passphrase);
    cred.encryptedPassword = encrypted;
    cred.salt = salt;
    cred.iv = iv;
    warning = "⚠ Password stored (encrypted). Consider using SSH keys instead: \"generate ssh key for " + opts.host + "\"";
  }

  // Remove existing entry for same host
  vault.credentials = vault.credentials.filter(c => c.host !== opts.host);
  vault.credentials.push(cred);
  saveVault(vault);

  return { id, warning };
}

export function getCredential(host: string): (StoredCredential & { password?: string }) | null {
  const vault = loadVault();
  const cred = vault.credentials.find(c => c.host === host || c.hostname === host);
  if (!cred) return null;

  // Decrypt password if present
  const result: StoredCredential & { password?: string } = { ...cred };
  if (cred.encryptedPassword && cred.salt && cred.iv) {
    try {
      const passphrase = _masterPassphrase ?? "notoken-default-key";
      result.password = decrypt(cred.encryptedPassword, passphrase, cred.salt, cred.iv);
    } catch { /* decryption failed */ }
  }

  // Update usage
  cred.lastUsed = new Date().toISOString();
  cred.useCount++;
  saveVault(vault);

  return result;
}

export function listCredentials(): Array<{ host: string; user: string; hasPassword: boolean; hasKey: boolean; proxyJump?: string; useCount: number }> {
  return loadVault().credentials.map(c => ({
    host: c.host,
    user: c.user,
    hasPassword: !!c.encryptedPassword,
    hasKey: !!c.keyPath,
    proxyJump: c.proxyJump,
    useCount: c.useCount,
  }));
}

export function removeCredential(host: string): boolean {
  const vault = loadVault();
  const before = vault.credentials.length;
  vault.credentials = vault.credentials.filter(c => c.host !== host);
  if (vault.credentials.length < before) { saveVault(vault); return true; }
  return false;
}

export function removeAllCredentials(): number {
  const vault = loadVault();
  const count = vault.credentials.length;
  vault.credentials = [];
  vault.masterHash = undefined;
  saveVault(vault);
  return count;
}

export function hasPassword(host: string): boolean {
  const vault = loadVault();
  const cred = vault.credentials.find(c => c.host === host);
  return !!cred?.encryptedPassword;
}

export function getPasswordWarnings(): string[] {
  const warnings: string[] = [];
  const vault = loadVault();
  const withPasswords = vault.credentials.filter(c => c.encryptedPassword);
  if (withPasswords.length > 0) {
    warnings.push(`${withPasswords.length} credential(s) use stored passwords. Switch to SSH keys for better security.`);
    for (const c of withPasswords) {
      warnings.push(`  ${c.host} (${c.user}) — has stored password. Run: "generate ssh key for ${c.host}"`);
    }
  }
  if (!vault.masterHash) {
    warnings.push("No master passphrase set. Passwords encrypted with default key. Run: \"set ssh passphrase\"");
  }
  return warnings;
}

// ── Key management ──────────────────────────────────────────────────────────

export function generateKeyPair(name?: string, type?: string): { publicKey: string; privatePath: string } {
  const keyType = type ?? "ed25519";
  const keyName = `notoken_${name ?? "default"}_${keyType}`;
  const keyPath = resolve(SSH_DIR, keyName);

  if (!existsSync(SSH_DIR)) { mkdirSync(SSH_DIR, { recursive: true }); chmodSync(SSH_DIR, 0o700); }

  if (existsSync(keyPath)) {
    return { publicKey: readFileSync(`${keyPath}.pub`, "utf-8").trim(), privatePath: keyPath };
  }

  execSync(`ssh-keygen -t ${keyType} -f "${keyPath}" -N "" -C "notoken-${name ?? "default"}"`, { stdio: "pipe" });
  chmodSync(keyPath, 0o600);

  return { publicKey: readFileSync(`${keyPath}.pub`, "utf-8").trim(), privatePath: keyPath };
}

export function copyKeyToServer(host: string, user: string, password?: string): string {
  const cred = getCredential(host);
  const keyPath = cred?.keyPath ?? resolve(SSH_DIR, "notoken_default_ed25519.pub");
  const actualPassword = password ?? cred?.password;
  const targetUser = user ?? cred?.user ?? "root";
  const targetHost = cred?.hostname ?? host;

  if (!existsSync(keyPath) && !existsSync(keyPath.replace(".pub", "") + ".pub")) {
    // Generate a key first
    generateKeyPair(host);
  }

  const pubKeyPath = keyPath.endsWith(".pub") ? keyPath : `${keyPath}.pub`;
  if (actualPassword) {
    // Use sshpass if available
    try {
      execSync(`which sshpass`, { stdio: "pipe" });
      execSync(`sshpass -p "${actualPassword}" ssh-copy-id -i "${pubKeyPath}" -o StrictHostKeyChecking=no ${targetUser}@${targetHost}`, { stdio: "pipe", timeout: 30000 });
      return `Key copied to ${targetUser}@${targetHost}. You can now remove the stored password: "remove ssh password for ${host}"`;
    } catch {}
  }

  // Fallback to manual copy
  const pubKey = readFileSync(pubKeyPath, "utf-8").trim();
  try {
    execSync(`ssh-copy-id -i "${pubKeyPath}" -o StrictHostKeyChecking=no ${targetUser}@${targetHost}`, { stdio: "pipe", timeout: 30000 });
    return `Key copied to ${targetUser}@${targetHost}`;
  } catch {
    return `Could not auto-copy. Manually add this to ${targetUser}@${targetHost}:~/.ssh/authorized_keys:\n\n${pubKey}`;
  }
}

export function listKeys(): Array<{ name: string; type: string; path: string; hasPublic: boolean }> {
  if (!existsSync(SSH_DIR)) return [];
  const files = readdirSync(SSH_DIR);
  const keys: Array<{ name: string; type: string; path: string; hasPublic: boolean }> = [];
  for (const f of files) {
    if (f.endsWith(".pub") || f.startsWith("known_hosts") || f === "config" || f === "authorized_keys") continue;
    const full = resolve(SSH_DIR, f);
    try {
      const content = readFileSync(full, "utf-8");
      if (content.includes("PRIVATE KEY")) {
        const type = content.includes("ED25519") ? "ed25519" : content.includes("RSA") ? "rsa" : content.includes("ECDSA") ? "ecdsa" : "unknown";
        keys.push({ name: f, type, path: full, hasPublic: existsSync(`${full}.pub`) });
      }
    } catch {}
  }
  return keys;
}

// ── SSH config management ───────────────────────────────────────────────────

export function addConfigEntry(opts: { host: string; hostname: string; user: string; keyPath?: string; port?: number; proxyJump?: string }): void {
  const configPath = resolve(SSH_DIR, "config");
  if (!existsSync(SSH_DIR)) { mkdirSync(SSH_DIR, { recursive: true }); chmodSync(SSH_DIR, 0o700); }

  // Remove existing entry
  removeConfigEntry(opts.host);

  const entry = [
    `\nHost ${opts.host}`,
    `  HostName ${opts.hostname}`,
    `  User ${opts.user}`,
    opts.port && opts.port !== 22 ? `  Port ${opts.port}` : null,
    opts.keyPath ? `  IdentityFile ${opts.keyPath}` : null,
    opts.proxyJump ? `  ProxyJump ${opts.proxyJump}` : null,
    "",
  ].filter(Boolean).join("\n");

  const existing = existsSync(configPath) ? readFileSync(configPath, "utf-8") : "";
  writeFileSync(configPath, existing + entry + "\n");
  try { chmodSync(configPath, 0o600); } catch {}
}

export function removeConfigEntry(host: string): boolean {
  const configPath = resolve(SSH_DIR, "config");
  if (!existsSync(configPath)) return false;
  const content = readFileSync(configPath, "utf-8");
  const lines = content.split("\n");
  const filtered: string[] = [];
  let skip = false;
  for (const line of lines) {
    if (line.match(new RegExp(`^Host\\s+${host}\\s*$`, "i"))) { skip = true; continue; }
    if (skip && line.match(/^Host\s+/)) skip = false;
    if (skip && (line.startsWith("  ") || line.trim() === "")) continue;
    filtered.push(line);
  }
  if (filtered.length !== lines.length) { writeFileSync(configPath, filtered.join("\n")); return true; }
  return false;
}

export function listConfigEntries(): Array<Record<string, string>> {
  const configPath = resolve(SSH_DIR, "config");
  if (!existsSync(configPath)) return [];
  const content = readFileSync(configPath, "utf-8");
  const entries: Array<Record<string, string>> = [];
  let current: Record<string, string> | null = null;
  for (const line of content.split("\n")) {
    const hostMatch = line.match(/^Host\s+(.+)/);
    if (hostMatch) {
      if (current) entries.push(current);
      current = { host: hostMatch[1].trim() };
      continue;
    }
    if (current && line.trim()) {
      const kv = line.trim().match(/^(\w+)\s+(.+)/);
      if (kv) {
        const key = kv[1].toLowerCase();
        if (key === "hostname") current.hostname = kv[2];
        else if (key === "user") current.user = kv[2];
        else if (key === "port") current.port = kv[2];
        else if (key === "identityfile") current.keyPath = kv[2];
        else if (key === "proxyjump") current.proxyJump = kv[2];
      }
    }
  }
  if (current) entries.push(current);
  return entries.filter(e => e.host !== "*");
}
