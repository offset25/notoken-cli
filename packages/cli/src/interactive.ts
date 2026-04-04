import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { parseIntent } from "notoken-core";
import { askForConfirmation } from "notoken-core";
import { isDangerous, validateIntent, getRiskLevel } from "notoken-core";
import { executeIntent } from "notoken-core";
import { taskRunner, type BackgroundTask } from "notoken-core";
import { agentSpawner, type AgentHandle } from "notoken-core";
import { createPlan, formatPlan } from "notoken-core";
import { formatVerbose, formatTaskNotification, formatJobsList } from "notoken-core";
import { loadHosts } from "notoken-core";
import { tokenize } from "notoken-core";
import { loadRules } from "notoken-core";
import { classifyMulti } from "notoken-core";
import { analyzeUncertainty, logUncertainty, getUncoveredSpans } from "notoken-core";
import {
  getOrCreateConversation, addUserTurn, addSystemTurn, saveConversation,
  listConversations, getRecentEntities,
  type Conversation,
} from "notoken-core";
import {
  resolveCoreferences, extractEntitiesFromFields,
} from "notoken-core";
import {
  redactSecrets, listSecrets, saveSecretsToFile, resolvePlaceholders, clearSecrets,
} from "notoken-core";
import { getPlaybook, formatPlaybookList, runPlaybook } from "notoken-core";
import { detectLocalPlatform, formatPlatform } from "notoken-core";
import { listBackups, formatBackupList, rollback, cleanExpiredBackups } from "notoken-core";
import { llmFallback, formatLLMFallback, isLLMConfigured } from "notoken-core";
import {
  formatStatus, goOffline, goOnline, disableLLM, enableLLM,
} from "notoken-core";
import {
  getRecentSessions, formatSessionList,
} from "notoken-core";
import {
  createFullBackup, restoreFromBackup, listFullBackups, formatBackupsList,
} from "notoken-core";
import {
  detectBrowserEngines, getBestEngine, installBrowserEngine,
  browse, formatBrowserStatus, stopDockerBrowser,
} from "notoken-core";
import { resolveAlias, saveAlias, removeAlias, listAliases } from "notoken-core";
import { completeInput } from "notoken-core";
import { analyzeFailure } from "notoken-core";
import { suggestAction } from "notoken-core";

const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  cyan: "\x1b[36m",
  magenta: "\x1b[35m",
};

