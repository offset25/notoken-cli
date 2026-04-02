/**
 * notoken setup openclaw
 *
 * Guided OpenClaw setup:
 * 1. Check/upgrade Node version (needs 22.14+)
 * 2. Install OpenClaw
 * 3. Ask for API key (OpenAI/Anthropic)
 * 4. Ask for Telegram bot token (optional)
 * 5. Generate workspace config
 * 6. Offer to start the gateway
 */

import { execSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";
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
    console.log(`${c.bold}[1/6] Checking Node.js...${c.reset}`);
    const nodeVersion = execSync("node --version", { encoding: "utf-8" }).trim();
    const major = parseInt(nodeVersion.replace("v", ""));

    if (major < 22) {
      console.log(`  ${c.yellow}⚠${c.reset} Node ${nodeVersion} — OpenClaw needs 22.14+`);
      const upgrade = await ask(rl, `  Upgrade Node.js to 22? [y/N] `);
      if (/^y/i.test(upgrade)) {
        console.log(`  ${c.dim}Upgrading Node.js...${c.reset}`);
        try {
          execSync("curl -fsSL https://deb.nodesource.com/setup_22.x | bash - && apt-get install -y nodejs 2>/dev/null || nvm install 22", {
            stdio: "inherit", timeout: 120_000,
          });
          console.log(`  ${c.green}✓${c.reset} Node upgraded`);
        } catch {
          console.log(`  ${c.red}✗${c.reset} Could not upgrade automatically.`);
          console.log(`  ${c.dim}Install Node 22+ manually: https://nodejs.org${c.reset}`);
          return;
        }
      } else {
        console.log(`  ${c.dim}OpenClaw may not work on Node ${major}. Continuing anyway...${c.reset}`);
      }
    } else {
      console.log(`  ${c.green}✓${c.reset} Node ${nodeVersion}`);
    }

    // ── Step 2: Install OpenClaw ──
    console.log(`\n${c.bold}[2/6] Installing OpenClaw...${c.reset}`);
    const installed = tryExec("openclaw --version");
    if (installed) {
      console.log(`  ${c.green}✓${c.reset} Already installed (${installed})`);
    } else {
      try {
        console.log(`  ${c.dim}This may take a minute (192MB)...${c.reset}`);
        execSync("npm install -g openclaw@latest", { stdio: "inherit", timeout: 300_000 });
        console.log(`  ${c.green}✓${c.reset} OpenClaw installed`);
      } catch {
        console.log(`  ${c.red}✗${c.reset} Install failed. Try: npm install -g openclaw@latest`);
        return;
      }
    }

    // ── Step 3: AI Provider ──
    console.log(`\n${c.bold}[3/6] AI Provider${c.reset}`);
    console.log(`  Which AI provider do you want to use?\n`);
    console.log(`  ${c.cyan}1${c.reset} Anthropic (Claude) ${c.dim}— recommended${c.reset}`);
    console.log(`  ${c.cyan}2${c.reset} OpenAI (GPT)`);
    console.log(`  ${c.cyan}3${c.reset} Ollama (local, free)`);
    console.log(`  ${c.cyan}4${c.reset} Skip for now\n`);

    const providerChoice = await ask(rl, `  Choice [1-4]: `);

    let provider = "anthropic";
    let apiKey = "";
    let model = "";

    switch (providerChoice.trim()) {
      case "1":
        provider = "anthropic";
        model = "claude-sonnet-4-20250514";
        console.log(`\n  ${c.dim}Get your key at: https://console.anthropic.com/settings/keys${c.reset}`);
        apiKey = await ask(rl, `  Anthropic API key: `);
        break;
      case "2":
        provider = "openai";
        model = "gpt-4o";
        console.log(`\n  ${c.dim}Get your key at: https://platform.openai.com/api-keys${c.reset}`);
        apiKey = await ask(rl, `  OpenAI API key: `);
        break;
      case "3":
        provider = "ollama";
        model = "llama3.2";
        console.log(`\n  ${c.green}✓${c.reset} Using Ollama (make sure it's running: ollama serve)`);
        break;
      default:
        console.log(`  ${c.dim}Skipping API setup. You can configure later with: openclaw onboard${c.reset}`);
        break;
    }

    // ── Step 4: Telegram Bot ──
    console.log(`\n${c.bold}[4/6] Telegram Bot (optional)${c.reset}`);
    console.log(`  ${c.dim}Create a bot at https://t.me/BotFather — send /newbot${c.reset}`);
    const telegramToken = await ask(rl, `  Telegram bot token (or press Enter to skip): `);

    // ── Step 5: Generate Config ──
    console.log(`\n${c.bold}[5/6] Creating workspace...${c.reset}`);

    const workspaceDir = resolve(homedir(), ".openclaw");
    if (!existsSync(workspaceDir)) {
      mkdirSync(workspaceDir, { recursive: true });
    }

    // Generate gateway.yaml
    const gatewayConfig = buildGatewayConfig(provider, model, apiKey, telegramToken);
    const configPath = resolve(workspaceDir, "gateway.yaml");
    writeFileSync(configPath, gatewayConfig, { mode: 0o600 });
    console.log(`  ${c.green}✓${c.reset} Config written to ${configPath}`);

    // Generate .env
    const envContent = buildEnvFile(provider, apiKey, telegramToken);
    const envPath = resolve(workspaceDir, ".env");
    writeFileSync(envPath, envContent, { mode: 0o600 });
    console.log(`  ${c.green}✓${c.reset} Secrets written to ${envPath} (chmod 600)`);

    // ── Step 6: Start? ──
    console.log(`\n${c.bold}[6/6] Ready!${c.reset}\n`);
    console.log(`  ${c.bold}Workspace:${c.reset} ${workspaceDir}`);
    console.log(`  ${c.bold}Config:${c.reset}    ${configPath}`);
    console.log(`  ${c.bold}Provider:${c.reset}  ${provider} (${model || "default"})`);
    if (telegramToken) {
      console.log(`  ${c.bold}Telegram:${c.reset}  configured`);
    }

    console.log(`\n  ${c.bold}Next steps:${c.reset}`);
    console.log(`  ${c.cyan}openclaw onboard${c.reset}              — Full guided setup (recommended)`);
    console.log(`  ${c.cyan}openclaw gateway --verbose${c.reset}    — Start the gateway`);
    if (telegramToken) {
      console.log(`  ${c.cyan}openclaw gateway${c.reset}              — Start and connect to Telegram`);
    }

    const startNow = await ask(rl, `\n  Start OpenClaw now? [y/N] `);
    if (/^y/i.test(startNow)) {
      console.log(`\n  ${c.dim}Starting openclaw onboard...${c.reset}\n`);
      try {
        execSync("openclaw onboard", { stdio: "inherit", cwd: workspaceDir });
      } catch {
        console.log(`\n  ${c.dim}You can start it manually: cd ${workspaceDir} && openclaw onboard${c.reset}`);
      }
    } else {
      console.log(`\n  ${c.dim}Run when ready: cd ${workspaceDir} && openclaw onboard${c.reset}`);
    }

    console.log();
  } finally {
    rl.close();
  }
}

