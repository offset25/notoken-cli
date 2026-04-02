/**
 * notoken doctor
 *
 * Full diagnostic and recovery tool. Works even when everything is broken.
 *
 * Diagnoses:
 *   - PATH issues, missing tools, broken installs
 *   - npm corruption, stale caches, permission issues
 *   - Node.js version problems
 *   - Claude CLI auth/token issues
 *   - Docker daemon state
 *   - Git configuration
 *   - SSH key/config problems
 *   - Environment variables
 *   - Config file integrity
 *   - Disk space (can't fix anything if disk is full)
 *
 * For each issue found: explains what's wrong, suggests a fix,
 * and offers to run it automatically.
 */

import { execSync } from "node:child_process";
import { existsSync, statSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { detectLocalPlatform, getInstallCommand, type PlatformInfo } from "notoken-core";
import { CONFIG_DIR, USER_HOME, DATA_DIR, LOG_DIR, ensureUserDirs } from "notoken-core";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

interface Issue {
  severity: "critical" | "warning" | "info";
  category: string;
  message: string;
  fix?: string;
  fixCmd?: string;
  fixDangerous?: boolean;
}

export async function runDoctor(): Promise<void> {
  console.log(`\n${c.bold}${c.cyan}  notoken doctor${c.reset}`);
  console.log(`${c.dim}  Diagnosing your environment...${c.reset}\n`);

  const issues: Issue[] = [];
  let platform: PlatformInfo;

  // ── Platform Detection ──
  try {
    platform = detectLocalPlatform();
    const wsl = platform.isWSL ? ` ${c.yellow}(WSL)${c.reset}` : "";
    console.log(`  ${c.bold}System:${c.reset} ${platform.distro}${wsl} | ${platform.arch} | ${platform.shell}`);
    console.log(`  ${c.bold}Packages:${c.reset} ${platform.packageManager} | ${c.bold}Init:${c.reset} ${platform.initSystem}`);
  } catch {
    console.log(`  ${c.red}Could not detect platform${c.reset}`);
    platform = { os: "unknown", distro: "unknown", distroVersion: "", distroFamily: "unknown", kernel: "", isWSL: false, shell: "bash", packageManager: "unknown", initSystem: "unknown", arch: "" };
    issues.push({ severity: "warning", category: "System", message: "Could not detect OS/platform" });
  }

  console.log();

  // ── PATH Check ──
  section("PATH");
  const path = process.env.PATH ?? "";
  const pathDirs = path.split(":").filter(Boolean);
  const missingPathDirs: string[] = [];
  const commonPaths = ["/usr/local/bin", "/usr/bin", "/bin", "/usr/sbin"];
  for (const p of commonPaths) {
    if (!pathDirs.includes(p)) missingPathDirs.push(p);
  }
  if (missingPathDirs.length > 0) {
    fail(`PATH missing standard directories: ${missingPathDirs.join(", ")}`);
    issues.push({
      severity: "critical", category: "PATH",
      message: `Missing from PATH: ${missingPathDirs.join(", ")}`,
      fix: "Add missing directories to PATH",
      fixCmd: `export PATH="${missingPathDirs.join(":")}:$PATH"`,
    });
  } else {
    pass(`PATH has ${pathDirs.length} directories`);
  }

  // Check for node in PATH
  const nodeInPath = which("node");
  if (!nodeInPath) {
    fail("node not found in PATH");
    issues.push({
      severity: "critical", category: "PATH",
      message: "Node.js not found in PATH",
      fix: "Install Node.js or fix PATH",
      fixCmd: platform.packageManager === "apt" ? "curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs" : "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash",
    });
  }

  // ── Node.js ──
  section("Node.js");
  const nodeVersion = getVersion("node --version");
  if (nodeVersion) {
    const major = parseInt(nodeVersion.replace("v", ""));
    if (major < 18) {
      warn(`Node.js ${nodeVersion} — version 18+ required`);
      issues.push({
        severity: "critical", category: "Node.js",
        message: `Node.js ${nodeVersion} is too old (need 18+)`,
        fix: "Upgrade Node.js",
        fixCmd: "nvm install 20 2>/dev/null || curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash - && sudo apt-get install -y nodejs",
      });
    } else {
      pass(`Node.js ${nodeVersion}`);
    }
  } else {
    fail("Node.js not installed");
  }

  // ── npm ──
  section("npm");
  const npmVersion = getVersion("npm --version");
  if (npmVersion) {
    pass(`npm ${npmVersion}`);

    // Check npm cache health
    const cacheCheck = tryExec("npm cache verify 2>&1 | tail -1");
    if (cacheCheck?.includes("error") || cacheCheck?.includes("WARN")) {
      warn("npm cache may be corrupted");
      issues.push({
        severity: "warning", category: "npm",
        message: "npm cache appears corrupted",
        fix: "Clear and rebuild npm cache",
        fixCmd: "npm cache clean --force && npm cache verify",
      });
    }

    // Check for permission issues
    const npmPrefix = tryExec("npm config get prefix");
    if (npmPrefix?.includes("/usr/local") || npmPrefix?.includes("/usr")) {
      const canWrite = tryExec(`test -w "${npmPrefix}/lib" && echo ok`);
      if (!canWrite?.includes("ok")) {
        warn(`npm global dir not writable: ${npmPrefix}`);
        issues.push({
          severity: "warning", category: "npm",
          message: `Cannot write to npm global directory: ${npmPrefix}`,
          fix: "Fix npm permissions or use nvm",
          fixCmd: `sudo chown -R $(whoami) "${npmPrefix}/lib" "${npmPrefix}/bin" "${npmPrefix}/share" 2>/dev/null || echo "Consider using nvm instead"`,
        });
      }
    }

    // Check for stale package-lock
    if (existsSync("package-lock.json") && existsSync("package.json")) {
      const lockAge = Date.now() - statSync("package-lock.json").mtimeMs;
      const pkgAge = Date.now() - statSync("package.json").mtimeMs;
      if (pkgAge < lockAge - 60_000) {
        warn("package.json newer than package-lock.json");
        issues.push({
          severity: "warning", category: "npm",
          message: "package.json was modified after package-lock.json — deps may be out of sync",
          fix: "Reinstall dependencies",
          fixCmd: "npm install",
        });
      }
    }
  } else {
    fail("npm not found");
    issues.push({
      severity: "critical", category: "npm",
      message: "npm not installed",
      fix: "Install npm (comes with Node.js)",
      fixCmd: getInstallCommand("npm", platform),
    });
  }

  // ── Git ──
  section("Git");
  const gitVersion = getVersion("git --version");
  if (gitVersion) {
    pass(gitVersion);
    const gitUser = tryExec("git config --global user.name");
    const gitEmail = tryExec("git config --global user.email");
    if (!gitUser?.trim()) {
      warn("git user.name not set");
      issues.push({
        severity: "info", category: "Git",
        message: "Git user name not configured",
        fix: "Set git user name",
        fixCmd: 'git config --global user.name "Your Name"',
      });
    }
    if (!gitEmail?.trim()) {
      warn("git user.email not set");
      issues.push({
        severity: "info", category: "Git",
        message: "Git user email not configured",
        fix: "Set git user email",
        fixCmd: 'git config --global user.email "you@example.com"',
      });
    }
  } else {
    fail("git not installed");
    issues.push({ severity: "critical", category: "Git", message: "Git not installed", fix: "Install git", fixCmd: getInstallCommand("git", platform) });
  }

  // ── Claude CLI ──
  section("Claude CLI");
  const claudeVersion = getVersion("claude --version");
  if (claudeVersion) {
    pass(`Claude ${claudeVersion}`);

    // Check auth
    const claudeAuth = tryExec("claude --version 2>&1");
    if (claudeAuth?.toLowerCase().includes("not authenticated") || claudeAuth?.toLowerCase().includes("login")) {
      warn("Claude CLI not authenticated");
      issues.push({
        severity: "warning", category: "Claude",
        message: "Claude CLI is installed but not authenticated",
        fix: "Log in to Claude",
        fixCmd: "claude login",
      });
    }
  } else {
    info("Claude CLI not installed (optional — enables LLM features)");
    issues.push({
      severity: "info", category: "Claude",
      message: "Claude CLI not installed",
      fix: "Install Claude CLI for LLM-powered features",
      fixCmd: "npm install -g @anthropic-ai/claude-code",
    });
  }

  // ── Ollama (local LLM) ──
  section("Ollama (Local LLM)");
  const ollamaVersion = getVersion("ollama --version");
  if (ollamaVersion) {
    pass(`Ollama ${ollamaVersion}`);

    // Check if daemon is running
    const ollamaRunning = tryExec("curl -sf http://localhost:11434/api/tags 2>/dev/null");
    if (ollamaRunning) {
      pass("Ollama server running");
      // Check models
      try {
        const models = JSON.parse(ollamaRunning);
        const names = (models.models || []).map((m: Record<string, string>) => m.name);
        if (names.length > 0) {
          pass(`Models: ${names.slice(0, 5).join(", ")}`);
        } else {
          warn("No models pulled — run: ollama pull llama3.2");
          issues.push({
            severity: "info", category: "Ollama",
            message: "Ollama installed but no models pulled",
            fix: "Pull a small model for local LLM features",
            fixCmd: "ollama pull llama3.2",
          });
        }
      } catch {}
    } else {
      warn("Ollama installed but not running");
      issues.push({
        severity: "info", category: "Ollama",
        message: "Ollama is installed but the server is not running",
        fix: "Start Ollama server",
        fixCmd: "ollama serve &",
      });
    }
  } else {
    info("Ollama not installed (optional — enables local LLM without cloud tokens)");
    issues.push({
      severity: "info", category: "Ollama",
      message: "Ollama not installed — local AI features unavailable",
      fix: "Install Ollama for token-free local LLM",
      fixCmd: "curl -fsSL https://ollama.com/install.sh | sh && ollama pull llama3.2",
    });
  }

  // ── Docker ──
  section("Docker");
  const dockerVersion = getVersion("docker --version");
  if (dockerVersion) {
    pass(dockerVersion);

    // Check if daemon is running
    const dockerPing = tryExec("docker info --format '{{.ServerVersion}}' 2>&1");
    if (!dockerPing || dockerPing.includes("Cannot connect") || dockerPing.includes("error")) {
      warn("Docker daemon not running");
      issues.push({
        severity: "warning", category: "Docker",
        message: "Docker is installed but the daemon is not running",
        fix: "Start Docker daemon",
        fixCmd: "sudo systemctl start docker",
      });
    } else {
      info(`  Docker daemon running (server ${dockerPing.trim()})`);
    }

    // Check disk usage
    const dockerDf = tryExec("docker system df --format '{{.Size}}' 2>/dev/null | head -1");
    if (dockerDf) {
      info(`  Docker disk: ${dockerDf.trim()}`);
    }
  } else {
    info("Docker not installed (optional)");
  }

  // ── SSH ──
  section("SSH");
  const sshDir = resolve(homedir(), ".ssh");
  if (existsSync(sshDir)) {
    pass(".ssh directory exists");
    const keyFiles = ["id_rsa", "id_ed25519", "id_ecdsa"].filter((k) => existsSync(resolve(sshDir, k)));
    if (keyFiles.length > 0) {
      pass(`SSH keys: ${keyFiles.join(", ")}`);
      // Check permissions
      for (const key of keyFiles) {
        const mode = statSync(resolve(sshDir, key)).mode & 0o777;
        if (mode !== 0o600) {
          warn(`${key} has permissions ${mode.toString(8)} (should be 600)`);
          issues.push({
            severity: "warning", category: "SSH",
            message: `SSH key ${key} has wrong permissions: ${mode.toString(8)}`,
            fix: "Fix SSH key permissions",
            fixCmd: `chmod 600 ~/.ssh/${key}`,
          });
        }
      }
    } else {
      info("No SSH keys found (generate with: ssh-keygen -t ed25519)");
    }
  } else {
    info("No .ssh directory");
  }

  // ── Disk Space ──
  section("Disk Space");
  const dfOutput = tryExec("df -h / | tail -1");
  if (dfOutput) {
    const match = dfOutput.match(/(\d+)%/);
    if (match) {
      const usage = parseInt(match[1]);
      if (usage >= 95) {
        fail(`Root filesystem ${usage}% full — CRITICAL`);
        issues.push({
          severity: "critical", category: "Disk",
          message: `Root filesystem is ${usage}% full — system may be unstable`,
          fix: "Free up disk space",
          fixCmd: "sudo apt-get autoremove -y 2>/dev/null; sudo apt-get clean 2>/dev/null; docker system prune -f 2>/dev/null; sudo journalctl --vacuum-size=100M 2>/dev/null",
        });
      } else if (usage >= 85) {
        warn(`Root filesystem ${usage}% full`);
        issues.push({
          severity: "warning", category: "Disk",
          message: `Root filesystem is ${usage}% full`,
          fix: "Clean up disk space",
          fixCmd: "sudo apt-get autoremove -y 2>/dev/null; sudo apt-get clean 2>/dev/null; docker system prune -f 2>/dev/null",
        });
      } else {
        pass(`Root filesystem ${usage}% used`);
      }
    }
  }

  // ── Environment Variables ──
  section("Environment");
  if (process.env.NOTOKEN_LLM_CLI) {
    pass(`NOTOKEN_LLM_CLI=${process.env.NOTOKEN_LLM_CLI}`);
  } else if (process.env.NOTOKEN_LLM_ENDPOINT) {
    pass(`NOTOKEN_LLM_ENDPOINT set`);
  } else {
    info("No LLM configured (set NOTOKEN_LLM_CLI=claude for AI features)");
  }

  if (process.env.ANTHROPIC_API_KEY) {
    pass("ANTHROPIC_API_KEY set");
  }
  if (process.env.OPENAI_API_KEY) {
    pass("OPENAI_API_KEY set");
  }

  // ── notoken Config ──
  section("notoken Config");
  const configFiles = ["intents.json", "rules.json", "hosts.json", "file-hints.json", "playbooks.json"];
  for (const file of configFiles) {
    const path = resolve(CONFIG_DIR, file);
    if (existsSync(path)) {
      // Validate JSON
      try {
        JSON.parse(readFileSync(path, "utf-8"));
        pass(file);
      } catch {
        fail(`${file} — invalid JSON`);
        issues.push({
          severity: "critical", category: "Config",
          message: `${file} contains invalid JSON`,
          fix: "Fix or restore from backup",
        });
      }
    } else {
      fail(`${file} — missing`);
      issues.push({ severity: "critical", category: "Config", message: `Config file missing: ${path}` });
    }
  }

  // Ensure data dirs
  try {
    ensureUserDirs();
    pass(`Data dirs OK (${USER_HOME})`);
  } catch {
    warn("Could not create data directories");
  }

  // ── Summary ──
  console.log(`\n${"─".repeat(50)}`);

  const critical = issues.filter((i) => i.severity === "critical");
  const warnings = issues.filter((i) => i.severity === "warning");
  const infos = issues.filter((i) => i.severity === "info");

  if (critical.length === 0 && warnings.length === 0) {
    console.log(`\n  ${c.green}${c.bold}✓ All clear!${c.reset} No issues found.\n`);
    return;
  }

  console.log(`\n  ${c.bold}Diagnosis:${c.reset} ${c.red}${critical.length} critical${c.reset} | ${c.yellow}${warnings.length} warnings${c.reset} | ${infos.length} info\n`);

  // Show fixable issues
  const fixable = issues.filter((i) => i.fixCmd);
  if (fixable.length === 0) return;

  console.log(`  ${c.bold}Fixable issues:${c.reset}\n`);
  for (let i = 0; i < fixable.length; i++) {
    const issue = fixable[i];
    const icon = issue.severity === "critical" ? `${c.red}✗${c.reset}` : issue.severity === "warning" ? `${c.yellow}⚠${c.reset}` : `${c.dim}i${c.reset}`;
    console.log(`  ${icon} ${c.bold}${issue.category}:${c.reset} ${issue.message}`);
    console.log(`    ${c.green}Fix:${c.reset} ${issue.fix}`);
    console.log(`    ${c.dim}$ ${issue.fixCmd}${c.reset}\n`);
  }

  // Offer to fix
  const autoFixable = fixable.filter((i) => i.severity === "critical" || i.severity === "warning");
  if (autoFixable.length > 0) {
    const rl = readline.createInterface({ input, output });
    try {
      const answer = await rl.question(`  ${c.bold}Auto-fix ${autoFixable.length} issue(s)?${c.reset} [y/N] `);
      if (/^y(es)?$/i.test(answer.trim())) {
        console.log();
        for (const issue of autoFixable) {
          if (!issue.fixCmd) continue;
          console.log(`  ${c.cyan}Fixing:${c.reset} ${issue.message}`);
          try {
            const result = execSync(issue.fixCmd, {
              encoding: "utf-8",
              stdio: ["pipe", "pipe", "pipe"],
              timeout: 120_000,
            });
            if (result.trim()) {
              console.log(`  ${c.dim}${result.trim().split("\n").slice(0, 3).join("\n")}${c.reset}`);
            }
            console.log(`  ${c.green}✓ Fixed${c.reset}\n`);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            console.log(`  ${c.red}✗ Failed: ${msg.split("\n")[0]}${c.reset}\n`);
          }
        }
        console.log(`  ${c.green}Done.${c.reset} Run ${c.cyan}notoken doctor${c.reset} again to verify.\n`);
      }
    } finally {
      rl.close();
    }
  }
}

// ─── Output helpers ──────────────────────────────────────────────────────────

function section(name: string): void {
  console.log(`\n  ${c.bold}${name}:${c.reset}`);
}

function pass(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function fail(msg: string): void {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
}

function warn(msg: string): void {
  console.log(`  ${c.yellow}⚠${c.reset} ${msg}`);
}

function info(msg: string): void {
  console.log(`  ${c.dim}○${c.reset} ${msg}`);
}

function which(cmd: string): string | null {
  try {
    return execSync(`which ${cmd} 2>/dev/null`, { encoding: "utf-8" }).trim() || null;
  } catch {
    return null;
  }
}

function getVersion(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 }).trim().split("\n")[0] || null;
  } catch {
    return null;
  }
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}
