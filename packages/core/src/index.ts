/**
 * notoken-core — shared library.
 *
 * Exports the core engine that both CLI and Electron app use.
 * This is the single source of truth for all notoken functionality.
 *
 * Usage:
 *   import { parse, execute, detect, install, doctor } from "notoken/core";
 */

// ── NLP & Parsing ──
export { parseIntent } from "./nlp/parseIntent.js";
export { parseByRules } from "./nlp/ruleParser.js";
export { disambiguate } from "./nlp/disambiguate.js";
export { classifyMulti } from "./nlp/multiClassifier.js";
export { semanticParse, tokenize, keyboardDistance, fuzzyMatch } from "./nlp/semantic.js";
export { analyzeUncertainty, getUncoveredSpans } from "./nlp/uncertainty.js";
export { llmFallback, isLLMConfigured, getLLMBackend, formatLLMFallback } from "./nlp/llmFallback.js";

// ── Execution ──
export { executeIntent } from "./handlers/executor.js";
export { runRemoteCommand, runLocalCommand } from "./execution/ssh.js";

// ── Config ──
export { loadRules, loadIntents, getIntentDef, loadHosts, getConfigDir } from "./utils/config.js";
export { CONFIG_DIR, DATA_DIR, LOG_DIR, PACKAGE_ROOT, USER_HOME, isSEA, ensureUserDirs } from "./utils/paths.js";

// ── Platform & Detection ──
export { detectLocalPlatform, getInstallCommand, getServiceCommand, getPackageForCommand, formatPlatform } from "./utils/platform.js";
export type { PlatformInfo } from "./utils/platform.js";

// ── Paths ──
export { winToLinux, linuxToWin, normalizePath, getUserDirs, isWSL, isWindows } from "./utils/wslPaths.js";

// ── Permissions ──
export { getLocalPermissions, getRemotePermissions, checkAccessForIntent, parsePermissionRequest, formatPermissionsDisplay } from "./utils/permissions.js";

// ── Analysis ──
export { analyzeOutput, analyzeLoad, analyzeDisk, analyzeMemory } from "./utils/analysis.js";
export { analyzeDirectory } from "./utils/dirAnalysis.js";

// ── File Operations ──
export { smartRead, smartSearch, getFileInfo } from "./utils/smartFile.js";
export { parseFile, formatParsedFile, detectFileType } from "./parsers/index.js";
export { findKnownLocations, searchRemoteFile } from "./parsers/fileFinder.js";

// ── Conversation ──
export { getOrCreateConversation, addUserTurn, addSystemTurn, saveConversation, getLastEntity, getRecentEntities, listConversations } from "./conversation/store.js";
export type { Conversation, ConversationTurn, KnowledgeNode, UncertaintyReport } from "./conversation/store.js";
export { resolveCoreferences, extractEntitiesFromFields } from "./conversation/coreference.js";
export { redactSecrets, listSecrets, clearSecrets, saveSecretsToFile, resolvePlaceholders } from "./conversation/secrets.js";

// ── Agents & Background ──
export { taskRunner, type BackgroundTask } from "./agents/taskRunner.js";
export { agentSpawner, type AgentHandle } from "./agents/agentSpawner.js";
export { createPlan, formatPlan } from "./agents/planner.js";
export { loadPlaybooks, getPlaybook, runPlaybook, formatPlaybookList } from "./agents/playbookRunner.js";

// ── Healing / Learning ──
export { validatePatch } from "./healing/ruleValidator.js";
export { promotePatch } from "./healing/patchPromoter.js";

// ── Safety ──
export { validateIntent, isDangerous, getRiskLevel } from "./policy/safety.js";
export { askForConfirmation, askForChoice } from "./policy/confirm.js";

// ── UI Helpers ──
export { formatVerbose, formatTaskNotification, formatJobsList } from "./utils/verbose.js";
export { formatExplain } from "./utils/explain.js";
export { formatParsedCommand } from "./utils/output.js";
export { Spinner, withSpinner, progressBar } from "./utils/spinner.js";

// ── Auto-backup ──
export { createBackup, rollback, listBackups, cleanExpiredBackups, formatBackupList } from "./utils/autoBackup.js";

// ── Updates ──
export { checkForUpdate, checkForUpdateSync, runUpdate, formatUpdateBanner, type UpdateInfo } from "./utils/updater.js";

// ── LLM Manager ──
export {
  detectProviders, formatStatus, goOffline, goOnline, disableLLM, enableLLM,
  isOfflineMode, isLLMDisabled, recordOfflineCommand, getTokensSaved,
  formatTokensSaved, formatTokensSavedBrief, saveOnExit, getSessionId,
  type LLMProvider, type LLMState,
} from "./utils/llmManager.js";

// ── Session Summaries ──
export {
  getRecentSessions, getSessionsForFolder, formatSessionSummary, formatSessionList,
  type SessionSummary,
} from "./utils/sessionSummary.js";

// ── Logging ──
export { logFailure, loadFailures, clearFailures } from "./utils/logger.js";
export { logUncertainty, loadUncertaintyLog, getUncertaintySummary } from "./nlp/uncertainty.js";
export { recordHistory, loadHistory, getRecentHistory, searchHistory } from "./context/history.js";

// ── Plugins ──
export { pluginRegistry } from "./plugins/index.js";
export type { NotokenPlugin, PluginIntent, PluginPlaybook, PluginHooks, LoadedPlugin } from "./plugins/index.js";

// ── Types ──
export type { DynamicIntent, ParsedCommand, IntentDef, FieldDef, EnvironmentName } from "./types/intent.js";
export type { RulePatch, RulePatchChange, FailureLog, RulesConfig } from "./types/rules.js";