export async function runInteractive(options: { adaptRules?: boolean } = {}): Promise<void> {
  // Load command history for up-arrow navigation
  let historyEntries: string[] = [];
  try {
    const { getReadlineHistory } = await import("notoken-core");
    historyEntries = getReadlineHistory();
  } catch {}

  const rl = readline.createInterface({
    input, output,
    completer: completeInput,
    history: historyEntries,
    historySize: 500,
  } as any);

  let dryRun = false;
  let verbose = true;
  let adaptRules = options.adaptRules ?? false;
  const pendingNotifications: string[] = [];

  // Set up progress reporter — display live progress from background tasks
  try {
    const { progressReporter } = await import("notoken-core");
    progressReporter.on("progress", (event: { taskId: number; intent: string; message: string; percent?: number }) => {
      const pct = event.percent !== undefined ? ` (${event.percent}%)` : "";
      process.stdout.write(`\r\x1b[2K  ${c.dim}⏳ [#${event.taskId}] ${event.message}${pct}${c.reset}`);
    });
  } catch {}

  // Load or create conversation for current working directory
  const cwd = process.cwd();
  const conv = getOrCreateConversation(cwd);

  // Listen for background events
  taskRunner.on("task:completed", (task: BackgroundTask) => {
    const dur = task.completedAt ? task.completedAt.getTime() - task.startedAt.getTime() : undefined;
    pendingNotifications.push(formatTaskNotification(task.id, task.rawText, "completed", dur));
  });
  taskRunner.on("task:failed", (task: BackgroundTask) => {
    pendingNotifications.push(formatTaskNotification(task.id, task.rawText, "failed"));
  });
  agentSpawner.on("agent:done", (agent: AgentHandle) => {
    const status = agent.status === "completed" ? "completed" : "failed";
    const dur = agent.completedAt ? agent.completedAt.getTime() - agent.startedAt.getTime() : undefined;
    pendingNotifications.push(formatTaskNotification(agent.id + 1000, agent.name, status, dur));
  });

  // Show startup banner with platform info
  const platform = detectLocalPlatform();
  const wslTag = platform.isWSL ? ` ${c.yellow}(WSL)${c.reset}` : "";
  const { getLLMBackend } = await import("notoken-core");
  const llmBackend = getLLMBackend();
  const llmTag = llmBackend ? ` ${c.green}LLM:${llmBackend}${c.reset}` : "";

  // Check for updates (non-blocking, cache only on startup)
  const { checkForUpdate, checkForUpdateSync, formatUpdateBanner } = await import("notoken-core");
  const cachedUpdate = checkForUpdateSync();
  const updateTag = cachedUpdate?.updateAvailable ? ` ${c.yellow}⬆ ${cachedUpdate.latest}${c.reset}` : "";

  console.log(`${c.bold}${c.cyan}NoToken${c.reset}${updateTag}`);
  console.log(`${c.dim}${platform.distro}${wslTag} | ${platform.shell} | ${platform.packageManager} | ${platform.arch}${llmTag}${c.reset}`);
  console.log(`${c.dim}Conversation: ${conv.id} (${conv.turns.length} prior turns)${c.reset}`);
  console.log(`${c.dim}Append & for background. Ctrl+B to background running task. Ctrl+C twice to quit.${c.reset}`);

  if (cachedUpdate?.updateAvailable) {
    console.log(formatUpdateBanner(cachedUpdate));
  }

  // Show a random daily tip at startup
  try {
    const { getRandomTip } = await import("notoken-core");
    console.log(`  ${getRandomTip()}`);
  } catch {}
  console.log();

  // Refresh update cache in background (non-blocking)
  checkForUpdate().catch(() => {});

  // ── Ctrl+C handling: once warns, twice saves and quits ──
  let ctrlCCount = 0;
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;

  process.on("SIGINT", () => {
    ctrlCCount++;
    if (ctrlCCount === 1) {
      console.log(`\n${c.yellow}Press Ctrl+C again to quit (conversation will be saved).${c.reset}`);
      ctrlCTimer = setTimeout(() => { ctrlCCount = 0; }, 2000);
    } else {
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      console.log(`\n${c.dim}Saving conversation...${c.reset}`);
      saveConversation(conv);
      console.log(`${c.green}✓${c.reset} Conversation saved (${conv.turns.length} turns, ${conv.knowledgeTree.length} entities).`);
      console.log("Bye.");
      process.exit(0);
    }
  });

  const prompt = () => {
    const bgCount = taskRunner.active + agentSpawner.active;
    const bgLabel = bgCount > 0 ? `${c.yellow}[${bgCount} bg]${c.reset}` : "";
    // Show current directory — shorten home dir to ~
    const home = process.env.HOME ?? "/root";
    let dir = process.cwd();
    if (dir.startsWith(home)) dir = "~" + dir.slice(home.length);
    // Truncate long paths — show last 2 segments
    const parts = dir.split("/");
    if (parts.length > 3) dir = "…/" + parts.slice(-2).join("/");
    const queueCount = inputQueue.length;
    const queueLabel = queueCount > 0 ? `${c.yellow}[${queueCount} queued]${c.reset}` : "";
    return `${c.cyan}${dir}${c.reset}${dryRun ? `${c.dim}(dry)` : ""}${bgLabel}${queueLabel}${c.reset}> `;
  };

  // ── Input queue: user can type while commands execute ──
  const inputQueue: string[] = [];

  // ── Active task tracker for cancellation ──
  interface ActiveTask { id: number; intent: string; abortController: AbortController; startedAt: number; }
  const activeTasks: ActiveTask[] = [];
  let taskIdCounter = 0;

  while (true) {
    if (pendingNotifications.length > 0) {
      console.log(`\n${c.bold}${c.cyan}── Background Results ──${c.reset}`);
      for (const n of pendingNotifications) console.log(n);
      console.log();
      pendingNotifications.length = 0;
    }

    // Show active task count reminder if any are running
    if (activeTasks.length > 0) {
      const taskList = activeTasks.map(t => {
        const elapsed = Math.round((Date.now() - t.startedAt) / 1000);
        return `${t.intent} (${elapsed}s)`;
      }).join(", ");
      console.log(`${c.dim}⏳ Running: ${taskList}${c.reset}`);
    }

    // Process queued commands or read new input
    let line: string;
    if (inputQueue.length > 0) {
      line = inputQueue.shift()!;
      console.log(`${c.dim}[queued → executing]${c.reset} ${line}`);
    } else {
      // Reset Ctrl+C counter on each new prompt
      ctrlCCount = 0;

      try {
        line = await rl.question(prompt());
      } catch {
        break;
      }
    }

    const trimmed = line.trim();
    if (!trimmed) continue;

    // Save to persistent command history
    try {
      const { addToHistory } = await import("notoken-core");
      addToHistory(trimmed);
    } catch {}

    // Accept both :command and /command for meta commands
    if (trimmed.startsWith(":") || trimmed.startsWith("/")) {
      const metaCmd = trimmed.startsWith("/") ? ":" + trimmed.slice(1) : trimmed;
      await handleMetaCommand(metaCmd, conv, dryRun, verbose, adaptRules, pendingNotifications, (k, v) => {
        if (k === "dryRun") dryRun = v as boolean;
        if (k === "verbose") verbose = v as boolean;
        if (k === "adaptRules") adaptRules = v as boolean;
      }, activeTasks, inputQueue);
      continue;
    }

    const runInBackground = trimmed.endsWith("&");
    let commandText = runInBackground ? trimmed.slice(0, -1).trim() : trimmed;

    // ── Alias resolution ──
    const resolved = resolveAlias(commandText);
    if (resolved !== commandText) {
      console.log(`${c.dim}alias: ${commandText} → ${resolved}${c.reset}`);
      commandText = resolved;
    }

    // ── Greetings ──
    if (isGreeting(commandText)) {
      console.log(`\n${c.yellow}⚠ You need to authenticate before you can use Codex.${c.reset}`);
      console.log(`  Run ${c.bold}notoken login${c.reset} to authenticate.\n`);
      continue;
    }

    // ── Secret redaction — never store passwords in conversation ──
    const redaction = redactSecrets(commandText);
    const textForStorage = redaction.redactedText;
    if (redaction.secretCount > 0) {
      console.log(`${c.yellow}⚠ ${redaction.secretCount} secret(s) detected and redacted from history.${c.reset}`);
      for (const p of redaction.placeholders) {
        console.log(`  ${c.dim}${p.id} (${p.label})${c.reset}`);
      }
      // Use original (unredacted) text for execution, redacted for storage
    }

    // SSH shortcut
    const sshMatch = commandText.match(/^ssh\s+([\w-]+)\s+(.+)$/);
    if (sshMatch && !commandText.includes("into")) {
      const [, env, cmd] = sshMatch;
      if (runInBackground) {
        const agent = agentSpawner.spawnShell(`ssh ${env}`, `Remote: ${cmd}`, buildSshCommand(env, cmd));
        console.log(`${c.green}↗${c.reset} Agent #${agent.id} spawned: ssh ${env} "${cmd}"`);
      } else {
        await runSshDirect(env, cmd);
      }
      continue;
    }

    // ── Coreference resolution ──
    const coref = resolveCoreferences(commandText, conv);
    let textToParse = coref.resolvedText;

    // Cross-validate with knowledge graph — if both agree, boost confidence
    let agreementBoost = 0;
    if (coref.resolutions.length > 0) {
      try {
        const { resolveCandidates } = await import("notoken-core");
        const recentEnts = getRecentEntities(conv, 5).map((e: { entity: string }) => e.entity);

        for (const res of coref.resolutions) {
          if (res.source === "knowledge_tree" && res.resolved) {
            // Check if knowledge graph agrees with coreference
            const kgCandidates = resolveCandidates(res.original, recentEnts);
            if (kgCandidates.length > 0 && kgCandidates[0].entity.name === res.resolved) {
              agreementBoost = 0.1; // Both systems agree → high confidence
              console.log(`  ${c.dim}${res.original} → ${res.resolved} ${c.green}✓ confirmed by knowledge graph${c.reset}`);
            } else if (kgCandidates.length > 0) {
              // Disagreement — show both
              console.log(`  ${c.dim}${res.original} → ${res.resolved} (session) vs ${kgCandidates[0].entity.name} (graph)${c.reset}`);
            } else {
              console.log(`  ${c.dim}${res.original} → ${res.resolved} (${res.source})${c.reset}`);
            }
          } else {
            console.log(`  ${c.dim}${res.original} → ${res.resolved} (${res.source})${c.reset}`);
          }
        }
      } catch {
        // Knowledge graph not available — just show coreference results
        for (const r of coref.resolutions) {
          console.log(`  ${c.dim}${r.original} → ${r.resolved} (${r.source})${c.reset}`);
        }
      }

      if (coref.resolutions.length > 0) {
        console.log(`${c.dim}Resolved references:${c.reset}`);
      }
    }

    // If coreference gave us a full resolved intent, use it directly
    let parsed;
    if (coref.resolvedIntent) {
      const { disambiguate } = await import("notoken-core");
      // Apply agreement boost to confidence
      if (agreementBoost > 0) {
        coref.resolvedIntent.confidence = Math.min(0.99, coref.resolvedIntent.confidence + agreementBoost);
      }
      parsed = disambiguate(coref.resolvedIntent);
    } else {
      // ── Check for multi-step plan ──
      const plan = createPlan(textToParse);
      if (plan.isMultiStep) {
        console.log();
        console.log(formatPlan(plan));
        console.log();

        if (!dryRun) {
          const ok = await askForConfirmation("Execute this plan?");
          if (ok) {
            await executePlan(plan, conv, verbose);
          } else {
            console.log("Cancelled.");
          }
        }
        continue;
      }

      parsed = await parseIntent(textToParse);
    }

    // ── Multi-classifier scoring (show in verbose) ──
    if (verbose) {
      const recentIntents = conv.turns
        .filter((t) => t.role === "user" && t.intent)
        .slice(-5)
        .map((t) => t.intent!);
      const multiResult = classifyMulti(commandText, recentIntents);

      console.log();
      console.log(formatVerbose(parsed));

      if (multiResult.scores.length > 1) {
        console.log(`\n  ${c.cyan}Classifier scores:${c.reset}`);
        for (const s of multiResult.scores.slice(0, 3)) {
          const bar = "█".repeat(Math.round(s.score * 20));
          console.log(`    ${s.intent.padEnd(20)} ${c.dim}${bar}${c.reset} ${(s.score * 100).toFixed(0)}% (${s.votes} votes)`);
        }
        if (multiResult.ambiguous) {
          console.log(`  ${c.yellow}⚠ Ambiguous — top intents are close${c.reset}`);
        }
      }
      console.log();
    }

    // ── Uncertainty tracking ──
    const rules = loadRules();
    const tokens = tokenize(textToParse, Object.keys(rules.serviceAliases), Object.keys(rules.environmentAliases));
    const uncertaintyReport = analyzeUncertainty(textToParse, tokens, parsed.intent);
    const uncoveredSpans = getUncoveredSpans(textToParse, tokens);

    if (uncertaintyReport.unknownTokens.length > 0 || uncoveredSpans.length > 0) {
      if (verbose) {
        console.log(`  ${c.yellow}Uncertain:${c.reset}`);
        if (uncertaintyReport.unknownTokens.length > 0) {
          console.log(`    Unknown tokens: ${uncertaintyReport.unknownTokens.join(", ")}`);
        }
        if (uncoveredSpans.length > 0) {
          console.log(`    Uncovered phrases: "${uncoveredSpans.join('", "')}"`);
        }
        console.log();
      }

      logUncertainty({
        timestamp: new Date().toISOString(),
        rawText: commandText,
        intent: parsed.intent.intent,
        overallConfidence: parsed.intent.confidence,
        unknownTokens: uncertaintyReport.unknownTokens,
        lowConfidenceFields: uncertaintyReport.lowConfidenceFields,
        uncoveredSpans,
      });
    }

    // ── Record to conversation (use redacted text, never store secrets) ──
    const entities = extractEntitiesFromFields(parsed.intent.fields);
    addUserTurn(conv, textForStorage, parsed.intent.intent, parsed.intent.confidence, parsed.intent.fields, entities, uncertaintyReport);

    // ── Validation ──
    const errors = validateIntent(parsed.intent);
    if (errors.length > 0) {
      console.error(`${c.red}Validation failed:${c.reset}`);
      for (const err of errors) console.error(`  - ${err}`);
      addSystemTurn(conv, "validation_failed", undefined, errors.join("; "));
      continue;
    }

    if (parsed.intent.intent === "unknown") {
      console.error(`${c.red}Could not determine intent.${c.reset} Logged for adapting.`);
      console.error(`${c.dim}Tip: Try rephrasing, or type :help to see what I can do.${c.reset}`);
      addSystemTurn(conv, "unknown_intent", undefined, "No intent matched");

      // Fire LLM fallback in background (non-blocking) if configured
      if (isLLMConfigured()) {
        console.log(`${c.dim}Asking LLM in background...${c.reset}`);
        const recentIntents = conv.turns.filter((t) => t.role === "user" && t.intent).slice(-5).map((t) => t.intent!);
        const knownEntities = getRecentEntities(conv, 5).map((e) => ({ entity: e.entity, type: e.type }));

        llmFallback(commandText, { recentIntents, knownEntities, uncertainTokens: uncertaintyReport?.unknownTokens })
          .then((fallbackResult) => {
            if (fallbackResult?.understood && fallbackResult.suggestedIntents.length > 0) {
              pendingNotifications.push(`\n${formatLLMFallback(fallbackResult)}`);
              const best = fallbackResult.suggestedIntents[0];
              if (best.confidence >= 0.7) {
                pendingNotifications.push(`${c.dim}Run suggested: ${best.intent} (${(best.confidence * 100).toFixed(0)}%)${c.reset}`);
              }
            }
          })
          .catch(() => {});
      }

      // Adaptive rules: run Claude healer in background to learn from this failure
      if (adaptRules && isLLMConfigured()) {
        runAutoHeal(pendingNotifications);
      }
      continue;
    }

    // Natural language task management
    if (parsed.intent.intent === "notoken.jobs") {
      if (activeTasks.length === 0 && inputQueue.length === 0 && taskRunner.active === 0) {
        console.log(`${c.green}✓${c.reset} No tasks running. All clear.`);
      } else {
        if (activeTasks.length > 0) {
          console.log(`\n${c.bold}${c.cyan}Running:${c.reset}`);
          for (const at of activeTasks) {
            const elapsed = Math.round((Date.now() - at.startedAt) / 1000);
            console.log(`  ${c.cyan}#${at.id}${c.reset} ${at.intent} ${c.dim}(${elapsed}s) — say "cancel" to stop${c.reset}`);
          }
        }
        if (inputQueue.length > 0) {
          console.log(`\n${c.bold}Queued (${inputQueue.length}):${c.reset}`);
          for (let i = 0; i < inputQueue.length; i++) {
            console.log(`  ${c.dim}${i + 1}. ${inputQueue[i]}${c.reset}`);
          }
        }
        const bgTasks = taskRunner.list().filter(t => t.status === "running");
        if (bgTasks.length > 0) {
          console.log(`\n${c.bold}Background (taskRunner):${c.reset}`);
          for (const t of bgTasks) {
            console.log(`  ${c.dim}#${t.id} ${t.rawText}${c.reset}`);
          }
        }
      }
      continue;
    }

    if (parsed.intent.intent === "notoken.cancel") {
      // Cancel the most recent active background task, or clear the queue
      if (activeTasks.length > 0) {
        const task = activeTasks[activeTasks.length - 1];
        task.abortController.abort();
        activeTasks.pop();
        console.log(`${c.yellow}✗ Cancelled:${c.reset} ${task.intent} (task #${task.id})`);
      } else if (inputQueue.length > 0) {
        const cleared = inputQueue.length;
        inputQueue.length = 0;
        console.log(`${c.yellow}✗ Cleared ${cleared} queued command(s).${c.reset}`);
      } else {
        // Also try taskRunner
        const tasks = taskRunner.list().filter(t => t.status === "running");
        if (tasks.length > 0) {
          const last = tasks[tasks.length - 1];
          taskRunner.cancel(last.id);
          console.log(`${c.yellow}✗ Cancelled:${c.reset} task #${last.id}`);
        } else {
          console.log(`${c.yellow}Nothing to cancel.${c.reset} No tasks running.`);
        }
      }
      addSystemTurn(conv, "cancelled");
      continue;
    }

    if (parsed.needsClarification) {
      // Smart prompting: ask for each missing field instead of failing
      if (parsed.missingFields.length > 0) {
        console.log(`${c.yellow}I need a bit more info to run "${parsed.intent.intent}":${c.reset}`);
        let allAnswered = true;
        for (const field of parsed.missingFields) {
          const friendlyName = field.replace(/([A-Z])/g, " $1").toLowerCase();
          let answer: string;
          try {
            answer = await rl.question(`${c.cyan}  What ${friendlyName} would you like? ${c.reset}`);
          } catch {
            allAnswered = false;
            break;
          }
          answer = answer.trim();
          if (!answer) {
            console.log(`${c.dim}  Skipped — aborting command.${c.reset}`);
            allAnswered = false;
            break;
          }
          parsed.intent.fields[field] = answer;
        }
        if (!allAnswered) {
          addSystemTurn(conv, "needs_clarification", undefined, "User cancelled field prompting");
          continue;
        }
        // Re-check for ambiguous fields (missing fields are now filled)
        if (parsed.ambiguousFields.length > 0) {
          for (const a of parsed.ambiguousFields) {
            console.log(`${c.yellow}  "${a.field}" is ambiguous — did you mean ${a.candidates.join(" or ")}?${c.reset}`);
            let answer: string;
            try {
              answer = await rl.question(`${c.cyan}  Which one? ${c.reset}`);
            } catch {
              allAnswered = false;
              break;
            }
            answer = answer.trim();
            if (!answer) { allAnswered = false; break; }
            parsed.intent.fields[a.field] = answer;
          }
          if (!allAnswered) {
            addSystemTurn(conv, "needs_clarification", undefined, "User cancelled disambiguation");
            continue;
          }
        }
        // Fields filled — fall through to execution
        parsed.needsClarification = false;
        console.log(`${c.green}✓${c.reset} Got it — proceeding with ${parsed.intent.intent}.`);
      } else if (parsed.ambiguousFields.length > 0) {
        for (const a of parsed.ambiguousFields) {
          console.log(`${c.yellow}  "${a.field}" is ambiguous — did you mean ${a.candidates.join(" or ")}?${c.reset}`);
          let answer: string;
          try {
            answer = await rl.question(`${c.cyan}  Which one? ${c.reset}`);
          } catch {
            break;
          }
          answer = answer.trim();
          if (!answer) break;
          parsed.intent.fields[a.field] = answer;
        }
        parsed.needsClarification = false;
      } else {
        // Low confidence — no missing/ambiguous fields, just uncertain
        console.error(`${c.yellow}Clarification needed — please be more specific.${c.reset}`);
        addSystemTurn(conv, "needs_clarification");
        continue;
      }
    }

    if (dryRun) {
      console.log(`${c.dim}[dry-run] Would execute: ${parsed.intent.intent} (risk: ${getRiskLevel(parsed.intent)})${c.reset}`);
      continue;
    }

    // ── Background execution ──
    if (runInBackground) {
      const intent = parsed.intent;
      const task = taskRunner.submit(commandText, intent, () => executeIntent(intent));
      console.log(`${c.green}↗${c.reset} Background task #${task.id}: ${intent.intent}`);
      continue;
    }

    // ── Foreground execution ──
    if (isDangerous(parsed.intent)) {
      const ok = await askForConfirmation(`Execute ${parsed.intent.intent}? (risk: ${getRiskLevel(parsed.intent)})`);
      if (!ok) {
        console.log("Cancelled.");
        continue;
      }
    }

    // ── Non-blocking execution: all commands run async, input stays available ──
    // Fast commands (<2s) run inline. Slow commands auto-promote to background.
    // User can always keep typing — queued commands run after current finishes.

    const intentLabel = parsed.intent.intent;
    const abortController = new AbortController();
    const taskId = ++taskIdCounter;
    const executionPromise = executeIntent(parsed.intent);
    let completed = false;
    let inlineError: Error | null = null;

    // Give the command 2 seconds to finish inline
    const timeoutPromise = new Promise<null>(resolve => setTimeout(() => resolve(null), 2000));
    const quickResult = await Promise.race([
      executionPromise.then(r => { completed = true; return r; }).catch(err => { completed = true; inlineError = err instanceof Error ? err : new Error(String(err)); return null; }),
      timeoutPromise,
    ]);

    if (completed && inlineError) {
      // Fast command failed — show error and offer smart retry
      const failedErr = inlineError as Error;
      const msg = failedErr.message;
      console.error(`${c.red}✗${c.reset} ${msg}`);
      addSystemTurn(conv, intentLabel, undefined, msg);

      const fix = analyzeFailure(intentLabel, failedErr, parsed.intent.fields ?? {});
      if (fix?.canFix) {
        console.log(`${c.yellow}→${c.reset} ${fix.suggestion}`);
        console.log(`${c.dim}  (say "yes" to run: ${fix.fixCommand})${c.reset}`);
        suggestAction({
          action: fix.fixCommand,
          description: fix.explanation,
          type: "intent",
        });
      }
    } else if (completed && quickResult !== null) {
      // Fast command — show result inline
      console.log(quickResult);
      addSystemTurn(conv, intentLabel, quickResult as string);
    } else if (!completed) {
      // Slow command — auto-promote to background with tracking
      const task: ActiveTask = { id: taskId, intent: intentLabel, abortController, startedAt: Date.now() };
      activeTasks.push(task);
      console.log(`${c.dim}⏳ ${intentLabel} running in background (task #${taskId})...${c.reset}`);
      console.log(`${c.dim}   Say "cancel" to stop it, or keep typing.${c.reset}`);

      executionPromise
        .then(result => {
          // Remove from active tasks
          const idx = activeTasks.indexOf(task);
          if (idx >= 0) activeTasks.splice(idx, 1);

          if (abortController.signal.aborted) {
            pendingNotifications.push(`${c.yellow}✗ Cancelled:${c.reset} ${intentLabel} (task #${taskId})`);
          } else {
            pendingNotifications.push(`\n${c.green}✓${c.reset} ${c.bold}Done:${c.reset} ${intentLabel} (task #${taskId})\n${typeof result === "string" ? result.substring(0, 500) : ""}`);
            addSystemTurn(conv, intentLabel, typeof result === "string" ? result : "");
          }
        })
        .catch(err => {
          const idx = activeTasks.indexOf(task);
          if (idx >= 0) activeTasks.splice(idx, 1);

          if (abortController.signal.aborted) {
            pendingNotifications.push(`${c.yellow}✗ Cancelled:${c.reset} ${intentLabel} (task #${taskId})`);
          } else {
            const msg = err instanceof Error ? err.message : String(err);
            pendingNotifications.push(`\n${c.red}✗${c.reset} ${c.bold}Failed:${c.reset} ${intentLabel} (task #${taskId})\n  ${msg}`);
            addSystemTurn(conv, intentLabel, undefined, msg);

            // Smart retry — suggest a fix for background task failures
            const fix = analyzeFailure(intentLabel, err instanceof Error ? err : new Error(String(err)), parsed.intent.fields ?? {});
            if (fix?.canFix) {
              pendingNotifications.push(`${c.yellow}→${c.reset} ${fix.suggestion}\n${c.dim}  (say "yes" to run: ${fix.fixCommand})${c.reset}`);
              suggestAction({
                action: fix.fixCommand,
                description: fix.explanation,
                type: "intent",
              });
            }
          }
        });
    }
  }

  rl.close();
  saveConversation(conv);
  console.log(`${c.green}✓${c.reset} Conversation saved (${conv.turns.length} turns).`);
  console.log("Bye.");
}

