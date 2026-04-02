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
import { scanProjects, summarizeDirectory, formatProjectList, formatDirSummary } from "../utils/projectScanner.js";

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
