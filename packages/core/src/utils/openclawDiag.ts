/**
 * OpenClaw advanced diagnostics.
 *
 * Runs a multi-step check:
 *   1. Is the gateway process running?
 *   2. Is the HTTP health endpoint responding?
 *   3. Can we reach the WebSocket gateway?
 *   4. What channels are configured (Telegram, Discord, Matrix)?
 *   5. Are channels connected and healthy?
 *   6. What's the config state?
 *   7. Any errors in recent logs?
 */

import { exec } from "node:child_process";
import { promisify } from "node:util";
import { discoverInstallations } from "./entityResolver.js";

const execAsync = promisify(exec);

const c = {
  reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m",
  green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m",
};

interface DiagStep {
  name: string;
  status: "pass" | "warn" | "fail" | "skip";
  detail: string;
}

/** Extract the text reply from openclaw agent JSON output. */
function extractAgentReply(output: string): string | null {
  try {
    // Output may have log lines before JSON — find the JSON
    const jsonStart = output.indexOf("{");
    if (jsonStart < 0) return null;
    const json = JSON.parse(output.substring(jsonStart));
    // openclaw agent --json returns: { result: { payloads: [{ text: "..." }] } }
    const text = json?.result?.payloads?.[0]?.text
      ?? json?.reply
      ?? json?.text
      ?? json?.content;
    return text || null;
  } catch {
    return null;
  }
}

const isWin = process.platform === "win32";
const userHome = process.env.HOME ?? process.env.USERPROFILE ?? (isWin ? "C:\\Users\\Default" : "/root");

async function runCmd(cmd: string, timeout = 15_000): Promise<string> {
  try {
    const shell = isWin ? "bash" : undefined;
    const { stdout, stderr } = await execAsync(cmd, { timeout, shell });
    return (stdout + stderr).trim();
  } catch (err) {
    return (err as any)?.stdout?.trim() ?? (err as Error).message.split("\n")[0];
  }
}

/** Cross-platform: check if a command exists */
async function cmdExists(run: (cmd: string) => Promise<string>, cmd: string): Promise<string> {
  if (isWin) {
    const out = await run(`command -v ${cmd} 2>/dev/null || where ${cmd} 2>/dev/null`);
    return out && !out.includes("not found") && !out.includes("Could not find") ? out.trim() : "";
  }
  const out = await run(`which ${cmd} 2>/dev/null`);
  return out && out.includes(cmd) ? out.trim() : "";
}

/** Cross-platform: check if openclaw gateway process is running */
async function isGatewayRunning(run: (cmd: string) => Promise<string>): Promise<{ running: boolean; pid: string }> {
  if (isWin) {
    // Use WMI — Get-Process doesn't populate CommandLine on older Windows (Server 2016)
    const wmiOut = await run(`powershell -Command "Get-WmiObject Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { \\$_.CommandLine -match 'openclaw.*gateway' } | Select-Object -First 1 ProcessId" 2>/dev/null`);
    if (wmiOut && /\d+/.test(wmiOut)) {
      const pid = wmiOut.match(/(\d+)/)?.[1] ?? "?";
      return { running: true, pid };
    }
    // Fallback: check if health endpoint responds (gateway running but can't find process)
    const healthCheck = await run("curl -sf http://127.0.0.1:18789/health 2>/dev/null");
    if (healthCheck && healthCheck.includes('"ok"')) {
      return { running: true, pid: "?" };
    }
    return { running: false, pid: "" };
  }
  const psOut = await run("ps aux | grep openclaw-gateway | grep -v grep | head -1");
  if (psOut && psOut.includes("openclaw")) {
    const pidMatch = psOut.match(/\S+\s+(\d+)/);
    return { running: true, pid: pidMatch?.[1] ?? "?" };
  }
  return { running: false, pid: "" };
}

/** Cross-platform: nvm prefix for running openclaw with Node 22 */
function getNvmPrefix(): string {
  if (isWin) {
    // On Windows with bash (Git Bash/MSYS), nvm might be nvm-windows which doesn't need sourcing
    // Just try to use node directly — if Node 22 was installed it should be on PATH
    return "";
  }
  return `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done 2>/dev/null; nvm use 22 > /dev/null 2>&1;`;
}

/** Cross-platform: wrap an openclaw CLI command with the right Node version */
function wrapOcCmd(cmd: string, nvmPrefix: string): string {
  if (isWin) {
    // On Windows, just run directly — Node version managers update PATH globally
    return `${cmd} 2>&1`;
  }
  return `bash -c '${nvmPrefix} ${cmd} 2>&1'`;
}

/** Cross-platform: get Claude credentials path */
function getClaudeCredsPath(): string {
  return `${userHome}${isWin ? "\\" : "/"}.claude${isWin ? "\\" : "/"}.credentials.json`;
}

/** Cross-platform: get openclaw config base path */
function getOpenclawHome(): string {
  return `${userHome}${isWin ? "\\" : "/"}.openclaw`;
}

/**
 * Quick connectivity check — escalates from simplest to most thorough.
 * Used for "can you talk to openclaw?" / "is openclaw reachable?"
 *
 * Steps:
 *   1. Is the process alive? (ps aux — instant)
 *   2. Does the health endpoint respond? (curl — fast)
 *   3. Can the CLI communicate? (openclaw health — slower)
 *
 * Stops at the first failure and reports what's wrong.
 */