// ─── Plan Executor ───────────────────────────────────────────────────────────

async function executePlan(
  plan: ReturnType<typeof createPlan>,
  conv: Conversation,
  _verbose: boolean
): Promise<void> {
  let lastSuccess = true;

  for (const step of plan.steps) {
    // Check conditions
    if (step.condition === "if_success" && !lastSuccess) {
      step.status = "skipped";
      console.log(`${c.dim}⊘ Step ${step.id} skipped (previous failed)${c.reset}`);
      continue;
    }
    if (step.condition === "if_failure" && lastSuccess) {
      step.status = "skipped";
      console.log(`${c.dim}⊘ Step ${step.id} skipped (previous succeeded)${c.reset}`);
      continue;
    }

    if (!step.intent) {
      step.status = "failed";
      step.error = "Could not determine intent";
      console.error(`${c.red}✗ Step ${step.id}: unknown intent for "${step.rawText}"${c.reset}`);
      lastSuccess = false;
      continue;
    }

    console.log(`${c.cyan}⟳ Step ${step.id}:${c.reset} ${step.intent} — "${step.rawText}"`);
    step.status = "running";

    const intent = {
      intent: step.intent,
      confidence: step.confidence,
      rawText: step.rawText,
      fields: step.fields,
    };

    try {
      const result = await executeIntent(intent);
      step.status = "completed";
      step.result = result;
      lastSuccess = true;
      console.log(`${c.green}✓ Step ${step.id} completed${c.reset}`);
      console.log(result);
      addSystemTurn(conv, step.intent, result);
    } catch (err) {
      step.status = "failed";
      step.error = err instanceof Error ? err.message : String(err);
      lastSuccess = false;
      console.error(`${c.red}✗ Step ${step.id} failed: ${step.error}${c.reset}`);
      addSystemTurn(conv, step.intent, undefined, step.error);
    }
  }

  console.log();
  console.log(formatPlan(plan));
}

