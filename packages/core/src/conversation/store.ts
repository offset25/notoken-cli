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

export interface Conversation {
  id: string;
  folderPath: string;
  createdAt: string;
  updatedAt: string;
  turns: ConversationTurn[];
  /** Running knowledge of entities mentioned across turns */
  knowledgeTree: KnowledgeNode[];
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
