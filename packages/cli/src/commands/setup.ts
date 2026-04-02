/**
 * notoken setup <environment>
 *
 * Set up development or server environments:
 *   notoken setup dev        — Install dev tools, configure git, create dirs
 *   notoken setup server     — Harden server, install essentials, configure firewall
 *   notoken setup docker     — Install Docker, docker-compose, configure
 *   notoken setup node       — Install Node.js, npm, common global tools
 *   notoken setup ssl <domain> — Set up Let's Encrypt SSL
 */

import { execSync } from "node:child_process";
import { withSpinner } from "notoken-core";
import { detectLocalPlatform, getInstallCommand } from "notoken-core";

const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

const SETUPS: Record<string, { description: string; steps: Array<{ label: string; cmd: string | (() => string) }> }> = {
  dev: {
    description: "Set up local development environment",
    steps: [
      { label: "Installing build essentials", cmd: () => {
        const p = detectLocalPlatform();
        if (p.packageManager === "apt") return "sudo apt-get update && sudo apt-get install -y build-essential git curl wget";
        if (p.packageManager === "dnf") return "sudo dnf groupinstall -y 'Development Tools' && sudo dnf install -y git curl wget";
        if (p.packageManager === "brew") return "xcode-select --install 2>/dev/null; brew install git curl wget";
        return "echo 'Install build tools manually'";
      }},
      { label: "Configuring git", cmd: "git config --global init.defaultBranch main && git config --global pull.rebase false" },
      { label: "Installing Node.js tools", cmd: "npm install -g tsx typescript" },
      { label: "Creating project dirs", cmd: "mkdir -p ~/projects ~/scripts" },
    ],
  },
  server: {
    description: "Basic server hardening and essentials",
    steps: [
      { label: "Updating packages", cmd: () => {
        const p = detectLocalPlatform();
        if (p.packageManager === "apt") return "sudo apt-get update && sudo apt-get upgrade -y";
        if (p.packageManager === "dnf") return "sudo dnf update -y";
        return "echo 'Update packages manually'";
      }},
      { label: "Installing essentials", cmd: () => {
        const p = detectLocalPlatform();
        return getInstallCommand("curl wget git htop unzip fail2ban ufw", p);
      }},
      { label: "Enabling firewall", cmd: "sudo ufw default deny incoming && sudo ufw default allow outgoing && sudo ufw allow ssh && sudo ufw --force enable && sudo ufw status" },
      { label: "Enabling fail2ban", cmd: "sudo systemctl enable fail2ban && sudo systemctl start fail2ban" },
      { label: "Disabling root SSH login", cmd: "sudo sed -i 's/^#*PermitRootLogin.*/PermitRootLogin no/' /etc/ssh/sshd_config && echo 'Root SSH login disabled'" },
    ],
  },
  docker: {
    description: "Install and configure Docker + Compose",
    steps: [
      { label: "Installing Docker", cmd: "curl -fsSL https://get.docker.com | sh" },
      { label: "Adding user to docker group", cmd: "sudo usermod -aG docker $USER" },
      { label: "Starting Docker", cmd: "sudo systemctl enable docker && sudo systemctl start docker" },
      { label: "Verifying", cmd: "docker --version && docker compose version" },
    ],
  },
  node: {
    description: "Install Node.js via nvm with common tools",
    steps: [
      { label: "Installing nvm", cmd: "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash" },
      { label: "Installing Node.js LTS", cmd: "export NVM_DIR=\"$HOME/.nvm\" && [ -s \"$NVM_DIR/nvm.sh\" ] && . \"$NVM_DIR/nvm.sh\" && nvm install --lts" },
      { label: "Installing global tools", cmd: "npm install -g tsx typescript pm2" },
    ],
  },
};

export async function runSetup(args: string[]): Promise<void> {
  const target = args[0];

  if (!target) {
    console.log(`${c.bold}notoken setup${c.reset} <environment>\n`);
    for (const [key, setup] of Object.entries(SETUPS)) {
      console.log(`  ${c.cyan}${key.padEnd(12)}${c.reset} ${setup.description}`);
    }
    return;
  }

  const setup = SETUPS[target];
  if (!setup) {
    console.error(`${c.red}Unknown setup target: ${target}${c.reset}`);
    console.log(`Available: ${Object.keys(SETUPS).join(", ")}`);
    return;
  }

  console.log(`${c.bold}notoken setup ${target}${c.reset} — ${setup.description}\n`);

  for (let i = 0; i < setup.steps.length; i++) {
    const step = setup.steps[i];
    const cmd = typeof step.cmd === "function" ? step.cmd() : step.cmd;
    const num = `[${i + 1}/${setup.steps.length}]`;

    try {
      await withSpinner(`${num} ${step.label}`, async () => {
        return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 300_000 });
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`  ${c.red}✗ ${msg.split("\n")[0]}${c.reset}`);
    }
  }

  console.log(`\n${c.green}✓${c.reset} Setup complete.`);
}
