import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { DATA_DIR } from "../utils/paths.js";

const HISTORY_FILE = resolve(DATA_DIR, "history.json");
const SESSION_FILE = resolve(DATA_DIR, "session.json");

const MAX_HISTORY = 500;

export interface HistoryEntry {
  timestamp: string;
  rawText: string;
  intent: string;
  fields: Record<string, unknown>;
  command: string;
  environment: string;
  success: boolean;
}

export interface SessionContext {
  sessionId: string;
  startedAt: string;
  lastActivity: string;
  recentIntents: string[];
  recentEnvironments: string[];
  recentServices: string[];
  variables: Record<string, unknown>;
}

function ensureDataDir(): void {
  if (!existsSync(DATA_DIR)) {
    mkdirSync(DATA_DIR, { recursive: true });
  }
}

// ─── History ─────────────────────────────────────────────────────────────────

export function recordHistory(entry: HistoryEntry): void {
  ensureDataDir();
  const history = loadHistory();
  history.push(entry);

  // Trim to max
  if (history.length > MAX_HISTORY) {
    history.splice(0, history.length - MAX_HISTORY);
  }

  writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2));

  // Also update session
  updateSession(entry);
}

export function loadHistory(): HistoryEntry[] {
  if (!existsSync(HISTORY_FILE)) return [];
  const raw = readFileSync(HISTORY_FILE, "utf-8");
  return JSON.parse(raw);
}

export function getRecentHistory(count = 10): HistoryEntry[] {
  const history = loadHistory();
  return history.slice(-count);
}

export function searchHistory(query: string): HistoryEntry[] {
  const history = loadHistory();
  const lower = query.toLowerCase();
  return history.filter(
    (h) =>
      h.rawText.toLowerCase().includes(lower) ||
      h.intent.includes(lower) ||
      h.command.toLowerCase().includes(lower)
  );
}

export function clearHistory(): void {
  ensureDataDir();
  writeFileSync(HISTORY_FILE, "[]");
}

// ─── Session Context ─────────────────────────────────────────────────────────

function generateSessionId(): string {
  return `session_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

export function getSession(): SessionContext {
  ensureDataDir();
  if (existsSync(SESSION_FILE)) {
    const raw = readFileSync(SESSION_FILE, "utf-8");
    const session: SessionContext = JSON.parse(raw);
    // If session is older than 1 hour, start new
    const age = Date.now() - new Date(session.lastActivity).getTime();
    if (age < 3600_000) return session;
  }

  const session: SessionContext = {
    sessionId: generateSessionId(),
    startedAt: new Date().toISOString(),
    lastActivity: new Date().toISOString(),
    recentIntents: [],
    recentEnvironments: [],
    recentServices: [],
    variables: {},
  };
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
  return session;
}

function updateSession(entry: HistoryEntry): void {
  const session = getSession();
  session.lastActivity = new Date().toISOString();

  // Track recent intents (last 10)
  session.recentIntents.push(entry.intent);
  if (session.recentIntents.length > 10) session.recentIntents.shift();

  // Track recent environments
  if (entry.environment && !session.recentEnvironments.includes(entry.environment)) {
    session.recentEnvironments.push(entry.environment);
    if (session.recentEnvironments.length > 5) session.recentEnvironments.shift();
  }

  // Track recent services
  const service = entry.fields.service as string | undefined;
  if (service && !session.recentServices.includes(service)) {
    session.recentServices.push(service);
    if (session.recentServices.length > 5) session.recentServices.shift();
  }

  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

export function setVariable(key: string, value: unknown): void {
  const session = getSession();
  session.variables[key] = value;
  writeFileSync(SESSION_FILE, JSON.stringify(session, null, 2));
}

export function getVariable(key: string): unknown {
  const session = getSession();
  return session.variables[key];
}

/**
 * Get context hints for the parser.
 *
 * Returns the most likely environment and service based on recent activity,
 * so the parser can use these as smart defaults.
 */
export function getContextHints(): { environment?: string; service?: string } {
  const session = getSession();
  return {
    environment: session.recentEnvironments[session.recentEnvironments.length - 1],
    service: session.recentServices[session.recentServices.length - 1],
  };
}