export async function quickConnectivityCheck(runRemote?: (cmd: string) => Promise<string>): Promise<string> {
  const run = runRemote ?? ((cmd: string) => runCmd(cmd));
  const lines: string[] = [];

  lines.push(`\n${c.bold}${c.cyan}── OpenClaw Connectivity Check ──${c.reset}\n`);

  // Auto-discover and register all OpenClaw installations as entities
  try { await discoverInstallations("openclaw"); } catch { /* non-critical */ }

  // Detect environment
  let hostGatewayRunning = false;

  if (isWin) {
    lines.push(`  ${c.dim}Environment: Windows${c.reset}`);
  } else {
    const wslCheck = await run("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native");
    const inWSL = wslCheck.trim() === "wsl";

    if (inWSL) {
      lines.push(`  ${c.dim}Environment: WSL${c.reset}`);

      // Check for OpenClaw on Windows host — use PowerShell to get command lines (tasklist doesn't show script args)
      const hostPs = await run("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command \"Get-WmiObject Win32_Process -Filter \\\"Name='node.exe'\\\" | Select -Exp CommandLine\" 2>/dev/null");
      const hostHasOpenclaw = hostPs.includes("openclaw");
      const hostNodeCheck = await run("cmd.exe /c 'where openclaw' 2>/dev/null");
      const hostInstalled = hostNodeCheck.includes("openclaw");

      if (hostHasOpenclaw) {
        lines.push(`  ${c.green}✓${c.reset} OpenClaw detected on ${c.bold}Windows host${c.reset}`);
        // Check if it's a gateway process
        if (hostPs.includes("gateway")) {
          hostGatewayRunning = true;
          lines.push(`  ${c.green}✓${c.reset} Windows gateway is running on port 18789`);
          const hostHealth = await run("curl -sf http://127.0.0.1:18789/health 2>/dev/null");
          if (hostHealth.includes('"ok"')) {
            lines.push(`  ${c.green}✓${c.reset} Windows gateway health: OK`);
          } else {
            lines.push(`  ${c.yellow}⚠${c.reset} Windows gateway running but health check failed`);
          }
          const winConfig = await run("cmd.exe /c 'type \"%USERPROFILE%\\.openclaw\\openclaw.json\"' 2>/dev/null");
          const winModelMatch = winConfig.match(/"primary"\s*:\s*"([^"]+)"/);
          if (winModelMatch) {
            lines.push(`  ${c.dim}  Windows model: ${winModelMatch[1]}${c.reset}`);
          }
        }
      } else if (hostInstalled) {
        lines.push(`  ${c.yellow}○${c.reset} OpenClaw installed on Windows host but ${c.bold}not running${c.reset}`);
      }
    }
  }

  // Step 1: Is process running?
  console.error(`${c.dim}Checking if openclaw is running...${c.reset}`);
  const gwStatus = await isGatewayRunning(run);

  // If Windows host gateway is already running, don't try to start another one in WSL
  if (hostGatewayRunning && !gwStatus.running) {
    lines.push(`\n  ${c.green}✓${c.reset} Using Windows host gateway (WSL gateway not needed — same port 18789)`);
    const nvmPrefix = getNvmPrefix();

    // Test if WSL CLI can talk to Windows gateway
    console.error(`${c.dim}Testing WSL CLI → Windows gateway...${c.reset}`);
    const cliOut = await run(wrapOcCmd("openclaw health 2>&1 | head -5", nvmPrefix));
    if (cliOut.includes("Agents:") || cliOut.includes("Heartbeat") || cliOut.includes("Session store")) {
      lines.push(`  ${c.green}✓${c.reset} WSL CLI can communicate with Windows gateway`);
    } else {
      lines.push(`  ${c.yellow}⚠${c.reset} WSL CLI cannot reach Windows gateway — may need matching config`);
      lines.push(`  ${c.dim}  WSL config: ~/.openclaw/openclaw.json${c.reset}`);
      lines.push(`  ${c.dim}  Windows config: %USERPROFILE%\\.openclaw\\openclaw.json${c.reset}`);
    }

    await auditOpenclawComponents(run, nvmPrefix, lines);
    return lines.join("\n");
  }

  if (!gwStatus.running) {
    lines.push(`  ${c.yellow}✗${c.reset} Gateway is not running. ${c.bold}Starting now...${c.reset}`);

    // Check Node version — openclaw needs 22+
    const nodeOk = await ensureNodeVersion(run, lines);
    if (!nodeOk) {
      return lines.join("\n");
    }

    // Start the gateway with the right Node
    console.error(`${c.dim}→ Starting openclaw gateway...${c.reset}`);
    const startCmd = await buildStartCommand(run);
    const startOut = await run(`${startCmd} sleep 8 && curl -sf http://127.0.0.1:18789/health 2>/dev/null || echo STARTING`);

    if (startOut.includes('"ok":true') || startOut.includes('"status"')) {
      lines.push(`  ${c.green}✓${c.reset} ${c.bold}Gateway started successfully.${c.reset}`);
    } else if (startOut.includes("STARTING")) {
      lines.push(`  ${c.yellow}⚠${c.reset} Gateway starting... may take a few more seconds.`);
      // Try one more time after a brief wait
      const retryOut = await run("sleep 3 && curl -sf http://127.0.0.1:18789/health 2>/dev/null || echo FAIL");
      if (retryOut.includes('"ok"')) {
        lines.push(`  ${c.green}✓${c.reset} ${c.bold}Gateway is now running.${c.reset}`);
      } else {
        lines.push(`  ${c.dim}Still starting — check: openclaw health${c.reset}`);
      }
    } else {
      lines.push(`  ${c.red}✗${c.reset} Failed to start gateway.`);
      lines.push(`  ${c.dim}Try manually: openclaw gateway --force${c.reset}`);
      return lines.join("\n");
    }
  }

  lines.push(`  ${c.green}✓${c.reset} Gateway process running ${c.dim}(PID ${gwStatus.pid})${c.reset}`);

  // Step 2: Health endpoint
  console.error(`${c.dim}Checking health endpoint...${c.reset}`);
  const healthOut = await run("curl -sf http://127.0.0.1:18789/health 2>/dev/null || echo FAIL");
  if (healthOut === "FAIL" || !healthOut.includes('"ok"')) {
    lines.push(`  ${c.red}✗${c.reset} ${c.bold}Health endpoint not responding.${c.reset}`);
    lines.push(`  ${c.dim}Process is running but HTTP port 18789 isn't accepting connections.${c.reset}`);
    lines.push(`\n  ${c.bold}Try:${c.reset} ${c.cyan}restart openclaw${c.reset}`);
    return lines.join("\n");
  }

  lines.push(`  ${c.green}✓${c.reset} Health endpoint OK ${c.dim}(http://127.0.0.1:18789)${c.reset}`);

  // Step 3: CLI communication (use nvm if needed for correct Node)
  console.error(`${c.dim}Testing CLI communication...${c.reset}`);
  const nvmPrefix = getNvmPrefix();
  const cliOut = await run(wrapOcCmd("openclaw health 2>&1 | head -5", nvmPrefix));

  if (cliOut.includes("Agents:") || cliOut.includes("Heartbeat") || cliOut.includes("Session store")) {
    lines.push(`  ${c.green}✓${c.reset} CLI can communicate with gateway`);

    const agentMatch = cliOut.match(/Agents:\s*(.+)/);
    const heartbeatMatch = cliOut.match(/Heartbeat interval:\s*(.+)/);
    const sessionMatch = cliOut.match(/- (.+ago)/);
    if (agentMatch) lines.push(`  ${c.dim}  Agent: ${agentMatch[1]}${c.reset}`);
    if (heartbeatMatch) lines.push(`  ${c.dim}  Heartbeat: ${heartbeatMatch[1]}${c.reset}`);
    if (sessionMatch) lines.push(`  ${c.dim}  Last session: ${sessionMatch[1]}${c.reset}`);

    // Step 4: Try to actually send a message to the agent
    console.error(`${c.dim}Sending test message to agent...${c.reset}`);
    const agentOut = await run(wrapOcCmd(`${isWin ? "" : "timeout 30 "}openclaw agent --agent main --message "hi" --json`, nvmPrefix));

    const agentReply = extractAgentReply(agentOut);
    if (agentReply) {
      lines.push(`  ${c.green}✓${c.reset} Agent responded!`);
      lines.push(`  ${c.bold}  OpenClaw says:${c.reset} ${agentReply}`);
    } else if (agentOut.includes("No API key") || agentOut.includes("auth") || !agentReply) {
      // Agent didn't respond — likely missing LLM auth. Try to auto-configure.
      // Try to auto-detect API keys from environment
      const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
      const hasOpenAIKey = !!process.env.OPENAI_API_KEY;

      // Try to auto-configure auth — escalating methods:
      // 1. Claude CLI OAuth token sync (frictionless — uses existing login)
      // 2. Environment variables (ANTHROPIC_API_KEY / OPENAI_API_KEY)
      // 3. Suggest manual setup

      let authFixed = false;

      // Method 1: Read Claude Code's OAuth token directly from ~/.claude/.credentials.json
      const claudeCredsPath = getClaudeCredsPath();
      let claudeToken: string | null = null;
      try {
        const { readFileSync: readFS, existsSync: existsFS } = await import("node:fs");
        if (existsFS(claudeCredsPath)) {
          const creds = JSON.parse(readFS(claudeCredsPath, "utf-8"));
          claudeToken = creds?.claudeAiOauth?.accessToken ?? null;
        }
      } catch {}

      if (claudeToken) {
        lines.push(`  ${c.cyan}Found Claude Code OAuth token — configuring openclaw...${c.reset}`);

        // Write directly into openclaw's auth-profiles.json
        const authProfilePath = `${getOpenclawHome()}${isWin ? "\\" : "/"}agents${isWin ? "\\" : "/"}main${isWin ? "\\" : "/"}agent${isWin ? "\\" : "/"}auth-profiles.json`;
        try {
          const { readFileSync: readFS, writeFileSync: writeFS, existsSync: existsFS, mkdirSync: mkdirFS } = await import("node:fs");
          const { dirname: dirnameFS } = await import("node:path");

          let profiles: any = { version: 1, profiles: {} };
          if (existsFS(authProfilePath)) {
            profiles = JSON.parse(readFS(authProfilePath, "utf-8"));
          } else {
            mkdirFS(dirnameFS(authProfilePath), { recursive: true });
          }

          // Add/update the anthropic profile with the Claude Code OAuth token
          profiles.profiles["anthropic:claude-oauth"] = {
            type: "oauth",
            provider: "anthropic",
            access: claudeToken,
            expires: Date.now() + 86400000, // 24h — token will be refreshed by Claude
          };

          writeFS(authProfilePath, JSON.stringify(profiles, null, 2));
          lines.push(`  ${c.green}✓${c.reset} Claude OAuth token injected into openclaw auth`);

          // Reload secrets so the gateway picks up the new token
          await run(wrapOcCmd("openclaw secrets reload 2>&1 || true", nvmPrefix));
          authFixed = true;
        } catch (e) {
          lines.push(`  ${c.yellow}⚠${c.reset} Could not write auth profile: ${(e as Error).message?.split("\n")[0]}`);
        }
      }

      // Method 1b: Try openclaw's built-in setup-token sync as fallback
      if (!authFixed) {
        const claudeInstalled = await cmdExists(run, "claude");
        if (claudeInstalled) {
          lines.push(`  ${c.cyan}Trying Claude CLI token sync...${c.reset}`);
          const syncOut = await run(wrapOcCmd("openclaw models auth setup-token --provider anthropic --yes", nvmPrefix));
          if (!syncOut.includes("error") && !syncOut.includes("Error")) {
            lines.push(`  ${c.green}✓${c.reset} Claude token synced`);
            authFixed = true;
          }
        }
      }

      // Method 2: Environment API keys
      if (!authFixed) {
        const hasAnthropicKey = !!process.env.ANTHROPIC_API_KEY;
        const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
        if (hasAnthropicKey || hasOpenAIKey) {
          const provider = hasAnthropicKey ? "anthropic" : "openai";
          const key = hasAnthropicKey ? process.env.ANTHROPIC_API_KEY : process.env.OPENAI_API_KEY;
          lines.push(`  ${c.cyan}Found ${provider.toUpperCase()} key — configuring...${c.reset}`);
          const pasteOut = await run(wrapOcCmd(`openclaw models auth paste-token --provider ${provider} <<< "${key}"`, nvmPrefix));
          if (!pasteOut.includes("error")) {
            lines.push(`  ${c.green}✓${c.reset} API key configured`);
            authFixed = true;
          }
        }
      }

      // Method 3: Check if Codex CLI is available (OpenAI Codex OAuth)
      if (!authFixed) {
        const codexCheck = await cmdExists(run, "codex");
        if (codexCheck) {
          lines.push(`  ${c.cyan}Found Codex CLI — syncing OAuth token...${c.reset}`);
          const syncOut = await run(wrapOcCmd("openclaw models auth setup-token --provider openai-codex --yes", nvmPrefix));
          if (!syncOut.includes("error") && !syncOut.includes("Error")) {
            lines.push(`  ${c.green}✓${c.reset} Codex OAuth token synced to openclaw`);
            authFixed = true;
          }
        }
      }

      // Retry the message if auth was fixed
      if (authFixed) {
        console.error(`${c.dim}Retrying message to agent...${c.reset}`);
        const retryOut = await run(wrapOcCmd(`${isWin ? "" : "timeout 30 "}openclaw agent --agent main --message "hi" --json`, nvmPrefix));
        const retryReply = extractAgentReply(retryOut);
        if (retryReply) {
          lines.push(`  ${c.green}✓${c.reset} Agent responded!`);
          lines.push(`  ${c.bold}  OpenClaw says:${c.reset} ${retryReply}`);
        } else if (retryOut.includes("No API key") || retryOut.includes("auth")) {
          lines.push(`  ${c.yellow}⚠${c.reset} Auth configured but agent still needs setup`);
          lines.push(`  ${c.dim}  Run: openclaw configure --section model${c.reset}`);
        } else {
          lines.push(`  ${c.yellow}⚠${c.reset} Agent didn't reply — may need gateway restart`);
          lines.push(`  ${c.dim}  Try: restart openclaw${c.reset}`);
        }
      } else {
        lines.push(`  ${c.yellow}⚠${c.reset} No API key found — need Claude CLI or ANTHROPIC_API_KEY`);
        lines.push(`  ${c.dim}  Install Claude: npm install -g @anthropic-ai/claude-code${c.reset}`);
        lines.push(`  ${c.dim}  Then: claude login${c.reset}`);
        lines.push(`  ${c.dim}  notoken will sync the token to openclaw automatically.${c.reset}`);
      }
    } else if (agentOut.includes("pairing required")) {
      lines.push(`  ${c.yellow}⚠${c.reset} Gateway needs pairing`);
      lines.push(`  ${c.dim}  Run: openclaw setup${c.reset}`);
    } else {
      lines.push(`  ${c.yellow}⚠${c.reset} Agent didn't respond: ${c.dim}${agentOut.split("\n")[0].substring(0, 60)}${c.reset}`);
    }

    lines.push(`\n  ${c.green}${c.bold}✓ OpenClaw gateway is running and reachable.${c.reset}`);
    lines.push(`  ${c.dim}Dashboard: http://127.0.0.1:18789/${c.reset}`);
    lines.push(`  ${c.dim}TUI: openclaw tui${c.reset}`);
  } else if (cliOut.includes("error") || cliOut.includes("failed")) {
    lines.push(`  ${c.yellow}⚠${c.reset} CLI returned errors: ${c.dim}${cliOut.split("\n")[0]}${c.reset}`);
    lines.push(`\n  ${c.bold}Try:${c.reset} ${c.cyan}diagnose openclaw${c.reset} ${c.dim}for full diagnostics${c.reset}`);
  } else {
    lines.push(`  ${c.green}✓${c.reset} CLI responded ${c.dim}(${cliOut.split("\n")[0].substring(0, 60)})${c.reset}`);
    lines.push(`\n  ${c.green}${c.bold}✓ OpenClaw is running and reachable.${c.reset}`);
  }

  // ── Component audit — what's available for openclaw ──
  await auditOpenclawComponents(run, nvmPrefix, lines);

  return lines.join("\n");
}

