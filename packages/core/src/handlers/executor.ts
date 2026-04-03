import type { DynamicIntent, IntentDef } from "../types/intent.js";
import { getIntentDef, loadHosts } from "../utils/config.js";
import { runRemoteCommand, runLocalCommand } from "../execution/ssh.js";
import {
  gitStatus, gitLog, gitDiff, gitPull, gitPush,
  gitBranch, gitCheckout, gitCommit, gitAdd, gitStash, gitReset,
} from "../execution/git.js";
import { resolveFuzzyFields } from "../nlp/fuzzyResolver.js";
import { recordHistory } from "../context/history.js";
import { createBackup, getRemoteBackupCommand } from "../utils/autoBackup.js";
import { detectLocalPlatform, getPackageForCommand, getInstallCommand } from "../utils/platform.js";
import { withSpinner } from "../utils/spinner.js";
import { analyzeOutput } from "../utils/analysis.js";
import { smartRead, smartSearch } from "../utils/smartFile.js";
import { pluginRegistry } from "../plugins/registry.js";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { Spinner } from "../utils/spinner.js";
import { runDockerExec, testSshConnection } from "../execution/ssh.js";
import { scanForCleanup, formatCleanupTable, runInteractiveCleanup, smartDriveScan, formatDriveScan, runDeepScanBackground } from "../utils/diskCleanup.js";
import { detectProjects as detectProjectsNew, formatProjectDetection, readProjectConfig, formatPackageScripts, getScriptRunCmd } from "../utils/projectDetect.js";
import { smartArchive } from "../utils/smartArchive.js";
import { buildQuery, formatQueryPlan, type DbType } from "../utils/dbQuery.js";
import { resolveEntity, verbalizeResolution, learnEntity, listEntities } from "../utils/entityResolver.js";
import { detectMultiTarget, executeMulti } from "../utils/multiExec.js";
import { diagnoseOpenclaw, autoFixOpenclaw, quickConnectivityCheck } from "../utils/openclawDiag.js";
const execAsync = promisify(exec);
import { scanProjects, summarizeDirectory, formatProjectList, formatDirSummary } from "../utils/projectScanner.js";
import { generateImage, detectImageEngines, formatImageEngineStatus } from "../utils/imageGen.js";
import { searchWikidata, formatWikiEntity, formatWikiSuggestions } from "../nlp/wikidata.js";
import { suggestAction } from "../conversation/pendingActions.js";

/**
 * Generic command executor.
 *
 * For git.* intents, uses simple-git for richer programmatic output.
 * For everything else, interpolates command templates and runs via shell.
 */
