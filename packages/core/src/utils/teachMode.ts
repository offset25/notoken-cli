/**
 * Teach Mode — let users define custom command mappings.
 *
 * "remember that deploy means git pull && npm install && pm2 restart"
 * Next time: "deploy" → runs that command chain
 *
 * Stored in ~/.notoken/learned-commands.json
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const LEARNED_PATH = resolve(homedir(), ".notoken", "learned-commands.json");

interface LearnedCommand {
  trigger: string;
  command: string;
  description?: string;
  learnedAt: string;
  usedCount: number;
}

let _commands: LearnedCommand[] | null = null;

function load(): LearnedCommand[] {
  if (_commands) return _commands;
  if (existsSync(LEARNED_PATH)) {
    try { _commands = JSON.parse(readFileSync(LEARNED_PATH, "utf-8")); return _commands!; } catch {}
  }
  _commands = [];
  return _commands;
}

function save(): void {
  const dir = resolve(LEARNED_PATH, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(LEARNED_PATH, JSON.stringify(load(), null, 2));
}

/**
 * Teach a new command.
 * "remember that deploy means git pull && npm install && pm2 restart api"
 */
export function teachCommand(trigger: string, command: string, description?: string): void {
  const cmds = load();
  const existing = cmds.findIndex(c => c.trigger.toLowerCase() === trigger.toLowerCase());
  if (existing >= 0) {
    cmds[existing].command = command;
    cmds[existing].description = description;
    cmds[existing].learnedAt = new Date().toISOString();
  } else {
    cmds.push({ trigger: trigger.toLowerCase(), command, description, learnedAt: new Date().toISOString(), usedCount: 0 });
  }
  save();
}

/**
 * Look up a learned command by trigger.
 */
export function getLearnedCommand(trigger: string): LearnedCommand | null {
  const cmds = load();
  const found = cmds.find(c => c.trigger.toLowerCase() === trigger.toLowerCase());
  if (found) {
    found.usedCount++;
    if (found.usedCount % 5 === 0) save(); // periodic save
  }
  return found ?? null;
}

/**
 * List all learned commands.
 */
export function listLearnedCommands(): LearnedCommand[] {
  return [...load()].sort((a, b) => b.usedCount - a.usedCount);
}

/**
 * Forget a learned command.
 */
export function forgetCommand(trigger: string): boolean {
  const cmds = load();
  const idx = cmds.findIndex(c => c.trigger.toLowerCase() === trigger.toLowerCase());
  if (idx >= 0) { cmds.splice(idx, 1); save(); return true; }
  return false;
}

/**
 * Parse a "remember that X means Y" statement.
 * Returns { trigger, command } or null.
 */
export function parseTeachStatement(text: string): { trigger: string; command: string } | null {
  // "remember that deploy means git pull && npm install"
  const m1 = text.match(/^remember\s+(?:that\s+)?(.+?)\s+(?:means|is|equals|does|runs|executes)\s+(.+)$/i);
  if (m1) return { trigger: m1[1].trim(), command: m1[2].trim() };

  // "when I say deploy, run git pull && npm install"
  const m2 = text.match(/^when\s+(?:i\s+)?say\s+(.+?),?\s+(?:run|execute|do)\s+(.+)$/i);
  if (m2) return { trigger: m2[1].trim(), command: m2[2].trim() };

  // "teach: deploy = git pull && npm install"
  const m3 = text.match(/^teach:?\s+(.+?)\s*=\s*(.+)$/i);
  if (m3) return { trigger: m3[1].trim(), command: m3[2].trim() };

  return null;
}
