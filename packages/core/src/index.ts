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
export { findSimilarIntents, phraseSimilarity, expandWithCooccurrences } from "./nlp/semanticSimilarity.js";
export { loadKnowledgeGraph, saveKnowledgeGraph, addEntity, addRelation, getEntity, getRelated, resolveReference, resolveCandidates, inferIntent, queryGraph, rebuildGraph, learnFromExecution, flushGraph } from "./nlp/knowledgeGraph.js";
export { expandQuery, findCluster, suggestIntents, clusterWords } from "./nlp/conceptExpansion.js";
export { analyzeUncertainty, getUncoveredSpans } from "./nlp/uncertainty.js";
export { llmFallback, isLLMConfigured, getLLMBackend, formatLLMFallback } from "./nlp/llmFallback.js";
export { suggestEntityCorrection, correctEntities, resolveDescription, resetEntityVocab } from "./nlp/entitySpellCorrect.js";
export { recordOutcome, getMultiplier, calibrateVotes, recordCorrection, getCalibrationStats, flushCalibration } from "./nlp/confidenceCalibrator.js";
export { detectBatch, expandBatch, expandEnvironmentBatch } from "./nlp/batchParser.js";
export { getCurrentTopic, suggestFollowups, getTopicDefault } from "./conversation/topicTracker.js";

// ── Progress & History ──
export { progressReporter, reportProgress, reportStep } from "./utils/progressReporter.js";
export { loadHistory as loadCommandHistory, addToHistory, searchHistory as searchCommandHistory, getRecentCommands, getReadlineHistory } from "./utils/commandHistory.js";

// ── Execution ──
export { executeIntent } from "./handlers/executor.js";
export { runRemoteCommand, runLocalCommand } from "./execution/ssh.js";

// ── Config ──
export { loadRules, loadIntents, getIntentDef, loadHosts, getConfigDir } from "./utils/config.js";
export { CONFIG_DIR, DATA_DIR, LOG_DIR, PACKAGE_ROOT, USER_HOME, isSEA, ensureUserDirs } from "./utils/paths.js";
export { loadAliases, resolveAlias, saveAlias, removeAlias, listAliases } from "./utils/aliases.js";
export { buildCompletions, completeInput } from "./utils/completer.js";

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
export { getOrCreateConversation, addUserTurn, addSystemTurn, saveConversation, getLastEntity, getRecentEntities, getRecentTurns, listConversations, loadContextFile, unloadContextFile, listContextFiles, setEntityFocus, getEntityFocus, getPreviousFocus, resolveFocusReference } from "./conversation/store.js";
export type { Conversation, ConversationTurn, KnowledgeNode, UncertaintyReport, EntityFocus } from "./conversation/store.js";
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
export { checkForUpdate, checkForUpdateSync, runUpdate, formatUpdateBanner, isNewer, type UpdateInfo } from "./utils/updater.js";

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

// ── Session Backup & Prefs ──
export {
  isSessionOpen, toggleSession, hideSession, unhideSession, getHiddenSessions, getLastViewedSession,
  createFullBackup, restoreFromBackup, listFullBackups, formatBackupsList,
  type BackupInfo,
} from "./utils/sessionBackup.js";

// ── Smart Retry ──
export {
  analyzeFailure,
  type FailureAnalysis,
} from "./utils/smartRetry.js";

// ── Pending Actions ──
export {
  suggestAction, getLastPendingAction, consumePendingAction,
  isAffirmation, isRedirectingPendingAction, clearPendingActions,
  type PendingAction,
} from "./conversation/pendingActions.js";

// ── Multi-Intent ──
export {
  parseMultiIntent, splitCompoundSentence, formatPlanSteps,
  type MultiIntentPlan, type PlanStep,
} from "./nlp/multiIntent.js";

// ── Concept Router ──
export { routeByConcepts, mergeConceptDomains, type ConceptRouterResult } from "./nlp/conceptRouter.js";

// ── Vocabulary Builder ──
export {
  enrichVocabularyFromWiki, loadLearnedVocabulary, getEnrichedConcepts,
  type LearnedVocabulary,
} from "./nlp/vocabularyBuilder.js";

// ── Shell Compatibility ──
export {
  commandExists, tryExec as shellTryExec, getTempDir, timestamp, fileSize,
  lineCount, shellExec, crossPlatformCmd, silenceStderr, isWin,
  getPlatformSummary, isAdmin, getSystemInstallCmd,
} from "./utils/shellCompat.js";

// ── Install Tracker ──
export {
  trackInstall, getInstallHistory, getInstalledByType, getInstalledItem,
  untrackInstall, formatInstallHistory, getUninstallSteps,
  type InstalledItem, type InstallHistory,
} from "./utils/installTracker.js";

// ── Wikidata Knowledge Base ──
export {
  searchWikidata, lookupUnknownNouns, formatWikiEntity, formatWikiSuggestions,
  type WikiEntity, type WikiLookupResult,
} from "./nlp/wikidata.js";

// ── Image Generation ──
export {
  detectGpu, detectImageEngines, getBestImageEngine, generateImage,
  getInstallPlan, installImageEngine, formatImageEngineStatus,
  getDriveInfo, resolveUserPath,
  type ImageEngine, type ImageEngineStatus, type GpuInfo, type GenerateResult, type DriveInfo,
} from "./utils/imageGen.js";

// ── Project Scanner ──
export {
  scanProjects, summarizeDirectory, formatProjectList, formatDirSummary,
  type ProjectInfo, type DirSummary,
} from "./utils/projectScanner.js";

// ── Browser ──
export {
  detectBrowserEngines, getBestEngine, installBrowserEngine, browse, formatBrowserStatus,
  stopDockerBrowser, normalizeUrl,
  type BrowserEngine, type BrowserStatus, type BrowseOptions, type BrowseResult, type InstallResult,
} from "./utils/browser.js";

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