function buildGatewayConfig(
  provider: string,
  model: string,
  _apiKey: string,
  telegramToken: string
): string {
  const lines: string[] = [];

  lines.push("# OpenClaw Gateway Configuration");
  lines.push("# Generated by notoken setup openclaw");
  lines.push(`# ${new Date().toISOString()}`);
  lines.push("");
  lines.push("gateway:");
  lines.push("  port: 18789");
  lines.push("  verbose: true");
  lines.push("");
  lines.push("models:");
  lines.push(`  default:`);

  if (provider === "anthropic") {
    lines.push(`    provider: anthropic`);
    lines.push(`    model: ${model}`);
    lines.push(`    # Key loaded from .env (ANTHROPIC_API_KEY)`);
  } else if (provider === "openai") {
    lines.push(`    provider: openai`);
    lines.push(`    model: ${model}`);
    lines.push(`    # Key loaded from .env (OPENAI_API_KEY)`);
  } else if (provider === "ollama") {
    lines.push(`    provider: ollama`);
    lines.push(`    model: ${model}`);
    lines.push(`    base_url: http://localhost:11434`);
  }

  if (telegramToken) {
    lines.push("");
    lines.push("channels:");
    lines.push("  telegram:");
    lines.push("    enabled: true");
    lines.push("    # Token loaded from .env (TELEGRAM_BOT_TOKEN)");
  }

  lines.push("");
  return lines.join("\n");
}

function buildEnvFile(provider: string, apiKey: string, telegramToken: string): string {
  const lines: string[] = [];

  lines.push("# OpenClaw secrets");
  lines.push("# Generated by notoken setup openclaw");
  lines.push(`# ${new Date().toISOString()}`);
  lines.push("");

  if (provider === "anthropic" && apiKey) {
    lines.push(`ANTHROPIC_API_KEY=${apiKey}`);
  } else if (provider === "openai" && apiKey) {
    lines.push(`OPENAI_API_KEY=${apiKey}`);
  }

  if (telegramToken) {
    lines.push(`TELEGRAM_BOT_TOKEN=${telegramToken}`);
  }

  lines.push("");
  return lines.join("\n");
}

async function ask(rl: readline.Interface, prompt: string): Promise<string> {
  return rl.question(prompt);
}

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 10_000 }).trim();
  } catch {
    return null;
  }
}