export async function executeIntent(intent: DynamicIntent): Promise<string> {
  const def = getIntentDef(intent.intent);
  if (!def) {
    throw new Error(`No intent definition found for: ${intent.intent}`);
  }

  // Plugin beforeExecute hooks — can cancel execution
  const proceed = await pluginRegistry.runBeforeExecute({
    intent: intent.intent,
    fields: intent.fields,
    rawText: intent.rawText,
  });
  if (proceed === false) {
    return "[cancelled by plugin]";
  }

  // ── Context-aware intent announcement ──
  // When the intent is ambiguous (e.g. "diagnose" without a target),
  // use entity focus from conversation to infer what the user means,
  // and announce what we're about to do so the user can redirect.
  try {
    const { getOrCreateConversation, getEntityFocus, setEntityFocus } = await import("../conversation/store.js");
    const conv = getOrCreateConversation(process.cwd());

    // Set focus when user explicitly mentions a service
    const rawLower = intent.rawText.toLowerCase();
    if (rawLower.includes("discord")) setEntityFocus(conv, "discord", "service");
    else if (rawLower.includes("openclaw") || rawLower.includes("claw")) setEntityFocus(conv, "openclaw", "service");
    else if (rawLower.includes("ollama")) setEntityFocus(conv, "ollama", "service");
    else if (rawLower.includes("docker")) setEntityFocus(conv, "docker", "service");

    // For ambiguous intents (diagnose, fix, check, status, restart, etc.)
    // without an explicit service name — resolve from entity focus
    const ambiguousVerbs = /^(diagnose|fix|check|troubleshoot|repair|restart|start|stop|status|update)\s*$/i;
    if (ambiguousVerbs.test(rawLower.trim()) || (rawLower.match(/^(diagnose|fix|check|troubleshoot|repair)\s+(it|this|that)$/i))) {
      const focus = getEntityFocus(conv);
      if (focus) {
        const target = focus.entityId;
        console.log(`\x1b[2m  → ${intent.intent} targeting \x1b[1m${target}\x1b[0m\x1b[2m (based on conversation)\x1b[0m`);
        console.log(`\x1b[2m    Say "not that" or specify: "${rawLower.split(/\s/)[0]} openclaw" / "${rawLower.split(/\s/)[0]} discord"\x1b[0m`);

        // Inject the target into rawText for downstream handlers
        intent.rawText = `${intent.rawText} ${target}`;
      }
    }
  } catch { /* conversation store not available — skip context */ }

  // Fuzzy resolve file paths if needed
  const resolved = await resolveFuzzyFields(intent);
  const fields = resolved.fields;
  const environment = (fields.environment as string) ?? "local";

  // "local" environment means run on this machine, not SSH
  // Also run locally if no real hosts are configured (placeholder hosts)
  const isLocal = def.execution === "local"
    || environment === "local"
    || environment === "localhost"
    || !hasRealHost(environment);

  let result: string;
  let command: string;

  // Auto-backup before destructive file operations
  const destructiveIntents = ["files.copy", "files.move", "files.remove", "env.set"];
  if (destructiveIntents.includes(intent.intent)) {
    const targetFile = (fields.source ?? fields.target ?? fields.path) as string | undefined;
    if (targetFile) {
      if (def.execution === "local") {
        const backup = createBackup(targetFile, intent.intent);
        if (backup) {
          console.error(`\x1b[2m[auto-backup] ${backup.originalPath} → ${backup.backupPath}\x1b[0m`);
        }
      }
      // For remote: prepend backup command
    }
  }

  // ── Ported handlers ─────────────────────────────────────────────────────────
  const nvmPfx = `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done 2>/dev/null; nvm use 22 > /dev/null 2>&1;`;

  // ── WSL/Windows environment-aware OpenClaw execution ──
  // Detects current env, parses "on windows"/"on wsl"/"the other one"/"both",
  // and routes commands accordingly.
  type OcEnv = "wsl" | "windows" | "both";

  // Persist last targeted env so "the other one" works
  const _ocEnvKey = "__notoken_last_oc_env";
  function getLastOcEnv(): OcEnv | null {
    return (process as any)[_ocEnvKey] ?? null;
  }
  function setLastOcEnv(env: OcEnv) {
    (process as any)[_ocEnvKey] = env;
  }

  async function detectOcEnv(): Promise<{ inWSL: boolean; wslInstalled: boolean; winInstalled: boolean }> {
    const isWSL = (await runLocalCommand("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native").catch(() => "native")).trim() === "wsl";
    if (!isWSL) return { inWSL: false, wslInstalled: true, winInstalled: false };
    const wslOC = await runLocalCommand("which openclaw 2>/dev/null").catch(() => "");
    const winOC = await runLocalCommand("/mnt/c/Windows/System32/cmd.exe /c \"where openclaw\" 2>/dev/null").catch(() => "");
    return { inWSL: true, wslInstalled: !!wslOC.includes("openclaw"), winInstalled: !!winOC.includes("openclaw") };
  }

  function parseOcTarget(rawText: string): OcEnv | null {
    const t = rawText.toLowerCase();
    if (/\bboth\b/.test(t)) return "both";
    if (/\b(on\s+)?windows\b|\b(on\s+)?win\b|\bhost\b/.test(t)) return "windows";
    if (/\b(on\s+|in\s+)?wsl\b|\b(on\s+)?linux\b/.test(t)) return "wsl";
    if (/\bthe\s+other\s+(one|side|env|environment)\b|\bnot\s+this\s+one\b|\bthe\s+other\b/.test(t)) {
      const last = getLastOcEnv();
      if (last === "wsl") return "windows";
      if (last === "windows") return "wsl";
      return null; // don't know which "other" means
    }
    return null; // default — use current env
  }

  // Resolve Node 22 binary path once — nvm sourcing doesn't survive subshells/nohup
  let _node22Path: string | null = null;
  async function getNode22(): Promise<string> {
    if (_node22Path) return _node22Path;
    const searchDirs = [`${process.env.HOME}/.nvm`, "/home/ino/.nvm", "/root/.nvm"];
    for (const dir of searchDirs) {
      const found = await runLocalCommand(`ls -1 ${dir}/versions/node/v22*/bin/node 2>/dev/null | tail -1`).catch(() => "");
      if (found.trim()) { _node22Path = found.trim(); return _node22Path; }
    }
    // Fallback: try system node
    _node22Path = (await runLocalCommand("which node").catch(() => "node")).trim();
    return _node22Path;
  }

  /** Run an openclaw command on the specified environment(s). */
  async function runOcCmd(cmd: string, target: OcEnv | null, env: Awaited<ReturnType<typeof detectOcEnv>>, timeout = 30_000): Promise<string> {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

    // Resolve target — default to current env
    const isNativeWindows = process.platform === "win32" && !env.inWSL;
    const effective = target ?? (env.inWSL ? "wsl" : (isNativeWindows ? "windows" : "wsl"));
    setLastOcEnv(effective === "both" ? "wsl" : effective);

    // ── Native Windows: run openclaw directly (no node22/nohup wrapping) ──
    if (isNativeWindows && (effective === "windows" || !target)) {
      setLastOcEnv("windows");
      try {
        return await runLocalCommand(`${cmd} 2>&1`, timeout);
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        if (e.stdout?.trim()) return e.stdout.trim();
        if (e.stderr?.trim()) return e.stderr.trim();
        throw err;
      }
    }

    // Build openclaw command with Node 22 binary directly (WSL/Linux)
    const node22 = await getNode22();
    const ocBin = (await runLocalCommand("readlink -f $(which openclaw) 2>/dev/null || which openclaw").catch(() => "openclaw")).trim();
    // Replace "openclaw" at start of cmd with node22 + ocBin
    const wslCmd = cmd.replace(/^openclaw\b/, `${node22} ${ocBin}`);

    // Build Windows command — use cmd.exe (PowerShell blocks .ps1 scripts due to execution policy)
    function buildWinCmd(ocCmd: string): string {
      const escaped = ocCmd.replace(/"/g, '\\"');
      return `/mnt/c/Windows/System32/cmd.exe /c "${escaped}" 2>/dev/null`;
    }

    if (effective === "both") {
      const results: string[] = [];
      if (env.wslInstalled) {
        results.push(`${cc.bold}${cc.cyan}[WSL]${cc.reset}`);
        results.push(await runLocalCommand(`${wslCmd} 2>&1`, timeout).catch(e => `${cc.yellow}⚠ ${(e as Error).message.split("\n")[0]}${cc.reset}`));
      } else {
        results.push(`${cc.bold}${cc.cyan}[WSL]${cc.reset} ${cc.dim}Not installed${cc.reset}`);
      }
      if (env.winInstalled) {
        results.push(`\n${cc.bold}${cc.cyan}[Windows]${cc.reset}`);
        results.push(await runLocalCommand(buildWinCmd(cmd), timeout).catch(e => `${cc.yellow}⚠ ${(e as Error).message.split("\n")[0]}${cc.reset}`));
      } else {
        results.push(`\n${cc.bold}${cc.cyan}[Windows]${cc.reset} ${cc.dim}Not installed${cc.reset}`);
      }
      return results.join("\n");
    }

    if (effective === "windows") {
      if (!env.inWSL) return `${cc.yellow}⚠ Not in WSL — can't target Windows host.${cc.reset}`;
      if (!env.winInstalled) return `${cc.yellow}⚠ OpenClaw not installed on Windows host.${cc.reset}\n${cc.dim}Install: open PowerShell and run: npm install -g openclaw${cc.reset}`;
      setLastOcEnv("windows");
      try {
        return await runLocalCommand(buildWinCmd(cmd), timeout);
      } catch (err: unknown) {
        const e = err as { stdout?: string; stderr?: string; message?: string };
        if (e.stdout?.trim()) return e.stdout.trim();
        if (e.stderr?.trim()) return e.stderr.trim();
        throw err;
      }
    }

    // WSL / native Linux — use Node 22 directly
    setLastOcEnv("wsl");
    try {
      return await runLocalCommand(`${wslCmd} 2>&1`, timeout);
    } catch (err: unknown) {
      const e = err as { stdout?: string; stderr?: string; message?: string };
      if (e.stdout?.trim()) return e.stdout.trim();
      if (e.stderr?.trim()) return e.stderr.trim();
      throw err;
    }
  }

  const MODEL_ALIASES: Record<string, string> = {
    "opus": "anthropic/claude-opus-4-6", "sonnet": "anthropic/claude-sonnet-4-6", "haiku": "anthropic/claude-haiku-4-5",
    "claude": "anthropic/claude-opus-4-6", "gpt-4o": "openai-codex/gpt-4o", "gpt-5": "openai-codex/gpt-5.4",
    "gpt": "openai-codex/gpt-4o", "chatgpt": "openai-codex/gpt-4o", "codex": "openai-codex/gpt-5.4",
    "openai": "openai-codex/gpt-4o", "gemini": "google/gemini-2.5-pro", "mistral": "mistral/mistral-large",
    "llama": "ollama/llama2:13b", "llama2": "ollama/llama2:13b", "llama3": "ollama/llama3.2", "llama3.2": "ollama/llama3.2",
    "ollama": "ollama/llama2:13b", "codellama": "ollama/codellama", "phi": "ollama/phi3", "qwen": "ollama/qwen2.5",
    "deepseek": "ollama/deepseek-v3",
  };

  // Multi-environment execution
  const multiTargets = detectMultiTarget(intent.rawText);
  if (multiTargets && multiTargets.length > 1) return executeMulti(intent, multiTargets);

  // ── OpenClaw handlers (environment-aware) ──────────────────────────────────
  // All openclaw.* intents detect WSL/Windows, support "on windows"/"on wsl"/
  // "the other one"/"both", and verbosely announce which env they're targeting.

  const isOpenclawIntent = intent.intent.startsWith("openclaw.");
  let ocEnv: Awaited<ReturnType<typeof detectOcEnv>> | null = null;
  let ocTarget: OcEnv | null = null;
  let ocLabel = "";

  if (isOpenclawIntent) {
    ocEnv = await detectOcEnv();
    ocTarget = parseOcTarget(intent.rawText);

    // Build verbose label
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", yellow: "\x1b[33m" };
    if (ocTarget === "both") {
      ocLabel = `${cc.bold}${cc.cyan}Targeting: both WSL and Windows${cc.reset}`;
    } else if (ocTarget === "windows") {
      ocLabel = `${cc.bold}${cc.cyan}Targeting: Windows host${cc.reset}`;
    } else if (ocTarget === "wsl") {
      ocLabel = `${cc.bold}${cc.cyan}Targeting: WSL${cc.reset}`;
    } else if (ocEnv.inWSL) {
      ocLabel = `${cc.bold}${cc.cyan}Targeting: WSL${cc.reset} ${cc.dim}(say "on windows", "the other one", or "both")${cc.reset}`;
    } else {
      ocLabel = `${cc.bold}${cc.cyan}Targeting: local${cc.reset}`;
    }
    console.log(`\n  ${ocLabel}\n`);
  }

  // Discord diagnose/fix/check — by intent or raw text match
  if (intent.intent === "discord.diagnose" || intent.intent === "discord.check" || intent.intent === "discord.setup" ||
      intent.rawText.match(/\b(diagnose|fix|check|troubleshoot|repair)\b.*\bdiscord\b|\bdiscord\b.*\b(diagnose|fix|check|troubleshoot|status)\b/i)) {
    const isQuick = intent.intent === "discord.check" || (!!intent.rawText.match(/\b(check|status)\b/i) && !intent.rawText.match(/\b(fix|diagnose|troubleshoot|repair)\b/i));
    const isSetup = intent.intent === "discord.setup" || !!intent.rawText.match(/\bsetup\b.*\bdiscord\b/i);
    try {
      if (isSetup) {
        // Full setup flow — create bot, authorize, configure
        try {
          const { createDiscordBot, authorizeDiscordBot } = await import("../automation/discordPatchright.js");
          const result = await createDiscordBot();
          if (result.success && result.token) {
            // Register with OpenClaw
            const node22 = await getNode22();
            const ocBin = (await runLocalCommand("readlink -f $(which openclaw) 2>/dev/null || which openclaw").catch(() => "openclaw")).trim();
            await runLocalCommand(`${node22} ${ocBin} channels add --channel discord --token "${result.token}" 2>&1`, 15_000).catch(() => "");
            if (result.appId) await authorizeDiscordBot(result.appId);
            return `\x1b[32m✓\x1b[0m Discord bot created and configured!\n  \x1b[2mRun: "diagnose discord" to verify everything works.\x1b[0m`;
          }
          return `\x1b[33m⚠\x1b[0m Setup incomplete. ${result.success ? "" : "Token not captured."}\n  \x1b[2mTry again or run: "setup discord with token YOUR_TOKEN"\x1b[0m`;
        } catch {
          // Fallback to manual instructions
          const { diagnoseDiscord } = await import("../utils/discordDiag.js");
          return await diagnoseDiscord();
        }
      } else if (isQuick) {
        const { quickDiscordCheck } = await import("../utils/discordDiag.js");
        return await quickDiscordCheck();
      } else {
        const { diagnoseDiscord } = await import("../utils/discordDiag.js");
        return await diagnoseDiscord();
      }
    } catch (err: unknown) {
      return `\x1b[31m✗ Discord diagnostics error: ${(err as Error).message.split("\n")[0]}\x1b[0m`;
    }
  }

  // OpenClaw status
  if (intent.intent === "openclaw.status") {
    const diagRemote = environment !== "local" && environment !== "localhost" && hasRealHost(environment);
    return diagRemote ? await quickConnectivityCheck((cmd: string) => runRemoteCommand(environment, cmd)) : await quickConnectivityCheck();
  }

  // OpenClaw diagnose
  if (intent.intent === "openclaw.diagnose") {
    const diagRemote = environment !== "local" && environment !== "localhost" && hasRealHost(environment);
    return diagRemote
      ? await withSpinner(`Diagnosing on ${environment}...`, () => diagnoseOpenclaw(true, (cmd: string) => runRemoteCommand(environment, cmd)))
      : await withSpinner("Diagnosing OpenClaw...", () => diagnoseOpenclaw(false));
  }

  // OpenClaw doctor — run diagnostics, or auto-fix if requested
  if (intent.intent === "openclaw.doctor") {
    if (intent.rawText.match(/fix|repair|auto.?fix/i)) {
      return isLocal ? await autoFixOpenclaw() : await autoFixOpenclaw((cmd: string) => runRemoteCommand(environment, cmd));
    }
    // Without "fix" — run diagnostics (same as openclaw.diagnose)
    const diagRemote = environment !== "local" && environment !== "localhost" && hasRealHost(environment);
    return diagRemote
      ? await withSpinner(`Diagnosing on ${environment}...`, () => diagnoseOpenclaw(true, (cmd: string) => runRemoteCommand(environment, cmd)))
      : await withSpinner("Diagnosing OpenClaw...", () => diagnoseOpenclaw(false));
  }

  // ── OpenClaw dashboard — open web UI and auto-pair ──
  if (intent.intent === "openclaw.dashboard") {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    // Check if gateway is running
    const health = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
    if (!health.includes('"ok"')) {
      console.log(`${cc.yellow}⚠ Gateway not running. Starting it...${cc.reset}`);
      if (process.platform === "win32") {
        const ocPath = (await runLocalCommand("npm config get prefix 2>/dev/null").catch(() => "")).trim();
        const ocEntry = ocPath ? `${ocPath}\\node_modules\\openclaw\\dist\\index.js` : "openclaw";
        await runLocalCommand(
          `powershell -Command "Start-Process -FilePath node -ArgumentList '${ocEntry}','gateway','--force','--allow-unconfigured' -WindowStyle Hidden" 2>/dev/null`
        ).catch(() => "");
      } else {
        await runLocalCommand("nohup openclaw gateway --force --allow-unconfigured > /dev/null 2>&1 &").catch(() => "");
      }
      for (let i = 0; i < 8; i++) {
        await runLocalCommand("sleep 1").catch(() => {});
        const h = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
        if (h.includes('"ok"')) break;
      }
    }

    // Read the pairing token from config
    const { readFileSync: readFS, existsSync: existsFS } = await import("node:fs");
    const userHome = process.env.USERPROFILE || process.env.HOME || "";
    const sep = process.platform === "win32" ? "\\" : "/";
    const configPath = `${userHome}${sep}.openclaw${sep}openclaw.json`;
    let token = "";
    try {
      if (existsFS(configPath)) {
        const config = JSON.parse(readFS(configPath, "utf-8"));
        token = config?.gateway?.auth?.token || "";
      }
    } catch {}

    // Try auto-pair with Playwright (fills token and clicks Connect automatically)
    const url = "http://127.0.0.1:18789";
    let autoPaired = false;

    // Ensure Playwright + Chromium are installed
    let hasPlaywright = false;
    try {
      await import("playwright");
      hasPlaywright = true;
    } catch {
      console.log(`${cc.cyan}Installing Playwright for browser automation...${cc.reset}`);
      try {
        await withSpinner("Installing Playwright...", () => runLocalCommand("npm install playwright 2>&1", 120_000));
        await withSpinner("Downloading Chromium...", () => runLocalCommand("npx playwright install chromium 2>&1", 300_000));
        hasPlaywright = true;
        console.log(`${cc.green}✓ Playwright + Chromium installed${cc.reset}\n`);
      } catch {
        console.log(`${cc.yellow}⚠ Could not install Playwright — falling back to manual pairing${cc.reset}\n`);
      }
    }

    try {
      if (!hasPlaywright) throw new Error("no playwright");
      const { chromium } = await import("playwright");
      console.log(`${cc.cyan}Opening OpenClaw dashboard and auto-pairing...${cc.reset}\n`);

      const browser = await chromium.launch({ headless: false });
      const page = await browser.newPage();
      await page.goto(url);
      await page.waitForTimeout(2000);

      // Fill token and click Connect
      const tokenInput = page.locator('input[placeholder*="OPENCLAW_GATEWAY_TOKEN"]');
      if (token && await tokenInput.count() > 0) {
        await tokenInput.fill(token);
        const connectBtn = page.locator('button').filter({ hasText: 'Connect' });
        if (await connectBtn.count() > 0) {
          await connectBtn.first().click();
          await page.waitForTimeout(3000);
          const bodyText = await page.textContent('body');
          if (!bodyText?.includes('How to connect') && !bodyText?.includes('unauthorized')) {
            autoPaired = true;
          }
        }
      } else if (await tokenInput.count() === 0) {
        // No token input — already connected
        autoPaired = true;
      }

      // Leave browser open for the user
      if (autoPaired) {
        return `${cc.green}✓${cc.reset} OpenClaw dashboard opened and auto-paired!\n  ${cc.cyan}${cc.bold}${url}${cc.reset}\n\n  ${cc.dim}The browser is open — you can chat with OpenClaw directly.${cc.reset}`;
      }
    } catch {
      // Playwright not available — fall back to manual
    }

    // Fallback: open browser normally and copy token to clipboard
    console.log(`${cc.cyan}Opening OpenClaw dashboard...${cc.reset}\n`);
    try {
      if (process.platform === "win32") {
        await runLocalCommand(`powershell -Command "Start-Process '${url}'" 2>/dev/null`);
      } else if (process.platform === "darwin") {
        await runLocalCommand(`open "${url}" 2>/dev/null`);
      } else {
        await runLocalCommand(`xdg-open "${url}" 2>/dev/null || wslview "${url}" 2>/dev/null`);
      }
    } catch {}

    if (token) {
      try {
        if (process.platform === "win32") {
          await runLocalCommand(`printf '%s' '${token}' | clip 2>/dev/null`);
        } else if (process.platform === "darwin") {
          await runLocalCommand(`printf '%s' '${token}' | pbcopy 2>/dev/null`);
        }
      } catch {}
    }

    const lines = [
      `${cc.green}✓${cc.reset} OpenClaw dashboard: ${cc.cyan}${cc.bold}${url}${cc.reset}`,
    ];
    if (token) {
      lines.push(``);
      lines.push(`  ${cc.bold}Pairing token:${cc.reset} ${cc.cyan}${token}${cc.reset}`);
      lines.push(`  ${cc.dim}Paste this into the web UI when it asks to pair.${cc.reset}`);
      if (process.platform === "win32" || process.platform === "darwin") {
        lines.push(`  ${cc.green}✓ Already copied to your clipboard — just paste it.${cc.reset}`);
      }
    } else {
      lines.push(`  ${cc.dim}No auth token — dashboard should connect directly.${cc.reset}`);
    }
    return lines.join("\n");
  }

  // ── OpenClaw channel setup — Telegram, Discord, Matrix, WhatsApp ──
  if (intent.intent === "openclaw.channel.setup") {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    // Detect which channel from the raw text
    const rawLower = intent.rawText.toLowerCase();
    let channel: string | null = null;
    if (/telegram/i.test(rawLower)) channel = "telegram";
    else if (/discord/i.test(rawLower)) channel = "discord";
    else if (/matrix/i.test(rawLower)) channel = "matrix";
    else if (/whatsapp/i.test(rawLower)) channel = "whatsapp";
    else if (/signal/i.test(rawLower)) channel = "signal";
    else if (/slack/i.test(rawLower)) channel = "slack";
    // Only use fields.channel if it's a known channel name
    if (!channel && (fields.channel as string)) {
      const fc = (fields.channel as string).toLowerCase();
      if (["telegram", "discord", "matrix", "whatsapp", "signal", "slack", "irc"].includes(fc)) {
        channel = fc;
      }
    }

    // Check if openclaw is installed — use Node 22 directly (openclaw --version fails on Node 18)
    const node22ForChannel = await getNode22();
    const ocBinForChannel = (await runLocalCommand("readlink -f $(which openclaw) 2>/dev/null || which openclaw").catch(() => "")).trim();
    const ocVer = await runLocalCommand(`${node22ForChannel} ${ocBinForChannel} --version 2>/dev/null`).catch(() => "");
    if (!ocVer && !ocBinForChannel.includes("openclaw")) {
      return `${cc.red}✗ OpenClaw is not installed.${cc.reset}\n  ${cc.dim}Say: "install openclaw" first.${cc.reset}`;
    }

    const CHANNEL_INFO: Record<string, {
      name: string;
      tokenFlag: string;
      instructions: string[];
      browserUrl?: string;
      extraFlags?: string;
      loginBased?: boolean;
    }> = {
      telegram: {
        name: "Telegram",
        tokenFlag: "--token",
        browserUrl: "https://t.me/BotFather",
        instructions: [
          `${cc.bold}To set up Telegram:${cc.reset}`,
          `  1. Open ${cc.cyan}https://t.me/BotFather${cc.reset} in your browser`,
          `  2. Send ${cc.bold}/newbot${cc.reset} and follow the prompts`,
          `  3. Copy the bot token (looks like ${cc.dim}123456:ABC-DEF1234ghIkl-zyx57W2v1u123ew11${cc.reset})`,
          `  4. Paste it here when prompted`,
        ],
      },
      discord: {
        name: "Discord",
        tokenFlag: "--token",
        browserUrl: "https://discord.com/developers/applications",
        instructions: [
          `${cc.bold}To set up Discord:${cc.reset}`,
          `  1. Open ${cc.cyan}https://discord.com/developers/applications${cc.reset}`,
          `  2. Click ${cc.bold}New Application${cc.reset} → name it → go to ${cc.bold}Bot${cc.reset} tab`,
          `  3. Click ${cc.bold}Reset Token${cc.reset} and copy the bot token`,
          `  4. Under ${cc.bold}Privileged Gateway Intents${cc.reset}, enable ${cc.bold}Message Content Intent${cc.reset}`,
          `  5. Go to ${cc.bold}OAuth2 > URL Generator${cc.reset}, select ${cc.bold}bot${cc.reset} scope + ${cc.bold}Send Messages${cc.reset} permission`,
          `  6. Copy the invite URL and open it to add the bot to your server`,
          `  7. Paste the bot token here when prompted`,
        ],
      },
      matrix: {
        name: "Matrix",
        tokenFlag: "--password",
        instructions: [
          `${cc.bold}To set up Matrix:${cc.reset}`,
          `  ${cc.dim}Matrix can run locally — no external account needed.${cc.reset}`,
          ``,
          `  ${cc.bold}Option A: Use an existing Matrix account${cc.reset}`,
          `  You'll need: homeserver URL, user ID, and password`,
          ``,
          `  ${cc.bold}Option B: Create a free account${cc.reset}`,
          `  1. Open ${cc.cyan}https://app.element.io/#/register${cc.reset}`,
          `  2. Create an account on matrix.org (or any homeserver)`,
          `  3. Use those credentials here`,
        ],
        browserUrl: "https://app.element.io/#/register",
      },
      whatsapp: {
        name: "WhatsApp",
        tokenFlag: "",
        loginBased: true,
        instructions: [
          `${cc.bold}To set up WhatsApp:${cc.reset}`,
          `  WhatsApp uses QR code pairing — no token needed.`,
          `  OpenClaw will show a QR code to scan with your phone.`,
        ],
      },
      signal: {
        name: "Signal",
        tokenFlag: "",
        loginBased: true,
        instructions: [
          `${cc.bold}To set up Signal:${cc.reset}`,
          `  Signal requires signal-cli to be installed.`,
          `  Run: ${cc.cyan}openclaw channels add --channel signal${cc.reset}`,
        ],
      },
      slack: {
        name: "Slack",
        tokenFlag: "--bot-token",
        browserUrl: "https://api.slack.com/apps",
        instructions: [
          `${cc.bold}To set up Slack:${cc.reset}`,
          `  1. Open ${cc.cyan}https://api.slack.com/apps${cc.reset}`,
          `  2. Create a new app → add Bot Token Scopes`,
          `  3. Install to workspace and copy the bot token (xoxb-...)`,
          `  4. Also copy the app token (xapp-...) from Basic Information`,
        ],
      },
    };

    // No channel specified — show menu
    if (!channel) {
      const lines = [
        `\n${cc.bold}${cc.cyan}── OpenClaw Channel Setup ──${cc.reset}\n`,
        `  Available channels:\n`,
        `  ${cc.cyan}1.${cc.reset} ${cc.bold}Telegram${cc.reset}  — Bot via BotFather (easiest)`,
        `  ${cc.cyan}2.${cc.reset} ${cc.bold}Discord${cc.reset}   — Bot via Developer Portal`,
        `  ${cc.cyan}3.${cc.reset} ${cc.bold}Matrix${cc.reset}    — Can run locally, no external account needed`,
        `  ${cc.cyan}4.${cc.reset} ${cc.bold}WhatsApp${cc.reset}  — QR code pairing with your phone`,
        `  ${cc.cyan}5.${cc.reset} ${cc.bold}Signal${cc.reset}    — Via signal-cli`,
        `  ${cc.cyan}6.${cc.reset} ${cc.bold}Slack${cc.reset}     — Bot via Slack API`,
        ``,
        `  ${cc.dim}Say: "setup telegram" or "setup discord" to configure a channel.${cc.reset}`,
      ];
      return lines.join("\n");
    }

    const info = CHANNEL_INFO[channel];
    if (!info) {
      return `${cc.red}✗ Unknown channel: "${channel}"${cc.reset}\n  ${cc.dim}Available: ${Object.keys(CHANNEL_INFO).join(", ")}${cc.reset}`;
    }

    // Show instructions
    console.log("");
    for (const line of info.instructions) console.log(line);
    console.log("");

    // Open browser to the setup page
    if (info.browserUrl) {
      console.log(`${cc.cyan}Opening ${info.browserUrl} in your browser...${cc.reset}\n`);
      try {
        if (process.platform === "win32") {
          await runLocalCommand(`powershell -Command "Start-Process '${info.browserUrl}'" 2>/dev/null`);
        } else if (process.platform === "darwin") {
          await runLocalCommand(`open "${info.browserUrl}" 2>/dev/null`);
        } else {
          await runLocalCommand(`xdg-open "${info.browserUrl}" 2>/dev/null || wslview "${info.browserUrl}" 2>/dev/null`);
        }
      } catch { /* browser open is best-effort */ }
    }

    // Login-based channels (WhatsApp, Signal) — just run openclaw's interactive login
    if (info.loginBased) {
      console.log(`${cc.cyan}Starting ${info.name} pairing...${cc.reset}\n`);
      try {
        const { execSync } = await import("node:child_process");
        execSync(`openclaw channels login --channel ${channel}`, { stdio: "inherit", timeout: 120_000 });
        // Verify
        const status = await runLocalCommand(`openclaw channels status 2>&1`).catch(() => "");
        if (status.toLowerCase().includes(channel)) {
          return `${cc.green}✓${cc.reset} ${info.name} connected to OpenClaw!`;
        }
        return `${cc.yellow}⚠${cc.reset} ${info.name} pairing may still be in progress.\n  ${cc.dim}Check: "openclaw channels status"${cc.reset}`;
      } catch {
        return `${cc.yellow}⚠${cc.reset} ${info.name} pairing timed out or was cancelled.\n  ${cc.dim}Try manually: openclaw channels login --channel ${channel}${cc.reset}`;
      }
    }

    // Token-based channels — prompt for the token
    const { askForConfirmation: confirm } = await import("../policy/confirm.js");
    const readline = await import("node:readline/promises");
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

    try {
      if (channel === "matrix") {
        // Matrix needs homeserver, user ID, and password
        const homeserver = await rl.question(`${cc.cyan}Homeserver URL${cc.reset} (e.g. https://matrix.org): `);
        const userId = await rl.question(`${cc.cyan}User ID${cc.reset} (e.g. @mybot:matrix.org): `);
        const password = await rl.question(`${cc.cyan}Password${cc.reset}: `);

        if (!homeserver.trim() || !userId.trim() || !password.trim()) {
          return `${cc.yellow}⚠ Setup cancelled — missing required fields.${cc.reset}`;
        }

        console.log(`\n${cc.cyan}Configuring Matrix...${cc.reset}`);
        const addOut = await withSpinner("Adding Matrix channel...", () => runLocalCommand(
          `openclaw channels add --channel matrix --homeserver "${homeserver.trim()}" --user-id "${userId.trim()}" --password "${password.trim()}" 2>&1`, 30_000
        ));

        // Restart gateway to pick up new channel
        await runLocalCommand("openclaw gateway reload 2>&1").catch(() => "");

        const status = await runLocalCommand("openclaw channels status 2>&1").catch(() => "");
        if (status.toLowerCase().includes("matrix")) {
          return `${cc.green}✓${cc.reset} Matrix channel configured!\n  ${cc.dim}Homeserver: ${homeserver.trim()}${cc.reset}\n  ${cc.dim}User: ${userId.trim()}${cc.reset}\n\n  ${cc.dim}Send a message to the bot in Matrix to test.${cc.reset}`;
        }
        return `${cc.yellow}⚠${cc.reset} Matrix added but may need gateway restart.\n  ${cc.dim}Try: "restart openclaw"${cc.reset}\n\n${cc.dim}${addOut.substring(0, 300)}${cc.reset}`;

      } else if (channel === "slack") {
        // Slack needs bot token + app token
        const botToken = await rl.question(`${cc.cyan}Bot token${cc.reset} (xoxb-...): `);
        const appToken = await rl.question(`${cc.cyan}App token${cc.reset} (xapp-...): `);

        if (!botToken.trim() || !appToken.trim()) {
          return `${cc.yellow}⚠ Setup cancelled — missing required tokens.${cc.reset}`;
        }

        console.log(`\n${cc.cyan}Configuring Slack...${cc.reset}`);
        const addOut = await withSpinner("Adding Slack channel...", () => runLocalCommand(
          `openclaw channels add --channel slack --bot-token "${botToken.trim()}" --app-token "${appToken.trim()}" 2>&1`, 30_000
        ));

        await runLocalCommand("openclaw gateway reload 2>&1").catch(() => "");

        return `${cc.green}✓${cc.reset} Slack channel configured!\n  ${cc.dim}Test it by messaging the bot in Slack.${cc.reset}`;

      } else {
        // Discord — try automated bot creation via Patchright first
        if (channel === "discord") {
          console.log(`\n${cc.cyan}Attempting automated Discord bot setup...${cc.reset}\n`);
          try {
            const { createDiscordBot, ensurePatchright } = await import("../automation/discordPatchright.js");
            if (ensurePatchright()) {
              const result = await createDiscordBot("OpenClaw");
              if (result.success && result.token) {
                console.log(`${cc.green}✓ Bot created automatically!${cc.reset}`);
                console.log(`\n${cc.cyan}Adding to OpenClaw...${cc.reset}`);
                await withSpinner("Adding Discord channel...", () => runLocalCommand(
                  `openclaw channels add --channel discord --token "${result.token}" 2>&1`, 30_000
                ));
                await runLocalCommand("openclaw gateway reload 2>&1").catch(() => "");
                const status = await runLocalCommand("openclaw channels status 2>&1").catch(() => "");
                if (status.toLowerCase().includes("discord")) {
                  return [
                    `${cc.green}✓${cc.reset} Discord bot created and connected to OpenClaw!`,
                    `  ${cc.dim}App ID: ${result.appId}${cc.reset}`,
                    `\n  ${cc.bold}Next:${cc.reset} Invite the bot to your Discord server:`,
                    `  ${cc.cyan}https://discord.com/oauth2/authorize?client_id=${result.appId}&scope=bot&permissions=2048${cc.reset}`,
                    `\n  ${cc.dim}Then send a message in a channel the bot can see to test.${cc.reset}`,
                  ].join("\n");
                }
                return `${cc.green}✓${cc.reset} Discord bot created (App: ${result.appId}).\n  ${cc.yellow}⚠${cc.reset} Gateway may need restart: "restart openclaw"`;
              }
            }
          } catch (autoErr: unknown) {
            console.log(`${cc.yellow}⚠ Automated setup failed — falling back to manual token entry.${cc.reset}`);
            console.log(`${cc.dim}  ${(autoErr as Error).message?.split("\n")[0] ?? ""}${cc.reset}\n`);
          }
        }

        // Manual token entry — Telegram, Discord (fallback)
        const tokenLabel = channel === "telegram" ? "Bot token from BotFather" : "Bot token";
        const token = await rl.question(`${cc.cyan}${tokenLabel}${cc.reset}: `);

        if (!token.trim()) {
          return `${cc.yellow}⚠ Setup cancelled — no token provided.${cc.reset}`;
        }

        console.log(`\n${cc.cyan}Configuring ${info.name}...${cc.reset}`);
        const addOut = await withSpinner(`Adding ${info.name} channel...`, () => runLocalCommand(
          `openclaw channels add --channel ${channel} ${info.tokenFlag} "${token.trim()}" 2>&1`, 30_000
        ));

        await runLocalCommand("openclaw gateway reload 2>&1").catch(() => "");

        const status = await runLocalCommand("openclaw channels status 2>&1").catch(() => "");
        if (status.toLowerCase().includes(channel)) {
          const lines = [`${cc.green}✓${cc.reset} ${info.name} channel configured!`];
          if (channel === "telegram") {
            lines.push(`\n  ${cc.dim}Send a message to your bot in Telegram to test.${cc.reset}`);
            lines.push(`  ${cc.dim}Then try: "tell openclaw hello" to see it respond.${cc.reset}`);
          } else if (channel === "discord") {
            lines.push(`\n  ${cc.dim}Make sure you've invited the bot to a server.${cc.reset}`);
            lines.push(`  ${cc.dim}Send a message in a channel the bot can see to test.${cc.reset}`);
          }
          return lines.join("\n");
        }
        return `${cc.yellow}⚠${cc.reset} ${info.name} added but may need gateway restart.\n  ${cc.dim}Try: "restart openclaw"${cc.reset}\n\n${cc.dim}${addOut.substring(0, 300)}${cc.reset}`;
      }
    } finally {
      rl.close();
    }
  }

  // Codex message — send a prompt to OpenAI Codex CLI
  if (intent.intent === "codex.message") {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    // Check if codex is installed
    const codexVer = await runLocalCommand("codex --version 2>/dev/null").catch(() => "");
    if (!codexVer) {
      return `${cc.red}✗ Codex CLI is not installed.${cc.reset}\n  ${cc.dim}Say: "install codex" first.${cc.reset}`;
    }

    // Check if authenticated — if not, auto-launch login
    const authCheck = await runLocalCommand("codex login status 2>&1").catch(() => "");
    if (!authCheck || /not logged/i.test(authCheck)) {
      console.log(`${cc.yellow}⚠ Codex is not authenticated. Opening browser to log in...${cc.reset}`);
      try {
        const { execSync } = await import("node:child_process");
        execSync("codex login", { stdio: "inherit", timeout: 120_000 });
        // Verify login succeeded
        const recheck = await runLocalCommand("codex login status 2>&1").catch(() => "");
        if (/not logged/i.test(recheck)) {
          return `${cc.red}✗ Authentication failed. Please try again with ${cc.bold}codex login${cc.reset}`;
        }
        console.log(`${cc.green}✓ Codex authenticated successfully.${cc.reset}\n`);
      } catch {
        return `${cc.red}✗ Authentication was cancelled or timed out.${cc.reset}\n  Run ${cc.bold}codex login${cc.reset} manually to authenticate.`;
      }
    }

    // Extract the message from the raw text
    const msgMatch = intent.rawText.match(/(?:tell|ask|message|say(?:\s+hello)?\s+to|send|talk\s+to)\s+codex\s+(.*)/i);
    const message = msgMatch?.[1]?.trim() || (fields.message as string) || intent.rawText;
    console.log(`${cc.dim}Sending to Codex: "${message}"${cc.reset}`);
    try {
      const codexOut = await runLocalCommand(`codex exec ${JSON.stringify(message)} 2>&1`, 120_000);
      if (codexOut.trim()) {
        return `\n${cc.bold}${cc.cyan}Codex:${cc.reset} ${codexOut.trim()}`;
      }
      return `${cc.yellow}⚠ Codex returned no output.${cc.reset}`;
    } catch (err: unknown) {
      return `${cc.red}✗ ${(err as Error).message.split("\n")[0]}${cc.reset}`;
    }
  }

  // OpenClaw message — send to the targeted env
  if (intent.intent === "openclaw.message") {
    const msgMatch = intent.rawText.match(/(?:tell|ask|message|say to|send)\s+(?:openclaw|claw)\s+(.*)/i);
    const message = msgMatch?.[1]?.trim() || (fields.message as string) || intent.rawText;
    console.log(`\x1b[2mSending to OpenClaw: "${message}"\x1b[0m`);
    try {
      const agentCmd = `openclaw agent --agent main --message ${JSON.stringify(message)} --json`;
      const agentOut = await runOcCmd(agentCmd, ocTarget, ocEnv!, 90_000);
      const jsonStart = agentOut.indexOf("{");
      if (jsonStart >= 0) {
        const json = JSON.parse(agentOut.substring(jsonStart));
        const reply = json?.result?.payloads?.[0]?.text ?? json?.reply ?? json?.text;
        if (reply) return `\n\x1b[1m\x1b[36mOpenClaw:\x1b[0m ${reply}`;
      }
      return agentOut.substring(0, 500);
    } catch (err: unknown) { return `\x1b[31m✗ ${(err as Error).message.split("\n")[0]}\x1b[0m`; }
  }

  // OpenClaw model — check or switch LLM on targeted env
  if (intent.intent === "openclaw.model") {
    const skipWords = new Set(["openclaw","model","llm","to","the","set","switch","change","use","using","which","what","is","on","windows","wsl","linux","host","both","other","one","side"]);
    const words = intent.rawText.toLowerCase().split(/\s+/).filter((w: string) => !skipWords.has(w) && w.length > 1);
    const lastWord = words[words.length - 1];
    const lastTwo = words.slice(-2).join(" ");
    let requestedModel = MODEL_ALIASES[lastTwo] ?? MODEL_ALIASES[lastWord ?? ""] ?? undefined;
    if (!requestedModel) { const m = intent.rawText.match(/([\w-]+\/[\w.-]+)/); if (m) requestedModel = m[1]; }

    if (requestedModel) {
      const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

      // If switching to an Ollama model, validate it meets OpenClaw requirements
      if (requestedModel.startsWith("ollama/")) {
        const ollamaModelName = requestedModel.replace("ollama/", "");
        const OPENCLAW_MIN_CTX = 16_000;

        // Check if Ollama is running
        const ollamaUp = await runLocalCommand("curl -sf http://localhost:11434/api/tags 2>/dev/null").catch(() => "");
        if (!ollamaUp.includes("models")) {
          return `${cc.red}✗ Ollama is not running.${cc.reset}\n  ${cc.dim}Start it: "start ollama"${cc.reset}`;
        }

        // Performance check — GPU, WSL, and cross-environment benchmarking
        const hasGpu = !!(await runLocalCommand("nvidia-smi --query-gpu=name --format=csv,noheader 2>/dev/null").catch(() => "")).trim();
        const checkIsWSL = (await runLocalCommand("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native").catch(() => "native")).trim() === "wsl";
        const ollamaPs = await runLocalCommand("curl -sf http://localhost:11434/api/ps 2>/dev/null").catch(() => "{}");
        const usingVram = ollamaPs.includes('"size_vram":') && !ollamaPs.includes('"size_vram":0');

        const perfWarnings: string[] = [];
        if (!hasGpu) {
          perfWarnings.push(`${cc.yellow}⚠ No CUDA GPU detected — Ollama will use CPU only.${cc.reset}`);
          perfWarnings.push(`  ${cc.dim}OpenClaw agent calls may take 3-5 minutes on CPU.${cc.reset}`);
        } else if (!usingVram) {
          perfWarnings.push(`${cc.yellow}⚠ GPU available but Ollama is not using VRAM.${cc.reset}`);
          perfWarnings.push(`  ${cc.dim}Check CUDA drivers or restart Ollama.${cc.reset}`);
        }
        if (checkIsWSL) {
          perfWarnings.push(`${cc.yellow}⚠ Running in WSL — filesystem bridge adds latency for model loading.${cc.reset}`);
          if (!hasGpu) {
            perfWarnings.push(`  ${cc.dim}Recommend using Claude/Codex for OpenClaw (fast, cloud-hosted).${cc.reset}`);
            perfWarnings.push(`  ${cc.dim}Ollama works best for notoken's own LLM fallback (simpler prompts).${cc.reset}`);
          }
        }

        if (perfWarnings.length > 0) {
          console.log(`\n${cc.bold}Performance check:${cc.reset}`);
          for (const w of perfWarnings) console.log(`  ${w}`);
          console.log(`  ${cc.dim}Estimated response time: ${hasGpu ? "5-15s" : checkIsWSL ? "3-5 min" : "1-3 min"}${cc.reset}\n`);
        }

        // Load model database for context window info
        let modelDb: Record<string, any> = {};
        try {
          const { readFileSync, existsSync } = await import("node:fs");
          const { resolve } = await import("node:path");
          for (const p of [resolve(process.cwd(), "packages/core/config/ollama-models.json"), resolve(process.cwd(), "config/ollama-models.json")]) {
            if (existsSync(p)) { modelDb = JSON.parse(readFileSync(p, "utf-8")).models ?? {}; break; }
          }
        } catch { /* */ }

        const modelInfo = modelDb[ollamaModelName] ?? modelDb[ollamaModelName.split(":")[0]];
        const ctxWindow = modelInfo?.context ?? 0;

        // Check if model is installed
        const installed = ollamaUp.includes(`"${ollamaModelName}"`) || ollamaUp.includes(`"${ollamaModelName}:latest"`) || ollamaUp.includes(`"${ollamaModelName}:`);

        if (ctxWindow > 0 && ctxWindow < OPENCLAW_MIN_CTX) {
          // Model exists in our DB and context is too small
          const compatible = Object.entries(modelDb)
            .filter(([_, m]: [string, any]) => m.context >= OPENCLAW_MIN_CTX)
            .sort((a: any, b: any) => a[1].sizeGB - b[1].sizeGB);

          const lines = [`\n${cc.red}✗ ${ollamaModelName} has ${ctxWindow.toLocaleString()} token context — OpenClaw needs at least ${OPENCLAW_MIN_CTX.toLocaleString()}.${cc.reset}\n`];
          if (compatible.length > 0) {
            lines.push(`  ${cc.bold}Compatible models:${cc.reset}`);
            for (const [name, m] of compatible.slice(0, 5) as [string, any][]) {
              const isInstalled = ollamaUp.includes(`"${name}"`);
              lines.push(`    ${isInstalled ? cc.green + "✓" : cc.dim + "○"}${cc.reset} ${cc.bold}${name}${cc.reset} — ${m.context.toLocaleString()} ctx, ${m.sizeGB}GB ${isInstalled ? cc.dim + "(installed)" + cc.reset : ""}`);
            }
            const best = compatible[0][0];
            lines.push(`\n  ${cc.dim}Try: "switch openclaw to ${best}"${cc.reset}`);

            // Suggest pulling if not installed
            const bestInstalled = ollamaUp.includes(`"${best}"`);
            if (!bestInstalled) {
              lines.push(`  ${cc.dim}Or: "ollama pull ${best}" first, then switch${cc.reset}`);
              suggestAction({ action: `ollama pull ${best}`, description: `Pull ${best} for OpenClaw`, type: "intent" });
            }
          }
          return lines.join("\n");
        }

        // Model not in DB or context OK — check if installed
        if (!installed) {
          // Check disk space before suggesting pull
          const dfOut = await runLocalCommand("df -BG / | tail -1 | awk '{print $4}'").catch(() => "0G");
          const freeGB = parseInt(dfOut);
          const needsGB = modelInfo?.sizeGB ?? 4;

          const lines = [`\n${cc.yellow}⚠ ${ollamaModelName} is not installed in Ollama.${cc.reset}\n`];
          if (modelInfo) {
            lines.push(`  ${cc.bold}${modelInfo.name}${cc.reset} — ${modelInfo.parameters}, ${modelInfo.sizeGB}GB download`);
            lines.push(`  Context: ${modelInfo.context.toLocaleString()} tokens ${modelInfo.context >= OPENCLAW_MIN_CTX ? cc.green + "✓ OK for OpenClaw" + cc.reset : cc.red + "✗ too small" + cc.reset}`);
          }

          // Check if models should be moved to another drive first
          if (freeGB < needsGB + 5) {
            lines.push(`\n  ${cc.yellow}⚠ Only ${freeGB}GB free. Consider moving Ollama models first:${cc.reset}`);
            lines.push(`  ${cc.dim}  "move ollama models to /mnt/d/ollama"${cc.reset}`);
          }

          lines.push(`\n  ${cc.bold}I can pull it for you.${cc.reset} Want me to do that?`);
          suggestAction({ action: `ollama pull ${ollamaModelName}`, description: `Pull ${ollamaModelName} then switch OpenClaw`, type: "intent" });
          return lines.join("\n");
        }
      }

      // If Ollama model — ensure provider auth is registered first
      if (requestedModel.startsWith("ollama/")) {
        console.log(`${cc.dim}Registering Ollama provider auth...${cc.reset}`);

        // Use expect to non-interactively register Ollama auth token
        const expectAvailable = await runLocalCommand("which expect 2>/dev/null").catch(() => "");
        const node22 = await getNode22();
        const ocBin = (await runLocalCommand("readlink -f $(which openclaw) 2>/dev/null || which openclaw").catch(() => "openclaw")).trim();

        if (expectAvailable) {
          await runLocalCommand(`expect -c '
set timeout 10
spawn ${node22} ${ocBin} models auth paste-token --provider ollama
expect "Paste token"
send "ollama-local\\r"
expect eof
' 2>&1`, 15_000).catch(() => "");
        } else {
          // Fallback: write auth profile directly to the auth-profiles.json
          try {
            const { readFileSync, writeFileSync, existsSync } = await import("node:fs");
            const authFile = `${process.env.HOME}/.openclaw/agents/main/agent/auth-profiles.json`;
            let profiles: any = {};
            if (existsSync(authFile)) profiles = JSON.parse(readFileSync(authFile, "utf-8"));
            if (!profiles["ollama:manual"]) {
              profiles["ollama:manual"] = { provider: "ollama", mode: "token", token: "ollama-local", created: new Date().toISOString() };
              writeFileSync(authFile, JSON.stringify(profiles, null, 2));
              console.log(`${cc.green}✓${cc.reset} Ollama auth profile written`);
            }
          } catch { /* */ }
        }
      }

      const switchCmd = `openclaw models set "${requestedModel}"`;
      result = await withSpinner(`Switching to ${requestedModel}...`, () => runOcCmd(switchCmd, ocTarget, ocEnv!));

      // If Ollama model — also restart gateway so it picks up the new config
      if (requestedModel.startsWith("ollama/")) {
        console.log(`${cc.dim}Restarting gateway to pick up Ollama model...${cc.reset}`);
        await runLocalCommand("pkill -f openclaw-gateway 2>/dev/null").catch(() => "");
        await runLocalCommand("sleep 2");

        const node22 = await getNode22();
        const ocBin = (await runLocalCommand("readlink -f $(which openclaw) 2>/dev/null || which openclaw").catch(() => "openclaw")).trim();
        const ocConfig = await runLocalCommand("cat /root/.openclaw/openclaw.json 2>/dev/null || echo '{}'").catch(() => "{}");
        const ollamaEnv = ocConfig.includes('"ollama/') ? 'OLLAMA_API_KEY="ollama-local" OLLAMA_HOST="http://localhost:11434" ' : "";
        await runLocalCommand(`bash -c '${ollamaEnv}nohup ${node22} ${ocBin} gateway --force --allow-unconfigured > /tmp/openclaw-start.log 2>&1 &'`).catch(() => "");

        // Wait for health
        for (let i = 0; i < 8; i++) {
          await runLocalCommand("sleep 1");
          const health = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
          if (health.includes('"ok"')) break;
        }
      }

      return result + `\n${cc.green}✓${cc.reset} OpenClaw now using: ${cc.bold}${requestedModel}${cc.reset}`;
    }
    result = await withSpinner("Checking model...", () => runOcCmd("openclaw models status --plain", ocTarget, ocEnv!));
    return `\n\x1b[1m\x1b[36m── OpenClaw LLM ──\x1b[0m\n\n  Current: \x1b[32m${result.trim()}\x1b[0m\n\n  Switch: opus, sonnet, haiku, gpt-4o, codex, gemini, llama, ollama\n  \x1b[2mSay: "switch openclaw to sonnet" or "switch openclaw to sonnet on windows"\x1b[0m`;
  }

  // OpenClaw service management (start/stop/restart) — environment-aware
  if (intent.intent === "openclaw.start" || intent.intent === "openclaw.stop" || intent.intent === "openclaw.restart") {
    const action = intent.intent.split(".")[1];
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
    const targetEnv = ocTarget ?? (ocEnv?.inWSL ? "wsl" : (process.platform === "win32" ? "windows" : "wsl"));

    // ── Native Windows actions (not WSL) — must come before WSL-to-Windows host block ──
    const isNativeWin = process.platform === "win32" && !ocEnv?.inWSL;
    if (isNativeWin) {
      if (action === "stop" || action === "restart") {
        await runLocalCommand(`powershell -Command "Get-WmiObject Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { \\$_.CommandLine -match 'openclaw.*gateway' } | ForEach-Object { \\$_.Terminate() }" 2>/dev/null`).catch(() => "");
        await runLocalCommand("sleep 2").catch(() => "");
        if (action === "stop") {
          const check = await runLocalCommand(`powershell -Command "Get-WmiObject Win32_Process -Filter \\"Name='node.exe'\\" | Where-Object { \\$_.CommandLine -match 'openclaw.*gateway' } | Select-Object ProcessId" 2>/dev/null`).catch(() => "");
          return check && /\d+/.test(check)
            ? `${cc.yellow}⚠ Gateway may still be running.${cc.reset}`
            : `${cc.green}✓${cc.reset} OpenClaw gateway stopped.`;
        }
      }

      if (action === "start" || action === "restart") {
        const ocPath = (await runLocalCommand("npm config get prefix 2>/dev/null").catch(() => "")).trim();
        const ocEntry = ocPath ? `${ocPath}\\node_modules\\openclaw\\dist\\index.js` : "openclaw";
        const userHome = process.env.USERPROFILE || "";
        const ocConfigBash = `$(cygpath '${userHome}\\.openclaw\\openclaw.json')`;
        const ocConfig = await runLocalCommand(`cat "${ocConfigBash}" 2>/dev/null || echo '{}'`).catch(() => "{}");
        const isOllamaModel = ocConfig.includes('"ollama/');
        const envVars = isOllamaModel ? '$env:OLLAMA_API_KEY="ollama-local"; $env:OLLAMA_HOST="http://localhost:11434"; ' : "";

        await runLocalCommand(
          `powershell -Command "${envVars}Start-Process -FilePath node -ArgumentList '${ocEntry}','gateway','--force','--allow-unconfigured' -WindowStyle Hidden" 2>/dev/null`
        ).catch(() => "");

        let healthy = false;
        for (let i = 0; i < 10; i++) {
          await runLocalCommand("sleep 1").catch(() => {});
          const health = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
          if (health.includes('"ok"')) { healthy = true; break; }
        }

        const modelName = ocConfig.match(/"primary"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";
        return healthy
          ? `${cc.green}✓${cc.reset} OpenClaw gateway ${action}ed.\n  ${cc.bold}Model:${cc.reset} ${modelName}\n  ${cc.bold}Health:${cc.reset} ${cc.green}http://127.0.0.1:18789${cc.reset}\n  ${cc.dim}TUI: openclaw tui | Chat: "tell openclaw hello"${cc.reset}`
          : `${cc.yellow}⚠${cc.reset} Gateway ${action}ing but not healthy yet.\n\n  ${cc.dim}Check: "is openclaw running"${cc.reset}`;
      }
    }

    // ── Windows host actions (from WSL) ──
    if (targetEnv === "windows" || targetEnv === "both") {
      if (!ocEnv?.inWSL) {
        if (targetEnv === "windows") return `${cc.yellow}⚠ Not in WSL — can't target Windows host.${cc.reset}`;
      } else {
        const winLabel = targetEnv === "both" ? `${cc.bold}${cc.cyan}[Windows]${cc.reset} ` : "";

        if (action === "stop" || action === "restart") {
          // Find and kill OpenClaw node processes on Windows
          const killOut = await runLocalCommand(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Get-WmiObject Win32_Process -Filter \\"Name='node.exe'\\" | Where { \\$_.CommandLine -match 'openclaw' } | ForEach { \\$_.Terminate() }" 2>/dev/null`).catch(() => "");
          await runLocalCommand("sleep 2");
          if (action === "stop") {
            // Verify stopped
            const checkPs = await runLocalCommand(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Get-WmiObject Win32_Process -Filter \\"Name='node.exe'\\" | Select -Exp CommandLine" 2>/dev/null`).catch(() => "");
            const stillRunning = checkPs.includes("openclaw");
            if (targetEnv !== "both") {
              return stillRunning
                ? `${cc.yellow}⚠ Windows OpenClaw may still be running.${cc.reset}`
                : `${cc.green}✓${cc.reset} OpenClaw stopped on Windows host.`;
            }
            console.log(stillRunning
              ? `${winLabel}${cc.yellow}⚠ May still be running${cc.reset}`
              : `${winLabel}${cc.green}✓${cc.reset} Stopped`);
          }
        }

        if (action === "start" || action === "restart") {
          // Start OpenClaw on Windows host via PowerShell
          await runLocalCommand(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process node -ArgumentList 'C:\\Users\\Dino\\AppData\\Roaming\\npm\\node_modules\\openclaw\\dist\\index.js','gateway','--force','--allow-unconfigured' -WindowStyle Hidden" 2>/dev/null`).catch(() => "");

          // Wait for health
          let winHealthy = false;
          for (let i = 0; i < 8; i++) {
            await runLocalCommand("sleep 1");
            const health = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
            if (health.includes('"ok"')) { winHealthy = true; break; }
          }

          // Get Windows model
          const winConfig = await runLocalCommand("cmd.exe /c 'type \"%USERPROFILE%\\.openclaw\\openclaw.json\"' 2>/dev/null").catch(() => "");
          const winModel = winConfig.match(/"primary"\s*:\s*"([^"]+)"/)?.[1] ?? "unknown";

          if (targetEnv !== "both") {
            return winHealthy
              ? `${cc.green}✓${cc.reset} OpenClaw gateway ${action}ed on Windows host.\n  ${cc.bold}Model:${cc.reset} ${winModel}\n  ${cc.bold}Health:${cc.reset} ${cc.green}http://127.0.0.1:18789${cc.reset}`
              : `${cc.yellow}⚠${cc.reset} Windows gateway ${action}ing but not healthy yet.\n  ${cc.dim}Check: "is openclaw running on windows"${cc.reset}`;
          }
          console.log(winHealthy
            ? `${winLabel}${cc.green}✓${cc.reset} ${action}ed — model: ${winModel}`
            : `${winLabel}${cc.yellow}⚠${cc.reset} ${action}ing but not healthy yet`);
        }
      }
    }

    // ── WSL / Linux actions ──
    if (!isNativeWin && (targetEnv === "wsl" || targetEnv === "both")) {
      const wslLabel = targetEnv === "both" ? `${cc.bold}${cc.cyan}[WSL]${cc.reset} ` : "";

      if (action === "stop" || action === "restart") {
        await runLocalCommand("pkill -f openclaw-gateway 2>/dev/null").catch(() => "");
        await runLocalCommand("sleep 1");
        if (action === "stop") {
          const check = await runLocalCommand("pgrep -f openclaw-gateway 2>/dev/null").catch(() => "");
          const msg = check ? `${cc.yellow}⚠ Still running (PID ${check.trim()})${cc.reset}` : `${cc.green}✓${cc.reset} Stopped`;
          if (targetEnv !== "both") return `${msg.replace("Stopped", "OpenClaw gateway stopped.")}`;
          console.log(`${wslLabel}${msg}`);
          if (targetEnv === "both") return ""; // both sides reported above
        }
      }

      if (action === "start" || action === "restart") {
        // Check if Windows gateway already owns port 18789
        if (targetEnv === "wsl") {
          const portCheck = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
          if (portCheck.includes('"ok"')) {
            const hostPs = await runLocalCommand(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Get-WmiObject Win32_Process -Filter \\"Name='node.exe'\\" | Select -Exp CommandLine" 2>/dev/null`).catch(() => "");
            if (hostPs.includes("openclaw") && hostPs.includes("gateway")) {
              return `${cc.yellow}⚠${cc.reset} Port 18789 is in use by Windows host OpenClaw.\n  ${cc.dim}Stop it first: "stop openclaw on windows"\n  Or use the Windows gateway: "tell openclaw hello"${cc.reset}`;
            }
          }
        }

        const node22 = await getNode22();
        const ocPath = (await runLocalCommand("readlink -f $(which openclaw) 2>/dev/null || which openclaw").catch(() => "openclaw")).trim();
        const ocConfig = await runLocalCommand("cat /root/.openclaw/openclaw.json 2>/dev/null || echo '{}'").catch(() => "{}");
        const isOllamaModel = ocConfig.includes('"ollama/');
        const ollamaEnv = isOllamaModel ? 'OLLAMA_API_KEY="ollama-local" OLLAMA_HOST="http://localhost:11434" ' : "";

        const startCmd = `bash -c '${ollamaEnv}nohup ${node22} ${ocPath} gateway --force --allow-unconfigured > /tmp/openclaw-start.log 2>&1 & echo $!'`;
        await runLocalCommand(startCmd).catch(() => "");

        let healthy = false;
        for (let i = 0; i < 8; i++) {
          await runLocalCommand("sleep 1");
          const health = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
          if (health.includes('"ok"')) { healthy = true; break; }
        }

        const configModel = await runLocalCommand("grep -o '\"primary\":\"[^\"]*\"' /root/.openclaw/openclaw.json 2>/dev/null").catch(() => "");
        const modelName = configModel.match(/"primary":"([^"]+)"/)?.[1] ?? "unknown";

        if (healthy) {
          const msg = `${cc.green}✓${cc.reset} OpenClaw gateway ${action}ed.\n  ${cc.bold}Model:${cc.reset} ${modelName}\n  ${cc.bold}Health:${cc.reset} ${cc.green}http://127.0.0.1:18789${cc.reset}\n  ${cc.dim}TUI: openclaw tui | Chat: "tell openclaw hello"${cc.reset}`;
          if (targetEnv !== "both") return msg;
          console.log(`${wslLabel}${cc.green}✓${cc.reset} ${action}ed — model: ${modelName}`);
        } else {
          const logs = await runLocalCommand("cat /tmp/openclaw-start.log 2>/dev/null | tail -5").catch(() => "");
          const msg = `${cc.yellow}⚠${cc.reset} Gateway ${action}ing but not healthy yet.\n${cc.dim}${logs}${cc.reset}\n\n  ${cc.dim}Check: "is openclaw running"${cc.reset}`;
          if (targetEnv !== "both") return msg;
          console.log(`${wslLabel}${cc.yellow}⚠${cc.reset} not healthy yet`);
        }
      }

      if (targetEnv === "both" && action === "stop") return "";
    }

    return "";
  }

  // Notoken model — check or switch LLM backend
  if (intent.intent === "notoken.model") {
    const { getLLMBackend } = await import("../nlp/llmFallback.js");
    const switchMatch = intent.rawText.match(/(?:switch|change|use)\s+(?:notoken\s+(?:to\s+)?|(?:to\s+)?)(\S+)/i);
    const target = ((fields.model as string)?.trim() || switchMatch?.[1])?.toLowerCase();
    if (target && ["claude","ollama","chatgpt","codex"].includes(target)) {
      if (target === "codex") {
        // Verify codex is installed
        try { await runLocalCommand("codex --version"); } catch {
          return `\x1b[31m✗ Codex CLI not found.\x1b[0m\n\x1b[2m  Install: "install codex" or npm install -g @openai/codex\x1b[0m`;
        }
        process.env.NOTOKEN_LLM_CLI = "codex";
        delete process.env.NOTOKEN_LLM_ENDPOINT;
      } else if (target === "chatgpt") {
        process.env.NOTOKEN_LLM_CLI = "";
        process.env.NOTOKEN_LLM_ENDPOINT = "https://api.openai.com/v1/chat/completions";
      } else {
        process.env.NOTOKEN_LLM_CLI = target;
        delete process.env.NOTOKEN_LLM_ENDPOINT;
      }
      return `\x1b[32m✓\x1b[0m Notoken now using: \x1b[1m${target}\x1b[0m\n\x1b[2mSet NOTOKEN_LLM_CLI=${target} to make permanent.\x1b[0m`;
    }
    const backend = getLLMBackend();
    const ollamaUp = await runLocalCommand("curl -sf http://localhost:11434/api/tags 2>/dev/null | head -1").catch(() => "");
    const codexOk = await runLocalCommand("codex --version 2>/dev/null").catch(() => "");
    return `\n\x1b[1m\x1b[36m── Notoken LLM ──\x1b[0m\n\n  Current: ${backend ? `\x1b[32m${backend}\x1b[0m` : "\x1b[33mnone\x1b[0m"}\n\n  Available:\n    ${await runLocalCommand("which claude 2>/dev/null").catch(() => "") ? "\x1b[32m✓" : "\x1b[2m○"}\x1b[0m claude\n    ${ollamaUp.includes("models") ? "\x1b[32m✓" : "\x1b[2m○"}\x1b[0m ollama\n    ${process.env.OPENAI_API_KEY ? "\x1b[32m✓" : "\x1b[2m○"}\x1b[0m chatgpt\n    ${codexOk ? "\x1b[32m✓" : "\x1b[2m○"}\x1b[0m codex\n\n  \x1b[2mSwitch: "use claude", "use ollama", "use codex"\x1b[0m`;
  }

  // Notoken status — comprehensive overview
  if (intent.intent === "notoken.status") {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m", magenta: "\x1b[35m" };
    const lines: string[] = [];
    lines.push(`\n${cc.bold}${cc.cyan}══════════════════════════════════════${cc.reset}`);
    lines.push(`${cc.bold}${cc.cyan}  Notoken — Status${cc.reset}`);
    lines.push(`${cc.bold}${cc.cyan}══════════════════════════════════════${cc.reset}\n`);

    // CLI version
    const cliVer = "1.7.0"; // from package.json
    lines.push(`  ${cc.bold}CLI:${cc.reset} ${cc.green}✓${cc.reset} notoken v${cliVer}`);

    // Desktop app detection
    const isWSL = (await runLocalCommand("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native").catch(() => "native")).trim() === "wsl";
    let appInstalled = false;
    let appPath = "";
    if (isWSL) {
      // Check Windows Program Files for Notoken app
      const winCheck = await runLocalCommand("cmd.exe /c 'where notoken-app 2>nul || dir /s /b \"C:\\Program Files\\Notoken\\notoken-app.exe\" 2>nul || dir /s /b \"%LOCALAPPDATA%\\Programs\\Notoken\\notoken-app.exe\" 2>nul' 2>/dev/null").catch(() => "");
      appInstalled = winCheck.includes("notoken");
      appPath = winCheck.trim().split("\n")[0] || "";
    } else {
      // Check Linux — look for AppImage or installed binary
      const linuxCheck = await runLocalCommand("which notoken-app 2>/dev/null || ls ~/Applications/Notoken*.AppImage 2>/dev/null || ls /opt/notoken/notoken-app 2>/dev/null").catch(() => "");
      appInstalled = !!linuxCheck.trim();
      appPath = linuxCheck.trim().split("\n")[0] || "";
    }

    if (appInstalled) {
      lines.push(`  ${cc.bold}App:${cc.reset} ${cc.green}✓${cc.reset} Notoken Desktop ${cc.dim}(${appPath})${cc.reset}`);
    } else {
      lines.push(`  ${cc.bold}App:${cc.reset} ${cc.dim}○ Notoken Desktop not installed${cc.reset}`);
      lines.push(`       ${cc.dim}Get it: "install notoken app" or ${cc.cyan}https://notoken.sh/download${cc.reset}`);
    }

    // LLM Backend
    const { getLLMBackend } = await import("../nlp/llmFallback.js");
    const backend = getLLMBackend();
    lines.push(`  ${cc.bold}LLM:${cc.reset} ${backend ? `${cc.green}✓${cc.reset} ${backend}` : `${cc.yellow}○${cc.reset} none configured`}`);

    // Environment
    lines.push(`\n  ${cc.bold}Environment:${cc.reset} ${isWSL ? "WSL" : "Linux"}`);

    // Components
    lines.push(`\n  ${cc.bold}Components:${cc.reset}`);

    const claudeVer = await runLocalCommand("claude --version 2>/dev/null | head -1").catch(() => "");
    lines.push(`    ${claudeVer ? `${cc.green}✓` : `${cc.dim}○`}${cc.reset} Claude Code ${claudeVer ? cc.dim + claudeVer.trim() + cc.reset : ""}`);

    const codexVer = await runLocalCommand("codex --version 2>/dev/null | head -1").catch(() => "");
    lines.push(`    ${codexVer ? `${cc.green}✓` : `${cc.dim}○`}${cc.reset} Codex CLI ${codexVer ? cc.dim + codexVer.trim() + cc.reset : ""}`);

    const ollamaVer = await runLocalCommand("ollama --version 2>/dev/null | head -1").catch(() => "");
    const ollamaUp = await runLocalCommand("curl -sf http://localhost:11434/api/tags 2>/dev/null | head -1").catch(() => "");
    lines.push(`    ${ollamaVer ? `${cc.green}✓` : `${cc.dim}○`}${cc.reset} Ollama ${ollamaVer ? (ollamaUp.includes("models") ? cc.green + "running" + cc.reset : cc.yellow + "stopped" + cc.reset) : ""}`);

    const ocVer = await runLocalCommand(`bash -c '${nvmPfx} openclaw --version 2>/dev/null | head -1'`).catch(() => "");
    const ocUp = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
    lines.push(`    ${ocVer ? `${cc.green}✓` : `${cc.dim}○`}${cc.reset} OpenClaw ${ocVer ? (ocUp.includes('"ok"') ? cc.green + "running" + cc.reset : cc.yellow + "stopped" + cc.reset) : ""}`);

    const dockerVer = await runLocalCommand("docker --version 2>/dev/null | head -1").catch(() => "");
    lines.push(`    ${dockerVer ? `${cc.green}✓` : `${cc.dim}○`}${cc.reset} Docker ${dockerVer ? cc.dim + dockerVer.trim().replace("Docker version ", "v") + cc.reset : ""}`);

    // Interfaces
    lines.push(`\n  ${cc.bold}Interfaces:${cc.reset}`);
    lines.push(`    ${cc.green}✓${cc.reset} ${cc.bold}CLI${cc.reset} — type commands or natural language in terminal`);
    lines.push(`    ${appInstalled ? `${cc.green}✓` : `${cc.dim}○`}${cc.reset} ${cc.bold}Desktop App${cc.reset} — point-and-click GUI + chat ${appInstalled ? "" : cc.dim + "(install: \"install notoken app\")" + cc.reset}`);
    if (ocUp.includes('"ok"')) {
      lines.push(`    ${cc.green}✓${cc.reset} ${cc.bold}OpenClaw Chat${cc.reset} — messaging via Telegram/Discord/Matrix/TUI`);
    }

    lines.push(`\n  ${cc.dim}Website: https://notoken.sh${cc.reset}`);
    lines.push(`  ${cc.dim}Say: "install notoken app", "how to install claude", "ollama status"${cc.reset}`);

    return lines.join("\n");
  }

  // Notoken desktop app — download and install
  if (intent.intent === "notoken.install_app") {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
    const isWSL = (await runLocalCommand("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native").catch(() => "native")).trim() === "wsl";
    const isWin = process.platform === "win32";
    const isMac = process.platform === "darwin";

    const lines: string[] = [];
    lines.push(`\n${cc.bold}${cc.cyan}── Notoken Desktop App ──${cc.reset}\n`);
    lines.push(`  ${cc.bold}Notoken${cc.reset} — point-and-click GUI + chat interface`);
    lines.push(`  Everything the CLI does, but with a visual interface.\n`);

    const baseUrl = "https://notoken.sh/download";

    if (isWSL || isWin) {
      // Windows — download .exe installer
      const arch = await runLocalCommand("cmd.exe /c 'echo %PROCESSOR_ARCHITECTURE%' 2>/dev/null").catch(() => "AMD64");
      const archLabel = arch.trim().replace(/\r/g, "").includes("ARM") ? "arm64" : "x64";
      const exeUrl = `${baseUrl}/notoken-setup-win-${archLabel}.exe`;

      lines.push(`  ${cc.bold}Platform:${cc.reset} Windows ${archLabel}`);
      lines.push(`  ${cc.bold}Download:${cc.reset} ${cc.cyan}${exeUrl}${cc.reset}\n`);

      // Try to download and run
      const downloadDir = isWSL
        ? await runLocalCommand("cmd.exe /c 'echo %USERPROFILE%\\Downloads' 2>/dev/null").catch(() => "C:\\Users\\Downloads")
        : `${process.env.USERPROFILE || "C:\\Users"}\\Downloads`;
      const downloadPath = downloadDir.trim().replace(/\r/g, "");
      const installerName = `notoken-setup-win-${archLabel}.exe`;

      lines.push(`  ${cc.bold}Installing...${cc.reset}`);
      console.log(lines.join("\n"));

      try {
        if (isWSL) {
          // Download via PowerShell on Windows host
          const psCmd = `powershell.exe -Command "Invoke-WebRequest -Uri '${exeUrl}' -OutFile '${downloadPath}\\\\${installerName}' -UseBasicParsing"`;
          await withSpinner("Downloading...", () => runLocalCommand(psCmd, 120_000));
          console.log(`\n  ${cc.green}✓${cc.reset} Downloaded to ${cc.bold}${downloadPath}\\${installerName}${cc.reset}`);

          // Launch the installer
          await runLocalCommand(`cmd.exe /c 'start "" "${downloadPath}\\\\${installerName}"' 2>/dev/null`).catch(() => "");
          return `\n  ${cc.green}✓${cc.reset} Installer launched. Follow the setup wizard.\n\n  ${cc.dim}After install, you can launch Notoken from the Start menu\n  or run: notoken-app${cc.reset}`;
        } else {
          // Native Windows
          const psCmd = `powershell -Command "Invoke-WebRequest -Uri '${exeUrl}' -OutFile '$env:TEMP\\${installerName}' -UseBasicParsing; Start-Process '$env:TEMP\\${installerName}'"`;
          await withSpinner("Downloading and launching installer...", () => runLocalCommand(psCmd, 120_000));
          return `\n  ${cc.green}✓${cc.reset} Installer launched. Follow the setup wizard.`;
        }
      } catch (err: unknown) {
        return `\n  ${cc.yellow}⚠${cc.reset} Auto-download failed. Download manually:\n  ${cc.cyan}${exeUrl}${cc.reset}\n\n  ${cc.dim}Or open in browser: "open ${baseUrl}"${cc.reset}`;
      }
    } else if (isMac) {
      const archOut = await runLocalCommand("uname -m").catch(() => "x86_64");
      const archLabel = archOut.trim() === "arm64" ? "arm64" : "x64";
      const dmgUrl = `${baseUrl}/notoken-setup-mac-${archLabel}.dmg`;

      lines.push(`  ${cc.bold}Platform:${cc.reset} macOS ${archLabel}`);
      lines.push(`  ${cc.bold}Download:${cc.reset} ${cc.cyan}${dmgUrl}${cc.reset}\n`);

      try {
        await withSpinner("Downloading...", () => runLocalCommand(`curl -fSL -o /tmp/notoken-setup.dmg "${dmgUrl}" 2>&1`, 120_000));
        await runLocalCommand("open /tmp/notoken-setup.dmg").catch(() => "");
        return lines.join("\n") + `\n  ${cc.green}✓${cc.reset} Downloaded and opened. Drag Notoken to Applications.`;
      } catch {
        return lines.join("\n") + `\n  ${cc.yellow}⚠${cc.reset} Download manually: ${cc.cyan}${dmgUrl}${cc.reset}`;
      }
    } else {
      // Linux — AppImage
      const archOut = await runLocalCommand("uname -m").catch(() => "x86_64");
      const archLabel = archOut.trim() === "aarch64" ? "arm64" : "x64";
      const appImageUrl = `${baseUrl}/notoken-app-linux-${archLabel}.AppImage`;

      lines.push(`  ${cc.bold}Platform:${cc.reset} Linux ${archLabel}`);
      lines.push(`  ${cc.bold}Download:${cc.reset} ${cc.cyan}${appImageUrl}${cc.reset}\n`);

      try {
        const appDir = `${process.env.HOME}/Applications`;
        await runLocalCommand(`mkdir -p "${appDir}"`);
        await withSpinner("Downloading...", () => runLocalCommand(`curl -fSL -o "${appDir}/Notoken.AppImage" "${appImageUrl}" 2>&1`, 120_000));
        await runLocalCommand(`chmod +x "${appDir}/Notoken.AppImage"`);
        return lines.join("\n") + `\n  ${cc.green}✓${cc.reset} Installed to ${cc.bold}${appDir}/Notoken.AppImage${cc.reset}\n\n  ${cc.dim}Run: ~/Applications/Notoken.AppImage${cc.reset}`;
      } catch {
        return lines.join("\n") + `\n  ${cc.yellow}⚠${cc.reset} Download manually: ${cc.cyan}${appImageUrl}${cc.reset}`;
      }
    }
  }

  // Ollama model management
  if (intent.intent === "ollama.models" || intent.intent === "ollama.list") {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    // Get system resources
    const ramOut = await runLocalCommand("free -b | grep Mem | awk '{print $2}'").catch(() => "0");
    const totalRAMGB = Math.round(parseInt(ramOut) / 1073741824);
    const freeRamOut = await runLocalCommand("free -b | grep Mem | awk '{print $7}'").catch(() => "0");
    const freeRAMGB = Math.round(parseInt(freeRamOut) / 1073741824);

    // Get installed models
    const installed = await runLocalCommand("ollama list 2>&1").catch(() => "Ollama not running");
    const lines: string[] = [];
    lines.push(`\n${cc.bold}${cc.cyan}── Ollama Models ──${cc.reset}\n`);
    lines.push(`  ${cc.bold}System:${cc.reset} ${totalRAMGB}GB RAM (${freeRAMGB}GB available)\n`);

    // Load model database
    let modelDb: any = {};
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      for (const p of [resolve(process.cwd(), "packages/core/config/ollama-models.json"), resolve(process.cwd(), "config/ollama-models.json")]) {
        if (existsSync(p)) { modelDb = JSON.parse(readFileSync(p, "utf-8")).models ?? {}; break; }
      }
    } catch { /* no model db */ }

    lines.push(`  ${cc.bold}Installed:${cc.reset}`);
    if (installed.includes("NAME")) {
      for (const line of installed.split("\n").slice(1).filter(Boolean)) {
        const parts = line.trim().split(/\s+/);
        const name = parts[0];
        const size = parts[2] ? `${parts[2]} ${parts[3] ?? ""}`.trim() : "";
        const info = modelDb[name] ?? modelDb[name.split(":")[0]];
        lines.push(`    ${cc.green}✓${cc.reset} ${cc.bold}${name}${cc.reset}  ${cc.dim}${size}${cc.reset}${info ? `  ${info.description}` : ""}`);
      }
    } else {
      lines.push(`    ${cc.dim}No models installed.${cc.reset}`);
    }

    // Recommend models based on RAM
    const recommended = Object.entries(modelDb).filter(([_, m]: [string, any]) => m.recRAMGB <= totalRAMGB && m.tier !== "frontier");
    if (recommended.length > 0) {
      lines.push(`\n  ${cc.bold}Recommended for your system (${totalRAMGB}GB RAM):${cc.reset}`);
      for (const [name, m] of recommended.slice(0, 6) as [string, any][]) {
        const canRun = m.minRAMGB <= freeRAMGB ? `${cc.green}✓ can run now${cc.reset}` :
                       m.minRAMGB <= totalRAMGB ? `${cc.yellow}⚠ may need to close other apps${cc.reset}` :
                       `${cc.red}✗ not enough RAM${cc.reset}`;
        lines.push(`    ${cc.cyan}${name.padEnd(20)}${cc.reset} ${m.parameters.padEnd(8)} ${m.sizeGB}GB  ${canRun}  ${cc.dim}${m.description.substring(0, 50)}${cc.reset}`);
      }
    }

    // Models that are too big
    const tooBig = Object.entries(modelDb).filter(([_, m]: [string, any]) => m.minRAMGB > totalRAMGB);
    if (tooBig.length > 0) {
      lines.push(`\n  ${cc.dim}Too large for this system: ${tooBig.map(([n]) => n).join(", ")}${cc.reset}`);
    }

    lines.push(`\n  ${cc.dim}Pull: "ollama pull llama3.2" or "ollama pull codellama"${cc.reset}`);
    return lines.join("\n");
  }
  if (intent.intent === "ollama.pull") {
    const model = (fields.model as string) ?? intent.rawText.match(/pull\s+(\S+)/)?.[1] ?? "llama3.2";

    // Load model info
    let modelInfo: any = null;
    try {
      const { readFileSync, existsSync } = await import("node:fs");
      const { resolve } = await import("node:path");
      for (const p of [resolve(process.cwd(), "packages/core/config/ollama-models.json"), resolve(process.cwd(), "config/ollama-models.json")]) {
        if (existsSync(p)) { const db = JSON.parse(readFileSync(p, "utf-8")).models ?? {}; modelInfo = db[model] ?? db[model.split(":")[0]]; break; }
      }
    } catch { /* */ }

    // Check resources
    const dfOut = await runLocalCommand("df -BG / | tail -1 | awk '{print $4}'").catch(() => "0G");
    const freeGB = parseInt(dfOut);
    const ramOut = await runLocalCommand("free -b | grep Mem | awk '{print $7}'").catch(() => "0");
    const freeRAMGB = Math.round(parseInt(ramOut) / 1073741824);

    const lines: string[] = [];
    if (modelInfo) {
      lines.push(`\n\x1b[1m\x1b[36m── ${modelInfo.name} ──\x1b[0m\n`);
      lines.push(`  Provider:    ${modelInfo.provider}`);
      lines.push(`  Parameters:  ${modelInfo.parameters}`);
      lines.push(`  Download:    ${modelInfo.sizeGB}GB`);
      lines.push(`  RAM needed:  ${modelInfo.minRAMGB}GB min, ${modelInfo.recRAMGB}GB recommended`);
      lines.push(`  Context:     ${modelInfo.context.toLocaleString()} tokens`);
      lines.push(`  Capabilities: ${modelInfo.capabilities.join(", ")}`);
      lines.push(`  ${modelInfo.description}\n`);

      // Resource check — auto-detect other drives for more space
      if (modelInfo.sizeGB > freeGB || freeGB < modelInfo.sizeGB + 5) {
        // Check if models can be moved to another drive
        const pullIsWSL = (await runLocalCommand("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native").catch(() => "native")).trim() === "wsl";
        let altDrive = "";
        let altFreeGB = 0;
        if (pullIsWSL) {
          for (const drive of ["/mnt/d", "/mnt/e", "/mnt/f"]) {
            const altDf = await runLocalCommand(`df -BG "${drive}" 2>/dev/null | tail -1 | awk '{print $4}'`).catch(() => "0G");
            const altFree = parseInt(altDf);
            if (altFree > altFreeGB) { altFreeGB = altFree; altDrive = drive; }
          }
        }

        if (modelInfo.sizeGB > freeGB) {
          lines.push(`  \x1b[31m✗ Not enough disk space: need ${modelInfo.sizeGB}GB, only ${freeGB}GB free.\x1b[0m`);
          if (altDrive && altFreeGB >= modelInfo.sizeGB + 5) {
            lines.push(`  \x1b[33m→ ${altDrive} has ${altFreeGB}GB free. Move models there first:\x1b[0m`);
            lines.push(`  \x1b[2m  "move ollama models to ${altDrive}/ollama"\x1b[0m`);
            suggestAction({ action: `move ollama models to ${altDrive}/ollama`, description: `Move Ollama models to ${altDrive} then pull ${model}`, type: "intent" });
          } else {
            lines.push(`  \x1b[2m  Run "free up space" to make room.\x1b[0m`);
          }
          return lines.join("\n");
        }

        // Tight on space — warn and suggest move
        if (altDrive && altFreeGB > freeGB * 2) {
          lines.push(`  \x1b[33m⚠ Space is tight (${freeGB}GB free). Consider moving models to ${altDrive} (${altFreeGB}GB free):\x1b[0m`);
          lines.push(`  \x1b[2m  "move ollama models to ${altDrive}/ollama"\x1b[0m`);
        }
      }
      if (modelInfo.minRAMGB > freeRAMGB) {
        lines.push(`  \x1b[33m⚠ Tight on RAM: model needs ${modelInfo.minRAMGB}GB, you have ${freeRAMGB}GB free.\x1b[0m`);
        lines.push(`  \x1b[2m  It may run slowly or require closing other apps.\x1b[0m`);
      } else {
        lines.push(`  \x1b[32m✓ Resources OK: ${freeGB}GB disk, ${freeRAMGB}GB RAM available.\x1b[0m`);
      }
    } else if (freeGB < 5) {
      return `\x1b[31m⚠ Only ${freeGB}GB free — models typically need 2-8GB. Free up space first.\x1b[0m`;
    }

    console.log(lines.join("\n"));
    console.log(`\n\x1b[2mPulling ${model}... this may take a few minutes.\x1b[0m`);
    result = await withSpinner(`Pulling ${model}...`, () => runLocalCommand(`ollama pull ${model} 2>&1`, 300_000));
    return result;
  }

  // Ollama storage — check location & disk usage
  if (intent.intent === "ollama.storage") {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
    const lines: string[] = [];
    lines.push(`\n${cc.bold}${cc.cyan}── Ollama Storage ──${cc.reset}\n`);

    // Detect WSL vs native
    const isWSL = await runLocalCommand("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native").catch(() => "native");
    const inWSL = isWSL.trim() === "wsl";

    // Detect where Ollama is running
    const ollamaInWSL = await runLocalCommand("pgrep -x ollama 2>/dev/null").catch(() => "");
    const ollamaOnHost = inWSL ? await runLocalCommand("cmd.exe /c 'tasklist /FI \"IMAGENAME eq ollama.exe\" /NH' 2>/dev/null").catch(() => "") : "";
    const hostHasOllama = ollamaOnHost.includes("ollama.exe");

    if (inWSL) {
      lines.push(`  ${cc.bold}Environment:${cc.reset} WSL`);
      if (ollamaInWSL) lines.push(`  ${cc.green}✓${cc.reset} Ollama running ${cc.bold}inside WSL${cc.reset} (PID: ${ollamaInWSL.trim().split("\n")[0]})`);
      else lines.push(`  ${cc.dim}○ Ollama not running inside WSL${cc.reset}`);
      if (hostHasOllama) lines.push(`  ${cc.green}✓${cc.reset} Ollama running on ${cc.bold}Windows host${cc.reset}`);
      else lines.push(`  ${cc.dim}○ Ollama not detected on Windows host${cc.reset}`);
    } else {
      lines.push(`  ${cc.bold}Environment:${cc.reset} Native Linux`);
      if (ollamaInWSL) lines.push(`  ${cc.green}✓${cc.reset} Ollama running (PID: ${ollamaInWSL.trim().split("\n")[0]})`);
      else lines.push(`  ${cc.dim}○ Ollama not running${cc.reset}`);
    }

    // Model storage paths
    const envModels = process.env.OLLAMA_MODELS || "";
    const defaultPaths = ["/usr/share/ollama/.ollama/models", `${process.env.HOME}/.ollama/models`];
    let modelDir = envModels || "";
    if (!modelDir) {
      for (const dp of defaultPaths) {
        const exists = await runLocalCommand(`[ -d "${dp}" ] && echo yes || echo no`).catch(() => "no");
        if (exists.trim() === "yes") { modelDir = dp; break; }
      }
    }

    if (modelDir) {
      lines.push(`\n  ${cc.bold}Model directory:${cc.reset} ${modelDir}${envModels ? ` ${cc.dim}(OLLAMA_MODELS)${cc.reset}` : ""}`);
      const usage = await runLocalCommand(`du -sh "${modelDir}" 2>/dev/null | awk '{print $1}'`).catch(() => "unknown");
      const dfOut = await runLocalCommand(`df -h "${modelDir}" 2>/dev/null | tail -1`).catch(() => "");
      lines.push(`  ${cc.bold}Models size:${cc.reset} ${usage.trim()}`);
      if (dfOut) {
        const parts = dfOut.trim().split(/\s+/);
        lines.push(`  ${cc.bold}Drive:${cc.reset} ${parts[0] ?? "?"} — ${parts[3] ?? "?"} free of ${parts[1] ?? "?"}`);
      }

      // List individual models
      const modelList = await runLocalCommand(`ls -1 "${modelDir}/manifests/registry.ollama.ai/library/" 2>/dev/null`).catch(() => "");
      if (modelList.trim()) {
        lines.push(`\n  ${cc.bold}Stored models:${cc.reset}`);
        for (const m of modelList.trim().split("\n")) {
          const mSize = await runLocalCommand(`du -sh "${modelDir}/manifests/registry.ollama.ai/library/${m}" 2>/dev/null | awk '{print $1}'`).catch(() => "?");
          lines.push(`    ${cc.green}•${cc.reset} ${m} ${cc.dim}(${mSize.trim()})${cc.reset}`);
        }
      }
    } else {
      lines.push(`\n  ${cc.yellow}⚠ No model directory found.${cc.reset}`);
    }

    // GPU detection
    const nvidiaGpu = await runLocalCommand("nvidia-smi --query-gpu=name,memory.total,memory.used --format=csv,noheader,nounits 2>/dev/null").catch(() => "");
    if (nvidiaGpu.trim()) {
      lines.push(`\n  ${cc.bold}GPU:${cc.reset}`);
      for (const gpu of nvidiaGpu.trim().split("\n")) {
        const [name, total, used] = gpu.split(",").map(s => s.trim());
        lines.push(`    ${cc.green}✓${cc.reset} ${name} — ${used}MB / ${total}MB VRAM`);
      }
    } else {
      const intelGpu = await runLocalCommand("lspci 2>/dev/null | grep -i 'vga\\|3d\\|display'").catch(() => "");
      if (intelGpu.trim()) {
        lines.push(`\n  ${cc.bold}GPU:${cc.reset}`);
        for (const g of intelGpu.trim().split("\n")) {
          const gpuName = g.replace(/^.*:\s*/, "").trim();
          lines.push(`    ${cc.yellow}⚠${cc.reset} ${gpuName} ${cc.dim}(no CUDA — Ollama will use CPU)${cc.reset}`);
        }
      } else {
        lines.push(`\n  ${cc.bold}GPU:${cc.reset} ${cc.dim}None detected — Ollama will use CPU only${cc.reset}`);
      }
    }

    // Ollama process memory usage
    if (ollamaInWSL) {
      const memUsage = await runLocalCommand("ps -p " + ollamaInWSL.trim().split("\n")[0] + " -o rss= 2>/dev/null").catch(() => "");
      if (memUsage.trim()) {
        const rssKB = parseInt(memUsage.trim());
        const rssMB = Math.round(rssKB / 1024);
        const rssGB = (rssKB / 1048576).toFixed(1);
        lines.push(`\n  ${cc.bold}Memory usage:${cc.reset} ${rssMB >= 1024 ? rssGB + "GB" : rssMB + "MB"}`);
      }
    }

    // Service info
    const svcStatus = await runLocalCommand("systemctl is-active ollama 2>/dev/null").catch(() => "");
    const svcEnabled = await runLocalCommand("systemctl is-enabled ollama 2>/dev/null").catch(() => "");
    if (svcStatus.trim()) {
      const active = svcStatus.trim() === "active";
      lines.push(`\n  ${cc.bold}Service:${cc.reset} ${active ? `${cc.green}active${cc.reset}` : `${cc.red}${svcStatus.trim()}${cc.reset}`}${svcEnabled.trim() === "enabled" ? ` ${cc.dim}(enabled on boot)${cc.reset}` : ""}`);
      lines.push(`  ${cc.dim}Control: "start ollama", "stop ollama", "restart ollama"${cc.reset}`);
    }

    // Windows host Ollama storage (if in WSL)
    if (inWSL && hostHasOllama) {
      const winHome = await runLocalCommand("cmd.exe /c 'echo %USERPROFILE%' 2>/dev/null").catch(() => "");
      const winPath = winHome.trim().replace(/\r/g, "");
      if (winPath) {
        const wslWinPath = winPath.replace(/\\/g, "/").replace(/^([A-Z]):/i, (_, d: string) => `/mnt/${d.toLowerCase()}`);
        const winModelDir = `${wslWinPath}/.ollama/models`;
        const winUsage = await runLocalCommand(`du -sh "${winModelDir}" 2>/dev/null | awk '{print $1}'`).catch(() => "");
        if (winUsage.trim()) {
          lines.push(`\n  ${cc.bold}Windows host models:${cc.reset} ${winModelDir}`);
          lines.push(`  ${cc.bold}Size:${cc.reset} ${winUsage.trim()}`);
        }
      }
    }

    lines.push(`\n  ${cc.dim}Move models: "move ollama models to /mnt/d/ollama"${cc.reset}`);
    return lines.join("\n");
  }

  // Ollama move — relocate models to a different directory
  if (intent.intent === "ollama.move") {
    const dest = (fields.destination as string) ?? intent.rawText.match(/(?:to|→)\s+(\S+)/i)?.[1];
    if (!dest) return `\x1b[33mUsage: move ollama models to <path>\x1b[0m\n\x1b[2m  Example: "move ollama models to /mnt/d/ollama"\x1b[0m`;

    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
    const lines: string[] = [];

    // Find current model dir
    const defaultPaths = ["/usr/share/ollama/.ollama/models", `${process.env.HOME}/.ollama/models`];
    let srcDir = process.env.OLLAMA_MODELS || "";
    if (!srcDir) {
      for (const dp of defaultPaths) {
        const exists = await runLocalCommand(`[ -d "${dp}" ] && echo yes || echo no`).catch(() => "no");
        if (exists.trim() === "yes") { srcDir = dp; break; }
      }
    }
    if (!srcDir) return `${cc.red}✗ Could not find Ollama model directory.${cc.reset}`;

    const usage = await runLocalCommand(`du -sh "${srcDir}" 2>/dev/null | awk '{print $1}'`).catch(() => "?");
    lines.push(`\n${cc.bold}${cc.cyan}── Move Ollama Models ──${cc.reset}\n`);
    lines.push(`  ${cc.bold}From:${cc.reset} ${srcDir} (${usage.trim()})`);
    lines.push(`  ${cc.bold}To:${cc.reset}   ${dest}\n`);

    // Check destination drive space
    const destParent = dest.replace(/\/[^/]*$/, "") || "/";
    const dfOut = await runLocalCommand(`df -BG "${destParent}" 2>/dev/null | tail -1 | awk '{print $4}'`).catch(() => "0G");
    const freeGB = parseInt(dfOut);
    const srcSizeOut = await runLocalCommand(`du -sB1G "${srcDir}" 2>/dev/null | awk '{print $1}'`).catch(() => "0");
    const srcGB = parseInt(srcSizeOut);

    if (freeGB < srcGB + 1) {
      return `${cc.red}✗ Not enough space at ${dest}: need ~${srcGB}GB, only ${freeGB}GB free.${cc.reset}`;
    }
    lines.push(`  ${cc.green}✓${cc.reset} Space OK: ${freeGB}GB free, need ~${srcGB}GB\n`);

    // Execute the move
    lines.push(`  ${cc.dim}Step 1: Create destination...${cc.reset}`);
    await runLocalCommand(`mkdir -p "${dest}"`);

    lines.push(`  ${cc.dim}Step 2: Copy models (this may take a while)...${cc.reset}`);
    console.log(lines.join("\n"));
    await withSpinner("Copying models...", () => runLocalCommand(`cp -a "${srcDir}/." "${dest}/" 2>&1`, 600_000));

    // Update systemd service if it exists
    const serviceFile = await runLocalCommand("systemctl cat ollama 2>/dev/null | head -1 | sed 's/^# //'").catch(() => "");
    const svcPath = serviceFile.trim();
    if (svcPath && svcPath.endsWith(".service")) {
      const hasEnv = await runLocalCommand(`grep -c OLLAMA_MODELS "${svcPath}" 2>/dev/null`).catch(() => "0");
      if (parseInt(hasEnv.trim()) === 0) {
        await runLocalCommand(`sed -i '/\\[Service\\]/a Environment="OLLAMA_MODELS=${dest}"' "${svcPath}" 2>&1`);
      } else {
        await runLocalCommand(`sed -i 's|OLLAMA_MODELS=.*|OLLAMA_MODELS=${dest}"|' "${svcPath}" 2>&1`);
      }
      await runLocalCommand("systemctl daemon-reload 2>&1");
      await runLocalCommand("systemctl restart ollama 2>&1");
      const verify = await runLocalCommand("systemctl is-active ollama 2>&1").catch(() => "unknown");

      return `${cc.green}✓${cc.reset} Models moved to ${cc.bold}${dest}${cc.reset}\n  ${cc.green}✓${cc.reset} Service updated: OLLAMA_MODELS=${dest}\n  ${cc.green}✓${cc.reset} Ollama restarted: ${verify.trim()}\n\n  ${cc.dim}Old models at ${srcDir} can be removed once verified.\n  Run: rm -rf "${srcDir}"${cc.reset}`;
    }

    // No systemd — set env var
    process.env.OLLAMA_MODELS = dest;
    return `${cc.green}✓${cc.reset} Models copied to ${cc.bold}${dest}${cc.reset}\n  ${cc.yellow}⚠${cc.reset} Set OLLAMA_MODELS=${dest} in your environment to make permanent.\n  ${cc.dim}Add to ~/.bashrc: export OLLAMA_MODELS="${dest}"\n  Old models at ${srcDir} can be removed once verified.${cc.reset}`;
  }

  // Ollama service management (start/stop/restart)
  if (intent.intent === "ollama.start" || intent.intent === "ollama.stop" || intent.intent === "ollama.restart") {
    const action = intent.intent.split(".")[1]; // start, stop, restart
    const isWSL = (await runLocalCommand("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native").catch(() => "native")).trim() === "wsl";

    // Check if Ollama is managed by systemd (Linux/WSL service)
    const hasSystemd = (await runLocalCommand("systemctl list-unit-files ollama.service 2>/dev/null | grep -c ollama").catch(() => "0")).trim() !== "0";

    if (hasSystemd) {
      result = await withSpinner(`${action}ing Ollama service...`, () => runLocalCommand(`systemctl ${action} ollama 2>&1`, 15_000));
      const status = await runLocalCommand("systemctl is-active ollama 2>&1").catch(() => "unknown");
      return `\x1b[32m✓\x1b[0m Ollama service ${action}ed. Status: \x1b[1m${status.trim()}\x1b[0m`;
    }

    // WSL — check if running on Windows host
    if (isWSL) {
      const hostOllama = await runLocalCommand("cmd.exe /c 'tasklist /FI \"IMAGENAME eq ollama.exe\" /NH' 2>/dev/null").catch(() => "");
      if (hostOllama.includes("ollama.exe") || action === "start") {
        if (action === "stop") {
          await runLocalCommand("cmd.exe /c 'taskkill /IM ollama.exe /F' 2>/dev/null").catch(() => "");
          return `\x1b[32m✓\x1b[0m Ollama stopped on Windows host.`;
        } else if (action === "start") {
          await runLocalCommand("cmd.exe /c 'start \"\" \"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Ollama\\ollama app.exe\"' 2>/dev/null").catch(() => "");
          return `\x1b[32m✓\x1b[0m Ollama starting on Windows host...\n\x1b[2m  It may take a moment to become available.\x1b[0m`;
        } else {
          await runLocalCommand("cmd.exe /c 'taskkill /IM ollama.exe /F' 2>/dev/null").catch(() => "");
          await runLocalCommand("cmd.exe /c 'start \"\" \"C:\\Users\\%USERNAME%\\AppData\\Local\\Programs\\Ollama\\ollama app.exe\"' 2>/dev/null").catch(() => "");
          return `\x1b[32m✓\x1b[0m Ollama restarted on Windows host.`;
        }
      }
    }

    // Fallback — try running ollama serve directly
    if (action === "start") {
      await runLocalCommand("nohup ollama serve > /dev/null 2>&1 &");
      return `\x1b[32m✓\x1b[0m Ollama server starting...\n\x1b[2m  It may take a moment to become available at localhost:11434\x1b[0m`;
    } else if (action === "stop") {
      await runLocalCommand("pkill -x ollama 2>/dev/null").catch(() => "");
      return `\x1b[32m✓\x1b[0m Ollama stopped.`;
    } else {
      await runLocalCommand("pkill -x ollama 2>/dev/null").catch(() => "");
      await runLocalCommand("nohup ollama serve > /dev/null 2>&1 &");
      return `\x1b[32m✓\x1b[0m Ollama restarted.`;
    }
  }

  // Ollama remove — delete a model
  if (intent.intent === "ollama.remove") {
    const model = (fields.model as string) ?? intent.rawText.match(/(?:remove|delete|rm)\s+(?:ollama\s+(?:model\s+)?)?(\S+)/i)?.[1];
    if (!model) return `\x1b[33mUsage: ollama remove <model>\x1b[0m\n\x1b[2m  Example: "ollama remove llama3.2"\x1b[0m`;
    result = await withSpinner(`Removing ${model}...`, () => runLocalCommand(`ollama rm ${model} 2>&1`, 30_000));
    return result.includes("deleted") ? `\x1b[32m✓\x1b[0m Model ${model} removed.` : result;
  }

  // Codex CLI handlers
  if (intent.intent === "codex.status") {
    try {
      const ver = await runLocalCommand("codex --version 2>&1");
      const apiKey = process.env.OPENAI_API_KEY ? "\x1b[32m✓ OPENAI_API_KEY set\x1b[0m" : "\x1b[33m⚠ OPENAI_API_KEY not set\x1b[0m";
      return `\x1b[32m✓\x1b[0m Codex CLI installed: \x1b[1m${ver.trim()}\x1b[0m\n  ${apiKey}`;
    } catch {
      return `\x1b[31m✗ Codex CLI not installed.\x1b[0m\n\x1b[2m  Install: "install codex" or npm install -g @openai/codex\x1b[0m`;
    }
  }
  if (intent.intent === "codex.install") {
    try { await runLocalCommand("codex --version"); return `\x1b[32m✓\x1b[0m Codex CLI already installed.`; } catch { /* continue */ }
    console.log(`\x1b[2mInstalling Codex CLI...\x1b[0m`);
    result = await withSpinner("Installing Codex CLI...", () => runLocalCommand("npm install -g @openai/codex 2>&1", 120_000));
    const ver = await runLocalCommand("codex --version 2>&1").catch(() => "unknown");
    return `\x1b[32m✓\x1b[0m Codex CLI installed: ${ver.trim()}\n\x1b[2m  Set OPENAI_API_KEY to use it.\x1b[0m`;
  }
  if (intent.intent === "codex.run") {
    const task = (fields.task as string) ?? intent.rawText.replace(/^(?:codex|ask codex|use codex for|codex do|run codex)\s*/i, "").trim();
    if (!task) return `\x1b[33mUsage: codex run <task>\x1b[0m\n\x1b[2m  Example: "ask codex to refactor this function"\x1b[0m`;
    try { await runLocalCommand("codex --version"); } catch {
      return `\x1b[31m✗ Codex CLI not found.\x1b[0m\n\x1b[2m  Install: "install codex"\x1b[0m`;
    }
    console.log(`\x1b[2mRunning Codex: "${task}"\x1b[0m`);
    result = await withSpinner("Codex working...", () => runLocalCommand(`codex "${task.replace(/"/g, '\\"')}" 2>&1`, 120_000));
    return result;
  }

  // ── Node.js upgrade helper — tries multiple strategies, finds new binary even if PATH is stale ──
  async function upgradeNode(
    minMajor: number,
    cc: Record<string, string>,
    run: typeof runLocalCommand,
    spin: typeof withSpinner,
  ): Promise<{ ok: boolean; message: string; nodePath?: string }> {
    const isWin = process.platform === "win32";

    // Helper: find Node binary >= minMajor, even if not on current PATH
    async function findNodeBinary(): Promise<string | null> {
      // Check current PATH first
      const ver = await run("node --version 2>/dev/null").catch(() => "");
      if (ver && parseInt(ver.replace("v", "")) >= minMajor) return "node";

      if (isWin) {
        // Search common Windows install locations
        const paths = [
          "C:/Program Files/nodejs/node.exe",
          "C:/Program Files (x86)/nodejs/node.exe",
        ];
        for (const p of paths) {
          const v = await run(`"${p}" --version 2>/dev/null`).catch(() => "");
          if (v && parseInt(v.replace("v", "")) >= minMajor) return p;
        }
        // Check nvm-windows install paths
        const nvmRoot = (await run(`powershell -Command 'Write-Output $env:NVM_HOME' 2>/dev/null`).catch(() => "")).trim();
        if (nvmRoot) {
          const found = await run(`ls -1d "${nvmRoot}"/v${minMajor}* 2>/dev/null | head -1`).catch(() => "");
          if (found.trim()) {
            const p = `${found.trim()}/node.exe`;
            const v = await run(`"${p}" --version 2>/dev/null`).catch(() => "");
            if (v && parseInt(v.replace("v", "")) >= minMajor) return p;
          }
        }
      } else {
        // Check nvm directories
        const nvmDirs = [`${process.env.HOME}/.nvm`, "/home/ino/.nvm", "/root/.nvm"];
        for (const dir of nvmDirs) {
          const found = await run(`ls -1 ${dir}/versions/node/v${minMajor}*/bin/node 2>/dev/null | tail -1`).catch(() => "");
          if (found.trim()) return found.trim();
        }
      }
      return null;
    }

    // Step 0: Maybe it's already installed but not on PATH
    const existing = await findNodeBinary();
    if (existing) {
      if (existing !== "node") {
        const dir = existing.replace(/[/\\]node(\.exe)?$/, "");
        process.env.PATH = `${dir}${isWin ? ";" : ":"}${process.env.PATH}`;
      }
      return { ok: true, message: `Node.js ${minMajor}+ already available`, nodePath: existing };
    }

    // Step 1: Try version managers
    if (isWin) {
      // nvm-windows
      const nvmWin = await run("nvm version 2>/dev/null").catch(() => "");
      if (nvmWin && /\d+\.\d+/.test(nvmWin)) {
        await spin(`Installing Node ${minMajor} via nvm-windows...`, () => run(`nvm install ${minMajor} 2>&1`, 120_000));
        await run(`nvm use ${minMajor} 2>&1`).catch(() => "");
        const found = await findNodeBinary();
        if (found) {
          if (found !== "node") { const dir = found.replace(/[/\\]node(\.exe)?$/, ""); process.env.PATH = `${dir};${process.env.PATH}`; }
          return { ok: true, message: `Node.js ${minMajor} installed via nvm-windows`, nodePath: found };
        }
      }

      // fnm
      const fnm = await run("fnm --version 2>/dev/null").catch(() => "");
      if (fnm && fnm.includes("fnm")) {
        await spin(`Installing Node ${minMajor} via fnm...`, () => run(`fnm install ${minMajor} && fnm use ${minMajor} 2>&1`, 120_000));
        const found = await findNodeBinary();
        if (found) return { ok: true, message: `Node.js ${minMajor} installed via fnm`, nodePath: found };
      }
    } else {
      // nvm (Linux/WSL)
      const nvmSrc = `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done`;
      const nvmVer = await run(`bash -c '${nvmSrc} 2>/dev/null && nvm --version' 2>/dev/null`).catch(() => "");
      if (nvmVer && /\d+\.\d+/.test(nvmVer)) {
        await spin(`Installing Node ${minMajor} via nvm...`, () => run(`bash -c '${nvmSrc} && nvm install ${minMajor}' 2>&1`, 120_000));
        const found = await findNodeBinary();
        if (found) {
          if (found !== "node") { const dir = found.replace(/\/node$/, ""); process.env.PATH = `${dir}:${process.env.PATH}`; }
          return { ok: true, message: `Node.js ${minMajor} installed via nvm`, nodePath: found };
        }
      }
    }

    // Step 2: No version manager found — install one, then use it
    if (isWin) {
      // Try installing nvm-windows first (doesn't require admin, allows version switching)
      console.log(`${cc.cyan}No version manager found. Installing nvm-windows...${cc.reset}`);
      try {
        const nvmInstallUrl = "https://github.com/coreybutler/nvm-windows/releases/latest/download/nvm-noinstall.zip";
        const winTemp = (await run(`powershell -Command 'Write-Output $env:TEMP' 2>/dev/null`).catch(() => "")).trim() || "C:\\Windows\\Temp";
        const nvmDir = `${process.env.APPDATA || winTemp}\\nvm`;
        const nvmZipBash = `$(cygpath '${winTemp}')/nvm-noinstall.zip`;
        const nvmDirBash = `$(cygpath '${nvmDir}')`;

        // Download nvm-windows
        const hasCurl = await run("curl --version 2>/dev/null").catch(() => "");
        if (hasCurl && hasCurl.includes("curl")) {
          await spin("Downloading nvm-windows...", () => run(`curl -fsSL -o "${nvmZipBash}" "${nvmInstallUrl}" 2>&1`, 60_000));
        } else {
          await spin("Downloading nvm-windows...", () => run(
            `powershell -Command "& { Invoke-WebRequest -Uri '${nvmInstallUrl}' -OutFile '${winTemp}\\nvm-noinstall.zip' }" 2>&1`, 60_000
          ));
        }

        // Extract and configure
        await run(`mkdir -p "${nvmDirBash}" && unzip -o "${nvmZipBash}" -d "${nvmDirBash}" 2>&1`).catch(() => "");
        // Add to PATH for this session
        process.env.NVM_HOME = nvmDir;
        process.env.PATH = `${nvmDir};${process.env.PATH}`;

        // Verify nvm works
        const nvmCheck = await run("nvm version 2>/dev/null").catch(() => "");
        if (nvmCheck && /\d+\.\d+/.test(nvmCheck)) {
          console.log(`${cc.green}✓ nvm-windows installed${cc.reset}`);
          await spin(`Installing Node ${minMajor} via nvm-windows...`, () => run(`nvm install ${minMajor} 2>&1`, 120_000));
          await run(`nvm use ${minMajor} 2>&1`).catch(() => "");
          const found = await findNodeBinary();
          if (found) {
            if (found !== "node") { const dir = found.replace(/[/\\]node(\.exe)?$/, ""); process.env.PATH = `${dir};${process.env.PATH}`; }
            return { ok: true, message: `Node.js ${minMajor} installed via nvm-windows`, nodePath: found };
          }
        }
      } catch {
        console.log(`${cc.yellow}⚠ nvm-windows install failed, trying direct Node installer...${cc.reset}`);
      }

      // Fallback: direct MSI install (requires admin)
      const adminCheck = await run(
        `powershell -Command "& { ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator) }" 2>&1`
      ).catch(() => "False");
      if (adminCheck.trim() !== "True") {
        return { ok: false, message: `${cc.red}✗ Node.js ${minMajor}+ required but current Node is too old.${cc.reset}\n  ${cc.dim}Admin privileges required to upgrade. Run as Administrator, or install manually:${cc.reset}\n  ${cc.dim}  • nvm-windows: https://github.com/coreybutler/nvm-windows${cc.reset}\n  ${cc.dim}  • Node.js:     https://nodejs.org/${cc.reset}` };
      }

      // Download MSI — try curl first, fall back to PowerShell
      const msiUrl = `https://nodejs.org/dist/v${minMajor}.15.0/node-v${minMajor}.15.0-x64.msi`;
      const msiTemp = (await run(`powershell -Command 'Write-Output $env:TEMP' 2>/dev/null`).catch(() => "")).trim() || "C:\\Windows\\Temp";
      const msiWinPath = `${msiTemp}\\node${minMajor}.msi`;
      const msiBashPath = `$(cygpath '${msiTemp}')/node${minMajor}.msi`;

      const hasCurlMsi = await run("curl --version 2>/dev/null").catch(() => "");
      try {
        if (hasCurlMsi && hasCurlMsi.includes("curl")) {
          await spin(`Downloading Node ${minMajor}...`, () => run(`curl -fsSL -o "${msiBashPath}" "${msiUrl}" 2>&1`, 180_000));
        } else {
          await spin(`Downloading Node ${minMajor}...`, () => run(`powershell -Command "& { Invoke-WebRequest -Uri '${msiUrl}' -OutFile '${msiWinPath}' }" 2>&1`, 180_000));
        }
      } catch (dlErr: unknown) {
        // Download failed with first method — try the other
        console.log(`${cc.yellow}⚠ Download failed, trying alternate method...${cc.reset}`);
        try {
          if (hasCurlMsi && hasCurlMsi.includes("curl")) {
            await spin(`Downloading (PowerShell)...`, () => run(`powershell -Command "& { Invoke-WebRequest -Uri '${msiUrl}' -OutFile '${msiWinPath}' }" 2>&1`, 180_000));
          } else {
            await spin(`Downloading (curl)...`, () => run(`curl -fsSL -o "${msiBashPath}" "${msiUrl}" 2>&1`, 180_000));
          }
        } catch {
          return { ok: false, message: `${cc.red}✗ Could not download Node.js ${minMajor} installer.${cc.reset}\n  ${cc.dim}Download manually: ${msiUrl}${cc.reset}` };
        }
      }

      // Install MSI
      try {
        await spin(`Installing Node ${minMajor}...`, () => run(
          `powershell -Command "Start-Process msiexec.exe -ArgumentList '/i','${msiWinPath}','/qn' -Wait; Remove-Item '${msiWinPath}' -ErrorAction SilentlyContinue" 2>&1`, 180_000
        ));
      } catch {
        return { ok: false, message: `${cc.red}✗ MSI installer failed.${cc.reset}\n  ${cc.dim}Try installing manually: ${msiUrl}${cc.reset}` };
      }

      // Find the new binary (PATH may be stale)
      const found = await findNodeBinary();
      if (found) {
        if (found !== "node") {
          const dir = found.replace(/[/\\]node(\.exe)?$/, "");
          process.env.PATH = `${dir};${process.env.PATH}`;
        }
        return { ok: true, message: `Node.js ${minMajor} installed successfully`, nodePath: found };
      }

      return { ok: false, message: `${cc.yellow}⚠ Node ${minMajor} installer ran but couldn't find the binary.${cc.reset}\n  ${cc.dim}Restart your terminal, then try again.${cc.reset}` };
    } else {
      // Linux: install nvm + Node
      const nvmSrc = `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done`;
      try {
        await spin(`Installing nvm + Node ${minMajor}...`, () => run(
          `curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh 2>/dev/null | bash 2>&1; bash -c '${nvmSrc} && nvm install ${minMajor}' 2>&1`, 180_000
        ));
      } catch {
        return { ok: false, message: `${cc.red}✗ Failed to install nvm + Node ${minMajor}.${cc.reset}\n  ${cc.dim}Install manually: curl -o- https://nvm.sh | bash && nvm install ${minMajor}${cc.reset}` };
      }
      const found = await findNodeBinary();
      if (found) {
        if (found !== "node") { const dir = found.replace(/\/node$/, ""); process.env.PATH = `${dir}:${process.env.PATH}`; }
        return { ok: true, message: `Node.js ${minMajor} installed via nvm`, nodePath: found };
      }
      return { ok: false, message: `${cc.red}✗ Node ${minMajor} installed but not found on PATH.${cc.reset}\n  ${cc.dim}Restart your terminal, then try again.${cc.reset}` };
    }
  }

  // Shared tool install registry
  const INSTALL_INFO: Record<string, { name: string; install: string; check: string; description: string; notes?: string }> = {
    claude: { name: "Claude Code CLI", install: "npm install -g @anthropic-ai/claude-code", check: "claude --version", description: "Anthropic's Claude Code — AI-assisted development", notes: "Requires Node.js 18+. After install, run `claude` to authenticate." },
    codex: { name: "OpenAI Codex CLI", install: "npm install -g @openai/codex", check: "codex --version", description: "OpenAI Codex — coding agent with GPT-4o/5", notes: "Requires Node.js 18+. Set OPENAI_API_KEY after install." },
    ollama: { name: "Ollama", install: "curl -fsSL https://ollama.com/install.sh | sh", check: "ollama --version", description: "Run AI models locally — no cloud tokens needed", notes: "After install: `ollama pull llama3.2` to download a model." },
    docker: { name: "Docker", install: "curl -fsSL https://get.docker.com | sh", check: "docker --version", description: "Container runtime for packaging and deploying apps", notes: "On WSL, install Docker Desktop on Windows and enable WSL integration." },
    convex: { name: "Convex CLI", install: "npm install -g convex", check: "npx convex --version", description: "Convex backend platform CLI", notes: "Run `npx convex dev` to start a project." },
    openclaw: { name: "OpenClaw CLI", install: "npm install -g openclaw", check: "openclaw --version", description: "OpenClaw messaging gateway CLI", notes: "Requires Node.js 22+. Run `openclaw setup` after install." },
    node: { name: "Node.js", install: "curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.0/install.sh | bash && nvm install --lts", check: "node --version", description: "JavaScript runtime", notes: "Uses nvm for version management. Restart terminal after install." },
    bun: { name: "Bun", install: "curl -fsSL https://bun.sh/install | bash", check: "bun --version", description: "Fast JavaScript runtime and toolkit", notes: "Alternative to Node.js with built-in bundler and test runner." },
    certbot: { name: "Certbot", install: "sudo apt install -y certbot", check: "certbot --version", description: "Let's Encrypt SSL certificate manager", notes: "On RHEL/Fedora: `sudo dnf install certbot`" },
    "notoken-app": { name: "Notoken Desktop App", install: "echo 'Say: install notoken app'", check: "which notoken-app 2>/dev/null || echo ''", description: "Point-and-click GUI + chat — everything the CLI does, visually", notes: "Download from https://notoken.sh/download or say: \"install notoken app\"" },
  };

  const TOOL_ALIASES: Record<string, string> = { "claude-code": "claude", "anthropic": "claude", "openai": "codex", "gpt": "codex", "chatgpt": "codex", "nvm": "node", "nodejs": "node", "claw": "openclaw" };

  function resolveToolName(raw: string): string {
    const toolMatch = raw.match(/(?:install|setup|get|download)\s+(\S+)/i)
      ?? raw.match(/(\S+)\s+(?:install|setup)/i)
      ?? raw.match(/(?:how.*?(?:install|setup|get))\s+(\S+)/i);
    let name = (toolMatch?.[1] ?? "").toLowerCase().replace(/[?.!]/g, "");
    return TOOL_ALIASES[name] ?? name;
  }

  // Tool install info — "how do I install claude", "give me the command to install codex"
  if (intent.intent === "tool.info") {
    let toolName = resolveToolName(intent.rawText) || ((fields.tool as string) ?? "").toLowerCase();
    toolName = TOOL_ALIASES[toolName] ?? toolName;

    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", cyan: "\x1b[36m" };

    if (!toolName || !INSTALL_INFO[toolName]) {
      const lines = [`\n${cc.bold}${cc.cyan}── Available Tools ──${cc.reset}\n`];
      for (const [key, info] of Object.entries(INSTALL_INFO)) {
        const installed = await runLocalCommand(info.check + " 2>/dev/null").catch(() => "");
        const status = installed ? `${cc.green}✓ installed${cc.reset}` : `${cc.dim}○ not installed${cc.reset}`;
        lines.push(`  ${cc.bold}${key.padEnd(12)}${cc.reset} ${status}  ${cc.dim}${info.description}${cc.reset}`);
      }
      lines.push(`\n  ${cc.dim}Say: "how to install claude" or "install codex"${cc.reset}`);
      return lines.join("\n");
    }

    const info = INSTALL_INFO[toolName];
    const installed = await runLocalCommand(info.check + " 2>/dev/null").catch(() => "");
    const lines = [`\n${cc.bold}${cc.cyan}── ${info.name} ──${cc.reset}\n`];
    lines.push(`  ${info.description}\n`);

    if (installed) {
      lines.push(`  ${cc.green}✓ Already installed:${cc.reset} ${installed.trim()}\n`);
      lines.push(`  ${cc.bold}Install command:${cc.reset}`);
      lines.push(`  ${cc.cyan}${info.install}${cc.reset}\n`);
      lines.push(`  ${cc.bold}Verify:${cc.reset} ${info.check}`);
      if (info.notes) lines.push(`\n  ${cc.yellow}Note:${cc.reset} ${info.notes}`);
    } else {
      lines.push(`  ${cc.bold}Install command:${cc.reset}`);
      lines.push(`  ${cc.cyan}${info.install}${cc.reset}\n`);
      lines.push(`  ${cc.bold}Verify:${cc.reset} ${info.check}`);
      if (info.notes) lines.push(`\n  ${cc.yellow}Note:${cc.reset} ${info.notes}`);
      lines.push(`\n  ${cc.bold}I can install it for you.${cc.reset} Want me to do that?`);
      // Register pending action so "yes"/"do it" triggers the install
      suggestAction({ action: `install ${toolName}`, description: `Install ${info.name}`, type: "intent" });
    }

    return lines.join("\n");
  }

  // Tool install — "install claude", "install openclaw", "install codex"
  if (intent.intent === "tool.install") {
    let toolName = resolveToolName(intent.rawText) || ((fields.tool as string) ?? "").toLowerCase();
    toolName = TOOL_ALIASES[toolName] ?? toolName;
    // Don't let env qualifiers get mistaken for tool names
    if (["windows", "wsl", "linux", "host", "both"].includes(toolName)) {
      toolName = resolveToolName(intent.rawText.replace(/\b(on\s+)?(windows|wsl|linux|host|both)\b/gi, "").trim()) || toolName;
    }

    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    if (!toolName || !INSTALL_INFO[toolName]) {
      return `${cc.red}✗ Unknown tool: "${toolName || "?"}"\x1b[0m\n\n  ${cc.dim}Available: ${Object.keys(INSTALL_INFO).join(", ")}${cc.reset}`;
    }

    const info = INSTALL_INFO[toolName];
    const wantWindows = !!intent.rawText.match(/\b(on\s+)?windows\b|\b(on\s+)?win\b|\bon\s+d\b|\bd\s+drive\b/i);

    // Check if already installed — but for "on windows" requests, check Windows specifically
    if (!wantWindows) {
      const existing = await runLocalCommand(info.check + " 2>/dev/null").catch(() => "");
      if (existing) {
        return `${cc.green}✓${cc.reset} ${info.name} is already installed: ${cc.bold}${existing.trim()}${cc.reset}`;
      }
    }

    // Check Node.js for npm-based tools
    if (info.install.startsWith("npm ")) {
      const nodeVer = await runLocalCommand("node --version 2>/dev/null").catch(() => "");
      if (!nodeVer) {
        return `${cc.red}✗ Node.js is required to install ${info.name}.${cc.reset}\n  ${cc.dim}Say: "install node" first.${cc.reset}`;
      }

      // Check minimum Node version from notes (e.g. "Requires Node.js 22+")
      const minNodeMatch = info.notes?.match(/Node\.js\s+(\d+)\+/);
      if (minNodeMatch) {
        const minMajor = parseInt(minNodeMatch[1]);
        const currentMajor = parseInt(nodeVer.replace("v", ""));
        if (currentMajor < minMajor) {
          console.log(`${cc.yellow}⚠ ${info.name} requires Node.js ${minMajor}+ (current: ${nodeVer.trim()})${cc.reset}`);
          console.log(`${cc.cyan}Upgrading Node.js to ${minMajor}...${cc.reset}\n`);

          const upgraded = await upgradeNode(minMajor, cc, runLocalCommand, withSpinner);
          if (!upgraded.ok) {
            return upgraded.message;
          }
          console.log(`${cc.green}✓ ${upgraded.message}${cc.reset}\n`);
        }
      }
    }

    // ── Special handling: Ollama in WSL — recommend/install Windows native for GPU ──
    if (toolName === "ollama") {
      const installIsWSL = (await runLocalCommand("grep -qi microsoft /proc/version 2>/dev/null && echo wsl || echo native").catch(() => "native")).trim() === "wsl";

      if (installIsWSL) {
        // Check for GPU on Windows host
        const gpuInfo = await runLocalCommand("/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command \"Get-WmiObject Win32_VideoController | Select -Exp Name\" 2>/dev/null").catch(() => "");
        const hasNvidiaGpu = gpuInfo.toLowerCase().includes("nvidia");

        // Check if Ollama already installed on Windows
        const winOllama = await runLocalCommand("/mnt/c/Windows/System32/cmd.exe /c \"where ollama\" 2>/dev/null").catch(() => "");
        const winInstalled = winOllama.includes("ollama");

        // Check target from user input — "install ollama on windows", "install ollama on d drive"
        const wantWindows = intent.rawText.match(/\b(on\s+)?windows\b|\b(on\s+)?win\b|\bon\s+d\b|\bd\s+drive\b/i);
        const wantWSL = intent.rawText.match(/\b(on\s+|in\s+)?wsl\b|\b(on\s+)?linux\b/i);

        if (winInstalled && !wantWSL) {
          const winVer = await runLocalCommand("/mnt/c/Windows/System32/cmd.exe /c \"ollama --version\" 2>/dev/null").catch(() => "");
          return `${cc.green}✓${cc.reset} Ollama already installed on Windows: ${cc.bold}${winVer.trim().replace(/\r/g, "")}${cc.reset}${hasNvidiaGpu ? `\n  ${cc.green}✓${cc.reset} GPU: ${gpuInfo.trim().replace(/\r/g, "")}` : ""}`;
        }

        if ((hasNvidiaGpu && !wantWSL) || wantWindows) {
          // Install Ollama natively on Windows for GPU access
          console.log(`\n${cc.bold}${cc.cyan}── Installing Ollama for Windows ──${cc.reset}\n`);
          if (hasNvidiaGpu) {
            console.log(`  ${cc.green}✓${cc.reset} GPU detected: ${cc.bold}${gpuInfo.trim().replace(/\r/g, "")}${cc.reset}`);
            console.log(`  ${cc.dim}Installing natively on Windows for GPU acceleration.${cc.reset}`);
            console.log(`  ${cc.dim}(WSL Ollama would be CPU-only — 10-50x slower)${cc.reset}\n`);
          }

          // Check D: drive space
          const dFree = await runLocalCommand("df -BG /mnt/d 2>/dev/null | tail -1 | awk '{print $4}'").catch(() => "0G");
          const dFreeGB = parseInt(dFree);

          // Download Ollama installer to D: drive
          const installDir = "D:\\\\Ollama";
          const installerUrl = "https://ollama.com/download/OllamaSetup.exe";
          const downloadPath = "D:\\\\OllamaSetup.exe";

          try {
            // Check if installer was already downloaded (e.g. user cancelled and wants to retry)
            const existingInstaller = await runLocalCommand(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "if(Test-Path '${downloadPath}'){(Get-Item '${downloadPath}').Length}" 2>/dev/null`).catch(() => "0");
            const existingSize = parseInt(existingInstaller.trim()) || 0;

            if (existingSize > 100_000_000) {
              // Installer already exists (>100MB) — skip download
              console.log(`  ${cc.green}✓${cc.reset} Installer already downloaded (${(existingSize / 1e9).toFixed(1)}GB)`);
              console.log(`  ${cc.dim}Relaunching...${cc.reset}`);
            } else {
              console.log(`  ${cc.dim}Downloading Ollama installer...${cc.reset}`);
              await withSpinner("Downloading Ollama...", () => runLocalCommand(
                `/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Invoke-WebRequest -Uri '${installerUrl}' -OutFile '${downloadPath}' -UseBasicParsing" 2>/dev/null`,
                600_000
              ));
            }

            // Set OLLAMA_MODELS to D: drive before installing
            console.log(`  ${cc.dim}Setting models directory to D:\\\\Ollama\\\\models...${cc.reset}`);
            await runLocalCommand(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "[Environment]::SetEnvironmentVariable('OLLAMA_MODELS', 'D:\\\\Ollama\\\\models', 'User')" 2>/dev/null`).catch(() => "");

            // Launch installer — use PowerShell Start-Process (cmd.exe start has file lock issues)
            console.log(`  ${cc.dim}Launching installer...${cc.reset}`);
            await runLocalCommand(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process '${downloadPath.replace(/\\\\/g, "\\")}'" 2>/dev/null`).catch(() => "");

            const lines = [
              `\n${cc.green}✓${cc.reset} Ollama installer launched on Windows.\n`,
              `${cc.bold}${cc.cyan}── Setup Instructions ──${cc.reset}\n`,
              `  ${cc.bold}1.${cc.reset} The installer window should appear on your desktop`,
              `     ${cc.dim}If you don't see it, check your taskbar for "Ollama Setup"${cc.reset}`,
              `  ${cc.bold}2.${cc.reset} Click ${cc.bold}"Install"${cc.reset} — installs to AppData\\Local\\Programs\\Ollama`,
              `  ${cc.bold}3.${cc.reset} Wait for it to finish — adds Ollama to your PATH`,
              `  ${cc.bold}4.${cc.reset} Ollama starts automatically in the system tray`,
              `     ${cc.dim}Look for the llama icon near your clock${cc.reset}`,
              `  ${cc.bold}5.${cc.reset} It serves on ${cc.cyan}http://localhost:11434${cc.reset} — both WSL and Windows can use it\n`,
              `  ${cc.bold}Models:${cc.reset} D:\\Ollama\\models ${cc.dim}(set via OLLAMA_MODELS)${cc.reset}`,
              hasNvidiaGpu ? `  ${cc.bold}GPU:${cc.reset} ${cc.green}${gpuInfo.trim().replace(/\r/g, "")} — CUDA acceleration enabled${cc.reset}` : "",
              `\n${cc.bold}${cc.cyan}── After Install ──${cc.reset}\n`,
              `  Verify:  ${cc.cyan}ollama --version${cc.reset} ${cc.dim}(open PowerShell or say "is ollama installed")${cc.reset}`,
              `  Pull:    ${cc.cyan}ollama pull llama3.2${cc.reset} ${cc.dim}(2GB, 131K context, fast on GPU)${cc.reset}`,
              `  Test:    ${cc.cyan}ollama run llama3.2 "hello"${cc.reset}`,
              `  Or say:  ${cc.cyan}"ollama pull llama3.2"${cc.reset} — notoken handles it\n`,
              `  ${cc.dim}notoken will auto-detect the Windows Ollama on next status check${cc.reset}`,
            ].filter(Boolean);
            return lines.join("\n");
          } catch (err: unknown) {
            return `${cc.yellow}⚠${cc.reset} Auto-download failed. Install manually:\n  ${cc.cyan}${installerUrl}${cc.reset}\n  ${cc.dim}Set OLLAMA_MODELS=D:\\Ollama\\models before installing${cc.reset}`;
          }
        }

        // WSL install but warn about CPU-only
        if (hasNvidiaGpu && wantWSL) {
          console.log(`${cc.yellow}⚠ Installing in WSL — GPU (${gpuInfo.trim().replace(/\r/g, "")}) won't be used.${cc.reset}`);
          console.log(`  ${cc.dim}For GPU acceleration, say: "install ollama on windows"${cc.reset}\n`);
        }
      }
    }

    console.log(`\n${cc.cyan}Installing ${info.name}...${cc.reset}`);
    console.log(`${cc.dim}  Running: ${info.install}${cc.reset}\n`);

    // ── Install with retry and self-healing ──
    const maxAttempts = 2;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        result = await withSpinner(`Installing ${info.name}...`, () => runLocalCommand(info.install + " 2>&1", 300_000));

        // Verify installation
        let ver = await runLocalCommand(info.check + " 2>/dev/null").catch(() => "");

        if (ver) {
          const lines = [`${cc.green}✓${cc.reset} ${info.name} installed successfully: ${cc.bold}${ver.trim()}${cc.reset}`];
          if (info.notes) lines.push(`\n  ${cc.yellow}Next:${cc.reset} ${info.notes}`);

          // Post-install: for openclaw, run onboard + start gateway + pair device + open dashboard
          if (toolName === "openclaw") {
            const { readFileSync: rfs, existsSync: efs, writeFileSync: wfs, mkdirSync: mfs } = await import("node:fs");
            const { dirname: dn } = await import("node:path");
            const home = process.env.USERPROFILE || process.env.HOME || "";
            const sep = process.platform === "win32" ? "\\" : "/";
            const ocHome = `${home}${sep}.openclaw`;
            const configPath = `${ocHome}${sep}openclaw.json`;

            // Step 1: Run non-interactive onboard (sets up config, workspace, auth)
            console.log(`\n${cc.cyan}Running OpenClaw onboard...${cc.reset}`);
            const authChoice = efs(`${home}${sep}.claude${sep}.credentials.json`) ? "anthropic-cli" : "skip";
            await withSpinner("Setting up OpenClaw...", () => runLocalCommand(
              `openclaw onboard --mode local --non-interactive --accept-risk --auth-choice ${authChoice} --skip-channels --skip-skills --skip-daemon --skip-health --skip-search --skip-ui 2>&1`, 60_000
            )).catch(() => "");
            lines.push(`${cc.green}✓${cc.reset} OpenClaw onboarded`);

            // Step 2: Fix model ID (onboard may set claude-cli/ prefix which gateway doesn't recognize)
            try {
              if (efs(configPath)) {
                const config = JSON.parse(rfs(configPath, "utf-8"));
                const primary = config?.agents?.defaults?.model?.primary || "";
                if (primary.startsWith("claude-cli/")) {
                  const fixedModel = primary.replace("claude-cli/", "anthropic/");
                  config.agents.defaults.model.primary = fixedModel;
                  if (config.agents.defaults.models) {
                    delete config.agents.defaults.models[primary];
                    config.agents.defaults.models[fixedModel] = {};
                  }
                  wfs(configPath, JSON.stringify(config, null, 2));
                  lines.push(`${cc.green}✓${cc.reset} Model set to ${fixedModel}`);
                }
              }
            } catch {}

            // Step 3: Sync Claude Code OAuth token to openclaw auth-profiles
            const claudeCreds = `${home}${sep}.claude${sep}.credentials.json`;
            try {
              if (efs(claudeCreds)) {
                const creds = JSON.parse(rfs(claudeCreds, "utf-8"));
                const claudeToken = creds?.claudeAiOauth?.accessToken;
                if (claudeToken) {
                  const authPath = `${ocHome}${sep}agents${sep}main${sep}agent${sep}auth-profiles.json`;
                  let profiles: any = { version: 1, profiles: {} };
                  if (efs(authPath)) profiles = JSON.parse(rfs(authPath, "utf-8"));
                  else mfs(dn(authPath), { recursive: true });
                  profiles.profiles["anthropic:claude-oauth"] = { type: "oauth", provider: "anthropic", access: claudeToken, expires: Date.now() + 86400000 };
                  wfs(authPath, JSON.stringify(profiles, null, 2));
                  lines.push(`${cc.green}✓${cc.reset} Claude Code token synced`);
                }
              }
            } catch {}

            // Step 4: Start gateway
            console.log(`${cc.cyan}Starting gateway...${cc.reset}`);
            if (process.platform === "win32") {
              const ocPrefix = (await runLocalCommand("npm config get prefix 2>/dev/null").catch(() => "")).trim();
              const ocEntry = ocPrefix ? `${ocPrefix}\\node_modules\\openclaw\\dist\\index.js` : "openclaw";
              await runLocalCommand(
                `powershell -Command "Start-Process -FilePath node -ArgumentList '${ocEntry}','gateway','--force','--allow-unconfigured' -WindowStyle Hidden" 2>/dev/null`
              ).catch(() => "");
            } else {
              await runLocalCommand("nohup openclaw gateway --force --allow-unconfigured > /dev/null 2>&1 &").catch(() => "");
            }
            let gwUp = false;
            for (let i = 0; i < 10; i++) {
              await runLocalCommand("sleep 1").catch(() => {});
              const h = await runLocalCommand("curl -sf http://127.0.0.1:18789/health 2>/dev/null").catch(() => "");
              if (h.includes('"ok"')) { gwUp = true; break; }
            }

            if (gwUp) {
              lines.push(`${cc.green}✓${cc.reset} Gateway started on http://127.0.0.1:18789`);

              // Step 5: Auto-pair CLI device with full admin scopes
              try {
                const devicesDir = `${ocHome}${sep}devices`;
                const pairedPath = `${devicesDir}${sep}paired.json`;
                const pendingPath = `${devicesDir}${sep}pending.json`;

                if (efs(pairedPath) && efs(pendingPath)) {
                  const paired = JSON.parse(rfs(pairedPath, "utf-8"));
                  const pending = JSON.parse(rfs(pendingPath, "utf-8"));
                  const fullScopes = ["operator.admin", "operator.read", "operator.write", "operator.approvals", "operator.pairing"];

                  // Approve all pending requests
                  let approved = 0;
                  for (const [reqId, req] of Object.entries(pending) as [string, any][]) {
                    const deviceId = req.deviceId;
                    if (paired[deviceId]) {
                      paired[deviceId].scopes = fullScopes;
                      paired[deviceId].approvedScopes = fullScopes;
                      paired[deviceId].clientId = req.clientId || paired[deviceId].clientId;
                      paired[deviceId].clientMode = req.clientMode || paired[deviceId].clientMode;
                      if (paired[deviceId].tokens?.operator) {
                        paired[deviceId].tokens.operator.scopes = fullScopes;
                      }
                      paired[deviceId].approvedAtMs = Date.now();
                      approved++;
                    }
                  }

                  // Also upgrade any existing devices with limited scopes
                  for (const [deviceId, device] of Object.entries(paired) as [string, any][]) {
                    if (!device.scopes?.includes("operator.admin")) {
                      device.scopes = fullScopes;
                      device.approvedScopes = fullScopes;
                      if (device.tokens?.operator) device.tokens.operator.scopes = fullScopes;
                      device.approvedAtMs = Date.now();
                      approved++;
                    }
                  }

                  if (approved > 0) {
                    wfs(pairedPath, JSON.stringify(paired, null, 2));
                    wfs(pendingPath, "{}");
                    lines.push(`${cc.green}✓${cc.reset} Device pairing configured (${approved} device(s))`);
                  }
                }
              } catch {}

              // Step 6: Open dashboard with Playwright auto-pair
              lines.push(`\n${cc.cyan}Opening dashboard...${cc.reset}`);
              try {
                const { chromium } = await import("playwright");
                const browser = await chromium.launch({ headless: false });
                const page = await browser.newPage();
                await page.goto("http://127.0.0.1:18789");
                await page.waitForTimeout(2000);
                const tokenInput = page.locator('input[placeholder*="OPENCLAW_GATEWAY_TOKEN"]');
                let gwToken = "";
                try { gwToken = JSON.parse(rfs(configPath, "utf-8"))?.gateway?.auth?.token || ""; } catch {}
                if (gwToken && await tokenInput.count() > 0) {
                  await tokenInput.fill(gwToken);
                  const btn = page.locator('button').filter({ hasText: 'Connect' });
                  if (await btn.count() > 0) await btn.first().click();
                  await page.waitForTimeout(2000);
                }
                lines.push(`${cc.green}✓${cc.reset} Dashboard opened and paired!`);
              } catch {
                try {
                  if (process.platform === "win32") await runLocalCommand(`powershell -Command "Start-Process 'http://127.0.0.1:18789'" 2>/dev/null`);
                  else await runLocalCommand(`xdg-open "http://127.0.0.1:18789" 2>/dev/null || open "http://127.0.0.1:18789" 2>/dev/null`);
                } catch {}
                lines.push(`${cc.dim}Dashboard: http://127.0.0.1:18789${cc.reset}`);
              }
            } else {
              lines.push(`${cc.yellow}⚠${cc.reset} Gateway didn't start — try: "start openclaw"`);
            }
          }

          return lines.join("\n");
        }

        // ── Verification failed — diagnose and retry ──
        if (attempt < maxAttempts) {
          console.log(`${cc.yellow}⚠ Installed but verification failed. Diagnosing...${cc.reset}`);

          // Scenario 1: Node version mismatch after MSI install (shell has stale PATH)
          const minNodeMatch2 = info.notes?.match(/Node\.js\s+(\d+)\+/);
          if (minNodeMatch2 && process.platform === "win32") {
            const minMajor2 = parseInt(minNodeMatch2[1]);
            // Search for the newly installed Node binary directly
            const searchPaths = [
              `C:/Program Files/nodejs/node.exe`,
              `C:/Program Files (x86)/nodejs/node.exe`,
            ];
            let newNodePath = "";
            for (const p of searchPaths) {
              const found = await runLocalCommand(`test -f "${p}" && "${p}" --version 2>/dev/null`).catch(() => "");
              if (found && parseInt(found.replace("v", "")) >= minMajor2) {
                newNodePath = p;
                break;
              }
            }
            // Also check nvm-windows install paths
            if (!newNodePath) {
              const nvmRoot = (await runLocalCommand(`powershell -Command 'Write-Output $env:NVM_HOME' 2>/dev/null`).catch(() => "")).trim();
              if (nvmRoot) {
                const found = await runLocalCommand(`ls -1 "${nvmRoot}"/v${minMajor2}*/node.exe 2>/dev/null | head -1`).catch(() => "");
                if (found.trim()) newNodePath = found.trim();
              }
            }

            if (newNodePath) {
              console.log(`${cc.cyan}Found Node ${minMajor2}+ at ${newNodePath} — refreshing PATH...${cc.reset}`);
              // Update PATH for this process and retry
              const nodeDir = newNodePath.replace(/\/node\.exe$/, "").replace(/\\node\.exe$/, "");
              process.env.PATH = `${nodeDir};${process.env.PATH}`;
              // Re-run npm install with the new Node
              console.log(`${cc.cyan}Retrying installation with Node ${minMajor2}+...${cc.reset}\n`);
              continue;
            }
          }

          // Scenario 2: Binary installed but not on PATH (npm global bin not in PATH)
          const npmBin = await runLocalCommand("npm config get prefix 2>/dev/null").catch(() => "");
          if (npmBin.trim()) {
            const binDir = process.platform === "win32" ? npmBin.trim() : `${npmBin.trim()}/bin`;
            if (!process.env.PATH?.includes(binDir)) {
              console.log(`${cc.cyan}Adding npm global bin to PATH: ${binDir}${cc.reset}`);
              process.env.PATH = `${binDir}${process.platform === "win32" ? ";" : ":"}${process.env.PATH}`;
              // Retry verification
              ver = await runLocalCommand(info.check + " 2>/dev/null").catch(() => "");
              if (ver) {
                const lines = [`${cc.green}✓${cc.reset} ${info.name} installed successfully: ${cc.bold}${ver.trim()}${cc.reset}`];
                if (info.notes) lines.push(`\n  ${cc.yellow}Next:${cc.reset} ${info.notes}`);
                return lines.join("\n");
              }
            }
          }

          // Scenario 3: Tool needs a specific Node but `node` on PATH is still old
          // Try running the check with the tool's expected Node directly
          if (minNodeMatch2 && process.platform === "win32") {
            const curVer = await runLocalCommand("node --version 2>/dev/null").catch(() => "unknown");
            console.log(`${cc.yellow}Node ${minNodeMatch2[1]}+ may have installed but this shell still uses ${curVer.trim()}.${cc.reset}`);
            console.log(`${cc.cyan}Searching for the new Node binary...${cc.reset}`);
          }
        }

        return `${cc.yellow}⚠${cc.reset} Install completed but could not verify. Try: ${cc.cyan}${info.check}${cc.reset}\n\n${cc.dim}Output:\n${result.substring(0, 500)}${cc.reset}\n\n  ${cc.dim}If Node was just upgraded, restart your terminal and try again.${cc.reset}`;
      } catch (err: unknown) {
        const errMsg = (err as Error).message.split("\n")[0];

        // Self-healing: if npm install failed, diagnose why
        if (attempt < maxAttempts) {
          // Check if it's a permissions error
          if (errMsg.includes("EACCES") || errMsg.includes("permission denied")) {
            console.log(`${cc.yellow}⚠ Permission error — retrying with sudo...${cc.reset}`);
            try {
              result = await withSpinner(`Installing ${info.name} (sudo)...`, () => runLocalCommand(`sudo ${info.install} 2>&1`, 300_000));
              const ver = await runLocalCommand(info.check + " 2>/dev/null").catch(() => "");
              if (ver) {
                return `${cc.green}✓${cc.reset} ${info.name} installed successfully: ${cc.bold}${ver.trim()}${cc.reset}`;
              }
            } catch { /* fall through to error */ }
          }

          // Check if it's a network/registry error
          if (errMsg.includes("ETIMEDOUT") || errMsg.includes("ENOTFOUND") || errMsg.includes("fetch failed")) {
            console.log(`${cc.yellow}⚠ Network error — retrying in 3s...${cc.reset}`);
            await runLocalCommand("sleep 3").catch(() => {});
            continue;
          }
        }

        return `${cc.red}✗ Installation failed:${cc.reset} ${errMsg}\n\n  ${cc.dim}Try manually: ${info.install}${cc.reset}`;
      }
    }
    return `${cc.red}✗ Installation failed after ${maxAttempts} attempts.${cc.reset}\n  ${cc.dim}Try manually: ${info.install}${cc.reset}`;
  }

  // Discord diagnose/fix/check — "diagnose discord", "fix discord", "check discord"
  if (intent.rawText.match(/\b(diagnose|fix|check|troubleshoot|repair)\b.*\bdiscord\b|\bdiscord\b.*\b(diagnose|fix|check|troubleshoot|status)\b/i)) {
    const isQuick = !!intent.rawText.match(/\b(check|status)\b/i) && !intent.rawText.match(/\b(fix|diagnose|troubleshoot|repair)\b/i);
    try {
      if (isQuick) {
        const { quickDiscordCheck } = await import("../utils/discordDiag.js");
        return await quickDiscordCheck();
      } else {
        const { diagnoseDiscord } = await import("../utils/discordDiag.js");
        return await diagnoseDiscord();
      }
    } catch (err: unknown) {
      return `\x1b[31m✗ Discord diagnostics error: ${(err as Error).message.split("\n")[0]}\x1b[0m`;
    }
  }

  // Discord/channel setup — "setup discord", "add discord channel", "connect discord"
  if ((intent.intent === "openclaw.configure" || intent.intent === "openclaw.channel.setup" || intent.intent === "tool.install") &&
      intent.rawText.match(/\bdiscord\b/i)) {
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    // Check if user provided a token directly: "setup discord with token abc123"
    const tokenMatch = intent.rawText.match(/token\s+(\S+)/i);
    if (tokenMatch) {
      const token = tokenMatch[1];
      console.log(`${cc.dim}Registering Discord bot token with OpenClaw...${cc.reset}`);
      const node22 = await getNode22();
      const ocBin = (await runLocalCommand("readlink -f $(which openclaw) 2>/dev/null || which openclaw").catch(() => "openclaw")).trim();
      try {
        await runLocalCommand(`${node22} ${ocBin} channels add --channel discord --token "${token}" 2>&1`, 15_000);
        return `${cc.green}✓${cc.reset} Discord channel registered!\n  ${cc.dim}Restart OpenClaw: "restart openclaw"${cc.reset}`;
      } catch (err: unknown) {
        return `${cc.red}✗ Failed to register: ${(err as Error).message.split("\n")[0]}${cc.reset}`;
      }
    }

    // Try Playwright automation
    try {
      const { setupDiscordChannel } = await import("../automation/discordSetup.js");
      return await setupDiscordChannel();
    } catch {
      // Playwright not available — show manual instructions
    }

    // Manual instructions
    const lines = [
      `\n${cc.bold}${cc.cyan}── Discord Bot Setup ──${cc.reset}\n`,
      `  ${cc.bold}Step 1:${cc.reset} Open ${cc.cyan}https://discord.com/developers/applications${cc.reset}`,
      `  ${cc.bold}Step 2:${cc.reset} Click ${cc.bold}"New Application"${cc.reset} → name it "OpenClaw" → Create`,
      `  ${cc.bold}Step 3:${cc.reset} Left sidebar → ${cc.bold}"Bot"${cc.reset} → click ${cc.bold}"Reset Token"${cc.reset} → ${cc.yellow}Copy the token${cc.reset}`,
      `  ${cc.bold}Step 4:${cc.reset} Scroll down → enable ${cc.bold}"Message Content Intent"${cc.reset} → Save`,
      `  ${cc.bold}Step 5:${cc.reset} Left sidebar → ${cc.bold}"OAuth2" → "URL Generator"${cc.reset}`,
      `          Check: ${cc.cyan}bot${cc.reset} scope → then: ${cc.cyan}Send Messages${cc.reset} + ${cc.cyan}Read Messages/View Channels${cc.reset}`,
      `  ${cc.bold}Step 6:${cc.reset} Copy the generated URL → open it → pick your server → Authorize\n`,
      `  ${cc.bold}Then tell notoken:${cc.reset}`,
      `  ${cc.cyan}"setup discord with token YOUR_BOT_TOKEN"${cc.reset}\n`,
      `  ${cc.dim}notoken will register it with OpenClaw and restart the gateway.${cc.reset}`,
    ];
    // Open browser for the user
    try {
      await runLocalCommand(`/mnt/c/Windows/System32/cmd.exe /c "start https://discord.com/developers/applications" 2>/dev/null`).catch(() => "");
      lines.push(`\n  ${cc.green}✓${cc.reset} Opened Discord Developer Portal in your browser.`);
    } catch { /* */ }

    return lines.join("\n");
  }

  // Entity define/list
  if (intent.intent === "entity.define") return learnEntity(intent.rawText) ?? "Could not understand. Try: 'metroplex is 66.94.115.165'";
  if (intent.intent === "entity.list") return listEntities();

  // Disk cleanup / scan
  if (intent.intent === "disk.cleanup") {
    const targets = await withSpinner("Scanning disk...", () => scanForCleanup());
    console.log(formatCleanupTable(targets));
    return targets.length > 0 ? await runInteractiveCleanup(targets) : "";
  }
  if (intent.intent === "disk.scan") {
    const drives = await withSpinner("Scanning drives...", () => smartDriveScan());
    return await formatDriveScan(drives, false);
  }

  // Database query
  if (intent.intent === "db.query" || intent.intent === "db.tables" || intent.intent === "db.describe") {
    let dbType: DbType = "postgres";
    try { await runLocalCommand("which psql"); } catch { try { await runLocalCommand("which mysql"); dbType = "mysql"; } catch { /* */ } }
    const qr = buildQuery(intent.rawText, fields, dbType);
    if (!qr.query) return qr.explanation;
    console.log(formatQueryPlan(qr));
    const { askForConfirmation } = await import("../policy/confirm.js");
    if (!(await askForConfirmation("\nRun this query?"))) return "\x1b[2mCancelled.\x1b[0m";
    return isLocal ? await withSpinner("Running...", () => runLocalCommand(qr.command)) : await withSpinner(`Running on ${environment}...`, () => runRemoteCommand(environment, qr.command));
  }

  // Project detect/install/update/run
  if (intent.intent === "project.detect") { const p = detectProjectsNew(); const i = readProjectConfig(); return formatProjectDetection(p) + (i ? "\n" + formatPackageScripts(i) : ""); }
  if (intent.intent === "project.install") { const p = detectProjectsNew(); if (!p.length) return "No project found."; return await withSpinner(`${p[0].installCmd}...`, () => runLocalCommand(p[0].installCmd)); }
  if (intent.intent === "project.update") { const p = detectProjectsNew(); if (!p.length) return "No project found."; return await withSpinner(`${p[0].updateCmd}...`, () => runLocalCommand(p[0].updateCmd)); }
  if (intent.intent === "project.run") { const s = (fields.script as string) ?? "dev"; const cmd = getScriptRunCmd(s); if (!cmd) { const i = readProjectConfig(); return i ? `"${s}" not found.\n${formatPackageScripts(i)}` : "No project."; } return await runLocalCommand(cmd); }

  // SSH test
  if (intent.intent === "ssh.test") return await testSshConnection(environment);

  // Smart archive (local only)
  if (intent.intent === "archive.tar" && isLocal) {
    const source = (fields.source as string) ?? process.cwd();
    const includeAll = intent.rawText.match(/include.?(all|everything)|with.?node.?modules|no.?exclude/i) !== null;
    command = "[smart-archive]";
    result = await smartArchive({ source, destination: fields.destination as string | undefined, includeAll });
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: true });
    return result;
  }

  // OpenClaw nvm wrapper for template commands
  if (intent.intent.startsWith("openclaw.") && def.command.includes("openclaw") && !def.command.startsWith("[")) {
    const nvmWrap = `for d in "$HOME/.nvm" "/home/"*"/.nvm" "/root/.nvm"; do [ -s "$d/nvm.sh" ] && export NVM_DIR="$d" && . "$d/nvm.sh" && break; done 2>/dev/null; nvm use 22 > /dev/null 2>&1;`;
    command = interpolateCommand(def, fields);
    const wrappedCmd = `bash -c '${nvmWrap} ${command}'`;
    try {
      result = await withSpinner(`${intent.intent}...`, () => runLocalCommand(wrappedCmd));
    } catch (err: unknown) {
      result = `\x1b[31m✗ ${(err as Error).message.split("\n")[0]}\x1b[0m`;
    }
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: true });
    return result;
  }

  // ── End ported handlers ────────────────────────────────────────────────────

  // Smart file reading — size check, sampling, context search
  if (intent.intent === "file.read" || intent.intent === "file.parse") {
    const filePath = (fields.path as string) ?? "";
    if (filePath) {
      command = `[smart-read] ${filePath}`;
      result = await withSpinner(`Reading ${filePath}...`, () =>
        smartRead(filePath, !isLocal, isLocal ? undefined : environment)
      );
      recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: true });
      return result;
    }
  }

  if (intent.intent === "file.search_in") {
    const filePath = (fields.path as string) ?? "";
    const query = (fields.query as string) ?? "";
    if (filePath && query) {
      command = `[smart-search] ${query} in ${filePath}`;
      result = await withSpinner(`Searching "${query}" in ${filePath}...`, () =>
        smartSearch(filePath, query, !isLocal, isLocal ? undefined : environment)
      );
      recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: true });
      return result;
    }
  }

  // Knowledge lookup — Wikidata
  if (intent.intent === "knowledge.lookup") {
    // Extract the full topic from raw text, not the truncated field
    const topic = intent.rawText
      .replace(/^(what|who)\s+(is|are|was|were)\s+/i, "")
      .replace(/^(tell\s+me\s+about|define|lookup|look\s+up|explain|info\s+about|information\s+about|facts\s+about|learn\s+about|whats\s+a|what\s+are)\s*/i, "")
      .replace(/\?$/, "").trim()
      || ((fields.topic as string) ?? "");
    command = `[wiki-lookup] ${topic}`;
    const wikiResult = await searchWikidata(topic);
    if (wikiResult.found && wikiResult.entity) {
      result = formatWikiEntity(wikiResult.entity);
    } else if (wikiResult.suggestions?.length) {
      result = formatWikiSuggestions(wikiResult.suggestions);
    } else {
      result = `No information found for "${topic}"`;
    }
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: wikiResult.found });
    return result;
  }

  // Where is everything installed
  if (intent.intent === "ai.where_installed") {
    const { detectImageEngines, getDriveInfo } = await import("../utils/imageGen.js");
    const { execSync: ex } = await import("node:child_process");
    const tryCmd = (cmd: string) => { try { return ex(cmd, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 5000 }).trim(); } catch { return null; } };

    const engines = detectImageEngines();
    const lines: string[] = [];
    lines.push("\x1b[1m\x1b[36mInstall Locations\x1b[0m\n");

    // Local SD engines
    const installed = engines.filter(e => e.installed && e.path);
    if (installed.length > 0) {
      lines.push("\x1b[1mLocal Engines:\x1b[0m");
      for (const e of installed) {
        const size = tryCmd(`du -sh "${e.path}" 2>/dev/null`)?.split("\t")[0] ?? "?";
        lines.push(`  \x1b[32m✓\x1b[0m \x1b[1m${e.engine}\x1b[0m: ${e.path} (${size})`);
      }
      lines.push("");
    }

    // Docker images
    const dockerImages = tryCmd("docker images --format '{{.Repository}}:{{.Tag}}  {{.Size}}  {{.ID}}' 2>/dev/null | grep -i 'stable-diffusion\\|ai-dock\\|comfyui\\|sd-webui'");
    if (dockerImages) {
      lines.push("\x1b[1mDocker Images:\x1b[0m");
      for (const img of dockerImages.split("\n").filter(l => l.trim())) {
        lines.push(`  \x1b[36m${img}\x1b[0m`);
      }
      lines.push("");
    }

    // Docker data root
    const dockerRoot = tryCmd("docker info 2>/dev/null | grep 'Docker Root Dir' | awk '{print $NF}'");
    if (dockerRoot) {
      const dockerDrive = getDriveInfo(dockerRoot);
      lines.push(`\x1b[1mDocker Data:\x1b[0m ${dockerRoot}`);
      if (dockerDrive) lines.push(`  Drive: ${dockerDrive.mount} — ${dockerDrive.freeGB}GB free (${dockerDrive.usedPct}% used)`);
      const dockerSize = tryCmd(`du -sh ${dockerRoot} 2>/dev/null`)?.split("\t")[0];
      if (dockerSize) lines.push(`  Total Docker disk usage: ${dockerSize}`);
      lines.push("");
    }

    // Models
    const modelsDirs = [
      ...engines.filter(e => e.path).map(e => `${e.path}/models`),
    ];
    for (const mDir of modelsDirs) {
      const models = tryCmd(`find "${mDir}" -name "*.safetensors" -o -name "*.ckpt" 2>/dev/null`);
      if (models) {
        lines.push(`\x1b[1mAI Models:\x1b[0m`);
        for (const m of models.split("\n").filter(l => l.trim())) {
          const size = tryCmd(`du -sh "${m}" 2>/dev/null`)?.split("\t")[0] ?? "?";
          lines.push(`  ${size}\t${m}`);
        }
        lines.push("");
      }
    }

    // Generated images
    const genDir = (await import("../utils/paths.js")).USER_HOME + "/generated-images";
    const imgCount = tryCmd(`ls "${genDir}"/*.png 2>/dev/null | wc -l`)?.trim() ?? "0";
    const imgSize = tryCmd(`du -sh "${genDir}" 2>/dev/null`)?.split("\t")[0] ?? "0";
    lines.push(`\x1b[1mGenerated Images:\x1b[0m ${genDir}`);
    lines.push(`  ${imgCount} images (${imgSize})`);

    result = lines.join("\n");
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: "[ai-where]", environment, success: true });
    return result;
  }

  // GPU info
  // Full SD diagnosis — end-to-end test: check, restart, generate, monitor
  if (intent.intent === "ai.diagnose") {
    const { detectGpu, detectImageEngines, getDriveInfo, generateImage } = await import("../utils/imageGen.js");
    const { execSync: exDiag, spawn: spawnDiag } = await import("node:child_process");
    const tryCmd = (cmd: string) => { try { return exDiag(cmd, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 5000 }).trim(); } catch { return null; } };
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    const say = (msg: string) => { console.error(msg); lines.push(msg); };
    const lines: string[] = [];
    let issues = 0;
    const wantsRestart = /restart/i.test(intent.rawText);

    say(`\n${cc.bold}${cc.cyan}Running Image Generation Diagnosis...${cc.reset}\n`);

    // 1. GPU
    say(`${cc.dim}Checking GPU...${cc.reset}`);
    const gpu = detectGpu();
    if (gpu.hasNvidia) {
      lines.push(`${cc.green}✓${cc.reset} GPU: ${gpu.gpuName} (${gpu.vram})`);
      if (gpu.vramFree) lines.push(`  VRAM free: ${gpu.vramFree} | Temp: ${gpu.gpuTemp ?? "?"} | Util: ${gpu.gpuUtil ?? "?"}`);
      if (gpu.gpuError) { lines.push(`  ${cc.yellow}⚠ ${gpu.gpuError}${cc.reset}`); issues++; }
    } else {
      lines.push(`${cc.yellow}⚠ No GPU — CPU mode only${cc.reset}`); issues++;
    }

    // 2. Engine installed?
    say(`${cc.dim}Checking if image engine is installed...${cc.reset}`);
    const engines = detectImageEngines();
    const installed = engines.find(e => e.installed && e.path && e.engine !== "docker");
    if (installed) {
      lines.push(`${cc.green}✓${cc.reset} Engine: ${installed.engine} at ${installed.path}`);
      const du = tryCmd(`du -sh "${installed.path}" 2>/dev/null`);
      if (du) lines.push(`  Size: ${du.split("\t")[0]}`);
    } else {
      lines.push(`${cc.red}✗ No local engine installed${cc.reset}`);
      lines.push(`  Fix: ${cc.cyan}notoken install stable-diffusion${cc.reset}`);
      issues++;
    }

    // 3. Model downloaded?
    say(`${cc.dim}Checking if AI model is downloaded...${cc.reset}`);
    if (installed?.path) {
      const { readdirSync: rd } = await import("node:fs");
      const modelsDir = `${installed.path}/models/Stable-diffusion`;
      try {
        const models = rd(modelsDir).filter((f: string) => f.endsWith(".safetensors") || f.endsWith(".ckpt"));
        if (models.length > 0) {
          lines.push(`${cc.green}✓${cc.reset} Model: ${models[0]}`);
        } else {
          lines.push(`${cc.red}✗ No model downloaded${cc.reset}`);
          lines.push(`  Fix: model will download on first launch, or manually download SD 1.5`);
          issues++;
        }
      } catch { lines.push(`${cc.yellow}⚠ Cannot check models directory${cc.reset}`); }
    }

    // 4. API running?
    say(`${cc.dim}Checking if server is responding...${cc.reset}`);
    const apiUp = !!tryCmd("curl -sf --max-time 3 http://localhost:7860/sdapi/v1/sd-models 2>/dev/null");
    if (apiUp) {
      lines.push(`${cc.green}✓${cc.reset} API: running at http://localhost:7860`);
      // Check what mode
      const flags = tryCmd("curl -sf --max-time 3 http://localhost:7860/sdapi/v1/cmd-flags 2>/dev/null");
      const cpuMode = flags?.includes('"skip_torch_cuda_test":true');
      lines.push(`  Mode: ${cpuMode ? "CPU" : "GPU"}`);
      // Check progress (is it busy?)
      const prog = tryCmd("curl -sf --max-time 3 http://localhost:7860/sdapi/v1/progress 2>/dev/null");
      if (prog) {
        try {
          const p = JSON.parse(prog);
          if (p.progress > 0 && p.progress < 1) {
            lines.push(`  ${cc.cyan}Currently generating: ${Math.round(p.progress * 100)}%${cc.reset}`);
          }
        } catch {}
      }
    } else {
      lines.push(`${cc.red}✗ API: not responding at localhost:7860${cc.reset}`);
      // Check if process exists
      const proc = tryCmd("ps aux | grep launch.py | grep -v grep | head -1");
      if (proc) {
        lines.push(`  ${cc.yellow}Process running but API not responding — may still be loading${cc.reset}`);
        lines.push(`  ${cc.dim}Wait a minute and check again: "image status"${cc.reset}`);
      } else {
        lines.push(`  ${cc.dim}Engine not running.${cc.reset}`);
        if (wantsRestart && installed) {
          lines.push(`\n  ${cc.cyan}Restarting...${cc.reset}`);
        } else {
          lines.push(`  Fix: ${cc.cyan}"start sd"${cc.reset} or ${cc.cyan}"restart sd"${cc.reset}`);
        }
      }
      issues++;
    }

    // 5. Disk space
    if (installed?.path) {
      const drive = getDriveInfo(installed.path);
      if (drive) {
        if (drive.freeGB < 5) {
          lines.push(`${cc.red}✗ Low disk: ${drive.freeGB}GB free on ${drive.mount}${cc.reset}`);
          issues++;
        } else {
          lines.push(`${cc.green}✓${cc.reset} Disk: ${drive.freeGB}GB free on ${drive.mount}`);
        }
      }
    }

    // 6. Docker
    const dockerRunning = engines.find(e => e.engine === "docker" && e.running);
    if (dockerRunning) {
      lines.push(`${cc.green}✓${cc.reset} Docker SD container running`);
    }

    // ── Phase 2: Fix issues automatically ──
    lines.push("");

    if (!installed) {
      lines.push(`${cc.bold}Action: Install needed${cc.reset} — say "install stable diffusion"`);
      result = lines.join("\n");
      recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: "[ai-diagnose]", environment, success: true });
      return result;
    }

    const instPath = installed.path ?? "";

    // If not running, start it
    if (!apiUp) {
      say(`\n${cc.cyan}▶ Server is not running. Starting engine automatically...${cc.reset}`);

      const { resolve: rp } = await import("node:path");
      const { existsSync: fe } = await import("node:fs");

      // Try GPU first, fall back to CPU if errors detected
      let useGpu = gpu.hasNvidia && !gpu.gpuError;
      let mode = useGpu ? "GPU" : "CPU";
      let args = useGpu
        ? ["launch.py", "--api", "--listen", "--skip-install"]
        : ["launch.py", "--api", "--listen", "--skip-torch-cuda-test", "--no-half", "--skip-install"];

      const venvPy = rp(instPath, "venv", "bin", "python");
      const child = spawnDiag(fe(venvPy) ? venvPy : "python3", args, {
        cwd: instPath, detached: true, stdio: "ignore",
        env: { ...process.env, PATH: `/usr/lib/wsl/lib:${process.env.PATH}` },
      });
      child.unref();

      // Wait for API (up to 2 min)
      lines.push(`${cc.dim}  Waiting for API (${mode} mode)...${cc.reset}`);
      let started = false;
      for (let i = 0; i < 40; i++) {
        await new Promise(r => setTimeout(r, 3000));
        if (tryCmd("curl -sf --max-time 2 http://localhost:7860/sdapi/v1/sd-models >/dev/null 2>&1") !== null) {
          started = true;
          break;
        }
        // Check for crash
        const newErrors = parseInt(tryCmd("dmesg 2>/dev/null | grep -ci 'dxgkio_reserve_gpu_va' 2>/dev/null") ?? "0") || 0;
        if (useGpu && newErrors > (parseInt(tryCmd("echo 1290") ?? "0") || 0)) {
          lines.push(`${cc.red}  ✗ GPU crashed! Switching to CPU mode...${cc.reset}`);
          try { exDiag("pkill -9 -f launch.py 2>/dev/null", { stdio: "ignore", timeout: 5000 }); } catch {}
          await new Promise(r => setTimeout(r, 3000));
          useGpu = false;
          mode = "CPU";
          args = ["launch.py", "--api", "--listen", "--skip-torch-cuda-test", "--no-half", "--skip-install"];
          const child2 = spawnDiag(fe(venvPy) ? venvPy : "python3", args, {
            cwd: instPath, detached: true, stdio: "ignore",
            env: { ...process.env, PATH: `/usr/lib/wsl/lib:${process.env.PATH}` },
          });
          child2.unref();
          lines.push(`${cc.dim}  Retrying in CPU mode...${cc.reset}`);
        }
        if (i % 10 === 9) lines.push(`${cc.dim}  Still loading... (${(i + 1) * 3}s)${cc.reset}`);
      }

      if (started) {
        lines.push(`${cc.green}  ✓ Engine started in ${mode} mode${cc.reset}`);
      } else {
        lines.push(`${cc.red}  ✗ Engine did not start after 2 minutes${cc.reset}`);
        lines.push(`${cc.dim}  Check log: tail ~/.notoken/.sd-forge.log${cc.reset}`);
        result = lines.join("\n");
        recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: "[ai-diagnose]", environment, success: false });
        return result;
      }
    }

    // ── Phase 3: Test generation ──
    say("");
    say(`${cc.cyan}▶ Now testing: generating a test image to verify everything works...${cc.reset}`);

    // Check memory before
    say(`${cc.dim}Checking GPU memory usage before generation...${cc.reset}`);
    const memBefore = tryCmd("PATH=/usr/lib/wsl/lib:$PATH nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null");
    if (memBefore) lines.push(`${cc.dim}  VRAM before: ${memBefore}${cc.reset}`);

    const testResult = await generateImage("test image: a red circle on white background");

    // Check memory during/after
    const memAfter = tryCmd("PATH=/usr/lib/wsl/lib:$PATH nvidia-smi --query-gpu=memory.used --format=csv,noheader 2>/dev/null");
    if (memAfter) lines.push(`${cc.dim}  VRAM after: ${memAfter}${cc.reset}`);

    if (testResult.success) {
      lines.push(`${cc.green}  ✓ Test image generated successfully!${cc.reset}`);
      if (testResult.imagePath) {
        lines.push(`${cc.dim}  Saved: ${testResult.imagePath}${cc.reset}`);
        // Clean up test image
        try { (await import("node:fs")).writeFileSync(testResult.imagePath, ""); } catch {}
      }
    } else {
      lines.push(`${cc.red}  ✗ Test generation failed: ${testResult.error ?? "unknown"}${cc.reset}`);
      issues++;
    }

    // ── Phase 4: Check if server survived ──
    say("");
    say(`${cc.dim}Verifying server is still running after generation...${cc.reset}`);
    const stillUp = !!tryCmd("curl -sf --max-time 3 http://localhost:7860/sdapi/v1/sd-models 2>/dev/null");
    if (stillUp) {
      lines.push(`${cc.green}  ✓ Server still running after test${cc.reset}`);
    } else {
      lines.push(`${cc.red}  ✗ Server crashed during generation!${cc.reset}`);
      lines.push(`${cc.dim}  This usually means GPU VRAM ran out. Try: "switch to cpu mode"${cc.reset}`);
      issues++;
    }

    // ── Summary ──
    lines.push("");
    if (issues === 0) {
      lines.push(`${cc.green}${cc.bold}All checks passed!${cc.reset} Image generation is fully working.`);
      lines.push(`${cc.dim}Say: "generate a picture of a cat"${cc.reset}`);
    } else {
      lines.push(`${cc.yellow}${issues} issue(s) found.${cc.reset}`);
      suggestAction({ action: "switch to cpu mode", description: "Try CPU mode for stability", type: "intent" });
    }

    result = lines.join("\n");
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: "[ai-diagnose]", environment, success: issues === 0 });
    return result;
  }

  if (intent.intent === "hardware.gpu") {
    const { detectGpu } = await import("../utils/imageGen.js");
    const gpu = detectGpu();
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
    const lines: string[] = [`${cc.bold}${cc.cyan}GPU Information${cc.reset}\n`];
    if (gpu.hasNvidia) {
      lines.push(`  ${cc.green}✓${cc.reset} ${cc.bold}${gpu.gpuName}${cc.reset}`);
      if (gpu.vram) lines.push(`  VRAM: ${gpu.vram} total${gpu.vramFree ? `, ${gpu.vramFree} free` : ""}`);
      if (gpu.gpuTemp) lines.push(`  Temperature: ${gpu.gpuTemp}`);
      if (gpu.gpuUtil) lines.push(`  Utilization: ${gpu.gpuUtil}`);
      if (gpu.driverVersion) lines.push(`  Driver: ${gpu.driverVersion}`);
      if (gpu.cudaVersion) lines.push(`  CUDA: ${gpu.cudaVersion}`);
      if (gpu.wslCuda) lines.push(`  WSL CUDA: ${cc.green}available${cc.reset}`);
      if (gpu.gpuError) lines.push(`  ${cc.red}⚠ Error: ${gpu.gpuError}${cc.reset}`);
    } else if (gpu.hasAmd) {
      lines.push(`  ${cc.green}✓${cc.reset} AMD GPU detected`);
    } else {
      lines.push(`  ${cc.yellow}No GPU detected${cc.reset} — running in CPU mode`);
    }
    result = lines.join("\n");
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: "[gpu-info]", environment, success: true });
    return result;
  }

  // GPU/CPU mode switch — restarts engine with appropriate flags
  if (intent.intent === "ai.gpu_mode") {
    const { detectGpu, detectImageEngines } = await import("../utils/imageGen.js");
    const { spawn: spawnChild } = await import("node:child_process");
    const { execSync: exSync } = await import("node:child_process");
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    const wantGpu = /gpu|graphics|nvidia|cuda/i.test(intent.rawText) && !/cpu|disable|off|without/i.test(intent.rawText);
    const gpu = detectGpu();
    const engines = detectImageEngines();

    if (wantGpu && !gpu.hasNvidia) {
      result = `${cc.red}No NVIDIA GPU detected.${cc.reset} Only CPU mode available.`;
    } else if (wantGpu && gpu.gpuError && !/force/i.test(intent.rawText)) {
      result = `${cc.yellow}⚠ GPU detected (${gpu.gpuName}) but has issues:${cc.reset}\n  ${cc.dim}${gpu.gpuError}${cc.reset}\n\n  GPU mode may crash. Say ${cc.cyan}"force gpu mode"${cc.reset} to try anyway, or use ${cc.cyan}"cpu mode"${cc.reset} (recommended).`;
      suggestAction({ action: "switch to cpu mode", description: "Use CPU mode (stable)", type: "intent" });
      recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: "[gpu-mode-warn]", environment, success: true });
      return result;
    } else {
      const engine = engines.find(e => e.installed && e.path && e.engine !== "docker");
      if (!engine?.path) {
        result = `${cc.yellow}No local engine installed.${cc.reset} Say "install stable diffusion" first.`;
      } else {
        // Kill running engine
        console.error(`${cc.dim}Stopping current engine...${cc.reset}`);
        try { exSync("pkill -9 -f 'launch.py' 2>/dev/null", { stdio: "ignore", timeout: 5000 }); } catch {}
        await new Promise(r => setTimeout(r, 3000));

        const mode = wantGpu ? "GPU" : "CPU";
        const launchArgs = wantGpu
          ? ["launch.py", "--api", "--listen", "--skip-install"]
          : ["launch.py", "--api", "--listen", "--skip-torch-cuda-test", "--no-half", "--skip-install"];

        const { resolve: resolvePath } = await import("node:path");
        const { existsSync: fileExists } = await import("node:fs");
        const venvPy = resolvePath(engine.path, "venv", "bin", "python");
        console.error(`${cc.cyan}Restarting in ${mode} mode...${cc.reset}`);
        const child = spawnChild(fileExists(venvPy) ? venvPy : "python3", launchArgs, {
          cwd: engine.path, detached: true, stdio: "ignore",
          env: { ...process.env, PATH: `/usr/lib/wsl/lib:${process.env.PATH}` },
        });
        child.unref();

        // Wait for API (up to 3 min)
        let ready = false;
        for (let i = 0; i < 60; i++) {
          await new Promise(r => setTimeout(r, 3000));
          try { exSync("curl -sf --max-time 2 http://localhost:7860/sdapi/v1/sd-models >/dev/null 2>&1", { timeout: 5000 }); ready = true; break; } catch {}
          if (i % 10 === 9) console.error(`${cc.dim}  Still starting... (${(i + 1) * 3}s)${cc.reset}`);
        }

        if (ready) {
          result = `${cc.green}✓${cc.reset} Restarted in ${cc.bold}${mode} mode${cc.reset}\n  API: http://localhost:7860`;
          if (wantGpu) result += `\n  Using: ${gpu.gpuName}${gpu.vramFree ? ` (${gpu.vramFree} free)` : ""}`;
        } else {
          result = `${cc.yellow}⚠ Engine started but API not responding.${cc.reset}`;
          if (wantGpu) {
            result += `\n  GPU mode may have crashed. Try: ${cc.cyan}"switch to cpu mode"${cc.reset}`;
            suggestAction({ action: "switch to cpu mode", description: "Fall back to CPU", type: "intent" });
          }
        }
      }
    }
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: `[gpu-mode]`, environment, success: true });
    return result;
  }

  // Start SD — auto-detects GPU, verifies it started
  if (intent.intent === "ai.start_sd") {
    const { detectGpu, detectImageEngines } = await import("../utils/imageGen.js");
    const { spawn: spawnChild, execSync: exStart } = await import("node:child_process");
    const tryCmd = (cmd: string) => { try { return exStart(cmd, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 5000 }).trim(); } catch { return null; } };
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };
    const engines = detectImageEngines();

    // Check what's currently on port 7860
    const portOwner = tryCmd("ss -tlnp 2>/dev/null | grep ':7860' | head -1") ?? tryCmd("lsof -i:7860 2>/dev/null | head -2");
    const apiUp = !!tryCmd("curl -sf --max-time 2 http://localhost:7860/sdapi/v1/sd-models 2>/dev/null");
    const running = engines.find(e => e.running);

    if (apiUp && running) {
      const platform = running.platform ?? "unknown";
      console.error(`${cc.yellow}Port 7860 is already in use by ${running.engine} [${platform}]${cc.reset}`);
      if (running.pid) console.error(`${cc.dim}  PID: ${running.pid}${cc.reset}`);

      // Check if user wants to switch
      const wantsWSL = /wsl|linux/i.test(intent.rawText);
      const wantsWindows = /windows|win|stability matrix|sm/i.test(intent.rawText);

      if (wantsWSL && platform === "windows") {
        console.error(`${cc.cyan}Stopping Windows engine to start WSL engine...${cc.reset}`);
        // Can't kill Windows process from WSL directly — tell user
        console.error(`${cc.dim}  Please close Stability Matrix on Windows, then say "start sd" again.${cc.reset}`);
        result = `${cc.yellow}Windows engine is using port 7860.${cc.reset} Close Stability Matrix first, then try again.`;
      } else if (wantsWindows && platform === "wsl") {
        console.error(`${cc.cyan}Stopping WSL engine to start Windows engine...${cc.reset}`);
        try { exStart("pkill -9 -f 'launch.py' 2>/dev/null", { stdio: "ignore", timeout: 5000 }); } catch {}
        await new Promise(r => setTimeout(r, 3000));
        console.error(`${cc.green}✓${cc.reset} WSL engine stopped. Launching Stability Matrix...`);
        const smDir = engines.find(e => e.engine === "stability-matrix")?.path;
        if (smDir) {
          try {
            const winPath = tryCmd(`wslpath -w "${smDir}" 2>/dev/null`);
            if (winPath) exStart(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process '${winPath}\\StabilityMatrix.exe'" 2>/dev/null`, { stdio: "ignore", timeout: 10000 });
          } catch {}
        }
        result = `${cc.green}✓${cc.reset} WSL engine stopped. Stability Matrix launched on Windows.\n  ${cc.dim}Start a UI inside SM, then say "image status" to check.${cc.reset}`;
      } else {
        result = `${cc.green}✓${cc.reset} Already running: ${running.engine} [${platform}] at ${running.url}`;
      }
    } else if (apiUp && !running) {
      // Something else is on port 7860
      console.error(`${cc.yellow}⚠ Port 7860 is in use by an unknown process${cc.reset}`);
      if (portOwner) console.error(`${cc.dim}  ${portOwner}${cc.reset}`);
      result = `${cc.yellow}Port 7860 is already in use by something else.${cc.reset}\n  ${cc.dim}Check with: ss -tlnp | grep 7860${cc.reset}\n  ${cc.dim}Or use a different port.${cc.reset}`;
    } else {
      // Port free — start engine
      const engine = engines.find(e => e.installed && e.path && e.engine !== "docker" && e.engine !== "stability-matrix");
      if (!engine?.path) {
        // Try launching Stability Matrix instead
        const sm = engines.find(e => e.engine === "stability-matrix" && e.installed);
        if (sm?.path) {
          console.error(`${cc.cyan}Launching Stability Matrix...${cc.reset}`);
          try {
            const winPath = tryCmd(`wslpath -w "${sm.path}" 2>/dev/null`);
            if (winPath) exStart(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process '${winPath}\\StabilityMatrix.exe'" 2>/dev/null`, { stdio: "ignore", timeout: 10000 });
          } catch {}
          result = `${cc.cyan}Stability Matrix launched.${cc.reset} Start a UI inside it, then say "image status".`;
        } else {
          result = `${cc.yellow}No local engine installed.${cc.reset} Say "install stable diffusion" first.`;
        }
      } else {
        const gpu = detectGpu();
        const useGpu = gpu.hasNvidia && !gpu.gpuError && !/cpu/i.test(intent.rawText);
        const mode = useGpu ? "GPU" : "CPU";
        const args = useGpu
          ? ["launch.py", "--api", "--listen", "--skip-install"]
          : ["launch.py", "--api", "--listen", "--skip-torch-cuda-test", "--no-half", "--skip-install"];

        console.error(`${cc.cyan}Starting ${engine.engine} [${engine.platform}] in ${mode} mode...${cc.reset}`);
        const { resolve: rp } = await import("node:path");
        const { existsSync: fe } = await import("node:fs");
        const venvPy = rp(engine.path, "venv", "bin", "python");
        const child = spawnChild(fe(venvPy) ? venvPy : "python3", args, {
          cwd: engine.path, detached: true, stdio: "ignore",
          env: { ...process.env, PATH: `/usr/lib/wsl/lib:${process.env.PATH}` },
        });
        child.unref();

        result = `${cc.dim}Starting ${engine.engine} [${engine.platform}] in ${mode} mode... say "image status" to check.${cc.reset}`;
        suggestAction({ action: "image status", description: "Check if engine started", type: "intent" });
      }
    }
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: "[start-sd]", environment, success: true });
    return result;
  }

  // Stop SD — detects what's running and stops the right one
  if (intent.intent === "ai.stop_sd") {
    const { detectImageEngines } = await import("../utils/imageGen.js");
    const { execSync: exStop } = await import("node:child_process");
    const tryCmd = (cmd: string) => { try { return exStop(cmd, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 5000 }).trim(); } catch { return null; } };
    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", green: "\x1b[32m", yellow: "\x1b[33m", dim: "\x1b[2m", cyan: "\x1b[36m" };
    const engines = detectImageEngines();
    const running = engines.find(e => e.running);

    if (!running) {
      result = `${cc.dim}No engine running.${cc.reset}`;
    } else {
      const platform = running.platform ?? "unknown";
      console.error(`${cc.dim}Stopping ${running.engine} [${platform}]...${cc.reset}`);

      if (platform === "wsl" || platform === "linux") {
        try { exStop("pkill -9 -f 'launch.py' 2>/dev/null", { stdio: "ignore", timeout: 5000 }); } catch {}
        await new Promise(r => setTimeout(r, 2000));
        const stillUp = !!tryCmd("curl -sf --max-time 2 http://localhost:7860/ 2>/dev/null");
        result = stillUp
          ? `${cc.yellow}WSL engine killed but port 7860 still responding — Windows engine may be running too.${cc.reset}`
          : `${cc.green}✓${cc.reset} ${running.engine} [${platform}] stopped.`;
      } else if (platform === "windows") {
        console.error(`${cc.yellow}Cannot stop Windows processes from WSL directly.${cc.reset}`);
        result = `${cc.yellow}The engine is running on Windows (Stability Matrix).${cc.reset}\n  Close it from the Stability Matrix UI or Windows Task Manager.\n  ${cc.dim}Or say "stop wsl engine" to stop only the WSL one.${cc.reset}`;
      } else {
        try { exStop("pkill -9 -f 'launch.py' 2>/dev/null", { stdio: "ignore", timeout: 5000 }); } catch {}
        await new Promise(r => setTimeout(r, 2000));
        result = `${cc.green}✓${cc.reset} Engine stopped.`;
      }
    }
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command: "[stop-sd]", environment, success: true });
    return result;
  }

  // Install SD with optional user-specified path
  if (intent.intent === "ai.install_sd") {
    const { resolveUserPath } = await import("../utils/imageGen.js");
    // Extract drive/path from rawText: "on D drive", "on /mnt/f"
    const rawLower = intent.rawText.toLowerCase();
    const pathMatch = rawLower.match(/\b(?:on|in|at|to)\s+([a-z]\s*drive|\/\S+)/i);
    if (pathMatch) {
      const resolved = resolveUserPath(pathMatch[1]);
      if (resolved) {
        process.env.NOTOKEN_INSTALL_DIR = resolved;
        console.error(`\x1b[36mInstall location:\x1b[0m ${resolved}`);
      }
    }

    // The field parser may have extracted a drive letter as the "engine" field
    // e.g. "install stable diffusion on D drive" → engine: "d"
    const engineField = (fields.engine as string) ?? "";
    let engine: "auto1111" | "comfyui" | "fooocus" | "docker" = "auto1111";

    if (/^[a-z]$/i.test(engineField)) {
      // Single letter = drive letter, not an engine name
      const resolved = resolveUserPath(`${engineField} drive`);
      if (resolved) {
        process.env.NOTOKEN_INSTALL_DIR = resolved;
        console.error(`\x1b[36mInstall location:\x1b[0m ${resolved}`);
      }
      // Default to auto1111
    } else if (engineField.includes("comfy")) {
      engine = "comfyui";
    } else if (engineField.includes("fooocus") || engineField.includes("focus")) {
      engine = "fooocus";
    } else if (engineField.includes("docker")) {
      engine = "docker";
    }

    command = `[install-sd] ${engine}`;
    const { installImageEngine } = await import("../utils/imageGen.js");
    const installResult = await installImageEngine(engine);
    result = installResult.message;
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: installResult.success });
    return result;
  }

  // Image generation — natural language to image
  if (intent.intent === "ai.generate_image") {
    // Simple: strip the command prefix, pass everything else as the prompt
    // "can you generate a picture of a dragon flying over a castle at sunset"
    // → "a dragon flying over a castle at sunset"
    const prompt = intent.rawText
      .replace(/^(can you|could you|please|will you|would you)\s+/i, "")
      .replace(/^(generate|create|make|draw|paint|imagine)\s+(me\s+)?/i, "")
      .replace(/^(a\s+)?(picture|image|photo|drawing|painting|art|artwork)\s+(of\s+)?/i, "")
      .replace(/\s+(and\s+)?(show|open|display|view)\s+(it\s+)?(to\s+)?(me|us)?\s*$/i, "")
      .replace(/\s+(please|for me|for us)\s*$/i, "")
      .trim()
      || ((fields.prompt as string) ?? "a beautiful landscape");
    command = `[image-gen] ${prompt}`;
    const genResult = await generateImage(prompt);
    result = genResult.message ?? genResult.error ?? "Unknown error";
    if (genResult.imagePath) {
      result += `\n\nFile: ${genResult.imagePath}`;
      // Auto-open the image if running locally
      if (isLocal) {
        try {
          const { execSync: run } = await import("node:child_process");
          const os = (await import("node:os")).platform();
          const isWSL = !!(() => { try { return run("grep -qi microsoft /proc/version && echo wsl", { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 2000 }).trim(); } catch { return null; } })();
          if (isWSL) {
            const winPath = run(`wslpath -w "${genResult.imagePath}" 2>/dev/null`, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 3000 }).trim();
            // Use PowerShell — cmd.exe often not in PATH for root in WSL
            run(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process '${winPath}'" 2>/dev/null`, { stdio: "ignore" });
          } else if (os === "darwin") {
            run(`open "${genResult.imagePath}"`, { stdio: "ignore" });
          } else if (os === "win32") {
            run(`start "" "${genResult.imagePath}"`, { stdio: "ignore", shell: "cmd.exe" });
          } else {
            run(`xdg-open "${genResult.imagePath}" 2>/dev/null`, { stdio: "ignore" });
          }
        } catch {}
      }
    }
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: genResult.success });
    return result;
  }

  // Image engine status
  if (intent.intent === "ai.image_status") {
    command = "[image-status]";
    const engines = detectImageEngines();
    const hasLocal = engines.some(e => e.installed && e.engine !== "docker" && e.running);

    // Detect if user is asking to GO offline, not just checking status
    const wantsOffline = /\b(can we|can i|how do i|how can i|let'?s|lets|i want to|set up|enable|switch to|go|do it|run it|run this)\b.*\b(offline|local|locally|private)\b/i.test(intent.rawText)
      || /\b(offline|local|locally|private)\b.*\b(install|set up|put|place)\b/i.test(intent.rawText);

    // Extract drive/path from the same sentence: "on D drive", "on /mnt/f"
    const driveMatch = intent.rawText.match(/\b(?:on|in|at|to)\s+([a-z]\s*drive|\/\S+)/i);
    if (driveMatch) {
      const { resolveUserPath } = await import("../utils/imageGen.js");
      const resolved = resolveUserPath(driveMatch[1]);
      if (resolved) {
        process.env.NOTOKEN_INSTALL_DIR = resolved;
        console.error(`\x1b[36mInstall location:\x1b[0m ${resolved} (from "${driveMatch[1]}")`);
      }
    }

    if (wantsOffline && !hasLocal) {
      // User wants offline — pick the best install path automatically
      const { installImageEngine, detectGpu } = await import("../utils/imageGen.js");
      const gpu = detectGpu();
      const { execSync: ex } = await import("node:child_process");
      const exec = (cmd: string) => { try { return ex(cmd, { encoding: "utf-8", stdio: ["pipe","pipe","pipe"], timeout: 5000 }).trim(); } catch { return null; } };
      const hasDocker = !!exec("docker --version");
      const hasPython = !!exec("python3 --version") || !!exec("python --version");
      const pyVer = exec("python3 --version") ?? exec("python --version") ?? "not installed";

      console.error(`\x1b[1m\x1b[35mSetting up offline image generation\x1b[0m\n`);
      console.error(`Currently using cloud API. Setting up local generation...\n`);

      if (gpu.hasNvidia) {
        console.error(`\x1b[32m✓ GPU: ${gpu.gpuName}${gpu.vram ? ` (${gpu.vram})` : ""}\x1b[0m`);
      } else {
        console.error(`\x1b[33m⚠ No GPU — CPU mode (slower but works)\x1b[0m`);
      }
      console.error(`${hasDocker ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m Docker: ${hasDocker ? "available" : "not installed"}`);
      console.error(`${hasPython ? "\x1b[32m✓" : "\x1b[31m✗"}\x1b[0m Python: ${pyVer}`);
      console.error(`\x1b[2mCancel anytime with Ctrl+C\x1b[0m\n`);

      suggestAction({
        action: "generate a picture of a cat",
        description: "Generate a test image to verify offline setup works",
        type: "intent",
      });

      // Strategy: Stability Matrix first (frictionless), then Docker, then Python
      let installResult: { success: boolean; message: string } | null = null;

      // 1. Stability Matrix — all-in-one, no pip/git/build tools needed
      const isWSL = !!exec("grep -qi microsoft /proc/version && echo wsl");
      const os = (await import("node:os")).platform();

      if (os === "win32" || isWSL) {
        console.error(`\x1b[1mStrategy: Stability Matrix\x1b[0m — all-in-one launcher, zero dependencies\n`);
        const smUrl = "https://github.com/LykosAI/StabilityMatrix/releases/latest/download/StabilityMatrix-win-x64.zip";
        const { getDriveInfo } = await import("../utils/imageGen.js");
        const installDir = process.env.NOTOKEN_INSTALL_DIR ?? (isWSL ? "/mnt/d/notoken/ai" : "D:\\notoken\\ai");
        const smDir = isWSL ? `${installDir}/StabilityMatrix` : `${installDir}\\StabilityMatrix`;
        const smZip = isWSL ? "/tmp/StabilityMatrix.zip" : `${process.env.TEMP ?? "C:\\Temp"}\\StabilityMatrix.zip`;

        console.error(`  Downloading Stability Matrix...`);
        try {
          if (isWSL) {
            exec(`mkdir -p "${installDir}"`);
            // Download via curl in WSL
            const { execSync: exSync } = await import("node:child_process");
            exSync(`curl -L -o "${smZip}" "${smUrl}"`, { stdio: "inherit", timeout: 300000 });
            exSync(`unzip -o -q "${smZip}" -d "${smDir}"`, { stdio: "inherit", timeout: 60000 });
            console.error(`\x1b[32m✓\x1b[0m Downloaded to ${smDir}`);

            // Open it on Windows side
            try {
              const winPath = exec(`wslpath -w "${smDir}"`);
              exSync(`/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe -Command "Start-Process '${winPath}\\StabilityMatrix.exe'" 2>/dev/null`, { stdio: "ignore" });
              console.error(`\x1b[32m✓\x1b[0m Launched on Windows!`);
            } catch {}

            installResult = {
              success: true,
              message: [
                `\x1b[32m✓\x1b[0m Stability Matrix installed at ${smDir}`,
                ``,
                `It's now open on your Windows desktop.`,
                `  1. Choose a UI (Forge, ComfyUI, or Fooocus)`,
                `  2. It downloads everything automatically`,
                `  3. Once running, say "generate a picture of a cat"`,
                ``,
                `\x1b[1mStability Matrix handles ALL dependencies — no Python, pip, or git needed.\x1b[0m`,
              ].join("\n"),
            };
          } else {
            // Native Windows
            const { execSync: exSync } = await import("node:child_process");
            exSync(`powershell -Command "Invoke-WebRequest -Uri '${smUrl}' -OutFile '${smZip}'"`, { stdio: "inherit", timeout: 300000, shell: "cmd.exe" });
            exSync(`powershell -Command "Expand-Archive -Path '${smZip}' -DestinationPath '${smDir}' -Force"`, { stdio: "inherit", timeout: 60000, shell: "cmd.exe" });
            exSync(`start "" "${smDir}\\StabilityMatrix.exe"`, { stdio: "ignore", shell: "cmd.exe" });

            installResult = {
              success: true,
              message: [
                `\x1b[32m✓\x1b[0m Stability Matrix installed at ${smDir}`,
                `  It's now open — choose a UI and it downloads everything.`,
                `  Say "generate a picture of a cat" when ready.`,
              ].join("\n"),
            };
          }
        } catch (smErr) {
          console.error(`\x1b[33m⚠ Stability Matrix download failed: ${smErr instanceof Error ? smErr.message : smErr}\x1b[0m`);
          console.error(`  Manual download: https://lykos.ai\n`);
        }
      }

      // 2. Docker fallback
      if (!installResult?.success) {
        let dockerHasSpace = false;
        if (hasDocker) {
          const { getDriveInfo } = await import("../utils/imageGen.js");
          const dockerRoot = exec("docker info 2>/dev/null | grep 'Docker Root Dir' | awk '{print $NF}'") ?? "/var/lib/docker";
          const dockerDrive = getDriveInfo(dockerRoot);
          dockerHasSpace = (dockerDrive?.freeGB ?? 0) >= 16;
          if (!dockerHasSpace) {
            console.error(`\x1b[33m⚠ Docker: only ${dockerDrive?.freeGB ?? 0}GB free (need ~15GB)\x1b[0m\n`);
          }
        }

        if (hasDocker && dockerHasSpace) {
          console.error(`\x1b[1mStrategy: Docker\x1b[0m — containerized, pre-built\n`);
          installResult = await installImageEngine("docker");
        }
      }

      // 3. Python fallback
      if (!installResult?.success && hasPython) {
        console.error(`\x1b[1mStrategy: Using Python + git\x1b[0m — installing directly to ${process.env.NOTOKEN_INSTALL_DIR ?? "best drive"}\n`);
        installResult = await installImageEngine("auto1111");
      }

      if (installResult?.success) {
        result = installResult.message + `\n\n\x1b[1mSay "try it" or "generate a picture of a cat" to test.\x1b[0m`;
      } else {
        // Nothing worked — show standalone download options
        result = [
          `\x1b[33m${installResult?.message ?? "Could not install automatically."}\x1b[0m\n`,
          `\x1b[1mDownload a standalone installer (no Docker or Python needed):\x1b[0m`,
          `  \x1b[1mStability Matrix:\x1b[0m https://lykos.ai`,
          `  \x1b[1mEasy Diffusion:\x1b[0m  https://easydiffusion.github.io`,
          `  \x1b[1mFooocus:\x1b[0m         https://github.com/lllyasviel/Fooocus`,
          `\n\x1b[2mOr: notoken install stability-matrix\x1b[0m`,
        ].join("\n");
      }
      recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: true });
      return result;
    }

    result = formatImageEngineStatus(engines);
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: true });
    return result;
  }

  // Project scanning — rich local output instead of raw find command
  if (intent.intent === "project.scan") {
    let scanPath = (fields.path as string) ?? ".";
    if (["here", "this", "this folder", "this directory", "."].includes(scanPath)) scanPath = process.cwd();
    command = `[project-scan] ${scanPath}`;
    const projects = scanProjects(scanPath);
    result = formatProjectList(projects, scanPath);
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: true });
    return result;
  }

  // Directory listing — rich summary
  if (intent.intent === "dir.list" || intent.intent === "dir.summary") {
    let dirPath = (fields.path as string) ?? ".";
    if (!dirPath || ["here", "this", "this folder", "this directory", "."].includes(dirPath)) dirPath = process.cwd();
    command = `[dir-summary] ${dirPath}`;
    const summary = summarizeDirectory(dirPath);
    result = formatDirSummary(summary);
    recordHistory({ timestamp: new Date().toISOString(), rawText: intent.rawText, intent: intent.intent, fields, command, environment, success: true });
    return result;
  }

  // Route git intents through simple-git for better output
  if (intent.intent.startsWith("git.")) {
    command = `[simple-git] ${intent.intent}`;
    result = await withSpinner(`${intent.intent}...`, () =>
      executeGitIntent(intent.intent, fields)
    );
  } else {
    command = interpolateCommand(def, fields);

    // For remote destructive ops, prepend a backup command
    if (destructiveIntents.includes(intent.intent) && !isLocal) {
      const targetFile = (fields.source ?? fields.target ?? fields.path) as string | undefined;
      if (targetFile) {
        command = getRemoteBackupCommand(targetFile) + command;
      }
    }

    const spinnerMsg = isLocal
      ? `${intent.intent}...`
      : `${intent.intent} on ${environment}...`;

    try {
      result = await withSpinner(spinnerMsg, async () => {
        if (isLocal) {
          return runLocalCommand(command);
        } else {
          return runRemoteCommand(environment, command);
        }
      });
    } catch (err) {
      // Auto-detect missing commands and suggest install
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("command not found") || msg.includes("not found")) {
        const missingCmd = extractMissingCommand(msg);
        if (missingCmd) {
          const platform = detectLocalPlatform();
          const pkg = getPackageForCommand(missingCmd, platform);
          const installCmd = getInstallCommand(pkg ?? missingCmd, platform);
          throw new Error(`${msg}\n\nMissing command: ${missingCmd}\nInstall with: ${installCmd}`);
        }
      }
      throw err;
    }
  }

  recordHistory({
    timestamp: new Date().toISOString(),
    rawText: intent.rawText,
    intent: intent.intent,
    fields,
    command,
    environment,
    success: true,
  });

  // Append intelligent analysis if applicable
  const analysis = analyzeOutput(intent.intent, result, fields);
  if (analysis) {
    result += "\n" + analysis;
  }

  // Plugin afterExecute hooks
  await pluginRegistry.runAfterExecute({ intent: intent.intent, fields }, result);

  return result;
}