/**
 * Audit all optional components that openclaw can use.
 * Reports what's detected, what's optional, and what's needed.
 */
async function auditOpenclawComponents(
  run: (cmd: string) => Promise<string>,
  nvmPrefix: string,
  lines: string[],
): Promise<void> {
  lines.push(`\n${c.bold}${c.cyan}── OpenClaw Components ──${c.reset}`);
  lines.push(`${c.dim}  Each is optional — need at least one LLM or one channel.${c.reset}\n`);

  let hasLLM = false;
  let hasChannel = false;

  // ── LLM / AI Providers ──
  lines.push(`  ${c.bold}LLM Providers:${c.reset}`);

  // Claude CLI
  const claudeVer = await run("claude --version 2>/dev/null | head -1");
  if (claudeVer && !claudeVer.includes("not found")) {
    lines.push(`  ${c.green}✓${c.reset} Claude Code: ${c.dim}${claudeVer.trim()}${c.reset}`);

    // Check OAuth token
    const claudeCredsPath = getClaudeCredsPath();
    try {
      const { existsSync: ef, readFileSync: rf } = await import("node:fs");
      if (ef(claudeCredsPath)) {
        const creds = JSON.parse(rf(claudeCredsPath, "utf-8"));
        if (creds?.claudeAiOauth?.accessToken) {
          lines.push(`    ${c.green}✓${c.reset} OAuth token present`);
          hasLLM = true;
        }
      }
    } catch {}
    if (!hasLLM) {
      lines.push(`    ${c.yellow}○${c.reset} Not logged in — run: ${c.cyan}claude login${c.reset}`);
    }
  } else {
    lines.push(`  ${c.dim}○${c.reset} Claude Code: not installed ${c.dim}(optional — npm install -g @anthropic-ai/claude-code)${c.reset}`);
  }

  // ANTHROPIC_API_KEY
  if (process.env.ANTHROPIC_API_KEY) {
    lines.push(`  ${c.green}✓${c.reset} ANTHROPIC_API_KEY: set in environment`);
    hasLLM = true;
  }

  // OPENAI_API_KEY
  if (process.env.OPENAI_API_KEY) {
    lines.push(`  ${c.green}✓${c.reset} OPENAI_API_KEY: set in environment`);
    hasLLM = true;
  }

  // Codex CLI (OpenAI Codex)
  const codexCheck = await cmdExists(run, "codex");
  if (codexCheck) {
    const codexVer = await run("codex --version 2>/dev/null | head -1");
    lines.push(`  ${c.green}✓${c.reset} Codex CLI: ${codexVer?.trim() ?? "installed"}`);
    // Check if openai-codex auth is in openclaw
    const authCheck = await run(wrapOcCmd("openclaw models status", nvmPrefix));
    if (authCheck.includes("openai-codex")) {
      lines.push(`    ${c.green}✓${c.reset} OAuth synced to openclaw`);
      hasLLM = true;
    } else {
      lines.push(`    ${c.yellow}○${c.reset} Not synced — run: ${c.cyan}openclaw models auth setup-token --provider openai-codex${c.reset}`);
    }
  } else {
    lines.push(`  ${c.dim}○${c.reset} Codex CLI: not installed ${c.dim}(optional — npm install -g @openai/codex)${c.reset}`);
  }

  // Ollama (local LLM)
  const ollamaVer = await run("ollama --version 2>/dev/null | head -1");
  if (ollamaVer && !ollamaVer.includes("not found")) {
    const ollamaRunning = await run("curl -sf http://localhost:11434/api/tags 2>/dev/null | head -1");
    if (ollamaRunning && ollamaRunning.includes("models")) {
      lines.push(`  ${c.green}✓${c.reset} Ollama: running (local LLM — no API key needed)`);
      hasLLM = true;
    } else {
      lines.push(`  ${c.yellow}○${c.reset} Ollama: installed but not running — ${c.cyan}ollama serve${c.reset}`);
    }
  } else {
    lines.push(`  ${c.dim}○${c.reset} Ollama: not installed ${c.dim}(optional — local LLM, no tokens needed)${c.reset}`);
  }

  // ── Chat Channels ──
  lines.push(`\n  ${c.bold}Chat Channels:${c.reset}`);

  // TUI (terminal — always available if gateway is running)
  const gwUp = await run("curl -sf http://127.0.0.1:18789/health 2>/dev/null || echo FAIL");
  if (gwUp.includes('"ok"')) {
    lines.push(`  ${c.green}✓${c.reset} Terminal (TUI): available — ${c.cyan}openclaw tui${c.reset}`);
    lines.push(`    ${c.green}✓${c.reset} notoken can talk to it: ${c.cyan}tell openclaw <message>${c.reset}`);
    hasChannel = true;
  } else {
    lines.push(`  ${c.yellow}○${c.reset} Terminal (TUI): gateway not running`);
  }

  const channelsOut = await run(wrapOcCmd("openclaw channels list", nvmPrefix));

  // Telegram
  if (channelsOut.toLowerCase().includes("telegram")) {
    const configured = channelsOut.toLowerCase().includes("telegram") && channelsOut.includes("configured");
    lines.push(`  ${configured ? `${c.green}✓` : `${c.yellow}○`}${c.reset} Telegram: ${configured ? "configured" : "detected but not configured"}`);
    if (configured) hasChannel = true;
  } else {
    lines.push(`  ${c.dim}○${c.reset} Telegram: not configured ${c.dim}(optional — openclaw configure --section channels)${c.reset}`);
  }

  // Discord
  if (channelsOut.toLowerCase().includes("discord")) {
    const configured = channelsOut.includes("configured");
    lines.push(`  ${configured ? `${c.green}✓` : `${c.yellow}○`}${c.reset} Discord: ${configured ? "configured" : "detected but not configured"}`);
    if (configured) hasChannel = true;
  } else {
    lines.push(`  ${c.dim}○${c.reset} Discord: not configured ${c.dim}(optional)${c.reset}`);
  }

  // Matrix
  if (channelsOut.toLowerCase().includes("matrix")) {
    const errored = channelsOut.includes("failed") || channelsOut.includes("Blocked");
    const configured = channelsOut.includes("configured");
    if (configured && !errored) {
      lines.push(`  ${c.green}✓${c.reset} Matrix: configured and running`);
      hasChannel = true;
    } else if (configured) {
      lines.push(`  ${c.yellow}⚠${c.reset} Matrix: configured but has errors — run: ${c.cyan}openclaw doctor --fix${c.reset}`);
    }
  } else {
    lines.push(`  ${c.dim}○${c.reset} Matrix: not configured ${c.dim}(optional — can run locally, no account needed)${c.reset}`);
  }

  // WhatsApp
  if (channelsOut.toLowerCase().includes("whatsapp")) {
    lines.push(`  ${c.green}✓${c.reset} WhatsApp: configured`);
    hasChannel = true;
  } else {
    lines.push(`  ${c.dim}○${c.reset} WhatsApp: not configured ${c.dim}(optional)${c.reset}`);
  }

  // ── Summary ──
  lines.push("");
  if (hasLLM && hasChannel) {
    lines.push(`  ${c.green}${c.bold}✓ Fully operational:${c.reset} LLM + chat channel available.`);
  } else if (hasLLM) {
    lines.push(`  ${c.green}✓${c.reset} LLM available — agent can respond.`);
    lines.push(`  ${c.dim}  Add a channel (Telegram/Discord/Matrix) to chat from your phone.${c.reset}`);
  } else if (hasChannel) {
    lines.push(`  ${c.green}✓${c.reset} Chat channel available.`);
    lines.push(`  ${c.yellow}  Need an LLM: set ANTHROPIC_API_KEY, install Claude, or run Ollama.${c.reset}`);
  } else {
    lines.push(`  ${c.yellow}${c.bold}⚠ Need at least one of:${c.reset}`);
    lines.push(`    ${c.cyan}1.${c.reset} LLM: Claude Code (${c.cyan}claude login${c.reset}), API key, or Ollama (local)`);
    lines.push(`    ${c.cyan}2.${c.reset} Channel: Telegram, Discord, or Matrix (${c.cyan}openclaw configure${c.reset})`);
  }
}

