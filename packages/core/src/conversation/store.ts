import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { resolve, basename } from "node:path";
import { homedir } from "node:os";

const CONVERSATIONS_ROOT = resolve(homedir(), ".notoken", "conversations");

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ConversationTurn {
  id: number;
  timestamp: string;
  role: "user" | "system";
  rawText: string;
  intent?: string;
  confidence?: number;
  fields?: Record<string, unknown>;
  result?: string;
  error?: string;
  /** Entities mentioned in this turn */
  entities: ConversationEntity[];
  /** Uncertainty info for this turn */
  uncertainty?: UncertaintyReport;
}

export interface ConversationEntity {
  text: string;
  type: "service" | "environment" | "path" | "user" | "branch" | "container" | "unknown";
  resolved?: string;
}

export interface UncertaintyReport {
  unknownTokens: string[];
  lowConfidenceFields: Array<{ field: string; value: string; confidence: number }>;
  overallConfidence: number;
}

export interface EntityFocus {
  /** The entity/installation currently being discussed */
  entityId: string;
  /** What type — "installation", "server", "database", "service" */
  entityType: string;
  /** When it became the focus */
  focusedAt: string;
  /** Turn ID when it became the focus */
  focusedAtTurn: number;
  /** Conversation history of discussed entities (most recent first) */
  history: Array<{ entityId: string; entityType: string; turnId: number }>;
}

export interface Conversation {
  id: string;
  folderPath: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
  /** Running knowledge of entities mentioned across turns */
  knowledgeTree: KnowledgeNode[];
  /** Currently focused entity — for "it", "that one", "restart it" resolution */
  focus?: EntityFocus;
  /** Files loaded into context — content available to LLM and command analysis */
  contextFiles?: Array<{ path: string; name: string; content: string; loadedAt: string }>;
}

export interface KnowledgeNode {
  entity: string;
  type: ConversationEntity["type"];
  firstMentioned: number;
  lastMentioned: number;
  /** How many turns reference this entity */
  frequency: number;
  /** Related entities seen in the same turns */
  coOccurrences: string[];
  /** Most recent field role (service, environment, target, etc.) */
  lastRole?: string;
}

// ─── Store ───────────────────────────────────────────────────────────────────

