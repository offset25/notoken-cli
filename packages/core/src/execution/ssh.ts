/**
 * SSH / local / Docker execution layer.
 *
 * Uses the `ssh2` npm package for all remote connections:
 * - Password auth (no sshpass/expect/plink needed)
 * - Key-based auth (reads key file directly)
 * - SSH agent forwarding
 * - Reads ~/.ssh/config for host aliases, keys, ports
 *
 * Falls back to system `ssh` binary only if ssh2 fails unexpectedly.
 */

import { Client } from "ssh2";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { loadHosts } from "../utils/config.js";

const execAsync = promisify(exec);

export interface HostEntry {
  host: string;
  description: string;
  port?: number;
  key?: string;
  password?: string;
  /** Path to a credentials file. Format: first line = username, second line = password */
  credentialsFile?: string;
}

/**
 * Read credentials from a file.
 * Supports formats:
 *   - Line 1: username, Line 2: password
 *   - username:password (single line)
 *   - KEY=VALUE format (USERNAME=x, PASSWORD=y)
 */
function readCredentialsFile(filePath: string): { username?: string; password?: string } {
  if (!existsSync(filePath)) return {};
  try {
    const content = readFileSync(filePath, "utf-8").trim();
    const lines = content.split("\n").map((l) => l.trim()).filter(Boolean);

    // KEY=VALUE format
    const kvUser = lines.find((l) => /^(USER|USERNAME)=/i.test(l));
    const kvPass = lines.find((l) => /^(PASS|PASSWORD)=/i.test(l));
    if (kvUser || kvPass) {
      return {
        username: kvUser?.split("=").slice(1).join("="),
        password: kvPass?.split("=").slice(1).join("="),
      };
    }

    // username:password (single line)
    if (lines.length === 1 && lines[0].includes(":")) {
      const [username, ...rest] = lines[0].split(":");
      return { username, password: rest.join(":") };
    }

    // Line 1 = username, line 2 = password
    return {
      username: lines[0] || undefined,
      password: lines[1] || undefined,
    };
  } catch {
    return {};
  }
}

// ─── SSH config parsing ──────────────────────────────────────────────────────

interface SshConfigEntry {
  hostname?: string;
  user?: string;
  port?: string;
  identityFile?: string;
}

function parseSshConfig(alias: string): SshConfigEntry | null {
  const configPath = resolve(homedir(), ".ssh", "config");
  if (!existsSync(configPath)) return null;

  try {
    const content = readFileSync(configPath, "utf-8");
    const lines = content.split("\n");
    let current: SshConfigEntry | null = null;
    let matched = false;

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;

      const hostMatch = trimmed.match(/^Host\s+(.+)$/i);
      if (hostMatch) {
        if (matched && current) return current;
        const patterns = hostMatch[1].split(/\s+/);
        matched = patterns.some((p) => {
          if (p === "*") return false;
          if (p.includes("*")) {
            const regex = new RegExp("^" + p.replace(/\*/g, ".*") + "$");
            return regex.test(alias);
          }
          return p === alias;
        });
        current = matched ? {} : null;
        continue;
      }

      if (matched && current) {
        const kv = trimmed.match(/^(\w+)\s+(.+)$/);
        if (kv) {
          const key = kv[1].toLowerCase();
          if (key === "hostname") current.hostname = kv[2];
          else if (key === "user") current.user = kv[2];
          else if (key === "port") current.port = kv[2];
          else if (key === "identityfile") current.identityFile = kv[2].replace("~", homedir());
        }
      }
    }

    return matched ? current : null;
  } catch {
    return null;
  }
}

// ─── ssh2 connection ─────────────────────────────────────────────────────────