/**
 * Ensure Node.js 22+ is available. Installs via nvm if needed.
 * Works in WSL, Linux, and Windows (via nvm-windows, fnm, or direct download).
 */
async function ensureNodeVersion(
  run: (cmd: string) => Promise<string>,
  lines: string[],
): Promise<boolean> {
  // Check current Node version
  const nodeVer = await run("node --version 2>/dev/null");
  const major = parseInt(nodeVer.replace("v", ""));

  if (major >= 22) {
    return true; // Already good
  }

  lines.push(`  ${c.dim}Current Node: ${nodeVer.trim()} (need 22+)${c.reset}`);

  // ── Windows: try nvm-windows, fnm, or direct download ──
  if (isWin) {
    // Check for nvm-windows
    const nvmWinCheck = await run("nvm version 2>/dev/null");
    if (nvmWinCheck && /\d+\.\d+/.test(nvmWinCheck)) {
      const nvmList = await run("nvm list 2>/dev/null");
      if (nvmList.includes("22.")) {
        lines.push(`  ${c.green}✓${c.reset} Node 22 available via nvm-windows`);
        await run("nvm use 22 2>&1");
        return true;
      }
      lines.push(`  ${c.cyan}Installing Node 22 via nvm-windows...${c.reset}`);
      console.error(`${c.dim}→ nvm install 22${c.reset}`);
      const installOut = await run("nvm install 22 2>&1");
      if (installOut.includes("22.") || installOut.toLowerCase().includes("installed")) {
        await run("nvm use 22 2>&1");
        lines.push(`  ${c.green}✓${c.reset} Node 22 installed via nvm-windows`);
        return true;
      }
    }

    // Check for fnm
    const fnmCheck = await run("fnm --version 2>/dev/null");
    if (fnmCheck && fnmCheck.includes("fnm")) {
      lines.push(`  ${c.cyan}Installing Node 22 via fnm...${c.reset}`);
      const fnmOut = await run("fnm install 22 && fnm use 22 2>&1");
      if (fnmOut.includes("installed") || fnmOut.includes("v22")) {
        lines.push(`  ${c.green}✓${c.reset} Node 22 installed via fnm`);
        return true;
      }
    }

    // Direct download via PowerShell as last resort — requires admin
    const adminCheck = await run(
      `powershell -Command "& { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }" 2>&1`
    );
    const hasAdmin = adminCheck.trim() === "True";

    if (!hasAdmin) {
      lines.push(`  ${c.red}✗${c.reset} Cannot install Node 22 — admin privileges required.`);
      lines.push(`  ${c.dim}Run as Administrator, or install manually:${c.reset}`);
      lines.push(`  ${c.dim}  • nvm-windows: https://github.com/coreybutler/nvm-windows${c.reset}`);
      lines.push(`  ${c.dim}  • Node.js:     https://nodejs.org/${c.reset}`);
      return false;
    }

    lines.push(`  ${c.cyan}Downloading Node 22 installer (admin)...${c.reset}`);
    console.error(`${c.dim}→ Downloading Node.js 22 for Windows${c.reset}`);
    const msiUrl = "https://nodejs.org/dist/v22.15.0/node-v22.15.0-x64.msi";
    // Resolve temp dir: use Windows %TEMP% for PowerShell, bash-compatible path for curl
    const winTemp = (await run(`powershell -Command 'Write-Output $env:TEMP' 2>/dev/null`)).trim() || "C:\\Windows\\Temp";
    const msiWinPath = `${winTemp}\\node22.msi`;
    const msiBashPath = `$(cygpath '${winTemp}')/node22.msi`;
    // Try curl first — Invoke-WebRequest doesn't work on Windows Server 2016 (old TLS/IE engine)
    const curlCheck = await run("curl --version 2>/dev/null");
    if (curlCheck && curlCheck.includes("curl")) {
      await run(`curl -fsSL -o "${msiBashPath}" "${msiUrl}" 2>&1`);
    } else {
      await run(
        `powershell -Command "& { Invoke-WebRequest -Uri '${msiUrl}' -OutFile '${msiWinPath}' }" 2>&1`
      );
    }
    const dlOut = await run(
      `powershell -Command "Start-Process msiexec.exe -ArgumentList '/i','${msiWinPath}','/qn' -Wait; Remove-Item '${msiWinPath}'" 2>&1`
    );

    // Verify after install
    const recheck = await run("node --version 2>/dev/null");
    const recheckMajor = parseInt(recheck.replace("v", ""));
    if (recheckMajor >= 22) {
      lines.push(`  ${c.green}✓${c.reset} Node ${recheck.trim()} installed`);
      return true;
    }

    lines.push(`  ${c.red}✗${c.reset} Node 22 installer ran but could not verify. You may need to restart your terminal.`);
    lines.push(`  ${c.dim}Try: node --version (if still old, restart terminal or download from https://nodejs.org/)${c.reset}`);
    return false;
  }

  // ── Linux/WSL: try nvm, fnm, or install nvm ──
  const nvmSourceCmd = `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done`;
  const nvmCheck = await run(`bash -c '${nvmSourceCmd} 2>/dev/null && nvm --version' 2>/dev/null`);
  const hasNvm = nvmCheck && !nvmCheck.includes("not found") && /\d+\.\d+/.test(nvmCheck);

  if (hasNvm) {
    const nvmList = await run(`bash -c '${nvmSourceCmd} 2>/dev/null && nvm ls 22 2>/dev/null'`);

    if (nvmList.includes("v22")) {
      lines.push(`  ${c.green}✓${c.reset} Node 22 available via nvm`);
      return true;
    }

    lines.push(`  ${c.cyan}Installing Node 22 via nvm...${c.reset}`);
    console.error(`${c.dim}→ nvm install 22${c.reset}`);
    const installOut = await run(`bash -c '${nvmSourceCmd} && nvm install 22' 2>&1`);

    if (installOut.includes("v22") || installOut.includes("Now using")) {
      lines.push(`  ${c.green}✓${c.reset} Node 22 installed via nvm`);
      return true;
    } else {
      lines.push(`  ${c.red}✗${c.reset} nvm install failed: ${installOut.split("\n")[0]}`);
      return false;
    }
  }

  // Check for fnm
  const fnmCheck = await run("fnm --version 2>/dev/null");
  if (fnmCheck && fnmCheck.includes("fnm")) {
    lines.push(`  ${c.cyan}Installing Node 22 via fnm...${c.reset}`);
    const fnmOut = await run("fnm install 22 && fnm use 22 2>&1");
    if (fnmOut.includes("installed") || fnmOut.includes("v22")) {
      lines.push(`  ${c.green}✓${c.reset} Node 22 installed via fnm`);
      return true;
    }
  }

  // No version manager — install nvm first
  lines.push(`  ${c.cyan}Installing nvm...${c.reset}`);
  console.error(`${c.dim}→ Installing nvm + Node 22${c.reset}`);
  const nvmInstall = await run(
    "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh 2>/dev/null | bash 2>&1; " +
    `bash -c '${nvmSourceCmd} && nvm install 22' 2>&1`
  );

  if (nvmInstall.includes("v22") || nvmInstall.includes("Now using")) {
    lines.push(`  ${c.green}✓${c.reset} nvm + Node 22 installed`);
    return true;
  }

  lines.push(`  ${c.red}✗${c.reset} Could not install Node 22 automatically.`);
  lines.push(`  ${c.dim}Install manually: nvm install 22 (or download from nodejs.org)${c.reset}`);
  return false;
}

