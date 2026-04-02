/**
 * notoken install <tool>
 *
 * Installs CLI tools and services:
 *   notoken install claude      — Claude Code CLI
 *   notoken install convex      — Convex CLI
 *   notoken install openclaw    — OpenClaw CLI
 *   notoken install docker      — Docker Engine
 *   notoken install node        — Node.js (via nvm)
 *   notoken install <package>   — System package via apt/dnf/yum
 */

import { execSync } from "node:child_process";
import { withSpinner } from "@notoken/core";
import { detectLocalPlatform, getInstallCommand } from "@notoken/core";

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

interface ToolInstaller {
  name: string;
  check: string;
  install: string;
  postInstall?: string;
  description: string;
}

const TOOLS: Record<string, ToolInstaller> = {
  claude: {
    name: "Claude Code CLI",
    check: "claude --version",
    install: "npm install -g @anthropic-ai/claude-code",
    postInstall: "claude --version",
    description: "Anthropic's Claude Code CLI for AI-assisted development",
  },
  convex: {
    name: "Convex CLI",
    check: "npx convex --version",
    install: "npm install -g convex",
    postInstall: "npx convex --version",
    description: "Convex backend platform CLI",
  },
  openclaw: {
    name: "OpenClaw CLI",
    check: "openclaw --version",
    install: "npm install -g openclaw",
    description: "OpenClaw CLI tool",
  },
  docker: {
    name: "Docker Engine",
    check: "docker --version",
    install: "curl -fsSL https://get.docker.com | sh",
    postInstall: "sudo usermod -aG docker $USER && docker --version",
    description: "Container runtime",
  },
  node: {
    name: "Node.js (via nvm)",
    check: "node --version",
    install: "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash && export NVM_DIR=\"$HOME/.nvm\" && [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && nvm install --lts",
    description: "Node.js JavaScript runtime",
  },
  bun: {
    name: "Bun",
    check: "bun --version",
    install: "curl -fsSL https://bun.sh/install | bash",
    description: "Fast JavaScript runtime and toolkit",
  },
  ollama: {
    name: "Ollama",
    check: "ollama --version",
    install: "curl -fsSL https://ollama.com/install.sh | sh",
    postInstall: "ollama --version",
    description: "Local LLM runner — run AI models without cloud tokens",
  },
  certbot: {
    name: "Certbot (Let's Encrypt)",
    check: "certbot --version",
    install: "",  // filled dynamically per platform
    description: "Let's Encrypt SSL certificate manager",
  },
};

export async function runInstall(args: string[]): Promise<void> {
  const toolName = args[0];

  if (!toolName) {
    console.log(`${c.bold}notoken install${c.reset} <tool>\n`);
    console.log(`${c.bold}Available tools:${c.reset}`);
    for (const [key, tool] of Object.entries(TOOLS)) {
      const installed = isInstalled(tool.check);
      const icon = installed ? `${c.green}✓${c.reset}` : `${c.dim}○${c.reset}`;
      console.log(`  ${icon} ${c.cyan}${key.padEnd(12)}${c.reset} ${tool.description}`);
    }
    console.log(`\n  ${c.dim}Any other name installs as a system package (apt/dnf/yum).${c.reset}`);
    return;
  }

  const tool = TOOLS[toolName];

  if (tool) {
    await installTool(tool, toolName);
  } else {
    await installSystemPackage(toolName);
  }
}

async function installTool(tool: ToolInstaller, key: string): Promise<void> {
  // Check if already installed
  if (isInstalled(tool.check)) {
    const version = getVersion(tool.check);
    console.log(`${c.green}✓${c.reset} ${tool.name} is already installed${version ? ` (${version})` : ""}`);
    return;
  }

  console.log(`${c.bold}Installing ${tool.name}...${c.reset}`);
  console.log(`${c.dim}${tool.description}${c.reset}\n`);

  // For certbot, use platform-specific install
  let installCmd = tool.install;
  if (key === "certbot" && !installCmd) {
    const platform = detectLocalPlatform();
    installCmd = getInstallCommand("certbot", platform);
  }

  try {
    await withSpinner(`Installing ${tool.name}...`, async () => {
      execSync(installCmd, { stdio: "pipe", timeout: 300_000 });
      return "";
    });

    if (tool.postInstall) {
      const version = getVersion(tool.postInstall);
      console.log(`${c.green}✓${c.reset} ${tool.name} installed${version ? ` (${version})` : ""}`);
    } else {
      console.log(`${c.green}✓${c.reset} ${tool.name} installed`);
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}✗${c.reset} Failed to install ${tool.name}`);
    console.error(`${c.dim}${msg.split("\n").slice(0, 3).join("\n")}${c.reset}`);
    console.error(`\n${c.dim}Try manually: ${installCmd}${c.reset}`);
  }
}

async function installSystemPackage(pkg: string): Promise<void> {
  const platform = detectLocalPlatform();
  const installCmd = getInstallCommand(pkg, platform);

  console.log(`${c.bold}Installing system package: ${pkg}${c.reset}`);
  console.log(`${c.dim}Using ${platform.packageManager} on ${platform.distro}${c.reset}\n`);

  try {
    await withSpinner(`Installing ${pkg}...`, async () => {
      execSync(installCmd, { stdio: "pipe", timeout: 300_000 });
      return "";
    });
    console.log(`${c.green}✓${c.reset} ${pkg} installed`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}✗${c.reset} Failed to install ${pkg}`);
    console.error(`${c.dim}${msg.split("\n").slice(0, 3).join("\n")}${c.reset}`);
  }
}

function isInstalled(checkCmd: string): boolean {
  try {
    execSync(checkCmd, { stdio: "pipe", timeout: 10_000 });
    return true;
  } catch {
    return false;
  }
}

function getVersion(checkCmd: string): string | null {
  try {
    return execSync(checkCmd, { encoding: "utf-8", stdio: "pipe", timeout: 10_000 }).trim().split("\n")[0];
  } catch {
    return null;
  }
}