function resolveHostConfig(entry: HostEntry): {
  hostname: string;
  username: string;
  port: number;
  privateKey?: Buffer;
  passphrase?: string;
  password?: string;
  agent?: string;
} {
  // Read credentials file if specified
  const fileCreds = entry.credentialsFile ? readCredentialsFile(entry.credentialsFile) : {};

  const rawHost = hostPart(entry.host);
  const rawUser = fileCreds.username ?? (entry.host.includes("@") ? entry.host.split("@")[0] : "root");
  const sshConfig = parseSshConfig(rawHost);

  const hostname = sshConfig?.hostname ?? rawHost;
  const username = sshConfig?.user ?? rawUser;
  const port = entry.port ?? (sshConfig?.port ? parseInt(sshConfig.port) : 22);
  const password = entry.password || fileCreds.password;

  // Key: explicit > ssh config > default keys
  const keyPath = entry.key || sshConfig?.identityFile;
  let privateKey: Buffer | undefined;

  if (keyPath && existsSync(keyPath)) {
    privateKey = readFileSync(keyPath);
  } else if (!password) {
    // Try default key locations
    const defaultKeys = [
      resolve(homedir(), ".ssh", "id_ed25519"),
      resolve(homedir(), ".ssh", "id_rsa"),
      resolve(homedir(), ".ssh", "id_ecdsa"),
    ];
    for (const k of defaultKeys) {
      if (existsSync(k)) {
        privateKey = readFileSync(k);
        break;
      }
    }
  }

  return {
    hostname,
    username,
    port,
    privateKey,
    password: password || undefined,
    // Use SSH agent if no key/password
    agent: (!privateKey && !password) ? process.env.SSH_AUTH_SOCK : undefined,
  };
}

/**
 * Execute a command on a remote host via ssh2.
 * Returns combined stdout+stderr.
 */
function execSsh2(entry: HostEntry, command: string, timeout = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const config = resolveHostConfig(entry);
    const conn = new Client();
    let stdout = "";
    let stderr = "";
    let timedOut = false;

    const timer = setTimeout(() => {
      timedOut = true;
      conn.end();
      reject(new Error(`SSH command timed out after ${timeout / 1000}s`));
    }, timeout);

    conn.on("ready", () => {
      conn.exec(command, (err: Error | undefined, stream: any) => {
        if (err) {
          clearTimeout(timer);
          conn.end();
          reject(err);
          return;
        }

        stream.on("data", (data: Buffer) => { stdout += data.toString(); });
        stream.stderr.on("data", (data: Buffer) => { stderr += data.toString(); });

        stream.on("close", (code: number) => {
          clearTimeout(timer);
          conn.end();
          if (code !== 0 && !stdout && stderr) {
            reject(new Error(stderr.trim()));
          } else {
            resolve(stderr ? `${stdout}${stderr}` : stdout);
          }
        });
      });
    });

    conn.on("error", (err: Error) => {
      clearTimeout(timer);
      if (timedOut) return;
      reject(enhanceError(err, entry));
    });

    conn.connect({
      host: config.hostname,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      password: config.password,
      agent: config.agent,
      readyTimeout: 10_000,
      // Try all auth methods
      authHandler: buildAuthHandler(config),
    });
  });
}

/** Build auth handler that tries methods in order. */
function buildAuthHandler(config: ReturnType<typeof resolveHostConfig>) {
  const methods: Array<{ type: string; [key: string]: unknown }> = [];

  if (config.privateKey) {
    methods.push({ type: "publickey", username: config.username, key: config.privateKey });
  }
  if (config.agent) {
    methods.push({ type: "agent", username: config.username });
  }
  if (config.password) {
    methods.push({ type: "password", username: config.username, password: config.password });
  }

  // If no methods configured, try agent then keyboard-interactive
  if (methods.length === 0) {
    methods.push({ type: "agent", username: config.username });
  }

  let idx = 0;
  return (methodsLeft: string[], _partialSuccess: boolean | null, callback: Function) => {
    if (idx >= methods.length) {
      return callback(false); // no more methods
    }
    const method = methods[idx++];
    callback(method);
  };
}

