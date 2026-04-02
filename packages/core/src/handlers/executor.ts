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

  const MODEL_ALIASES: Record<string, string> = {
    "opus": "anthropic/claude-opus-4-6", "sonnet": "anthropic/claude-sonnet-4-6", "haiku": "anthropic/claude-haiku-4-5",
    "claude": "anthropic/claude-opus-4-6", "gpt-4o": "openai-codex/gpt-4o", "gpt-5": "openai-codex/gpt-5.4",
    "gpt": "openai-codex/gpt-4o", "chatgpt": "openai-codex/gpt-4o", "codex": "openai-codex/gpt-5.4",
    "openai": "openai-codex/gpt-4o", "gemini": "google/gemini-2.5-pro", "mistral": "mistral/mistral-large",
    "llama": "ollama/llama2:13b", "llama2": "ollama/llama2:13b", "llama3": "ollama/llama3.2",
    "ollama": "ollama/llama2:13b", "codellama": "ollama/codellama", "phi": "ollama/phi3", "qwen": "ollama/qwen2.5",
    "deepseek": "ollama/deepseek-v3",
  };

  // Multi-environment execution
  const multiTargets = detectMultiTarget(intent.rawText);
  if (multiTargets && multiTargets.length > 1) return executeMulti(intent, multiTargets);

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

  // OpenClaw message
  if (intent.intent === "openclaw.message") {
    const msgMatch = intent.rawText.match(/(?:tell|ask|message|say to|send)\s+(?:openclaw|claw)\s+(.*)/i);
    const message = msgMatch?.[1]?.trim() || (fields.message as string) || intent.rawText;
    const agentCmd = `bash -c '${nvmPfx} timeout 60 openclaw agent --agent main --message ${JSON.stringify(message)} --json 2>&1'`;
    console.log(`\x1b[2mSending to OpenClaw: "${message}"\x1b[0m`);
    try {
      const agentOut = await runLocalCommand(agentCmd, 90_000);
      const jsonStart = agentOut.indexOf("{");
      if (jsonStart >= 0) {
        const json = JSON.parse(agentOut.substring(jsonStart));
        const reply = json?.result?.payloads?.[0]?.text ?? json?.reply ?? json?.text;
        if (reply) return `\n\x1b[1m\x1b[36mOpenClaw:\x1b[0m ${reply}`;
      }
      return agentOut.substring(0, 500);
    } catch (err: unknown) { return `\x1b[31m✗ ${(err as Error).message.split("\n")[0]}\x1b[0m`; }
  }

  // OpenClaw model — check or switch LLM
  if (intent.intent === "openclaw.model") {
    const skipWords = new Set(["openclaw","model","llm","to","the","set","switch","change","use","using","which","what","is","on"]);
    const words = intent.rawText.toLowerCase().split(/\s+/).filter((w: string) => !skipWords.has(w) && w.length > 1);
    const lastWord = words[words.length - 1];
    const lastTwo = words.slice(-2).join(" ");
    let requestedModel = MODEL_ALIASES[lastTwo] ?? MODEL_ALIASES[lastWord ?? ""] ?? undefined;
    if (!requestedModel) { const m = intent.rawText.match(/([\w-]+\/[\w.-]+)/); if (m) requestedModel = m[1]; }

    if (requestedModel) {
      result = await withSpinner(`Switching to ${requestedModel}...`, () =>
        runLocalCommand(`bash -c '${nvmPfx} openclaw models set "${requestedModel}" 2>&1'`, 10_000));
      return result + `\n\x1b[32m✓\x1b[0m OpenClaw now using: \x1b[1m${requestedModel}\x1b[0m`;
    }
    result = await withSpinner("Checking model...", () => runLocalCommand(`bash -c '${nvmPfx} openclaw models status --plain 2>&1'`, 10_000));
    return `\n\x1b[1m\x1b[36m── OpenClaw LLM ──\x1b[0m\n\n  Current: \x1b[32m${result.trim()}\x1b[0m\n\n  Switch: opus, sonnet, haiku, gpt-4o, codex, gemini, llama, ollama\n  \x1b[2mSay: "switch openclaw to sonnet"\x1b[0m`;
  }

  // Notoken model — check or switch LLM backend
  if (intent.intent === "notoken.model") {
    const { getLLMBackend } = await import("../nlp/llmFallback.js");
    const switchMatch = intent.rawText.match(/(?:switch|change|use)\s+(?:notoken\s+(?:to\s+)?|(?:to\s+)?)(\S+)/i);
    const target = ((fields.model as string)?.trim() || switchMatch?.[1])?.toLowerCase();
    if (target && ["claude","ollama","chatgpt"].includes(target)) {
      process.env.MYCLI_LLM_CLI = target === "chatgpt" ? "" : target;
      if (target === "chatgpt") process.env.MYCLI_LLM_ENDPOINT = "https://api.openai.com/v1/chat/completions";
      else delete process.env.MYCLI_LLM_ENDPOINT;
      return `\x1b[32m✓\x1b[0m Notoken now using: \x1b[1m${target}\x1b[0m\n\x1b[2mSet MYCLI_LLM_CLI=${target} to make permanent.\x1b[0m`;
    }
    const backend = getLLMBackend();
    const ollamaUp = await runLocalCommand("curl -sf http://localhost:11434/api/tags 2>/dev/null | head -1").catch(() => "");
    return `\n\x1b[1m\x1b[36m── Notoken LLM ──\x1b[0m\n\n  Current: ${backend ? `\x1b[32m${backend}\x1b[0m` : "\x1b[33mnone\x1b[0m"}\n\n  Available:\n    ${await runLocalCommand("which claude 2>/dev/null").catch(() => "") ? "\x1b[32m✓" : "\x1b[2m○"}\x1b[0m claude\n    ${ollamaUp.includes("models") ? "\x1b[32m✓" : "\x1b[2m○"}\x1b[0m ollama\n    ${process.env.OPENAI_API_KEY ? "\x1b[32m✓" : "\x1b[2m○"}\x1b[0m chatgpt\n\n  \x1b[2mSwitch: "use claude" or "use ollama"\x1b[0m`;
  }

  // Ollama model management
  if (intent.intent === "ollama.models" || intent.intent === "ollama.list") {
    const out = await withSpinner("Checking Ollama...", () => runLocalCommand("ollama list 2>&1"));
    return out;
  }
  if (intent.intent === "ollama.pull") {
    const model = (fields.model as string) ?? intent.rawText.match(/pull\s+(\S+)/)?.[1] ?? "llama3.2";
    // Check disk space before pulling
    const dfOut = await runLocalCommand("df -BG / | tail -1 | awk '{print $4}'").catch(() => "0G");
    const freeGB = parseInt(dfOut);
    if (freeGB < 5) return `\x1b[31m⚠ Only ${freeGB}GB free — Ollama models need 4-8GB. Free up space first.\x1b[0m`;
    console.log(`\x1b[2mPulling ${model}... this may take a few minutes.\x1b[0m`);
    result = await withSpinner(`Pulling ${model}...`, () => runLocalCommand(`ollama pull ${model} 2>&1`, 300_000));
    return result;
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

  // Smart archive
  if (intent.intent === "archive.tar" && isLocal) return await smartArchive({ source: (fields.source as string) ?? process.cwd(), destination: fields.destination as string | undefined, includeAll: !!intent.rawText.match(/include.?(all|everything)/i) });

  // OpenClaw nvm wrapper for template commands
  if (intent.intent.startsWith("openclaw.") && def.command.includes("openclaw") && !def.command.startsWith("[")) {
    command = interpolateCommand(def, fields);
    try { result = await withSpinner(`${intent.intent}...`, () => runLocalCommand(`bash -c '${nvmPfx} ${command}'`)); }
    catch (err: unknown) { result = `\x1b[31m✗ ${(err as Error).message.split("\n")[0]}\x1b[0m`; }
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
