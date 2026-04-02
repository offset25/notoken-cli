/**
 * notoken fix nvm
 *
 * Diagnoses and fixes common nvm issues:
 * - nvm not loading in shell (missing source in profile)
 * - nvm installed but not in PATH
 * - nvm installed for different user
 * - Node installed via nvm but not active
 * - Wrong default Node version
 * - Profile file mismatch (bash vs zsh)
 */

import { execSync } from "node:child_process";
import { existsSync, readFileSync, appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

const HOME = homedir();
const NVM_DIR = process.env.NVM_DIR || resolve(HOME, ".nvm");

const NVM_SOURCE_BLOCK = `
# nvm
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"
[ -s "$NVM_DIR/bash_completion" ] && \\. "$NVM_DIR/bash_completion"
`;

interface NvmDiagnosis {
  nvmInstalled: boolean;
  nvmDir: string;
  nvmLoaded: boolean;
  nodeVersions: string[];
  defaultVersion: string | null;
  currentVersion: string | null;
  shell: string;
  profileFile: string;
  profileHasNvm: boolean;
  issues: Array<{ problem: string; fix: string; auto: boolean }>;
}

export async function fixNvm(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  try {
    console.log(`\n${c.bold}${c.cyan}  nvm Doctor${c.reset}\n`);

    const diag = diagnose();

    // Show findings
    showDiagnosis(diag);

    if (diag.issues.length === 0) {
      console.log(`\n  ${c.green}✓ nvm is working correctly.${c.reset}\n`);
      return;
    }

    // Offer fixes
    console.log(`\n  ${c.bold}Found ${diag.issues.length} issue(s):${c.reset}\n`);

    for (let i = 0; i < diag.issues.length; i++) {
      const issue = diag.issues[i];
      console.log(`  ${c.yellow}${i + 1}.${c.reset} ${issue.problem}`);
      console.log(`     ${c.dim}Fix: ${issue.fix}${c.reset}`);
    }

    const autoFixable = diag.issues.filter(i => i.auto);
    if (autoFixable.length > 0) {
      const answer = await rl.question(`\n  ${c.bold}Auto-fix ${autoFixable.length} issue(s)?${c.reset} [Y/n] `);
      if (!/^n/i.test(answer)) {
        for (const issue of autoFixable) {
          applyFix(issue, diag);
        }

        // Verify
        console.log(`\n  ${c.bold}Verifying...${c.reset}`);
        const after = diagnose();
        if (after.issues.length === 0) {
          console.log(`  ${c.green}✓ All fixed!${c.reset}`);
        } else {
          console.log(`  ${c.yellow}${after.issues.length} issue(s) remaining.${c.reset}`);
          for (const issue of after.issues) {
            console.log(`  ${c.yellow}⚠${c.reset} ${issue.problem}`);
          }
        }

        // Tell user to reload
        console.log(`\n  ${c.bold}Important:${c.reset} Restart your terminal or run:`);
        console.log(`  ${c.cyan}source ${diag.profileFile}${c.reset}\n`);
      }
    }
  } finally {
    rl.close();
  }
}

function diagnose(): NvmDiagnosis {
  const shell = detectShell();
  const profileFile = getProfileFile(shell);
  const nvmInstalled = existsSync(resolve(NVM_DIR, "nvm.sh"));
  const nvmLoaded = !!tryExec('bash -c \'source ~/.nvm/nvm.sh 2>/dev/null && nvm --version\'');
  const profileHasNvm = checkProfileHasNvm(profileFile);

  let nodeVersions: string[] = [];
  let defaultVersion: string | null = null;
  let currentVersion: string | null = null;

  if (nvmInstalled) {
    const versions = tryExec(`bash -c 'source ${NVM_DIR}/nvm.sh 2>/dev/null && nvm ls --no-colors 2>/dev/null'`);
    if (versions) {
      nodeVersions = versions.split("\n")
        .map(l => l.trim().replace(/^[->*\s]+/, "").trim())
        .filter(l => l.startsWith("v"))
        .map(l => l.split(" ")[0]);
    }

    defaultVersion = tryExec(`bash -c 'source ${NVM_DIR}/nvm.sh 2>/dev/null && nvm alias default 2>/dev/null'`)
      ?.match(/v[\d.]+/)?.[0] ?? null;

    currentVersion = tryExec(`bash -c 'source ${NVM_DIR}/nvm.sh 2>/dev/null && node --version 2>/dev/null'`);
  }

  const issues: NvmDiagnosis["issues"] = [];

  // Issue 1: nvm not installed at all
  if (!nvmInstalled) {
    // Check if it's installed somewhere else
    const altDirs = [
      resolve(HOME, ".nvm"),
      "/usr/local/nvm",
      resolve("/home", process.env.SUDO_USER ?? "", ".nvm"),
    ].filter(d => d !== NVM_DIR);

    const altFound = altDirs.find(d => existsSync(resolve(d, "nvm.sh")));
    if (altFound) {
      issues.push({
        problem: `nvm found at ${altFound} but NVM_DIR points to ${NVM_DIR}`,
        fix: `Set NVM_DIR="${altFound}" in your profile`,
        auto: true,
      });
    } else {
      issues.push({
        problem: "nvm is not installed",
        fix: "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash",
        auto: true,
      });
    }
    return { nvmInstalled, nvmDir: NVM_DIR, nvmLoaded, nodeVersions, defaultVersion, currentVersion, shell, profileFile, profileHasNvm, issues };
  }

  // Issue 2: nvm installed but profile doesn't source it
  if (!profileHasNvm) {
    issues.push({
      problem: `nvm not sourced in ${profileFile} — won't load in new terminals`,
      fix: `Add nvm source block to ${profileFile}`,
      auto: true,
    });
  }

  // Issue 3: nvm installed but not loading (maybe wrong NVM_DIR)
  if (nvmInstalled && !nvmLoaded && profileHasNvm) {
    issues.push({
      problem: "nvm source block exists but nvm still not loading",
      fix: "Check NVM_DIR path matches actual installation",
      auto: false,
    });
  }

  // Issue 4: nvm works but no Node versions installed
  if (nvmInstalled && nodeVersions.length === 0) {
    issues.push({
      problem: "nvm installed but no Node.js versions available",
      fix: "nvm install --lts",
      auto: true,
    });
  }

  // Issue 5: No default version set
  if (nvmInstalled && nodeVersions.length > 0 && !defaultVersion) {
    issues.push({
      problem: "No default Node version set — nvm won't auto-use Node in new shells",
      fix: `nvm alias default ${nodeVersions[0]}`,
      auto: true,
    });
  }

  // Issue 6: Default version is old
  if (defaultVersion) {
    const major = parseInt(defaultVersion.replace("v", ""));
    if (major < 18) {
      issues.push({
        problem: `Default Node version ${defaultVersion} is too old (need 18+)`,
        fix: "nvm install 22 && nvm alias default 22",
        auto: true,
      });
    }
  }

  // Issue 7: Permission issues
  const nvmOwner = tryExec(`stat -c '%U' ${NVM_DIR} 2>/dev/null`);
  const currentUser = tryExec("whoami");
  if (nvmOwner && currentUser && nvmOwner !== currentUser && currentUser !== "root") {
    issues.push({
      problem: `nvm directory owned by ${nvmOwner}, but you are ${currentUser}`,
      fix: `sudo chown -R ${currentUser}:${currentUser} ${NVM_DIR}`,
      auto: true,
    });
  }

  return { nvmInstalled, nvmDir: NVM_DIR, nvmLoaded, nodeVersions, defaultVersion, currentVersion, shell, profileFile, profileHasNvm, issues };
}

function showDiagnosis(diag: NvmDiagnosis): void {
  const check = (ok: boolean, msg: string) =>
    console.log(`  ${ok ? `${c.green}✓` : `${c.red}✗`}${c.reset} ${msg}`);

  check(diag.nvmInstalled, `nvm installed at ${diag.nvmDir}`);
  check(diag.profileHasNvm, `Sourced in ${diag.profileFile}`);
  check(diag.nvmLoaded, "nvm loads in bash");
  check(diag.nodeVersions.length > 0, `Node versions: ${diag.nodeVersions.join(", ") || "none"}`);
  check(!!diag.defaultVersion, `Default: ${diag.defaultVersion ?? "not set"}`);
  check(!!diag.currentVersion, `Current: ${diag.currentVersion ?? "none active"}`);
  console.log(`  ${c.dim}Shell: ${diag.shell} | Profile: ${diag.profileFile}${c.reset}`);
}

function applyFix(issue: { problem: string; fix: string }, diag: NvmDiagnosis): void {
  console.log(`\n  ${c.cyan}Fixing:${c.reset} ${issue.problem}`);

  if (issue.fix.includes("Add nvm source block")) {
    appendFileSync(diag.profileFile, NVM_SOURCE_BLOCK);
    console.log(`  ${c.green}✓${c.reset} Added nvm to ${diag.profileFile}`);
    return;
  }

  if (issue.fix.includes("NVM_DIR=")) {
    const match = issue.fix.match(/NVM_DIR="([^"]+)"/);
    if (match) {
      const fixBlock = `\nexport NVM_DIR="${match[1]}"\n[ -s "$NVM_DIR/nvm.sh" ] && \\. "$NVM_DIR/nvm.sh"\n`;
      appendFileSync(diag.profileFile, fixBlock);
      console.log(`  ${c.green}✓${c.reset} Set NVM_DIR to ${match[1]} in ${diag.profileFile}`);
    }
    return;
  }

  if (issue.fix.startsWith("curl")) {
    try {
      execSync(issue.fix, { stdio: "inherit", timeout: 60_000 });
      console.log(`  ${c.green}✓${c.reset} nvm installed`);
    } catch {
      console.log(`  ${c.red}✗${c.reset} Install failed. Try manually: ${issue.fix}`);
    }
    return;
  }

  if (issue.fix.startsWith("nvm ")) {
    try {
      execSync(`bash -c 'source ${NVM_DIR}/nvm.sh 2>/dev/null && ${issue.fix}'`, { stdio: "inherit", timeout: 120_000 });
      console.log(`  ${c.green}✓${c.reset} Done`);
    } catch {
      console.log(`  ${c.red}✗${c.reset} Failed. Try manually: ${issue.fix}`);
    }
    return;
  }

  if (issue.fix.startsWith("sudo chown")) {
    try {
      execSync(issue.fix, { stdio: "inherit", timeout: 15_000 });
      console.log(`  ${c.green}✓${c.reset} Permissions fixed`);
    } catch {
      console.log(`  ${c.red}✗${c.reset} Permission fix failed. Run manually: ${issue.fix}`);
    }
    return;
  }

  console.log(`  ${c.dim}Manual fix needed: ${issue.fix}${c.reset}`);
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function detectShell(): string {
  const shell = process.env.SHELL ?? "";
  if (shell.includes("zsh")) return "zsh";
  if (shell.includes("fish")) return "fish";
  return "bash";
}

function getProfileFile(shell: string): string {
  const candidates: Record<string, string[]> = {
    bash: [".bashrc", ".bash_profile", ".profile"],
    zsh: [".zshrc", ".zprofile"],
    fish: [".config/fish/config.fish"],
  };

  for (const file of candidates[shell] ?? candidates.bash) {
    const full = resolve(HOME, file);
    if (existsSync(full)) return full;
  }

  // Default
  return resolve(HOME, shell === "zsh" ? ".zshrc" : ".bashrc");
}

function checkProfileHasNvm(profileFile: string): boolean {
  if (!existsSync(profileFile)) return false;
  const content = readFileSync(profileFile, "utf-8");
  return content.includes("NVM_DIR") || content.includes("nvm.sh");
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 }).trim() || null;
  } catch {
    return null;
  }
}