/** Enhance SSH errors with helpful context. */
function enhanceError(err: Error, entry: HostEntry): Error {
  const msg = err.message;

  if (msg.includes("Authentication failed") || msg.includes("All configured authentication methods failed")) {
    const hints: string[] = [`SSH auth failed for ${entry.host}.`];
    if (entry.key) hints.push(`  - Key: ${entry.key} — check file exists and permissions`);
    if (entry.password) hints.push(`  - Password — check password in hosts.json`);
    if (!entry.key && !entry.password) hints.push(`  - No key or password configured — check SSH agent or add to hosts.json`);
    hints.push(`\nTo configure: edit config/hosts.json and set "key" or "password" for this host.`);
    return new Error(hints.join("\n"));
  }

  if (msg.includes("ECONNREFUSED")) {
    return new Error(
      `Connection refused by ${hostPart(entry.host)}:${entry.port ?? 22}.\n` +
      `  - Is the SSH server running?\n` +
      `  - Is port ${entry.port ?? 22} open?\n` +
      `  - Check firewall rules.`
    );
  }

  if (msg.includes("ETIMEDOUT") || msg.includes("ENOTFOUND") || msg.includes("getaddrinfo")) {
    return new Error(
      `Cannot reach ${hostPart(entry.host)}.\n` +
      `  - Check the hostname/IP is correct\n` +
      `  - Check network connectivity\n` +
      `  - Try: ping ${hostPart(entry.host)}`
    );
  }

  return err;
}

// ─── Public API ──────────────────────────────────────────────────────────────

export async function runRemoteCommand(
  environment: string,
  command: string
): Promise<string> {
  const hosts = loadHosts();
  const entry = hosts[environment] as HostEntry | undefined;
  if (!entry) {
    throw new Error(`No host configured for environment: ${environment}`);
  }

  return execSsh2(entry, command);
}

