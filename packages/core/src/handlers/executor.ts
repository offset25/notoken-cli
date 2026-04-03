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
    const effective = target ?? (env.inWSL ? "wsl" : "wsl");
    setLastOcEnv(effective === "both" ? "wsl" : effective);

    // Build openclaw command with Node 22 binary directly
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

  // OpenClaw doctor auto-fix
  if (intent.intent === "openclaw.doctor" && intent.rawText.match(/fix|repair|auto.?fix/i)) {
    return isLocal ? await autoFixOpenclaw() : await autoFixOpenclaw((cmd: string) => runRemoteCommand(environment, cmd));
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
    const targetEnv = ocTarget ?? (ocEnv?.inWSL ? "wsl" : "wsl");

    // ── Windows host actions ──
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

    // ── WSL actions ──
    if (targetEnv === "wsl" || targetEnv === "both") {
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
            // Something already on 18789 — check if it's Windows
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

    const cc = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", green: "\x1b[32m", yellow: "\x1b[33m", red: "\x1b[31m", cyan: "\x1b[36m" };

    if (!toolName || !INSTALL_INFO[toolName]) {
      return `${cc.red}✗ Unknown tool: "${toolName || "?"}"\x1b[0m\n\n  ${cc.dim}Available: ${Object.keys(INSTALL_INFO).join(", ")}${cc.reset}`;
    }

    const info = INSTALL_INFO[toolName];

    // Check if already installed
    const existing = await runLocalCommand(info.check + " 2>/dev/null").catch(() => "");
    if (existing) {
      return `${cc.green}✓${cc.reset} ${info.name} is already installed: ${cc.bold}${existing.trim()}${cc.reset}`;
    }

    // Check Node.js for npm-based tools
    if (info.install.startsWith("npm ")) {
      const nodeVer = await runLocalCommand("node --version 2>/dev/null").catch(() => "");
      if (!nodeVer) {
        return `${cc.red}✗ Node.js is required to install ${info.name}.${cc.reset}\n  ${cc.dim}Say: "install node" first.${cc.reset}`;
      }
    }

    console.log(`\n${cc.cyan}Installing ${info.name}...${cc.reset}`);
    console.log(`${cc.dim}  Running: ${info.install}${cc.reset}\n`);

    try {
      result = await withSpinner(`Installing ${info.name}...`, () => runLocalCommand(info.install + " 2>&1", 300_000));

      // Verify installation
      const ver = await runLocalCommand(info.check + " 2>/dev/null").catch(() => "");
      if (ver) {
        const lines = [`${cc.green}✓${cc.reset} ${info.name} installed successfully: ${cc.bold}${ver.trim()}${cc.reset}`];
        if (info.notes) lines.push(`\n  ${cc.yellow}Next:${cc.reset} ${info.notes}`);
        return lines.join("\n");
      }
      return `${cc.yellow}⚠${cc.reset} Install completed but could not verify. Try: ${cc.cyan}${info.check}${cc.reset}\n\n${cc.dim}Output:\n${result.substring(0, 500)}${cc.reset}`;
    } catch (err: unknown) {
      return `${cc.red}✗ Installation failed:${cc.reset} ${(err as Error).message.split("\n")[0]}\n\n  ${cc.dim}Try manually: ${info.install}${cc.reset}`;
    }
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
    // Use NLP tokenizer to extract the subject/object as the prompt
    let prompt: string;
    try {
      const { tokenize, parseDependencies } = await import("../nlp/semantic.js");
      const tokens = tokenize(intent.rawText, [], []);
      const deps = parseDependencies(tokens);
      // The image subject is the object of the verb ("draw [a cat]", "generate [sunset]")
      const objects = deps.filter(d => d.relation === "object" || d.relation === "subject");
      if (objects.length > 0) {
        // Rebuild prompt from all object/subject tokens plus any modifiers
        const objectTokens = objects.map(d => d.dependent);
        const modifiers = deps.filter(d => d.relation === "modifier").map(d => d.dependent);
        const promptTokens = [...objectTokens, ...modifiers].sort((a, b) => a.index - b.index);
        const SKIP_WORDS = new Set(["me", "i", "you", "us", "it", "them", "we", "he", "she",
          "picture", "image", "photo", "drawing", "painting", "art", "artwork",
          "generate", "create", "make", "draw", "paint", "imagine", "please"]);
        prompt = promptTokens.map(t => t.text).filter(w => !SKIP_WORDS.has(w.toLowerCase())).join(" ");
      } else {
        // Fallback: take all nouns and adjectives as the prompt
        const SKIP_WORDS = new Set(["me", "i", "you", "us", "it", "them", "we", "he", "she",
          "picture", "image", "photo", "drawing", "painting", "art", "artwork"]);
        const nouns = tokens.filter(t => ["NOUN", "ADJ", "PATH"].includes(t.tag) && !SKIP_WORDS.has(t.text.toLowerCase()));
        prompt = nouns.map(t => t.text).join(" ");
      }
    } catch {
      prompt = "";
    }

    // Final fallback: regex strip if NLP produced nothing useful
    if (!prompt || prompt.length < 2) {
      prompt = intent.rawText
        .replace(/^(can you|could you|please|will you|would you)\s+/i, "")
        .replace(/^(generate|create|make|draw|paint|imagine)\s+(me\s+)?/i, "")
        .replace(/^(a\s+)?(picture|image|photo|drawing|painting|art|artwork)\s+(of\s+)?/i, "")
        .replace(/\s+(and\s+)?(show|open|display|view)\s+(it\s+)?(to\s+)?(me|us)?\s*$/i, "")
        .replace(/\s+(please|for me|for us)\s*$/i, "")
        .trim()
        || ((fields.prompt as string) ?? "image");
    }
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

      // Strategy: pick best approach based on what's available and disk space
      let installResult: { success: boolean; message: string } | null = null;

      // Check if Docker data root has enough space (~15GB needed)
      let dockerHasSpace = false;
      if (hasDocker) {
        const { getDriveInfo } = await import("../utils/imageGen.js");
        const dockerRoot = exec("docker info 2>/dev/null | grep 'Docker Root Dir' | awk '{print $NF}'") ?? "/var/lib/docker";
        const dockerDrive = getDriveInfo(dockerRoot);
        dockerHasSpace = (dockerDrive?.freeGB ?? 0) >= 16;
        if (!dockerHasSpace) {
          console.error(`\x1b[33m⚠ Docker data root (${dockerRoot}) only has ${dockerDrive?.freeGB ?? 0}GB free — need ~15GB for image\x1b[0m`);
          console.error(`\x1b[2m  Skipping Docker — using Python install on ${process.env.NOTOKEN_INSTALL_DIR ?? "best available drive"} instead\x1b[0m\n`);
        }
      }

      if (hasDocker && dockerHasSpace) {
        console.error(`\x1b[1mStrategy: Using Docker\x1b[0m — fastest, everything pre-built\n`);
        installResult = await installImageEngine("docker");
      }

      if ((!installResult || !installResult.success) && hasPython) {
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
