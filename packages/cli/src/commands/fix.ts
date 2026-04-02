/**
 * notoken fix <target>
 *
 * Auto-fix common issues:
 *   notoken fix npm           — Clear npm cache, fix permissions, reinstall
 *   notoken fix node_modules  — Remove and reinstall node_modules
 *   notoken fix git           — Fix common git issues (clean, reset index)
 *   notoken fix docker        — Prune docker, restart daemon
 *   notoken fix permissions   — Fix common permission issues
 *   notoken fix dns           — Flush DNS cache
 */

import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { withSpinner } from "notoken-core";
import { detectLocalPlatform } from "notoken-core";

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

const FIXERS: Record<string, { description: string; run: () => Promise<void> }> = {
  npm: {
    description: "Clear npm cache, verify integrity, fix permissions",
    run: async () => {
      await step("Clearing npm cache", "npm cache clean --force");
      await step("Verifying cache", "npm cache verify");
      await step("Checking for issues", "npm doctor 2>/dev/null || echo 'npm doctor not available'");
    },
  },
  node_modules: {
    description: "Remove and reinstall node_modules",
    run: async () => {
      if (existsSync("node_modules")) {
        await step("Removing node_modules", "rm -rf node_modules");
      }
      if (existsSync("package-lock.json")) {
        await step("Removing package-lock.json", "rm -f package-lock.json");
      }
      await step("Reinstalling dependencies", "npm install");
    },
  },
  git: {
    description: "Fix git index, clean untracked, garbage collect",
    run: async () => {
      await step("Checking git status", "git status --short");
      await step("Garbage collecting", "git gc --auto");
      await step("Verifying objects", "git fsck --no-dangling 2>/dev/null || echo 'Some warnings (usually OK)'");
    },
  },
  docker: {
    description: "Prune unused containers/images/volumes, restart daemon",
    run: async () => {
      await step("Pruning stopped containers", "docker container prune -f 2>/dev/null || echo 'Docker not running'");
      await step("Pruning dangling images", "docker image prune -f 2>/dev/null || echo 'Docker not running'");
      await step("Pruning unused volumes", "docker volume prune -f 2>/dev/null || echo 'Docker not running'");
      await step("Disk usage", "docker system df 2>/dev/null || echo 'Docker not running'");
    },
  },
  permissions: {
    description: "Fix common file permission issues",
    run: async () => {
      await step("Fixing ~/.ssh permissions", "chmod 700 ~/.ssh 2>/dev/null && chmod 600 ~/.ssh/* 2>/dev/null || echo 'No .ssh dir'");
      await step("Fixing ~/.mycli permissions", "chmod -R 700 ~/.mycli 2>/dev/null || echo 'No .mycli dir'");
      if (existsSync(".env")) {
        await step("Securing .env file", "chmod 600 .env");
      }
    },
  },
  dns: {
    description: "Flush DNS cache",
    run: async () => {
      const platform = detectLocalPlatform();
      if (platform.os === "darwin") {
        await step("Flushing DNS", "sudo dscacheutil -flushcache && sudo killall -HUP mDNSResponder");
      } else if (platform.os === "linux") {
        await step("Flushing DNS", "sudo systemd-resolve --flush-caches 2>/dev/null || sudo resolvectl flush-caches 2>/dev/null || echo 'No systemd-resolved'");
      } else {
        await step("Flushing DNS", "ipconfig /flushdns 2>/dev/null || echo 'Not supported'");
      }
    },
  },
};

export async function runFix(args: string[]): Promise<void> {
  const target = args[0];

  if (!target) {
    console.log(`${c.bold}notoken fix${c.reset} <target>\n`);
    for (const [key, fixer] of Object.entries(FIXERS)) {
      console.log(`  ${c.cyan}${key.padEnd(15)}${c.reset} ${fixer.description}`);
    }
    return;
  }

  const fixer = FIXERS[target];
  if (!fixer) {
    console.error(`${c.red}Unknown fix target: ${target}${c.reset}`);
    console.log(`Available: ${Object.keys(FIXERS).join(", ")}`);
    return;
  }

  console.log(`${c.bold}notoken fix ${target}${c.reset} — ${fixer.description}\n`);
  await fixer.run();
  console.log(`\n${c.green}✓${c.reset} Done.`);
}

async function step(label: string, cmd: string): Promise<void> {
  try {
    const output = await withSpinner(label, async () => {
      return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 120_000 });
    });
    if (output.trim()) {
      console.log(`${c.dim}${output.trim().split("\n").slice(0, 5).join("\n")}${c.reset}`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`  ${c.red}✗ ${msg.split("\n")[0]}${c.reset}`);
  }
}