function getConversationDir(folderPath: string): string {
  // Sanitize the folder path for filesystem use
  const safePath = folderPath.replace(/[^a-zA-Z0-9_\-\/]/g, "_").replace(/^\/+/, "");
  const dir = resolve(CONVERSATIONS_ROOT, safePath || "default");
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getConversationFile(folderPath: string, conversationId: string): string {
  return resolve(getConversationDir(folderPath), `${conversationId}.json`);
}

/**
 * Create a new conversation.
 */
export function createConversation(folderPath: string): Conversation {
  const id = `conv_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const conv: Conversation = {
    id,
    folderPath,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    turns: [],
    knowledgeTree: [],
  };
  saveConversation(conv);
  return conv;
}

/**
 * Save a conversation to disk.
 */
export function saveConversation(conv: Conversation): void {
  const file = getConversationFile(conv.folderPath, conv.id);
  conv.updatedAt = new Date().toISOString();
  writeFileSync(file, JSON.stringify(conv, null, 2));
}

/**
 * Load a conversation by ID.
 */
export function loadConversation(folderPath: string, conversationId: string): Conversation | null {
  const file = getConversationFile(folderPath, conversationId);
  if (!existsSync(file)) return null;
  return JSON.parse(readFileSync(file, "utf-8"));
}

/**
 * Load the most recent conversation for a folder path, or create a new one.
 */
export function getOrCreateConversation(folderPath: string): Conversation {
  const dir = getConversationDir(folderPath);
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .reverse();

  if (files.length > 0) {
    const latest = JSON.parse(readFileSync(resolve(dir, files[0]), "utf-8")) as Conversation;
    // If last activity was within 1 hour, continue it
    const age = Date.now() - new Date(latest.updatedAt).getTime();
    if (age < 3600_000) return latest;
  }

  return createConversation(folderPath);
}

/**
 * List all conversations for a folder path.
 */
export function listConversations(folderPath: string): Array<{ id: string; createdAt: string; turns: number }> {
  const dir = getConversationDir(folderPath);
  if (!existsSync(dir)) return [];

  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const conv = JSON.parse(readFileSync(resolve(dir, f), "utf-8")) as Conversation;
      return { id: conv.id, createdAt: conv.createdAt, turns: conv.turns.length };
    })
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

// ─── Turn Management ─────────────────────────────────────────────────────────

/**
 * Add a user turn to the conversation.
 */
export function addUserTurn(
  conv: Conversation,
  rawText: string,
  intent?: string,
  confidence?: number,
  fields?: Record<string, unknown>,
  entities?: ConversationEntity[],
  uncertainty?: UncertaintyReport
): ConversationTurn {
  const turn: ConversationTurn = {
    id: conv.turns.length + 1,
    timestamp: new Date().toISOString(),
    role: "user",
    rawText,
    intent,
    confidence,
    fields,
    entities: entities ?? [],
    uncertainty,
  };

  conv.turns.push(turn);

  // Update knowledge tree
  for (const entity of turn.entities) {
    updateKnowledge(conv, entity, turn.id, fields);
  }

  saveConversation(conv);
  return turn;
}

/**
 * Add a system result turn.
 */
export function addSystemTurn(
  conv: Conversation,
  rawText: string,
  result?: string,
  error?: string
): ConversationTurn {
  const turn: ConversationTurn = {
    id: conv.turns.length + 1,
    timestamp: new Date().toISOString(),
    role: "system",
    rawText,
    result,
    error,
    entities: [],
  };

  conv.turns.push(turn);
  saveConversation(conv);
  return turn;
}

// ─── Knowledge Tree ──────────────────────────────────────────────────────────

function updateKnowledge(
  conv: Conversation,
  entity: ConversationEntity,
  turnId: number,
  fields?: Record<string, unknown>
): void {
  const key = entity.resolved ?? entity.text;
  let node = conv.knowledgeTree.find((n) => n.entity === key);

  if (!node) {
    node = {
      entity: key,
      type: entity.type,
      firstMentioned: turnId,
      lastMentioned: turnId,
      frequency: 0,
      coOccurrences: [],
    };
    conv.knowledgeTree.push(node);
  }

  node.lastMentioned = turnId;
  node.frequency++;

  // Determine role from fields
  if (fields) {
    for (const [role, value] of Object.entries(fields)) {
      if (String(value) === key) {
        node.lastRole = role;
      }
    }
  }

  // Track co-occurrences with other entities in same turn
  const turnEntities = conv.turns
    .find((t) => t.id === turnId)
    ?.entities.map((e) => e.resolved ?? e.text)
    .filter((e) => e !== key) ?? [];

  for (const co of turnEntities) {
    if (!node.coOccurrences.includes(co)) {
      node.coOccurrences.push(co);
    }
  }
}

// ─── Entity Focus ──────────────────────────────────────────────────────────

/**
 * Set the currently discussed entity. Called when the user explicitly
 * references an entity/installation (e.g., "the windows openclaw",
 * "openclaw #2", "start openclaw on windows").
 */
export function setEntityFocus(
  conv: Conversation,
  entityId: string,
  entityType: string,
  turnId?: number,
): void {
  const turn = turnId ?? conv.turns.length;
  const entry = { entityId, entityType, turnId: turn };

  if (!conv.focus) {
    conv.focus = { entityId, entityType, focusedAt: new Date().toISOString(), focusedAtTurn: turn, history: [] };
  } else {
    // Push previous focus to history
    if (conv.focus.entityId !== entityId) {
      conv.focus.history.unshift({ entityId: conv.focus.entityId, entityType: conv.focus.entityType, turnId: conv.focus.focusedAtTurn });
      // Keep last 10
      if (conv.focus.history.length > 10) conv.focus.history = conv.focus.history.slice(0, 10);
    }
    conv.focus.entityId = entityId;
    conv.focus.entityType = entityType;
    conv.focus.focusedAt = new Date().toISOString();
    conv.focus.focusedAtTurn = turn;
  }
  saveConversation(conv);
}

/**
 * Get the currently focused entity.
 * Returns null if nothing is focused or focus is stale.
 * Staleness = too many turns have passed without re-mentioning the entity.
 * (Not wall-clock time — if user leaves and comes back, focus is still valid.)
 */
export function getEntityFocus(conv: Conversation, maxTurnsSinceFocus = 8): EntityFocus | null {
  if (!conv.focus) return null;
  // Focus expires after N turns without re-mentioning
  const turnsSinceFocus = conv.turns.length - conv.focus.focusedAtTurn;
  if (turnsSinceFocus > maxTurnsSinceFocus) return null;
  return conv.focus;
}

/**
 * Get the previously discussed entity (for "the other one" resolution).
 * Returns the entity that was focused before the current one.
 */
export function getPreviousFocus(conv: Conversation): { entityId: string; entityType: string } | null {
  if (!conv.focus?.history?.length) return null;
  return conv.focus.history[0];
}

/**
 * Resolve "it", "that one", "this one" to the focused entity.
 * Resolve "the other one" to the previously focused entity.
 */
export function resolveFocusReference(conv: Conversation, text: string): { entityId: string; entityType: string } | null {
  const lower = text.toLowerCase();

  // "the other one", "the previous one", "not this one"
  if (/\bthe\s+other\s+(one|entity|install|openclaw|ollama)\b|\bnot\s+this\s+one\b|\bthe\s+previous\s+one\b/.test(lower)) {
    return getPreviousFocus(conv);
  }

  // "it", "this one", "that one", "the same one" — return current focus
  if (/\b(restart|stop|start|check|update|configure|diagnose|fix)\s+(it|this|that)\b|\bthis\s+one\b|\bthat\s+one\b|\bthe\s+same\s+one\b/.test(lower)) {
    const focus = getEntityFocus(conv);
    if (focus) return { entityId: focus.entityId, entityType: focus.entityType };
  }

  return null;
}

// ─── Context Files ──────────────────────────────────────────────────────────

/**
 * Load a file into the conversation context.
 * Content is stored and available to LLM fallback and analysis.
 * Max 50KB per file to avoid bloating conversation store.
 */
export function loadContextFile(conv: Conversation, filePath: string): string {
  const absPath = resolve(filePath);
  if (!existsSync(absPath)) {
    return `File not found: ${absPath}`;
  }

  const stat = require("node:fs").statSync(absPath);
  if (stat.size > 50 * 1024) {
    return `File too large (${(stat.size / 1024).toFixed(0)} KB). Max 50 KB for context files. Use file.read for large files.`;
  }

  const content = readFileSync(absPath, "utf-8");
  const name = basename(absPath);

  if (!conv.contextFiles) conv.contextFiles = [];

  // Replace if already loaded
  const existing = conv.contextFiles.findIndex((f) => f.path === absPath);
  if (existing >= 0) {
    conv.contextFiles[existing] = { path: absPath, name, content, loadedAt: new Date().toISOString() };
  } else {
    conv.contextFiles.push({ path: absPath, name, content, loadedAt: new Date().toISOString() });
  }

  saveConversation(conv);
  return `Loaded ${name} (${content.split("\n").length} lines, ${(stat.size / 1024).toFixed(1)} KB) into context.`;
}

/**
 * Unload a file from context.
 */
export function unloadContextFile(conv: Conversation, fileName: string): string {
  if (!conv.contextFiles?.length) return "No context files loaded.";

  const idx = conv.contextFiles.findIndex(
    (f) => f.name === fileName || f.path.endsWith(fileName)
  );
  if (idx < 0) return `Not in context: ${fileName}`;

  const removed = conv.contextFiles.splice(idx, 1)[0];
  saveConversation(conv);
  return `Removed ${removed.name} from context.`;
}

/**
 * List loaded context files.
 */
export function listContextFiles(conv: Conversation): string {
  if (!conv.contextFiles?.length) return "No context files loaded.";

  const c = { reset: "\x1b[0m", bold: "\x1b[1m", dim: "\x1b[2m", cyan: "\x1b[36m", green: "\x1b[32m" };
  const lines = [`\n${c.bold}${c.cyan}── Context Files ──${c.reset}\n`];
  for (const f of conv.contextFiles) {
    const lineCount = f.content.split("\n").length;
    const sizeKB = (Buffer.byteLength(f.content) / 1024).toFixed(1);
    lines.push(`  ${c.green}✓${c.reset} ${c.bold}${f.name}${c.reset}  ${c.dim}(${lineCount} lines, ${sizeKB} KB, loaded ${new Date(f.loadedAt).toLocaleString()})${c.reset}`);
    lines.push(`    ${c.dim}${f.path}${c.reset}`);
  }
  lines.push(`\n${c.dim}To unload: :context unload <filename>${c.reset}`);
  return lines.join("\n");
}

/**
 * Get all context file contents as a single string for LLM prompts.
 */
export function getContextFilesContent(conv: Conversation): string {
  if (!conv.contextFiles?.length) return "";
  return conv.contextFiles
    .map((f) => `=== ${f.name} ===\n${f.content}`)
    .join("\n\n");
}

/**
 * Get the most recently mentioned entity of a given type.
 */
export function getLastEntity(conv: Conversation, type: ConversationEntity["type"]): KnowledgeNode | undefined {
  return conv.knowledgeTree
    .filter((n) => n.type === type)
    .sort((a, b) => b.lastMentioned - a.lastMentioned)[0];
}

/**
 * Get all entities, sorted by recency.
 */
export function getRecentEntities(conv: Conversation, limit = 10): KnowledgeNode[] {
  return [...conv.knowledgeTree]
    .sort((a, b) => b.lastMentioned - a.lastMentioned)
    .slice(0, limit);
}

/**
 * Get the last N user turns.
 */
export function getRecentTurns(conv: Conversation, count = 5): ConversationTurn[] {
  return conv.turns
    .filter((t) => t.role === "user")
    .slice(-count);
}