/**
 * Build the command to start openclaw with the correct Node version.
 * Uses nvm if the system Node is too old. Cross-platform.
 */
async function buildStartCommand(run: (cmd: string) => Promise<string>): Promise<string> {
  const nodeVer = await run("node --version 2>/dev/null");
  const major = parseInt(nodeVer.replace("v", ""));

  if (major >= 22) {
    if (isWin) {
      return `powershell -Command "Start-Process -WindowStyle Hidden -FilePath node -ArgumentList (Get-Command openclaw).Source,'gateway','--force','--allow-unconfigured'"`;
    }
    return "openclaw gateway --force --allow-unconfigured &";
  }

  if (isWin) {
    // On Windows, nvm-windows/fnm update PATH globally — just try to run
    return `powershell -Command "Start-Process -WindowStyle Hidden -FilePath node -ArgumentList (Get-Command openclaw).Source,'gateway','--force','--allow-unconfigured'"`;
  }

  // Try nvm — find it wherever it lives
  const nvmSource = `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done`;
  const nvmNode22 = await run(`bash -c '${nvmSource} 2>/dev/null && nvm which 22 2>/dev/null'`);
  if (nvmNode22 && nvmNode22.includes("/node")) {
    return `bash -c '${nvmSource} && nvm use 22 && openclaw gateway --force --allow-unconfigured' &`;
  }

  // Try fnm
  const fnmCheck = await run("fnm --version 2>/dev/null");
  if (fnmCheck && fnmCheck.includes("fnm")) {
    return `bash -c 'eval "$(fnm env)" && fnm use 22 && openclaw gateway --force --allow-unconfigured' &`;
  }

  // Fallback — just try
  return "nohup openclaw gateway --force > /dev/null 2>&1";
}