export async function runLocalCommand(command: string, timeout = 30_000): Promise<string> {
  const shell = process.platform === "win32" ? "bash" : undefined;
  const { stdout, stderr } = await execAsync(command, { timeout, shell });
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

/**
 * Run a command inside a Docker container.
 */
export async function runDockerExec(
  container: string,
  command: string
): Promise<string> {
  const { stdout, stderr } = await execAsync(
    `docker exec ${container} sh -c ${JSON.stringify(command)}`,
    { timeout: 30_000 }
  );
  return stderr ? `${stdout}\n${stderr}` : stdout;
}

/**
 * Test SSH connectivity to a host. Returns formatted status.
 */
export async function testSshConnection(environment: string): Promise<string> {
  const hosts = loadHosts();
  const entry = hosts[environment] as HostEntry | undefined;
  if (!entry) {
    return `No host configured for: ${environment}`;
  }

  const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", red: "\x1b[31m", cyan: "\x1b[36m", yellow: "\x1b[33m" };
  const config = resolveHostConfig(entry);
  const lines: string[] = [];

  lines.push(`\n${cc.bold}${cc.cyan}── SSH Connection Test: ${environment} ──${cc.reset}\n`);
  lines.push(`  Host:     ${cc.bold}${config.hostname}${cc.reset}`);
  lines.push(`  User:     ${config.username}`);
  lines.push(`  Port:     ${config.port}`);

  // Show auth method
  if (config.privateKey) {
    const keySource = entry.key || "(auto-detected)";
    lines.push(`  Auth:     ${cc.green}key${cc.reset} ${cc.dim}${keySource}${cc.reset}`);
  } else if (config.password) {
    const source = entry.credentialsFile ? `from ${entry.credentialsFile}` : "from hosts.json";
    lines.push(`  Auth:     ${cc.green}password${cc.reset} ${cc.dim}(${source}, via ssh2)${cc.reset}`);
  } else if (config.agent) {
    lines.push(`  Auth:     ${cc.green}SSH agent${cc.reset}`);
  } else {
    lines.push(`  Auth:     ${cc.yellow}none configured${cc.reset}`);
  }

  // Check SSH config
  const sshConf = parseSshConfig(hostPart(entry.host));
  if (sshConf) {
    lines.push(`  SSH config: ${cc.green}✓${cc.reset} found in ~/.ssh/config`);
    if (sshConf.hostname) lines.push(`    HostName: ${sshConf.hostname}`);
    if (sshConf.identityFile) lines.push(`    IdentityFile: ${sshConf.identityFile}`);
  }

  try {
    const result = await execSsh2(entry, "echo OK && hostname && uname -a", 15_000);
    if (result.includes("OK")) {
      const resultLines = result.split("\n");
      const hostname = resultLines[1]?.trim() ?? "unknown";
      const uname = resultLines[2]?.trim() ?? "";
      lines.push(`\n  ${cc.green}${cc.bold}✓ Connected${cc.reset}`);
      lines.push(`  Hostname: ${cc.bold}${hostname}${cc.reset}`);
      if (uname) lines.push(`  System:   ${cc.dim}${uname}${cc.reset}`);
    } else {
      lines.push(`\n  ${cc.yellow}⚠ Connected but unexpected response${cc.reset}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    lines.push(`\n  ${cc.red}${cc.bold}✗ Connection failed${cc.reset}`);
    lines.push(`  ${cc.red}${msg}${cc.reset}`);
  }

  return lines.join("\n");
}

// ─── SFTP file transfer ──────────────────────────────────────────────────────

import { createReadStream, createWriteStream, readdirSync, statSync, mkdirSync } from "node:fs";
import { basename, join, dirname, posix } from "node:path";
type SFTPWrapper = any;

export interface TransferProgress {
  file: string;
  bytesTransferred: number;
  totalBytes: number;
  filesCompleted: number;
  totalFiles: number;
}

export type TransferDirection = "upload" | "download";

/**
 * Transfer files to/from a remote host via SFTP.
 * Supports single files and recursive directories.
 */
export async function sftpTransfer(
  environment: string,
  localPath: string,
  remotePath: string,
  direction: TransferDirection,
  onProgress?: (progress: TransferProgress) => void,
): Promise<string> {
  const hosts = loadHosts();
  const entry = hosts[environment] as HostEntry | undefined;
  if (!entry) throw new Error(`No host configured for environment: ${environment}`);

  const config = resolveHostConfig(entry);
  const conn = new Client();

  return new Promise((resolve, reject) => {
    conn.on("ready", () => {
      conn.sftp(async (err: Error | undefined, sftp: any) => {
        if (err) { conn.end(); reject(err); return; }

        try {
          if (direction === "upload") {
            const result = await uploadPath(sftp, localPath, remotePath, onProgress);
            conn.end();
            resolve(result);
          } else {
            const result = await downloadPath(sftp, remotePath, localPath, onProgress);
            conn.end();
            resolve(result);
          }
        } catch (e) {
          conn.end();
          reject(e);
        }
      });
    });

    conn.on("error", (err: Error) => reject(enhanceError(err, entry)));

    conn.connect({
      host: config.hostname,
      port: config.port,
      username: config.username,
      privateKey: config.privateKey,
      password: config.password,
      agent: config.agent,
      readyTimeout: 10_000,
      authHandler: buildAuthHandler(config),
    });
  });
}

/** Collect all files in a local directory recursively. */
function collectLocalFiles(dir: string, base = ""): Array<{ localPath: string; relativePath: string; size: number }> {
  const files: Array<{ localPath: string; relativePath: string; size: number }> = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const fullPath = join(dir, entry.name);
    const relPath = base ? `${base}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...collectLocalFiles(fullPath, relPath));
    } else if (entry.isFile()) {
      files.push({ localPath: fullPath, relativePath: relPath, size: statSync(fullPath).size });
    }
  }
  return files;
}

/** Upload a file or directory to remote via SFTP. */
async function uploadPath(
  sftp: SFTPWrapper,
  localPath: string,
  remotePath: string,
  onProgress?: (p: TransferProgress) => void,
): Promise<string> {
  const stat = statSync(localPath);

  if (stat.isFile()) {
    await uploadFile(sftp, localPath, remotePath);
    return `Uploaded ${basename(localPath)} (${formatBytes(stat.size)})`;
  }

  // Directory: collect all files, create remote dirs, upload each
  const files = collectLocalFiles(localPath);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  let bytesTransferred = 0;
  let filesCompleted = 0;

  // Ensure remote base directory exists
  await mkdirRemote(sftp, remotePath);

  for (const file of files) {
    const remoteFilePath = posix.join(remotePath, file.relativePath);
    const remoteDir = posix.dirname(remoteFilePath);
    await mkdirRemote(sftp, remoteDir);
    await uploadFile(sftp, file.localPath, remoteFilePath);
    bytesTransferred += file.size;
    filesCompleted++;
    onProgress?.({
      file: file.relativePath,
      bytesTransferred,
      totalBytes,
      filesCompleted,
      totalFiles: files.length,
    });
  }

  return `Uploaded ${files.length} file(s) (${formatBytes(totalBytes)}) to ${remotePath}`;
}

/** Upload a single file. */
function uploadFile(sftp: SFTPWrapper, localPath: string, remotePath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = createReadStream(localPath);
    const writeStream = sftp.createWriteStream(remotePath);
    writeStream.on("close", () => resolve());
    writeStream.on("error", reject);
    readStream.on("error", reject);
    readStream.pipe(writeStream);
  });
}

/** Download a file or directory from remote via SFTP. */
async function downloadPath(
  sftp: SFTPWrapper,
  remotePath: string,
  localPath: string,
  onProgress?: (p: TransferProgress) => void,
): Promise<string> {
  // Check if remote path is a file or directory
  const remoteStat = await new Promise<any>((resolve, reject) => {
    sftp.stat(remotePath, (err: Error | null, stats: any) => {
      if (err) reject(new Error(`Remote path not found: ${remotePath}`));
      else resolve(stats);
    });
  });

  if (remoteStat.isFile()) {
    mkdirSync(dirname(localPath), { recursive: true });
    await downloadFile(sftp, remotePath, localPath);
    return `Downloaded ${basename(remotePath)} (${formatBytes(remoteStat.size)})`;
  }

  // Directory: list recursively, download each
  const files = await collectRemoteFiles(sftp, remotePath);
  const totalBytes = files.reduce((s, f) => s + f.size, 0);
  let bytesTransferred = 0;
  let filesCompleted = 0;

  for (const file of files) {
    const localFilePath = join(localPath, file.relativePath);
    mkdirSync(dirname(localFilePath), { recursive: true });
    await downloadFile(sftp, file.remotePath, localFilePath);
    bytesTransferred += file.size;
    filesCompleted++;
    onProgress?.({
      file: file.relativePath,
      bytesTransferred,
      totalBytes,
      filesCompleted,
      totalFiles: files.length,
    });
  }

  return `Downloaded ${files.length} file(s) (${formatBytes(totalBytes)}) to ${localPath}`;
}

/** Download a single file. */
function downloadFile(sftp: SFTPWrapper, remotePath: string, localPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const readStream = sftp.createReadStream(remotePath);
    const writeStream = createWriteStream(localPath);
    writeStream.on("close", () => resolve());
    writeStream.on("error", reject);
    readStream.on("error", reject);
    readStream.pipe(writeStream);
  });
}

