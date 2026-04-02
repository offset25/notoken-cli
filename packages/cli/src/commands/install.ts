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
import { withSpinner } from "notoken-core";
import { detectLocalPlatform, getInstallCommand } from "notoken-core";

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

    // Verify it actually works
    if (isInstalled(tool.check)) {
      const version = getVersion(tool.postInstall ?? tool.check);
      console.log(`${c.green}✓${c.reset} ${tool.name} installed${version ? ` (${version})` : ""}`);
    } else {
      console.error(`${c.yellow}⚠${c.reset} Package installed but ${tool.name} binary not found.`);
      console.error(`${c.dim}The npm package may be a placeholder or the binary has a different name.${c.reset}`);
      console.error(`${c.dim}Run: notoken uninstall ${key}${c.reset}`);
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

function tryExec(cmd: string): string | null {
  try {
    return execSync(cmd, { encoding: "utf-8", stdio: ["pipe", "pipe", "pipe"], timeout: 15_000 }).trim() || null;
  } catch {
    return null;
  }
}

// ── Uninstall ──

const UNINSTALL_CMDS: Record<string, string> = {
  claude: "npm uninstall -g @anthropic-ai/claude-code",
  convex: "npm uninstall -g convex",
  openclaw: "npm uninstall -g openclaw",
  bun: "rm -rf ~/.bun",
  ollama: "sudo rm -f /usr/local/bin/ollama && sudo rm -rf /usr/share/ollama",
  certbot: "",  // platform-specific
  matrix: "__SPECIAL__",  // handled separately
};

export async function runUninstall(args: string[]): Promise<void> {
  const toolName = args[0];

  if (!toolName) {
    console.log(`${c.bold}notoken uninstall${c.reset} <tool>\n`);
    console.log(`${c.bold}Installed tools:${c.reset}`);
    for (const [key, tool] of Object.entries(TOOLS)) {
      if (isInstalled(tool.check)) {
        const version = getVersion(tool.check);
        console.log(`  ${c.green}✓${c.reset} ${c.cyan}${key.padEnd(12)}${c.reset} ${version ?? ""}`);
      }
    }
    // Also check npm globals that aren't in TOOLS
    try {
      const globals = execSync("npm list -g --depth=0 --json 2>/dev/null", { encoding: "utf-8", timeout: 10_000 });
      const parsed = JSON.parse(globals);
      const deps = Object.keys(parsed.dependencies ?? {}).filter((d) => d !== "notoken" && d !== "notoken-core");
      if (deps.length > 0) {
        console.log(`\n${c.bold}Other global npm packages:${c.reset}`);
        for (const dep of deps) {
          console.log(`  ${c.dim}○${c.reset} ${dep}`);
        }
      }
    } catch {}
    return;
  }

  // Matrix special uninstall
  if (toolName === "matrix") {
    await uninstallMatrix();
    return;
  }

  // Known tool uninstall
  const uninstallCmd = UNINSTALL_CMDS[toolName];
  if (uninstallCmd !== undefined && uninstallCmd !== "__SPECIAL__") {
    const tool = TOOLS[toolName];
    const name = tool?.name ?? toolName;

    if (tool && !isInstalled(tool.check)) {
      // Check if npm package exists even without binary
      try {
        execSync(`npm list -g ${toolName} 2>/dev/null`, { stdio: "pipe" });
      } catch {
        console.log(`${c.dim}${name} is not installed.${c.reset}`);
        return;
      }
    }

    console.log(`${c.bold}Uninstalling ${name}...${c.reset}`);

    let cmd = uninstallCmd;
    if (!cmd) {
      const platform = detectLocalPlatform();
      if (platform.packageManager === "apt") cmd = `sudo apt-get remove -y ${toolName}`;
      else if (platform.packageManager === "dnf") cmd = `sudo dnf remove -y ${toolName}`;
      else cmd = `npm uninstall -g ${toolName}`;
    }

    try {
      await withSpinner(`Uninstalling ${name}...`, async () => {
        execSync(cmd, { stdio: "pipe", timeout: 60_000 });
        return "";
      });
      console.log(`${c.green}✓${c.reset} ${name} uninstalled`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`${c.red}✗${c.reset} Failed: ${msg.split("\n")[0]}`);
    }
    return;
  }

  // Generic npm uninstall
  console.log(`${c.bold}Uninstalling ${toolName}...${c.reset}`);
  try {
    await withSpinner(`Uninstalling ${toolName}...`, async () => {
      execSync(`npm uninstall -g ${toolName}`, { stdio: "pipe", timeout: 60_000 });
      return "";
    });
    console.log(`${c.green}✓${c.reset} ${toolName} uninstalled`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`${c.red}✗${c.reset} Failed: ${msg.split("\n")[0]}`);
    console.error(`${c.dim}Try: npm uninstall -g ${toolName}${c.reset}`);
  }
}

// ── Matrix Uninstall ──

async function uninstallMatrix(): Promise<void> {
  const readline = await import("node:readline/promises");
  const { stdin: input, stdout: output } = await import("node:process");
  const rl = readline.createInterface({ input, output });

  console.log(`${c.bold}${c.red}Uninstall Matrix Server${c.reset}\n`);
  console.log(`  This will:`);
  console.log(`  - Stop and remove the Matrix Conduit Docker container`);
  console.log(`  - Remove the Docker volume (all Matrix data)`);
  console.log(`  - Remove nginx/Apache Matrix config`);
  console.log(`  - Remove OpenClaw Matrix channel`);
  console.log(`  - Remove Matrix config files\n`);

  try {
    const confirm = await rl.question(`  ${c.red}Are you sure?${c.reset} Type "yes" to confirm: `);
    if (confirm.trim().toLowerCase() !== "yes") {
      console.log("  Cancelled.");
      return;
    }

    // Stop and remove container
    const conduitDirs = ["/opt/matrix-conduit", `${process.env.HOME}/.notoken/matrix-conduit`];
    for (const dir of conduitDirs) {
      if (tryExec(`test -d "${dir}" && echo yes`)) {
        console.log(`  ${c.dim}Stopping container...${c.reset}`);
        tryExec(`cd "${dir}" && docker compose down -v 2>/dev/null`);
        tryExec(`docker rm -f matrix-conduit 2>/dev/null`);
        tryExec(`docker volume rm matrix-conduit_conduit-data 2>/dev/null`);
        console.log(`  ${c.green}✓${c.reset} Container removed`);

        // Remove config dir
        tryExec(`rm -rf "${dir}"`);
        console.log(`  ${c.green}✓${c.reset} Config removed: ${dir}`);
      }
    }

    // Remove nginx config
    for (const path of [
      "/etc/nginx/sites-available/matrix",
      "/etc/nginx/sites-enabled/matrix",
      "/etc/nginx/conf.d/matrix.conf",
    ]) {
      if (tryExec(`test -f "${path}" && echo yes`)) {
        tryExec(`rm -f "${path}"`);
        console.log(`  ${c.green}✓${c.reset} Removed ${path}`);
      }
    }
    tryExec("nginx -t 2>/dev/null && systemctl reload nginx 2>/dev/null");

    // Remove Apache config
    for (const path of [
      "/etc/apache2/sites-available/matrix.conf",
      "/etc/apache2/sites-enabled/matrix.conf",
      "/etc/httpd/conf.d/matrix.conf",
    ]) {
      if (tryExec(`test -f "${path}" && echo yes`)) {
        tryExec(`rm -f "${path}"`);
        console.log(`  ${c.green}✓${c.reset} Removed ${path}`);
      }
    }
    tryExec("a2dissite matrix 2>/dev/null");
    tryExec("apache2ctl configtest 2>/dev/null && systemctl reload apache2 2>/dev/null");

    // Remove OpenClaw channel
    tryExec("openclaw channels remove --channel matrix --account default --force 2>/dev/null");
    console.log(`  ${c.green}✓${c.reset} OpenClaw Matrix channel removed`);

    console.log(`\n  ${c.green}Matrix server fully uninstalled.${c.reset}`);
  } finally {
    rl.close();
  }
}

// ── Integration Doctor ──

export async function runCheckIntegration(): Promise<void> {
  console.log(`\n${c.bold}${c.cyan}  Integration Check${c.reset}\n`);

  let channelList: string | null = null;

  // OpenClaw
  section("OpenClaw");
  const clawVersion = getVersion("openclaw --version");
  if (clawVersion) {
    ok(`Installed: ${clawVersion}`);

    // Config
    const configFile = tryExec("openclaw config file");
    if (configFile && tryExec(`test -f "${configFile}" && echo yes`)) {
      ok(`Config: ${configFile}`);
    } else {
      missing("No config — run: notoken setup openclaw");
    }

    // Gateway
    const gwMode = tryExec("openclaw config get gateway.mode 2>/dev/null");
    if (gwMode && !gwMode.includes("unset")) {
      ok(`Gateway mode: ${gwMode}`);
    } else {
      missing("Gateway mode not set — run: openclaw config set gateway.mode local");
    }

    // Model
    const model = tryExec("openclaw config get models.default.provider 2>/dev/null");
    if (model && !model.includes("unset")) {
      ok(`AI provider: ${model}`);
    } else {
      missing("No AI model configured — run: notoken setup openclaw");
    }

    // Channels
    channelList = tryExec("openclaw channels list 2>/dev/null");
    if (channelList) {
      const hasMatrix = channelList.includes("Matrix") || channelList.includes("matrix");
      const hasTelegram = channelList.includes("Telegram") || channelList.includes("telegram");
      const hasDiscord = channelList.includes("Discord") || channelList.includes("discord");

      if (hasMatrix) ok("Channel: Matrix connected");
      if (hasTelegram) ok("Channel: Telegram connected");
      if (hasDiscord) ok("Channel: Discord connected");
      if (!hasMatrix && !hasTelegram && !hasDiscord) {
        missing("No channels configured — run: notoken setup openclaw");
      }
    }

    // Gateway daemon
    const daemon = tryExec("systemctl --user is-active openclaw-gateway 2>/dev/null");
    if (daemon === "active") {
      ok("Gateway daemon: running");
    } else {
      hint("Gateway daemon not running — start: openclaw gateway --verbose");
    }
  } else {
    missing("OpenClaw not installed — run: notoken install openclaw");
  }

  // Matrix
  section("Matrix Server");
  const conduitRunning = tryExec("docker ps --format '{{.Names}}' 2>/dev/null | grep conduit");
  if (conduitRunning) {
    ok("Conduit container running");

    const health = tryExec("curl -sf http://127.0.0.1:8448/_matrix/client/versions 2>/dev/null");
    if (health) {
      ok("Matrix API responding");

      // Check if Matrix is paired with OpenClaw
      if (channelList?.includes("matrix")) {
        ok("OpenClaw ↔ Matrix paired");
      } else {
        missing("Matrix not connected to OpenClaw");
        hint("Run: notoken setup openclaw → choose Matrix");
        // Try to auto-pair
        console.log(`\n  ${c.bold}Attempt auto-pair?${c.reset}`);
        const readline = await import("node:readline/promises");
        const { stdin: input, stdout: output } = await import("node:process");
        const rl = readline.createInterface({ input, output });
        try {
          const doPair = await rl.question(`  Try to pair Matrix with OpenClaw? [Y/n] `);
          if (!/^n/i.test(doPair)) {
            // Register bot if not exists, then connect
            const botPass = "openclaw-" + Math.random().toString(36).slice(2, 14);
            const regResult = tryExec(`curl -sf -X POST http://127.0.0.1:8448/_matrix/client/r0/register -H 'Content-Type: application/json' -d '{"username":"openclaw-bot","password":"${botPass}","auth":{"type":"m.login.dummy"}}'`);
            let userId: string | undefined;
            let accessToken: string | undefined;

            if (regResult) {
              const data = JSON.parse(regResult);
              userId = data.user_id;
              accessToken = data.access_token;
            } else {
              // Try login
              const loginResult = tryExec(`curl -sf -X POST http://127.0.0.1:8448/_matrix/client/r0/login -H 'Content-Type: application/json' -d '{"type":"m.login.password","identifier":{"type":"m.id.user","user":"openclaw-bot"},"password":"${botPass}"}'`);
              if (loginResult) {
                const data = JSON.parse(loginResult);
                userId = data.user_id;
                accessToken = data.access_token;
              }
            }

            if (userId && accessToken) {
              tryExec(`openclaw channels add --channel matrix --homeserver http://127.0.0.1:8448 --user-id '${userId}' --access-token '${accessToken}' --device-name 'OpenClaw Bot' 2>/dev/null`);
              ok(`Paired: ${userId} ↔ OpenClaw`);
            } else {
              missing("Could not register/login bot. Manual pairing needed.");
            }
          }
        } finally {
          rl.close();
        }
      }
    } else {
      broken("Conduit running but API not responding");
      hint("Check: docker logs matrix-conduit");
    }
  } else {
    hint("Matrix server not running (optional)");
    hint("Set up with: notoken setup openclaw → choose Matrix");
  }

  // Claude CLI
  section("Claude CLI");
  const claudeVer = getVersion("claude --version");
  if (claudeVer) {
    ok(`Installed: ${claudeVer}`);
  } else {
    hint("Not installed — run: notoken install claude");
  }

  // Ollama
  section("Ollama");
  const ollamaVer = getVersion("ollama --version");
  if (ollamaVer) {
    ok(`Installed: ${ollamaVer}`);
    const running = tryExec("curl -sf http://localhost:11434/api/tags");
    if (running) {
      ok("Server running");
      try {
        const models = JSON.parse(running);
        const names = (models.models ?? []).map((m: Record<string, string>) => m.name);
        if (names.length > 0) ok(`Models: ${names.join(", ")}`);
        else missing("No models — run: ollama pull llama3.2");
      } catch {}
    } else {
      missing("Server not running — run: ollama serve");
    }
  } else {
    hint("Not installed — run: notoken install ollama");
  }

  console.log();

}

function section(name: string): void {
  console.log(`  ${c.bold}${name}:${c.reset}`);
}

function ok(msg: string): void {
  console.log(`  ${c.green}✓${c.reset} ${msg}`);
}

function missing(msg: string): void {
  console.log(`  ${c.red}✗${c.reset} ${msg}`);
}

function broken(msg: string): void {
  console.log(`  ${c.red}✗${c.reset} ${c.red}${msg}${c.reset}`);
}

function hint(msg: string): void {
  console.log(`  ${c.dim}○ ${msg}${c.reset}`);
}