export async function diagnoseOpenclaw(isRemote: boolean, runRemote?: (cmd: string) => Promise<string>): Promise<string> {
  const run = runRemote ?? ((cmd: string) => runCmd(cmd));
  const steps: DiagStep[] = [];
  const lines: string[] = [];

  lines.push(`\n${c.bold}${c.cyan}── OpenClaw Diagnostics ──${c.reset}\n`);

  // ── Environment detection ──
  if (isWin) {
    steps.push({ name: "Environment", status: "pass", detail: "Windows" });

    const localOC = await cmdExists(run, "openclaw");
    if (localOC) {
      const localVer = await run("openclaw --version 2>/dev/null || echo error");
      if (localVer.includes("error")) {
        steps.push({ name: "Install", status: "warn", detail: `Binary exists at ${localOC} but --version failed (may need Node 22+)` });
      } else {
        steps.push({ name: "Install", status: "pass", detail: `${localVer.trim()} at ${localOC}` });
      }
    } else {
      steps.push({ name: "Install", status: "fail", detail: "OpenClaw not installed — npm install -g openclaw" });
    }
  } else {
    const wslDiag = await run("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native");
    const diagInWSL = wslDiag.trim() === "wsl";

    if (diagInWSL) {
      steps.push({ name: "Environment", status: "pass", detail: "WSL (Windows Subsystem for Linux)" });

      // Check OpenClaw on Windows host
      const hostOC = await run("cmd.exe /c 'where openclaw' 2>/dev/null");
      if (hostOC.includes("openclaw")) {
        const hostRunning = await run("cmd.exe /c 'tasklist /FI \"IMAGENAME eq node.exe\" /V /NH' 2>/dev/null");
        if (hostRunning.includes("openclaw")) {
          steps.push({ name: "Windows host", status: "pass", detail: "OpenClaw running on Windows host" });
        } else {
          steps.push({ name: "Windows host", status: "warn", detail: "OpenClaw installed on Windows but not running" });
        }
      } else {
        steps.push({ name: "Windows host", status: "skip", detail: "OpenClaw not installed on Windows host (checking WSL only)" });
      }

      // Check WSL OpenClaw install
      const wslOC = await cmdExists(run, "openclaw");
      if (wslOC) {
        const wslVer = await run("openclaw --version 2>/dev/null || echo error");
        if (wslVer.includes("error")) {
          steps.push({ name: "WSL install", status: "warn", detail: `Binary exists at ${wslOC} but --version failed (may need Node 22+)` });
        } else {
          steps.push({ name: "WSL install", status: "pass", detail: `${wslVer.trim()} at ${wslOC}` });
        }
      } else {
        steps.push({ name: "WSL install", status: "fail", detail: "OpenClaw not installed in WSL — npm install -g openclaw" });
      }
    } else {
      steps.push({ name: "Environment", status: "pass", detail: "Native Linux" });

      const localOC = await cmdExists(run, "openclaw");
      if (localOC) {
        const localVer = await run("openclaw --version 2>/dev/null || echo error");
        if (localVer.includes("error")) {
          steps.push({ name: "Install", status: "warn", detail: `Binary exists at ${localOC} but --version failed (may need Node 22+)` });
        } else {
          steps.push({ name: "Install", status: "pass", detail: `${localVer.trim()} at ${localOC}` });
        }
      } else {
        steps.push({ name: "Install", status: "fail", detail: "OpenClaw not installed — npm install -g openclaw" });
      }
    }
  }

  // ── Step 0: Node version ──
  const nodeVer = await run("node --version 2>/dev/null");
  const nodeMajor = parseInt(nodeVer.replace("v", ""));
  if (nodeMajor >= 22) {
    steps.push({ name: "Node.js", status: "pass", detail: nodeVer.trim() });
  } else {
    steps.push({ name: "Node.js", status: "warn", detail: `${nodeVer.trim()} (need 22+) — will auto-install if needed` });
    // Try to ensure Node 22 is available
    const fixLines: string[] = [];
    const nodeOk = await ensureNodeVersion(run, fixLines);
    if (nodeOk) {
      steps[steps.length - 1] = { name: "Node.js", status: "pass", detail: `${nodeVer.trim()} → Node 22 available via nvm` };
    }
  }

  // ── Step 1: Is the process running? ──
  const diagGw = await isGatewayRunning(run);
  if (diagGw.running) {
    steps.push({ name: "Gateway process", status: "pass", detail: `Running (PID ${diagGw.pid})` });
  } else {
    // Try to auto-start
    const startCmd = await buildStartCommand(run);
    await run(`${startCmd}${isWin ? "" : " & sleep 4"}`);
    if (isWin) await run("powershell -Command Start-Sleep -Seconds 4");
    const retryGw = await isGatewayRunning(run);
    if (retryGw.running) {
      steps.push({ name: "Gateway process", status: "pass", detail: `Started automatically (PID ${retryGw.pid})` });
    } else {
      steps.push({ name: "Gateway process", status: "fail", detail: "Not running — auto-start failed" });
    }
  }

  // ── Step 2: HTTP health endpoint ──
  const healthOut = await run("curl -sf http://127.0.0.1:18789/health 2>/dev/null || echo FAIL");
  if (healthOut.includes('"ok":true') || healthOut.includes('"status":"live"')) {
    steps.push({ name: "Health endpoint", status: "pass", detail: "http://127.0.0.1:18789/health → OK" });
  } else if (healthOut === "FAIL") {
    steps.push({ name: "Health endpoint", status: "fail", detail: "Not responding on port 18789" });
  } else {
    steps.push({ name: "Health endpoint", status: "warn", detail: healthOut.substring(0, 80) });
  }

  // ── Step 3: Gateway RPC / WebSocket ──
  const gatewayOut = await run("openclaw gateway status 2>&1 | head -5");
  if (gatewayOut.includes("running") || gatewayOut.includes("RPC probe: ok")) {
    steps.push({ name: "Gateway RPC", status: "pass", detail: "WebSocket gateway responding" });
  } else if (gatewayOut.includes("not installed") || gatewayOut.includes("not found")) {
    steps.push({ name: "Gateway RPC", status: "fail", detail: "openclaw CLI not found" });
  } else {
    steps.push({ name: "Gateway RPC", status: "warn", detail: gatewayOut.split("\n")[0] });
  }

  // ── Step 4: TUI connectivity test ──
  // The TUI connects via WebSocket — if gateway is up, TUI would work
  if (steps.find(s => s.name === "Health endpoint")?.status === "pass") {
    steps.push({ name: "TUI connectivity", status: "pass", detail: "Gateway reachable — TUI can connect (openclaw tui)" });
  } else {
    steps.push({ name: "TUI connectivity", status: "fail", detail: "Gateway not reachable — TUI will fail" });
  }

  // ── Step 5: Channels ──
  const channelsOut = await run("openclaw channels list 2>&1");
  const channelLines = channelsOut.split("\n");

  // Parse channel list
  const channels: Array<{ name: string; type: string; status: string }> = [];

  // Check for Telegram
  if (channelsOut.toLowerCase().includes("telegram")) {
    const teleLine = channelLines.find(l => l.toLowerCase().includes("telegram"));
    const configured = teleLine?.includes("configured") ?? false;
    channels.push({ name: "Telegram", type: "telegram", status: configured ? "configured" : "not configured" });
  }

  // Check for Discord
  if (channelsOut.toLowerCase().includes("discord")) {
    const discLine = channelLines.find(l => l.toLowerCase().includes("discord"));
    const configured = discLine?.includes("configured") ?? false;
    channels.push({ name: "Discord", type: "discord", status: configured ? "configured" : "not configured" });
  }

  // Check for Matrix
  if (channelsOut.toLowerCase().includes("matrix")) {
    const matLine = channelLines.find(l => l.toLowerCase().includes("matrix"));
    const configured = matLine?.includes("configured") ?? false;
    const errored = matLine?.includes("failed") || matLine?.includes("error") || channelsOut.includes("Blocked hostname");
    channels.push({
      name: "Matrix",
      type: "matrix",
      status: errored ? "configured but errored" : configured ? "configured" : "not configured",
    });
  }

  // Check for WhatsApp
  if (channelsOut.toLowerCase().includes("whatsapp")) {
    const waLine = channelLines.find(l => l.toLowerCase().includes("whatsapp"));
    const configured = waLine?.includes("configured") ?? false;
    channels.push({ name: "WhatsApp", type: "whatsapp", status: configured ? "configured" : "not configured" });
  }

  if (channels.length > 0) {
    for (const ch of channels) {
      const status = ch.status === "configured" ? "pass" :
                     ch.status.includes("error") ? "warn" : "skip";
      steps.push({ name: `Channel: ${ch.name}`, status, detail: ch.status });
    }
  } else {
    steps.push({ name: "Channels", status: "warn", detail: "No channels configured — run: openclaw configure" });
  }

  // ── Step 5b: LLM auth — check if any provider is configured, auto-setup if not ──
  const modelsOut = await run("openclaw models status 2>&1");
  const hasProviderAuth = modelsOut.includes("Providers w/ OAuth/tokens (0)") === false
    && !modelsOut.includes("Providers w/ OAuth/tokens (0)");
  const missingAuth = modelsOut.includes("Missing auth");

  if (hasProviderAuth && !missingAuth) {
    steps.push({ name: "LLM auth", status: "pass", detail: "Provider auth configured" });
  } else {
    // No LLM auth — try to auto-configure from Claude Code credentials
    let authFixed = false;
    const claudeCredsPath = getClaudeCredsPath();
    try {
      const { readFileSync: readFS, existsSync: existsFS, writeFileSync: writeFS, mkdirSync: mkdirFS } = await import("node:fs");
      const { dirname: dirnameFS } = await import("node:path");

      if (existsFS(claudeCredsPath)) {
        const creds = JSON.parse(readFS(claudeCredsPath, "utf-8"));
        const claudeToken = creds?.claudeAiOauth?.accessToken;
        if (claudeToken) {
          // Write directly into openclaw's auth-profiles.json
          const authProfilePath = `${getOpenclawHome()}${isWin ? "\\" : "/"}agents${isWin ? "\\" : "/"}main${isWin ? "\\" : "/"}agent${isWin ? "\\" : "/"}auth-profiles.json`;
          let profiles: any = { version: 1, profiles: {} };
          if (existsFS(authProfilePath)) {
            profiles = JSON.parse(readFS(authProfilePath, "utf-8"));
          } else {
            mkdirFS(dirnameFS(authProfilePath), { recursive: true });
          }
          profiles.profiles["anthropic:claude-oauth"] = {
            type: "oauth",
            provider: "anthropic",
            access: claudeToken,
            expires: Date.now() + 86400000,
          };
          writeFS(authProfilePath, JSON.stringify(profiles, null, 2));
          steps.push({ name: "LLM auth", status: "pass", detail: "Auto-configured from Claude Code OAuth token" });
          authFixed = true;
        }
      }
    } catch {}

    if (!authFixed && process.env.ANTHROPIC_API_KEY) {
      steps.push({ name: "LLM auth", status: "pass", detail: "ANTHROPIC_API_KEY found in environment" });
      authFixed = true;
    }
    if (!authFixed && process.env.OPENAI_API_KEY) {
      steps.push({ name: "LLM auth", status: "pass", detail: "OPENAI_API_KEY found in environment" });
      authFixed = true;
    }
    if (!authFixed) {
      steps.push({ name: "LLM auth", status: "fail", detail: "No LLM provider configured — install Claude Code and run: claude login" });
    }
  }

  // ── Step 6: Config ──
  const configFileOut = await run("openclaw config file 2>&1");
  if (configFileOut && !configFileOut.includes("error") && !configFileOut.includes("not found")) {
    steps.push({ name: "Config file", status: "pass", detail: configFileOut.trim() });
  } else {
    steps.push({ name: "Config file", status: "fail", detail: "No config — run: openclaw setup" });
  }

  // ── Step 7: Recent errors in logs ──
  const logErrors = await run("openclaw logs 2>&1 | grep -i 'error\\|fail\\|fatal\\|crash' | tail -5");
  if (logErrors && logErrors.trim().length > 0) {
    const errorCount = logErrors.split("\n").length;
    steps.push({ name: "Recent log errors", status: "warn", detail: `${errorCount} error(s) in recent logs` });
  } else {
    steps.push({ name: "Recent log errors", status: "pass", detail: "No recent errors" });
  }

  // ── Step 8: Version ──
  const versionOut = await run("openclaw --version 2>&1");
  if (versionOut) {
    steps.push({ name: "Version", status: "pass", detail: versionOut.trim() });
  }

  // ── Render results ──
  for (const step of steps) {
    const icon = step.status === "pass" ? `${c.green}✓${c.reset}` :
                 step.status === "warn" ? `${c.yellow}⚠${c.reset}` :
                 step.status === "fail" ? `${c.red}✗${c.reset}` :
                 `${c.dim}○${c.reset}`;
    lines.push(`  ${icon} ${c.bold}${step.name}${c.reset}  ${c.dim}${step.detail}${c.reset}`);
  }

  // ── Summary ──
  const passCount = steps.filter(s => s.status === "pass").length;
  const warnCount = steps.filter(s => s.status === "warn").length;
  const failCount = steps.filter(s => s.status === "fail").length;

  lines.push("");
  if (failCount === 0 && warnCount === 0) {
    lines.push(`  ${c.green}${c.bold}✓ All checks passed.${c.reset}`);
  } else {
    lines.push(`  ${c.bold}Results:${c.reset} ${c.green}${passCount} passed${c.reset} | ${c.yellow}${warnCount} warnings${c.reset} | ${c.red}${failCount} failed${c.reset}`);
  }

  // ── Auto-fix ──
  if (failCount > 0 || warnCount > 0) {
    const fixes: Array<{ issue: string; command: string; description: string }> = [];

    if (steps.find(s => s.name === "Gateway process" && s.status === "fail")) {
      fixes.push({ issue: "Gateway not running", command: "openclaw gateway --force", description: "Start the gateway (kills stale port binds)" });
    }
    if (steps.find(s => s.name === "LLM auth" && s.status === "fail")) {
      fixes.push({ issue: "No LLM provider", command: "npm install -g @anthropic-ai/claude-code && claude login", description: "Install Claude Code and login — notoken will sync the token to openclaw" });
    }
    if (steps.find(s => s.name.includes("Matrix") && s.status === "warn")) {
      fixes.push({ issue: "Matrix plugin errors", command: "openclaw doctor --fix", description: "Install missing plugin dependencies" });
    }
    if (steps.find(s => s.name === "Config file" && s.status === "fail")) {
      fixes.push({ issue: "No configuration", command: "openclaw setup", description: "Run interactive setup" });
    }
    if (steps.find(s => s.name === "Channels" && s.status === "warn" && s.detail.includes("No channels"))) {
      fixes.push({ issue: "No channels configured", command: "openclaw configure --section channels", description: "Set up Telegram/Discord/Matrix" });
    }

    if (fixes.length > 0) {
      lines.push(`\n  ${c.bold}Available fixes:${c.reset}`);
      for (let i = 0; i < fixes.length; i++) {
        lines.push(`    ${c.yellow}${i + 1}.${c.reset} ${fixes[i].issue}`);
        lines.push(`       ${c.cyan}${fixes[i].command}${c.reset}  ${c.dim}— ${fixes[i].description}${c.reset}`);
      }

      // Store fixes for auto-fix
      (globalThis as any).__openclawFixes = fixes;
      lines.push(`\n  ${c.dim}Run "fix openclaw" to apply these fixes automatically.${c.reset}`);
    }
  }

  return lines.join("\n");
}

