/**
 * Achievement tracker — gamify CLI usage.
 *
 * Tracks milestones and shows achievements when hit:
 *   "🏆 First Command!" — ran your first command
 *   "🔥 10 Streak!" — 10 commands in one session
 *   "🌍 World Traveler" — connected to 5 different servers
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const STATS_PATH = resolve(homedir(), ".notoken", "usage-stats.json");

interface UsageStats {
  totalCommands: number;
  sessionCommands: number;
  uniqueIntents: string[];
  uniqueServers: string[];
  firstCommandDate?: string;
  streakDays: number;
  lastActiveDate?: string;
  achievements: string[];
}

let _stats: UsageStats | null = null;

function loadStats(): UsageStats {
  if (_stats) return _stats;
  if (existsSync(STATS_PATH)) {
    try { _stats = JSON.parse(readFileSync(STATS_PATH, "utf-8")); return _stats!; } catch {}
  }
  _stats = { totalCommands: 0, sessionCommands: 0, uniqueIntents: [], uniqueServers: [], streakDays: 0, achievements: [] };
  return _stats;
}

function saveStats(): void {
  const dir = resolve(STATS_PATH, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(STATS_PATH, JSON.stringify(loadStats(), null, 2));
}

interface Achievement { id: string; name: string; emoji: string; description: string; }

const ACHIEVEMENTS: Achievement[] = [
  { id: "first_command", name: "First Steps", emoji: "🎯", description: "Ran your first command" },
  { id: "10_commands", name: "Getting Started", emoji: "🚀", description: "Ran 10 commands" },
  { id: "50_commands", name: "Power User", emoji: "⚡", description: "Ran 50 commands" },
  { id: "100_commands", name: "Command Master", emoji: "🏆", description: "Ran 100 commands" },
  { id: "500_commands", name: "Terminal Legend", emoji: "👑", description: "Ran 500 commands" },
  { id: "1000_commands", name: "CLI God", emoji: "🌟", description: "Ran 1000 commands" },
  { id: "10_intents", name: "Explorer", emoji: "🗺️", description: "Used 10 different commands" },
  { id: "25_intents", name: "Versatile", emoji: "🎭", description: "Used 25 different commands" },
  { id: "50_intents", name: "Jack of All Trades", emoji: "🃏", description: "Used 50 different commands" },
  { id: "first_server", name: "Remote Access", emoji: "🌐", description: "Connected to a remote server" },
  { id: "5_servers", name: "World Traveler", emoji: "✈️", description: "Connected to 5 different servers" },
  { id: "3_day_streak", name: "Consistent", emoji: "🔥", description: "Used notoken 3 days in a row" },
  { id: "7_day_streak", name: "Dedicated", emoji: "💪", description: "Used notoken 7 days in a row" },
  { id: "30_day_streak", name: "Unstoppable", emoji: "🏅", description: "Used notoken 30 days in a row" },
  { id: "night_owl", name: "Night Owl", emoji: "🦉", description: "Used notoken after midnight" },
  { id: "early_bird", name: "Early Bird", emoji: "🐦", description: "Used notoken before 6 AM" },
  { id: "first_joke", name: "Comedy Fan", emoji: "😂", description: "Asked for a joke" },
  { id: "first_image", name: "Artist", emoji: "🎨", description: "Generated an image" },
];

/**
 * Record a command execution and check for new achievements.
 * Returns newly unlocked achievements (if any).
 */
export function recordCommand(intent: string, environment?: string): Achievement[] {
  const stats = loadStats();
  const newAchievements: Achievement[] = [];

  stats.totalCommands++;
  stats.sessionCommands++;

  if (!stats.firstCommandDate) stats.firstCommandDate = new Date().toISOString();

  if (!stats.uniqueIntents.includes(intent)) stats.uniqueIntents.push(intent);

  if (environment && environment !== "local" && environment !== "localhost" && environment !== "dev") {
    if (!stats.uniqueServers.includes(environment)) stats.uniqueServers.push(environment);
  }

  // Update streak
  const today = new Date().toISOString().split("T")[0];
  if (stats.lastActiveDate) {
    const last = new Date(stats.lastActiveDate);
    const diff = Math.floor((Date.now() - last.getTime()) / 86400000);
    if (diff === 1) stats.streakDays++;
    else if (diff > 1) stats.streakDays = 1;
  } else {
    stats.streakDays = 1;
  }
  stats.lastActiveDate = today;

  // Check achievements
  const check = (id: string, condition: boolean) => {
    if (condition && !stats.achievements.includes(id)) {
      stats.achievements.push(id);
      const a = ACHIEVEMENTS.find(a => a.id === id);
      if (a) newAchievements.push(a);
    }
  };

  check("first_command", stats.totalCommands >= 1);
  check("10_commands", stats.totalCommands >= 10);
  check("50_commands", stats.totalCommands >= 50);
  check("100_commands", stats.totalCommands >= 100);
  check("500_commands", stats.totalCommands >= 500);
  check("1000_commands", stats.totalCommands >= 1000);
  check("10_intents", stats.uniqueIntents.length >= 10);
  check("25_intents", stats.uniqueIntents.length >= 25);
  check("50_intents", stats.uniqueIntents.length >= 50);
  check("first_server", stats.uniqueServers.length >= 1);
  check("5_servers", stats.uniqueServers.length >= 5);
  check("3_day_streak", stats.streakDays >= 3);
  check("7_day_streak", stats.streakDays >= 7);
  check("30_day_streak", stats.streakDays >= 30);
  check("night_owl", new Date().getHours() >= 0 && new Date().getHours() < 4);
  check("early_bird", new Date().getHours() >= 4 && new Date().getHours() < 6);
  check("first_joke", intent === "chat.joke");
  check("first_image", intent === "ai.generate_image");

  // Save periodically
  if (stats.totalCommands % 5 === 0) saveStats();

  return newAchievements;
}

/** Get all achievements (unlocked and locked). */
export function getAchievements(): Array<Achievement & { unlocked: boolean }> {
  const stats = loadStats();
  return ACHIEVEMENTS.map(a => ({ ...a, unlocked: stats.achievements.includes(a.id) }));
}

/** Get usage stats for display. */
export function getUsageStats(): UsageStats {
  return { ...loadStats() };
}

/** Flush stats to disk. */
export function flushStats(): void { saveStats(); }