/** Recursively list files on remote. */
async function collectRemoteFiles(sftp: SFTPWrapper, dir: string, base = ""): Promise<Array<{ remotePath: string; relativePath: string; size: number }>> {
  const files: Array<{ remotePath: string; relativePath: string; size: number }> = [];
  const entries = await new Promise<any[]>((resolve, reject) => {
    sftp.readdir(dir, (err: Error | null, list: any[]) => {
      if (err) reject(err);
      else resolve(list || []);
    });
  });

  for (const entry of entries) {
    const fullPath = posix.join(dir, entry.filename);
    const relPath = base ? `${base}/${entry.filename}` : entry.filename;
    if (entry.attrs.isDirectory()) {
      files.push(...await collectRemoteFiles(sftp, fullPath, relPath));
    } else if (entry.attrs.isFile()) {
      files.push({ remotePath: fullPath, relativePath: relPath, size: entry.attrs.size });
    }
  }
  return files;
}

/** Create remote directory recursively. */
async function mkdirRemote(sftp: SFTPWrapper, path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += "/" + part;
    await new Promise<void>((resolve) => {
      sftp.mkdir(current, (_err: Error | null) => resolve()); // ignore errors (dir may exist)
    });
  }
}

function formatBytes(bytes: number): string {
  if (bytes >= 1073741824) return `${(bytes / 1073741824).toFixed(2)} GB`;
  if (bytes >= 1048576) return `${(bytes / 1048576).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(0)} KB`;
  return `${bytes} B`;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function hostPart(hostStr: string): string {
  return hostStr.includes("@") ? hostStr.split("@")[1] : hostStr;
}