/**
 * Apply auto-fixes from the last diagnosis.
 */
export async function autoFixOpenclaw(runRemote?: (cmd: string) => Promise<string>): Promise<string> {
  const run = runRemote ?? ((cmd: string) => runCmd(cmd));
  const fixes = (globalThis as any).__openclawFixes as Array<{ issue: string; command: string; description: string }> | undefined;

  if (!fixes || fixes.length === 0) {
    return `${c.dim}No fixes pending. Run "diagnose openclaw" first.${c.reset}`;
  }

  const lines: string[] = [];
  lines.push(`\n${c.bold}${c.cyan}── OpenClaw Auto-Fix ──${c.reset}\n`);

  for (const fix of fixes) {
    lines.push(`  ${c.cyan}Fixing:${c.reset} ${fix.issue}`);
    lines.push(`  ${c.dim}→ ${fix.command}${c.reset}`);

    const result = await run(fix.command + " 2>&1");
    const firstLine = result.split("\n")[0];

    if (result.includes("error") || result.includes("FAIL")) {
      lines.push(`  ${c.red}✗ ${firstLine}${c.reset}\n`);
    } else {
      lines.push(`  ${c.green}✓ Done${c.reset}\n`);
    }
  }

  // Clear fixes
  (globalThis as any).__openclawFixes = undefined;

  lines.push(`  ${c.dim}Run "diagnose openclaw" again to verify.${c.reset}`);
  return lines.join("\n");
}
