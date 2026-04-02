/**
 * notoken setup openclaw
 *
 * Guided OpenClaw setup using openclaw's own CLI tools:
 * 1. Check/upgrade Node version (needs 22.14+)
 * 2. Install OpenClaw
 * 3. Run openclaw setup (creates workspace)
 * 4. Ask for API key and configure model via openclaw config set
 * 5. Ask for Telegram bot token (optional)
 * 6. Run openclaw doctor --fix
 * 7. Offer to start gateway or run full onboard
 */

import { execSync, spawn as spawnProcess } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m",
};

export async function runSetupOpenclaw(): Promise<void> {
  const rl = readline.createInterface({ input, output });

  try {
    console.log(`\n${c.bold}${c.magenta}  OpenClaw Setup${c.reset}`);
    console.log(`${c.dim}  Personal AI assistant across all your messaging channels${c.reset}\n`);

    // ── Step 1: Check Node version ──
    console.log(`${c.bold}[1/7] Checking Node.js...${c.reset}`);
    const nodeVersion = tryExec("node --version") ?? "none";
    const major = parseInt(nodeVersion.replace("v", "")) || 0;

    if (major < 22) {
      console.log(`  ${c.yellow}⚠${c.reset} Node ${nodeVersion} — OpenClaw needs 22.14+`);
      const upgrade = await ask(rl, `  Upgrade Node.js to 22? [Y/n] `);
      if (!/^n/i.test(upgrade)) {
        console.log(`  ${c.dim}Upgrading Node.js...${c.reset}`);
        try {
          execSync("curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs 2>/dev/null || nvm install 22 2>/dev/null", {
            stdio: "inherit", timeout: 120_000,
          });
          const newVersion = tryExec("node --version");
          console.log(`  ${c.green}✓${c.reset} Node upgraded to ${newVersion}`);
        } catch {
          console.log(`  ${c.red}✗${c.reset} Auto-upgrade failed. Install Node 22+ manually.`);
          console.log(`  ${c.dim}https://nodejs.org or: nvm install 22${c.reset}`);
          return;
        }
      } else {
        console.log(`  ${c.yellow}⚠${c.reset} OpenClaw won't work without Node 22+. Aborting.`);
        return;
      }
    } else {
      console.log(`  ${c.green}✓${c.reset} Node ${nodeVersion}`);
    }

    // ── Step 2: Install OpenClaw ──
    console.log(`\n${c.bold}[2/7] Installing OpenClaw...${c.reset}`);
    const clawVersion = tryExec("openclaw --version");
    if (clawVersion) {
      console.log(`  ${c.green}✓${c.reset} Already installed (${clawVersion})`);
    } else {
      console.log(`  ${c.dim}This may take a minute (192MB)...${c.reset}`);
      try {
        execSync("npm install -g openclaw@latest", { stdio: "inherit", timeout: 300_000 });
        console.log(`  ${c.green}✓${c.reset} OpenClaw installed`);
      } catch {
        console.log(`  ${c.red}✗${c.reset} Install failed. Try: npm install -g openclaw@latest`);
        return;
      }
    }

    // ── Step 3: Run openclaw setup (creates workspace) ──
    console.log(`\n${c.bold}[3/7] Creating workspace...${c.reset}`);
    try {
      execSync("openclaw setup 2>&1 || true", { stdio: "inherit", timeout: 30_000 });
      console.log(`  ${c.green}✓${c.reset} Workspace initialized`);
    } catch {
      console.log(`  ${c.dim}Setup may have partially completed. Continuing...${c.reset}`);
    }

    // Set gateway mode to local
    tryExec('openclaw config set gateway.mode local');
    console.log(`  ${c.green}✓${c.reset} Gateway mode: local`);

    // ── Step 4: AI Provider ──
    console.log(`\n${c.bold}[4/7] AI Provider${c.reset}`);
    console.log(`  Which AI provider do you want to use?\n`);
    console.log(`  ${c.cyan}1${c.reset} Anthropic (Claude) ${c.dim}— recommended${c.reset}`);
    console.log(`  ${c.cyan}2${c.reset} OpenAI (GPT-4o)`);
    console.log(`  ${c.cyan}3${c.reset} Ollama (local, free)`);
    console.log(`  ${c.cyan}4${c.reset} Skip for now\n`);

    const providerChoice = await ask(rl, `  Choice [1-4]: `);

    switch (providerChoice.trim()) {
      case "1": {
        console.log(`\n  ${c.dim}Get your key at: https://console.anthropic.com/settings/keys${c.reset}`);
        const key = await ask(rl, `  Anthropic API key: `);
        if (key.trim()) {
          tryExec(`openclaw config set models.default.provider anthropic`);
          tryExec(`openclaw config set models.default.model claude-sonnet-4-20250514`);
          tryExec(`openclaw config set models.default.apiKey --ref-provider default --ref-source env --ref-id ANTHROPIC_API_KEY`);
          // Set the env var in openclaw config
          tryExec(`openclaw config set env.vars.ANTHROPIC_API_KEY "${key.trim()}"`);
          console.log(`  ${c.green}✓${c.reset} Anthropic configured (claude-sonnet-4-20250514)`);
        }
        break;
      }
      case "2": {
        console.log(`\n  ${c.dim}Get your key at: https://platform.openai.com/api-keys${c.reset}`);
        const key = await ask(rl, `  OpenAI API key: `);
        if (key.trim()) {
          tryExec(`openclaw config set models.default.provider openai`);
          tryExec(`openclaw config set models.default.model gpt-4o`);
          tryExec(`openclaw config set models.default.apiKey --ref-provider default --ref-source env --ref-id OPENAI_API_KEY`);
          tryExec(`openclaw config set env.vars.OPENAI_API_KEY "${key.trim()}"`);
          console.log(`  ${c.green}✓${c.reset} OpenAI configured (gpt-4o)`);
        }
        break;
      }
      case "3": {
        tryExec(`openclaw config set models.default.provider ollama`);
        tryExec(`openclaw config set models.default.model llama3.2`);
        tryExec(`openclaw config set models.default.baseUrl http://localhost:11434`);
        console.log(`  ${c.green}✓${c.reset} Ollama configured (make sure ollama serve is running)`);
        break;
      }
      default:
        console.log(`  ${c.dim}Skipping. Configure later: openclaw configure --section model${c.reset}`);
    }

    // ── Step 5: Telegram Bot ──
    console.log(`\n${c.bold}[5/7] Telegram Bot (optional)${c.reset}`);
    console.log(`  ${c.dim}To create a bot:${c.reset}`);
    console.log(`  ${c.dim}1. Open https://t.me/BotFather${c.reset}`);
    console.log(`  ${c.dim}2. Send /newbot${c.reset}`);
    console.log(`  ${c.dim}3. Choose a name and username${c.reset}`);
    console.log(`  ${c.dim}4. Copy the token it gives you${c.reset}`);
    const telegramToken = await ask(rl, `\n  Telegram bot token (Enter to skip): `);

    if (telegramToken.trim()) {
      tryExec(`openclaw config set channels.telegram.enabled true --strict-json`);
      tryExec(`openclaw config set channels.telegram.token --ref-provider default --ref-source env --ref-id TELEGRAM_BOT_TOKEN`);
      tryExec(`openclaw config set env.vars.TELEGRAM_BOT_TOKEN "${telegramToken.trim()}"`);
      console.log(`  ${c.green}✓${c.reset} Telegram configured`);

      // Ask about DM policy
      console.log(`\n  ${c.bold}Who can message your bot?${c.reset}`);
      console.log(`  ${c.cyan}1${c.reset} Only me (private) ${c.dim}— recommended${c.reset}`);
      console.log(`  ${c.cyan}2${c.reset} Anyone (open)`);
      const dmChoice = await ask(rl, `  Choice [1-2]: `);
      if (dmChoice.trim() === "2") {
        tryExec(`openclaw config set channels.telegram.dmPolicy open`);
      } else {
        tryExec(`openclaw config set channels.telegram.dmPolicy closed`);
        console.log(`  ${c.dim}Tip: After starting, pair your Telegram user with: openclaw pairing approve${c.reset}`);
      }
    }

    // ── Step 6: Run doctor --fix ──
    console.log(`\n${c.bold}[6/7] Running doctor...${c.reset}`);
    try {
      execSync("openclaw doctor --fix 2>&1 || true", { stdio: "inherit", timeout: 60_000 });
    } catch {}

    // Validate config
    const validation = tryExec("openclaw config validate 2>&1");
    if (validation?.includes("valid") || validation?.includes("ok")) {
      console.log(`  ${c.green}✓${c.reset} Config valid`);
    } else {
      console.log(`  ${c.yellow}⚠${c.reset} Config may have issues. Run: openclaw config validate`);
    }

    // ── Step 7: Launch ──
    console.log(`\n${c.bold}[7/7] Ready!${c.reset}\n`);
    console.log(`  ${c.bold}Config:${c.reset}  ${tryExec("openclaw config file") ?? "~/.openclaw/openclaw.json"}`);

    console.log(`\n  ${c.bold}What would you like to do?${c.reset}\n`);
    console.log(`  ${c.cyan}1${c.reset} Run full onboard wizard ${c.dim}— interactive, handles OAuth for all channels${c.reset}`);
    console.log(`  ${c.cyan}2${c.reset} Start the gateway now ${c.dim}— begin with current config${c.reset}`);
    console.log(`  ${c.cyan}3${c.reset} Open the TUI ${c.dim}— terminal interface to chat with your agent${c.reset}`);
    console.log(`  ${c.cyan}4${c.reset} Done for now\n`);

    const launchChoice = await ask(rl, `  Choice [1-4]: `);

    switch (launchChoice.trim()) {
      case "1":
        console.log(`\n  ${c.dim}Launching openclaw onboard...${c.reset}\n`);
        try {
          const child = spawnProcess("openclaw", ["onboard", "--install-daemon"], { stdio: "inherit" });
          await new Promise<void>((resolve) => child.on("close", () => resolve()));
        } catch {
          console.log(`  ${c.dim}Run manually: openclaw onboard --install-daemon${c.reset}`);
        }
        break;
      case "2":
        console.log(`\n  ${c.dim}Starting gateway...${c.reset}\n`);
        try {
          const child = spawnProcess("openclaw", ["gateway", "--verbose"], { stdio: "inherit" });
          await new Promise<void>((resolve) => child.on("close", () => resolve()));
        } catch {
          console.log(`  ${c.dim}Run manually: openclaw gateway --verbose${c.reset}`);
        }
        break;
      case "3":
        console.log(`\n  ${c.dim}Opening TUI...${c.reset}\n`);
        try {
          const child = spawnProcess("openclaw", ["tui"], { stdio: "inherit" });
          await new Promise<void>((resolve) => child.on("close", () => resolve()));
        } catch {
          console.log(`  ${c.dim}Run manually: openclaw tui${c.reset}`);
        }
        break;
      default:
        console.log(`\n  ${c.bold}Quick reference:${c.reset}`);
        console.log(`  ${c.cyan}openclaw onboard${c.reset}           — Full guided setup with OAuth`);
        console.log(`  ${c.cyan}openclaw gateway --verbose${c.reset} — Start the gateway`);
        console.log(`  ${c.cyan}openclaw tui${c.reset}               — Terminal chat interface`);
        console.log(`  ${c.cyan}openclaw doctor${c.reset}            — Diagnose issues`);
        console.log(`  ${c.cyan}openclaw configure${c.reset}         — Interactive config editor`);
        console.log(`  ${c.cyan}openclaw channels login${c.reset}    — Connect WhatsApp/Telegram/etc`);
        console.log(`  ${c.cyan}notoken doctor${c.reset}             — Check everything\n`);
    }
  } finally {
    rl.close();
  }
}

function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return rl.question(prompt);
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 }).trim();
  } catch {
    return null;
  }
}