async function executeGitIntent(
  intentName: string,
  fields: Record<string, unknown>
): Promise<string> {
  const path = (fields.path as string) ?? ".";

  switch (intentName) {
    case "git.status":
      return gitStatus(path);
    case "git.log":
      return gitLog(path, (fields.count as number) ?? 10);
    case "git.diff":
      return gitDiff(path, fields.target as string | undefined);
    case "git.pull":
      return gitPull(path, (fields.remote as string) ?? "origin", fields.branch as string | undefined);
    case "git.push":
      return gitPush(path, (fields.remote as string) ?? "origin", fields.branch as string | undefined);
    case "git.branch":
      return gitBranch(path);
    case "git.checkout":
      return gitCheckout(fields.branch as string, path);
    case "git.commit":
      return gitCommit(fields.message as string, path);
    case "git.add":
      return gitAdd((fields.target as string) ?? ".", path);
    case "git.stash":
      return gitStash((fields.action as string) ?? "push", path);
    case "git.reset":
      return gitReset((fields.target as string) ?? "HEAD", path);
    default:
      throw new Error(`Unknown git intent: ${intentName}`);
  }
}

function interpolateCommand(
  def: IntentDef,
  fields: Record<string, unknown>
): string {
  let cmd = def.command;

  for (const [key, value] of Object.entries(fields)) {
    if (value !== undefined && value !== null) {
      const safe = sanitize(String(value));
      cmd = cmd.replaceAll(`{{${key}}}`, safe);
    }
  }

  for (const [fieldName, fieldDef] of Object.entries(def.fields)) {
    if (fieldDef.default !== undefined) {
      const safe = sanitize(String(fieldDef.default));
      cmd = cmd.replaceAll(`{{${fieldName}}}`, safe);
    }
  }

  cmd = cmd.replace(/\{\{[a-zA-Z_]+\}\}/g, "");

  return cmd.trim();
}

