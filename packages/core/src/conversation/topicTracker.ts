/**
 * Topic Tracker — tracks what domain the conversation is about.
 *
 * If the user has been talking about Docker for 5 turns, bare commands
 * like "check status" or "restart" should default to Docker context.
 *
 * Also provides suggested follow-up commands based on what was just done.
 */

import type { Conversation, ConversationTurn } from "./store.js";

// ─── Topic detection ────────────────────────────────────────────────────────

const INTENT_TO_TOPIC: Record<string, string> = {
  "docker.": "docker",
  "service.": "services",
  "server.": "system",
  "disk.": "disk",
  "logs.": "logs",
  "network.": "network",
  "git.": "git",
  "deploy.": "deploy",
  "openclaw.": "openclaw",
  "discord.": "discord",
  "ollama.": "ollama",
  "security.": "security",
  "db.": "database",
  "backup.": "backup",
  "user.": "users",
  "firewall.": "firewall",
  "cron.": "cron",
  "files.": "files",
  "process.": "processes",
  "ai.": "ai",
  "notoken.": "notoken",
  "weather.": "general",
  "news.": "general",
};

function intentToTopic(intent: string): string | null {
  for (const [prefix, topic] of Object.entries(INTENT_TO_TOPIC)) {
    if (intent.startsWith(prefix)) return topic;
  }
  return null;
}

export interface TopicContext {
  /** Current dominant topic */
  topic: string | null;
  /** How many consecutive turns on this topic */
  depth: number;
  /** Confidence that this is the active topic (0-1) */
  confidence: number;
  /** Recent topics with counts */
  recentTopics: Array<{ topic: string; count: number }>;
}

/**
 * Analyze recent conversation to determine the current topic.
 */
export function getCurrentTopic(conv: Conversation, lookback = 8): TopicContext {
  const recent = conv.turns.slice(-lookback).filter(t => t.role === "user" && t.intent);
  if (recent.length === 0) return { topic: null, depth: 0, confidence: 0, recentTopics: [] };

  // Count topics in recent turns
  const topicCounts = new Map<string, number>();
  let consecutiveCount = 0;
  let lastTopic: string | null = null;

  for (const turn of recent.reverse()) {
    const topic = intentToTopic(turn.intent!);
    if (!topic) continue;

    topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);

    if (lastTopic === null) {
      lastTopic = topic;
      consecutiveCount = 1;
    } else if (topic === lastTopic) {
      consecutiveCount++;
    }
  }

  if (!lastTopic) return { topic: null, depth: 0, confidence: 0, recentTopics: [] };

  // Most frequent topic
  const sorted = [...topicCounts.entries()].sort((a, b) => b[1] - a[1]);
  const dominantTopic = sorted[0][0];
  const dominantCount = sorted[0][1];

  // Confidence based on dominance ratio and consecutive turns
  const confidence = Math.min(1.0,
    (dominantCount / recent.length) * 0.6 +
    (consecutiveCount / Math.min(recent.length, 5)) * 0.4
  );

  return {
    topic: dominantTopic,
    depth: consecutiveCount,
    confidence,
    recentTopics: sorted.map(([topic, count]) => ({ topic, count })),
  };
}

// ─── Suggested commands ─────────────────────────────────────────────────────

const SUGGESTIONS: Record<string, string[]> = {
  "service.restart": ["check service status", "show logs", "is it running now"],
  "service.status": ["restart service", "show logs", "check memory"],
  "server.check_disk": ["free up space", "scan drives", "show large files"],
  "server.uptime": ["check memory", "list processes", "check disk"],
  "server.check_memory": ["list processes", "check disk", "kill process"],
  "disk.cleanup": ["check disk space", "scan drives"],
  "disk.scan": ["free up space", "check disk space"],
  "docker.list": ["docker logs", "restart container", "docker images"],
  "docker.restart": ["docker list", "docker logs", "check status"],
  "logs.tail": ["search logs for errors", "show error logs"],
  "logs.errors": ["show full logs", "restart service", "check status"],
  "deploy.run": ["check status", "rollback deploy", "show logs"],
  "network.ports": ["check firewall rules", "block ip", "scan for attacks"],
  "security.scan": ["check firewall rules", "install fail2ban", "block ip"],
  "git.status": ["git log", "git pull", "git diff"],
  "git.pull": ["git status", "git log"],
  "process.list": ["kill process", "check memory", "check load"],
  "process.kill": ["list processes", "check memory"],
  "backup.create": ["list backups", "check disk space"],
  "ai.generate_image": ["check image status", "generate another image"],
  "openclaw.status": ["diagnose openclaw", "restart openclaw"],
  "openclaw.diagnose": ["fix openclaw", "restart openclaw"],
  "weather.current": ["news headlines"],
  "notoken.status": ["check disk", "check load", "show running services"],
};

/**
 * Suggest follow-up commands based on what was just executed.
 */
export function suggestFollowups(intent: string): string[] {
  return SUGGESTIONS[intent] ?? [];
}

/**
 * Get topic-aware default for ambiguous commands.
 * "check status" during a Docker conversation → docker.list
 * "restart" during a services conversation → service.restart
 */
export function getTopicDefault(ambiguousVerb: string, topic: TopicContext): string | null {
  if (!topic.topic || topic.confidence < 0.4) return null;

  const defaults: Record<string, Record<string, string>> = {
    docker: { status: "docker.list", restart: "docker.restart", stop: "docker.stop", logs: "docker.logs", list: "docker.list" },
    services: { status: "service.status", restart: "service.restart", stop: "service.stop", start: "service.start", check: "service.status" },
    system: { status: "server.uptime", check: "server.uptime" },
    disk: { status: "server.check_disk", check: "server.check_disk", clean: "disk.cleanup", scan: "disk.scan" },
    logs: { show: "logs.tail", check: "logs.errors", search: "logs.search" },
    network: { check: "network.ports", scan: "network.ports", status: "network.ports" },
    git: { status: "git.status", check: "git.status" },
    security: { check: "security.scan", scan: "security.scan" },
    database: { check: "db.size", status: "db.tables" },
    openclaw: { status: "openclaw.status", check: "openclaw.status", restart: "openclaw.restart", diagnose: "openclaw.diagnose" },
    discord: { status: "discord.check", check: "discord.check", diagnose: "discord.diagnose" },
  };

  const topicDefaults = defaults[topic.topic];
  if (!topicDefaults) return null;

  const verb = ambiguousVerb.toLowerCase().trim();
  return topicDefaults[verb] ?? null;
}