// ─── Meta Commands ───────────────────────────────────────────────────────────

async function handleMetaCommand(
  cmd: string,
  conv: Conversation,
  dryRun: boolean,
  verbose: boolean,
  adaptRules: boolean,
  pendingNotifications: string[],
  set: (key: string, value: unknown) => void,
  activeTasks?: Array<{ id: number; intent: string; startedAt: number }>,
  inputQueue?: string[]
): Promise<void> {
  const parts = cmd.split(/\s+/);
  const command = parts[0];

  // Handle "clear" directly — clear terminal
  if (command === "clear" || command === "cls") {
    console.clear();
    return;
  }

  // Handle "help" directly — same as :help
  if (command === "help" || cmd === "help me" || cmd === "what can you do") {
    console.log(`\nType natural language commands. Examples:\n  check disk space\n  restart nginx\n  what is load right now\n  are we under attack\n  generate an image\n  monitor discord\n  install codex\n\nMeta commands: /help, /jobs, /quit, /output <id>\nCtrl+B to background a running task.\n`);
    return;
  }

  // Handle "cd /path" directly — change working directory
  if (command === "cd" && parts[1]) {
    try {
      const target = parts[1].replace(/^~/, process.env.HOME ?? "/root");
      process.chdir(target);
      console.log(`${c.green}✓${c.reset} ${process.cwd()}`);
    } catch (e: any) {
      console.error(`${c.red}✗${c.reset} ${e.message}`);
    }
    return;
  }

  switch (command) {
    case ":update":
    case ":upgrade": {
      try {
        const { checkForUpdate, runUpdate } = await import("notoken-core");
        console.log("Checking for updates...");
        const info = await checkForUpdate();
        if (!info) { console.log("Could not check for updates."); break; }
        if (!info.updateAvailable) { console.log(`${c.green}✓${c.reset} Already on the latest version (${info.current})`); break; }
        console.log(`${c.yellow}⬆${c.reset} Update available: ${info.current} → ${c.green}${info.latest}${c.reset}`);
        console.log("Updating...");
        runUpdate();
        console.log(`${c.green}✓${c.reset} Updated to ${info.latest}. Restart notoken to use the new version.`);
      } catch (err) {
        console.error(`${c.red}✗${c.reset} Update failed: ${(err as Error).message}`);
      }
      break;
    }

    case ":quit":
    case ":q":
    case ":exit":
      saveConversation(conv);
      console.log(`${c.green}✓${c.reset} Conversation saved (${conv.turns.length} turns).`);
      console.log("Bye.");
      process.exit(0);

    case ":help":
      console.log(`
${c.bold}Commands:${c.reset}
  ${c.cyan}<text>${c.reset}               Parse and execute a natural language command
  ${c.cyan}<text> &${c.reset}             Run in background
  ${c.cyan}Ctrl+B${c.reset}              Move running task to background
  ${c.cyan}ssh <env> <cmd>${c.reset}      Run raw SSH command on environment

${c.bold}Meta:${c.reset}
  ${c.cyan}:jobs${c.reset}                Show background tasks and agents
  ${c.cyan}:output <id>${c.reset}         Show output from background task
  ${c.cyan}:kill <id>${c.reset}           Kill a background task or agent
  ${c.cyan}:dry${c.reset}                 Toggle dry-run (${dryRun ? "ON" : "OFF"})
  ${c.cyan}:verbose${c.reset}             Toggle verbose (${verbose ? "ON" : "OFF"})
  ${c.cyan}:ssh${c.reset}                 Show configured SSH hosts

${c.bold}Conversation:${c.reset}
  ${c.cyan}:context${c.reset}             Show knowledge tree — what entities the CLI remembers
  ${c.cyan}:history${c.reset}             Show recent conversation turns
  ${c.cyan}:conversations${c.reset}       List saved conversations for this path
  ${c.cyan}:uncertainty${c.reset}         Show phrases the CLI was uncertain about

${c.bold}Playbooks:${c.reset}
  ${c.cyan}:play <name> [env]${c.reset}   Run a playbook (e.g. :play health-check prod)
  ${c.cyan}:playbooks${c.reset}           List available playbooks

${c.bold}System:${c.reset}
  ${c.cyan}:platform${c.reset}            Show detected OS, distro, package manager
  ${c.cyan}:backups${c.reset}             List auto-backups (files backed up before modification)
  ${c.cyan}:rollback <id>${c.reset}       Rollback a file from auto-backup

${c.bold}Secrets:${c.reset}
  ${c.cyan}:secrets${c.reset}             List secrets held in memory (never stored in history)
  ${c.cyan}:save-secrets [file]${c.reset} Save secrets to file (chmod 600)
  ${c.cyan}:clear-secrets${c.reset}       Wipe secrets and passwords from memory
  ${c.cyan}:clearpasswords${c.reset}     Same as :clear-secrets

${c.bold}Adaptive Rules:${c.reset}
  ${c.cyan}:adapt${c.reset}              Toggle adaptive rules (${adaptRules ? "ON" : "OFF"})
  ${c.cyan}:improve${c.reset}            Run rule improvement via Claude now

${c.bold}LLM & Status:${c.reset}
  ${c.cyan}:status${c.reset}              Show LLM status (connected, offline, tokens saved)
  ${c.cyan}:offline${c.reset}             Disconnect all LLMs — deterministic only
  ${c.cyan}:online${c.reset}              Reconnect LLMs
  ${c.cyan}:disable <llm>${c.reset}       Disable a specific LLM (claude, ollama, api)
  ${c.cyan}:enable <llm>${c.reset}        Re-enable a specific LLM

${c.bold}Sessions:${c.reset}
  ${c.cyan}:sessions${c.reset}            Show recent sessions with stats
  ${c.cyan}:backup${c.reset}              Backup ~/.notoken/ to a timestamped archive
  ${c.cyan}:restore <file>${c.reset}      Restore from a backup archive
  ${c.cyan}:backups-full${c.reset}        List full backups

${c.bold}Browser:${c.reset}
  ${c.cyan}:browse <url>${c.reset}        Open URL in browser (patchright/playwright/docker/system)
  ${c.cyan}:browse <url> --ss${c.reset}   Take a screenshot of a page
  ${c.cyan}:browse status${c.reset}       Show available browser engines
  ${c.cyan}:browse install${c.reset}      Install patchright (or playwright/docker)
  ${c.cyan}:browse stop${c.reset}         Stop Docker browser container

${c.bold}Updates:${c.reset}
  ${c.cyan}:update${c.reset}              Check for updates and install

${c.bold}Aliases:${c.reset}
  ${c.cyan}:alias <name> <cmd>${c.reset}   Create a command alias
  ${c.cyan}:unalias <name>${c.reset}       Remove an alias
  ${c.cyan}:aliases${c.reset}              List all aliases

${c.bold}Other:${c.reset}
  ${c.cyan}:clear${c.reset}               Clear completed tasks
  ${c.cyan}:quit${c.reset}                Exit
`);
      break;

    case ":alias": {
      const aliasName = parts[1];
      const aliasCmd = parts.slice(2).join(" ");
      if (!aliasName || !aliasCmd) {
        console.log(`${c.yellow}Usage: :alias <name> <command>${c.reset}`);
      } else {
        saveAlias(aliasName, aliasCmd);
        console.log(`${c.green}✓${c.reset} Alias saved: ${c.cyan}${aliasName}${c.reset} → ${aliasCmd}`);
      }
      break;
    }

    case ":unalias": {
      const uname = parts[1];
      if (!uname) {
        console.log(`${c.yellow}Usage: :unalias <name>${c.reset}`);
      } else if (removeAlias(uname)) {
        console.log(`${c.green}✓${c.reset} Alias removed: ${uname}`);
      } else {
        console.log(`${c.yellow}No alias named "${uname}"${c.reset}`);
      }
      break;
    }

    case ":aliases": {
      const all = listAliases();
      const keys = Object.keys(all);
      if (keys.length === 0) {
        console.log(`${c.dim}No aliases defined. Use :alias <name> <command> to create one.${c.reset}`);
      } else {
        console.log(`\n${c.bold}Aliases:${c.reset}`);
        for (const [k, v] of Object.entries(all)) {
          console.log(`  ${c.cyan}${k}${c.reset} → ${v}`);
        }
        console.log();
      }
      break;
    }

    case ":dry":
      set("dryRun", !dryRun);
      console.log(`${c.green}✓${c.reset} Dry-run: ${!dryRun ? "ON" : "OFF"}`);
      break;

    case ":verbose":
      set("verbose", !verbose);
      console.log(`${c.green}✓${c.reset} Verbose: ${!verbose ? "ON" : "OFF"}`);
      break;

    case ":adapt":
      set("adaptRules", !adaptRules);
      console.log(`${c.green}✓${c.reset} Adaptive rules: ${!adaptRules ? `${c.green}ON${c.reset} — Rules will adapt and improve from failures` : "OFF"}`);
      break;

    case ":update": {
      const { checkForUpdate: checkUpdate, runUpdate } = await import("notoken-core");
      console.log(`${c.dim}Checking for updates...${c.reset}`);
      const updateInfo = await checkUpdate();
      if (!updateInfo) {
        console.log(`${c.dim}Could not check for updates.${c.reset}`);
      } else if (!updateInfo.updateAvailable) {
        console.log(`${c.green}✓${c.reset} You're on the latest version (${updateInfo.current})`);
      } else {
        console.log(`${c.yellow}⬆${c.reset} Update available: ${c.bold}${updateInfo.current}${c.reset} → ${c.green}${updateInfo.latest}${c.reset}`);
        const { askForConfirmation: confirmUpdate } = await import("notoken-core");
        const doUpdate = await confirmUpdate("Install update?");
        if (doUpdate) {
          console.log(`${c.dim}Updating notoken...${c.reset}`);
          try {
            runUpdate();
            console.log(`${c.green}✓${c.reset} Updated to ${updateInfo.latest}. Restart notoken to use new version.`);
          } catch (err) {
            console.log(`${c.red}✗${c.reset} ${err instanceof Error ? err.message : err}`);
          }
        }
      }
      break;
    }

    case ":improve":
    case ":heal": {
      if (!isLLMConfigured()) {
        console.log(`${c.red}No LLM configured. Set NOTOKEN_LLM_CLI=claude to enable.${c.reset}`);
        break;
      }
      console.log(`${c.dim}Improving rules via Claude...${c.reset}`);
      runAutoHeal(pendingNotifications, true);
      break;
    }

    case ":context": {
      const entities = getRecentEntities(conv, 15);
      if (entities.length === 0) {
        console.log(`${c.dim}No entities tracked yet.${c.reset}`);
      } else {
        console.log(`${c.bold}Knowledge tree:${c.reset}`);
        for (const e of entities) {
          const role = e.lastRole ? `(${e.lastRole})` : "";
          const cooc = e.coOccurrences.length > 0 ? `  with: ${e.coOccurrences.join(", ")}` : "";
          console.log(`  ${c.cyan}${e.entity}${c.reset} [${e.type}] ${role} — mentioned ${e.frequency}x${c.dim}${cooc}${c.reset}`);
        }
      }
      break;
    }

    case ":history": {
      const turns = conv.turns.slice(-10);
      if (turns.length === 0) {
        console.log(`${c.dim}No conversation history.${c.reset}`);
      } else {
        console.log(`${c.bold}Recent turns:${c.reset}`);
        for (const t of turns) {
          const icon = t.role === "user" ? `${c.cyan}→${c.reset}` : `${c.green}←${c.reset}`;
          const intent = t.intent ? ` [${t.intent}]` : "";
          const conf = t.confidence ? ` ${(t.confidence * 100).toFixed(0)}%` : "";
          console.log(`  ${icon} ${c.dim}#${t.id}${c.reset} ${t.rawText}${c.dim}${intent}${conf}${c.reset}`);
        }
      }
      break;
    }

    case ":conversations": {
      const convs = listConversations(process.cwd());
      if (convs.length === 0) {
        console.log(`${c.dim}No saved conversations.${c.reset}`);
      } else {
        console.log(`${c.bold}Conversations:${c.reset}`);
        for (const cv of convs) {
          const active = cv.id === conv.id ? ` ${c.green}← current${c.reset}` : "";
          console.log(`  ${c.dim}${cv.id}${c.reset} — ${cv.turns} turns — ${cv.createdAt}${active}`);
        }
      }
      break;
    }

    case ":uncertainty": {
      const { getUncertaintySummary } = await import("notoken-core");
      const summary = getUncertaintySummary();
      if (summary.length === 0) {
        console.log(`${c.dim}No uncertainty data.${c.reset}`);
      } else {
        console.log(`${c.bold}Most uncertain tokens:${c.reset}`);
        for (const entry of summary.slice(0, 15)) {
          console.log(`  ${c.yellow}${entry.token}${c.reset} — ${entry.count} occurrence(s)`);
        }
      }
      break;
    }

    case ":secrets": {
      const secrets = listSecrets();
      if (secrets.length === 0) {
        console.log(`${c.dim}No secrets in memory.${c.reset}`);
      } else {
        console.log(`${c.bold}Secrets in memory (${secrets.length}):${c.reset}`);
        for (const s of secrets) {
          console.log(`  ${c.dim}${s.id}${c.reset} ${s.preview}`);
        }
        console.log(`${c.dim}Use :save-secrets [file] to export. Secrets are never saved in conversation history.${c.reset}`);
      }
      break;
    }

    case ":save-secrets": {
      const file = saveSecretsToFile(parts[1]);
      console.log(`${c.green}✓${c.reset} Secrets saved to: ${file} (chmod 600)`);
      break;
    }

    case ":clear-secrets":
    case ":clearpasswords":
    case ":clear-passwords": {
      clearSecrets();
      console.log(`${c.green}✓${c.reset} All secrets and passwords wiped from memory.`);
      break;
    }

    case ":play": {
      const pbName = parts[1];
      const pbEnv = parts[2];
      if (!pbName) {
        console.log(formatPlaybookList());
        break;
      }
      const pb = getPlaybook(pbName);
      if (!pb) {
        console.log(`${c.red}Playbook not found: ${pbName}${c.reset}`);
        console.log(formatPlaybookList());
        break;
      }
      await runPlaybook(pb, pbEnv, { dryRun });
      break;
    }

    case ":playbooks":
      console.log(formatPlaybookList());
      break;

    case ":platform":
      console.log(formatPlatform(detectLocalPlatform()));
      break;

    case ":backups": {
      cleanExpiredBackups();
      console.log(formatBackupList(listBackups()));
      break;
    }

    case ":rollback": {
      const rbId = parts[1];
      if (!rbId) { console.log("Usage: :rollback <id>"); break; }
      if (rollback(rbId)) {
        console.log(`${c.green}✓${c.reset} Rolled back: ${rbId}`);
      } else {
        console.log(`${c.red}Rollback failed — backup not found: ${rbId}${c.reset}`);
      }
      break;
    }

    case ":jobs": {
      const tasks = taskRunner.list().map((t) => ({ id: t.id, rawText: t.rawText, status: t.status, startedAt: t.startedAt, completedAt: t.completedAt }));
      const agents = agentSpawner.list().map((a) => ({ id: a.id + 1000, rawText: `[agent] ${a.name}: ${a.description}`, status: a.status, startedAt: a.startedAt, completedAt: a.completedAt }));

      // Also show orchestrator active tasks
      if (activeTasks && activeTasks.length > 0) {
        console.log(`\n${c.bold}Active tasks:${c.reset}`);
        for (const at of activeTasks) {
          const elapsed = Math.round((Date.now() - at.startedAt) / 1000);
          console.log(`  ${c.cyan}#${at.id}${c.reset} ${at.intent} ${c.dim}(${elapsed}s)${c.reset}`);
        }
      }
      if (inputQueue && inputQueue.length > 0) {
        console.log(`\n${c.bold}Queued commands:${c.reset}`);
        for (let i = 0; i < inputQueue.length; i++) {
          console.log(`  ${c.dim}${i + 1}. ${inputQueue[i]}${c.reset}`);
        }
      }

      console.log(formatJobsList([...tasks, ...agents]));
      taskRunner.acknowledgeAll();
      agentSpawner.acknowledgeAll();
      break;
    }

    case ":output": {
      const id = Number(parts[1]);
      if (!id) { console.log("Usage: :output <id>"); break; }
      const task = taskRunner.get(id);
      if (task) {
        if (task.result) console.log(task.result);
        else if (task.error) console.log(`${c.red}Error:${c.reset} ${task.error}`);
        else console.log(`${c.dim}Still running...${c.reset}`);
        break;
      }
      const agent = agentSpawner.get(id - 1000);
      if (agent) {
        const lines = agentSpawner.getOutput(id - 1000, 30);
        console.log(lines.length > 0 ? lines.join("\n") : `${c.dim}No output yet.${c.reset}`);
        break;
      }
      console.log(`${c.red}No task/agent #${id}.${c.reset}`);
      break;
    }

    case ":kill": {
      const id = Number(parts[1]);
      if (!id) { console.log("Usage: :kill <id>"); break; }
      if (taskRunner.cancel(id)) console.log(`${c.green}✓${c.reset} Task #${id} cancelled.`);
      else if (agentSpawner.kill(id - 1000)) console.log(`${c.green}✓${c.reset} Agent #${id} killed.`);
      else console.log(`${c.red}Could not cancel #${id}.${c.reset}`);
      break;
    }

    case ":clear":
      console.log(`${c.green}✓${c.reset} Cleared ${taskRunner.prune()} completed task(s).`);
      break;

    case ":ssh": {
      const hosts = loadHosts();
      console.log(`${c.bold}SSH hosts:${c.reset}`);
      for (const [env, info] of Object.entries(hosts)) {
        console.log(`  ${c.cyan}${env}${c.reset}: ${info.host} — ${info.description}`);
      }
      break;
    }

    // ── LLM Status & Controls ──

    case ":status":
      console.log(formatStatus());
      break;

    case ":offline":
      console.log(goOffline());
      break;

    case ":online":
      console.log(goOnline());
      break;

    case ":disable": {
      const llmName = parts[1];
      if (!llmName) {
        console.log("Usage: :disable <llm>  (claude, ollama, api)");
        break;
      }
      console.log(disableLLM(llmName));
      break;
    }

    case ":enable": {
      const llmName = parts[1];
      if (!llmName) {
        console.log("Usage: :enable <llm>  (claude, ollama, api)");
        break;
      }
      console.log(enableLLM(llmName));
      break;
    }

    // ── Sessions ──

    case ":sessions": {
      const sessions = getRecentSessions(15);
      if (sessions.length === 0) {
        console.log(`${c.dim}No sessions recorded yet.${c.reset}`);
      } else {
        console.log(formatSessionList(sessions));
      }
      break;
    }

    case ":backup": {
      console.log(`${c.dim}Creating full backup of ~/.notoken/...${c.reset}`);
      try {
        const backupPath = createFullBackup();
        console.log(`${c.green}✓${c.reset} Backup created: ${backupPath}`);
      } catch (err) {
        console.log(`${c.red}✗${c.reset} Backup failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    case ":restore": {
      const backupFile = parts[1];
      if (!backupFile) {
        console.log("Usage: :restore <file>");
        const existing = listFullBackups();
        if (existing.length > 0) {
          console.log(`\n${formatBackupsList(existing)}`);
        }
        break;
      }
      try {
        restoreFromBackup(backupFile);
        console.log(`${c.green}✓${c.reset} Restored from: ${backupFile}`);
      } catch (err) {
        console.log(`${c.red}✗${c.reset} Restore failed: ${err instanceof Error ? err.message : err}`);
      }
      break;
    }

    // ── Browser ──

    case ":browse": {
      const browseArg = parts[1];
      const browseFlags = new Set(parts.filter(p => p.startsWith("--")));

      if (!browseArg || browseArg === "help") {
        console.log(`${c.bold}Browser:${c.reset}
  ${c.cyan}:browse <url>${c.reset}        Open URL
  ${c.cyan}:browse <url> --ss${c.reset}   Screenshot
  ${c.cyan}:browse status${c.reset}       Show engines
  ${c.cyan}:browse install${c.reset}      Install engine
  ${c.cyan}:browse stop${c.reset}         Stop Docker browser`);
        break;
      }

      if (browseArg === "status") {
        console.log(formatBrowserStatus(detectBrowserEngines()));
        break;
      }

      if (browseArg === "install") {
        const engine = parts[2] as "patchright" | "playwright" | "docker" | undefined;
        console.log(`${c.dim}Installing ${engine ?? "patchright"}...${c.reset}`);
        const result = await installBrowserEngine(engine);
        console.log(result.success ? `${c.green}✓${c.reset} ${result.message}` : `${c.red}✗${c.reset} ${result.message}`);
        break;
      }

      if (browseArg === "stop") {
        console.log(stopDockerBrowser());
        break;
      }

      // Open URL
      const screenshot = browseFlags.has("--screenshot") || browseFlags.has("--ss");
      const headless = browseFlags.has("--headless");
      const best = getBestEngine();
      if (!best || (best.engine === "system" && screenshot)) {
        console.log(`${c.yellow}No automation engine available.${c.reset} Run ${c.cyan}:browse install${c.reset}`);
        break;
      }

      console.log(`${c.dim}Opening ${browseArg} via ${best.engine}...${c.reset}`);
      const result = await browse({ url: browseArg, headless, screenshot });
      if (result.error) {
        console.log(`${c.red}✗${c.reset} ${result.error}`);
      } else {
        console.log(`${c.green}✓${c.reset} ${result.title ?? "Page loaded"} ${c.dim}(${result.engine})${c.reset}`);
        if (result.screenshotPath) {
          console.log(`${c.cyan}Screenshot:${c.reset} ${result.screenshotPath}`);
        }
      }
      break;
    }

    case ":backups-full": {
      const fullBackups = listFullBackups();
      if (fullBackups.length === 0) {
        console.log(`${c.dim}No full backups found. Use :backup to create one.${c.reset}`);
      } else {
        console.log(formatBackupsList(fullBackups));
      }
      break;
    }

    default:
      console.log(`${c.dim}Unknown command. Type :help${c.reset}`);
  }
}

function buildSshCommand(env: string, cmd: string): string {
  const hosts = loadHosts();
  const entry = hosts[env];
  if (!entry) return `echo "No host configured for: ${env}"`;
  return `ssh ${entry.host} ${JSON.stringify(cmd)}`;
}

async function runSshDirect(env: string, cmd: string): Promise<void> {
  const { runRemoteCommand } = await import("notoken-core");
  try {
    console.log(await runRemoteCommand(env, cmd));
  } catch (err) {
    console.error(`${c.red}SSH error:${c.reset} ${err instanceof Error ? err.message : err}`);
  }
}

// ─── Greeting detection ──────────────────────────────────────────────────────

const GREETING_PATTERNS = [
  /^(hi|hello|hey|howdy|greetings|good\s*(morning|afternoon|evening)|yo|sup|what'?s\s*up)\b/i,
  /^how\s*(are\s*you|is\s*it\s*going|do\s*you\s*do)\b/i,
  /^(thanks|thank\s*you|thx)\b/i,
];

function isGreeting(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.split(/\s+/).length > 6) return false;
  return GREETING_PATTERNS.some((p) => p.test(trimmed));
}

// ─── Adaptive rules ───────────────────────────────────────────────────────────────

let healingInProgress = false;

async function runAutoHeal(notifications: string[], foreground = false): Promise<void> {
  if (healingInProgress) {
    if (foreground) console.log(`${c.dim}Rule improvement already in progress...${c.reset}`);
    return;
  }

  healingInProgress = true;
  if (!foreground) {
    notifications.push(`${c.dim}Adaptive rules: analyzing failures in background...${c.reset}`);
  }

  const { exec: execCmd } = await import("node:child_process");
  const { resolve: resolvePath, dirname: dirnamePath } = await import("node:path");
  const { fileURLToPath } = await import("node:url");
  const thisDir = dirnamePath(fileURLToPath(import.meta.url));
  const healCmd = `npx tsx ${resolvePath(thisDir, "healing/claudeHealer.ts")} --promote --force`;

  const child = execCmd(healCmd, {
    cwd: resolvePath(thisDir, ".."),
    timeout: 180_000,
    encoding: "utf-8",
  });

  let output = "";
  child.stdout?.on("data", (data: string) => { output += data; });
  child.stderr?.on("data", (data: string) => { output += data; });

  child.on("close", async (code) => {
    healingInProgress = false;

    if (code === 0 && output.includes("Patch applied")) {
      const changes = output.match(/\+ synonym "(.+?)" → (\S+)/g);
      if (changes && changes.length > 0) {
        notifications.push(`\n${c.green}${c.bold}New skills learned:${c.reset}`);
        for (const change of changes.slice(0, 5)) {
          const match = change.match(/\+ synonym "(.+?)" → (\S+)/);
          if (match) {
            notifications.push(`  ${c.green}+${c.reset} I now understand "${c.cyan}${match[1]}${c.reset}" as ${c.bold}${match[2]}${c.reset}`);
          }
        }
        if (changes.length > 5) {
          notifications.push(`  ${c.dim}... and ${changes.length - 5} more${c.reset}`);
        }
        notifications.push(`${c.dim}Rules updated. Backups saved.${c.reset}`);

        // Reload config
        const { loadIntents: reloadIntents, loadRules: reloadRules } = await import("notoken-core");
        reloadIntents(true);
        reloadRules(true);
      }
    } else if (foreground) {
      console.log(output);
    } else if (output.includes("No failures")) {
      notifications.push(`${c.dim}Adaptive rules: no failures to fix.${c.reset}`);
    }
  });
}