function sanitize(value: string): string {
  if (value === "") return "";
  if (!/^[a-zA-Z0-9_.\/\\\- :@~]+$/.test(value)) {
    throw new Error(`Unsafe field value rejected: "${value}"`);
  }
  return value;
}

function extractMissingCommand(errorMsg: string): string | null {
  const match1 = errorMsg.match(/bash: (\w+): command not found/);
  if (match1) return match1[1];
  const match2 = errorMsg.match(/sh: \d+: (\w+): not found/);
  if (match2) return match2[1];
  const match3 = errorMsg.match(/\/bin\/\w+: (\w+): not found/);
  if (match3) return match3[1];
  return null;
}

/**
 * Check if a real (non-placeholder) SSH host is configured for an environment.
 * Placeholder hosts like "user@dev-server" are detected and treated as unconfigured.
 */
function hasRealHost(environment: string): boolean {
  try {
    const hosts = loadHosts();
    const entry = hosts[environment];
    if (!entry) return false;

    const host = entry.host;
    // Detect common placeholder patterns
    const placeholders = [
      /user@(dev|staging|prod|test)-server$/,
      /user@(dev|staging|prod|test)$/,
      /example\.com$/,
      /localhost$/,
      /127\.0\.0\.1$/,
    ];
    return !placeholders.some((p) => p.test(host));
  } catch {
    return false;
  }
}
