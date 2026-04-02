/**
 * Concept-based intent router.
 *
 * Instead of matching exact synonym phrases, this extracts concepts
 * from the user's input and routes to the right intent domain.
 *
 * How it works:
 *   1. Tokenize with compromise (POS tags)
 *   2. Extract: action verbs, subject nouns, attribute adjectives, question type
 *   3. Map concepts to intent domains via a concept→domain map
 *   4. Pick the best intent within that domain
 *
 * This handles:
 *   "is this happening offline or locally is it free or using cloud?"
 *   → concepts: [offline, local, free, cloud] → domain: ai.image_status
 *
 *   "can you check what crontabs I have running"
 *   → action: check, subject: crontabs → domain: cron.list
 */

import type { IntentDef } from "../types/intent.js";
import { loadIntents } from "../utils/config.js";
import { tokenize, type Token } from "./semantic.js";

// ─── Concept → Domain Map ──────────────────────────────────────────────────
// Maps nouns/concepts to intent domains. When a user mentions these concepts,
// the router knows which intent area to look in.

const CONCEPT_DOMAINS: Record<string, string[]> = {
  // Image generation
  "image":        ["ai.generate_image", "ai.image_status"],
  "picture":      ["ai.generate_image", "ai.image_status"],
  "photo":        ["ai.generate_image", "ai.image_status"],
  "generate":     ["ai.generate_image"],
  "stable diffusion": ["ai.image_status", "ai.install_sd"],
  "offline":      ["ai.image_status"],
  "cloud":        ["ai.image_status"],
  "local":        ["ai.image_status"],
  "private":      ["ai.image_status"],

  // Server / system
  "crontab":      ["cron.list"],
  "cron":         ["cron.list", "cron.add", "cron.remove"],
  "uptime":       ["server.uptime"],
  "load":         ["server.uptime"],
  "memory":       ["server.check_memory"],
  "ram":          ["server.check_memory"],
  "disk":         ["server.check_disk"],
  "storage":      ["server.check_disk"],
  "cpu":          ["server.uptime", "hardware.info"],

  // Network
  "ip":           ["network.ip"],
  "dns":          ["dns.lookup"],
  "port":         ["network.ports", "firewall.open"],
  "firewall":     ["firewall.list"],
  "traceroute":   ["network.traceroute"],
  "speed":        ["network.speedtest"],
  "bandwidth":    ["network.bandwidth"],
  "connection":   ["network.connections"],

  // Docker
  "container":    ["docker.ps", "docker.restart"],
  "docker":       ["docker.ps", "docker.restart"],

  // Git
  "commit":       ["git.status", "git.commit"],
  "branch":       ["git.branch"],
  "repo":         ["git.status"],

  // Files
  "file":         ["dir.list", "files.find"],
  "folder":       ["dir.list", "project.scan"],
  "directory":    ["dir.list", "project.scan"],
  "project":      ["project.scan", "project.info"],
  "media":        ["files.find_media"],
  "movie":        ["files.find_media"],
  "video":        ["files.find_media"],
  "music":        ["files.find_media"],
  "photos":       ["files.find_media"],

  // Services
  "nginx":        ["service.status", "service.restart"],
  "redis":        ["service.status", "service.restart"],
  "postgres":     ["service.status", "service.restart"],

  // System
  "hostname":     ["system.hostname"],
  "timezone":     ["system.timezone"],
  "kernel":       ["system.kernel"],
  "env":          ["system.env"],
  "hardware":     ["hardware.info"],
  "reboot":       ["system.reboot_history"],
  "update":       ["package.audit"],
  "package":      ["package.audit"],
  "vulnerability": ["package.audit"],

  // Browser
  "browser":      ["browser.status", "browser.open"],
  "browse":       ["browser.open"],
  "website":      ["browser.open"],
  "url":          ["browser.open"],
};

// Question words that indicate an info/status query (not an action)
const QUESTION_PATTERNS = [
  "is", "are", "was", "were", "do", "does", "did",
  "what", "which", "where", "how", "why", "when",
  "can", "could", "will", "would",
];

// Action verbs that indicate status/info queries
const STATUS_VERBS = new Set([
  "check", "show", "list", "view", "display", "see", "tell",
  "status", "info", "information", "report",
]);

// Action verbs that indicate mutation/execution
const ACTION_VERBS = new Set([
  "restart", "stop", "start", "kill", "install", "uninstall", "remove",
  "create", "make", "generate", "draw", "paint", "build",
  "open", "close", "block", "allow",
  "update", "upgrade", "fix", "repair",
  "send", "copy", "move", "delete", "tar", "zip",
]);

export interface ConceptRouterResult {
  intent: string;
  confidence: number;
  concepts: string[];
  isQuestion: boolean;
  reason: string;
}

/**
 * Route user input to intent by understanding concepts, not matching phrases.
 */
export function routeByConcepts(rawText: string): ConceptRouterResult | null {
  const text = rawText.toLowerCase().trim();
  const tokens = tokenize(text, [], []);

  // Extract key parts
  const verbs = tokens.filter(t => t.tag === "VERB").map(t => t.text.toLowerCase());
  const nouns = tokens.filter(t => ["NOUN", "SERVICE", "ADJ"].includes(t.tag)).map(t => t.text.toLowerCase());
  const allWords = text.split(/\s+/);

  // Is this a question?
  const isQuestion = QUESTION_PATTERNS.some(q => allWords[0] === q) || text.endsWith("?");
  const isStatusQuery = isQuestion || verbs.some(v => STATUS_VERBS.has(v));

  // Find matching concepts
  const matchedDomains = new Map<string, number>();
  const matchedConcepts: string[] = [];

  // Check ALL words against concept map (not just POS-tagged nouns/verbs)
  // because domain terms like "crontab", "docker", "nginx" may not be tagged correctly
  for (const word of allWords) {
    const domains = CONCEPT_DOMAINS[word];
    if (domains) {
      matchedConcepts.push(word);
      for (const domain of domains) {
        matchedDomains.set(domain, (matchedDomains.get(domain) ?? 0) + 1);
      }
    }
    // Also check plurals/variants (crontabs → crontab, containers → container)
    const singular = word.replace(/s$/, "");
    if (singular !== word) {
      const sDomains = CONCEPT_DOMAINS[singular];
      if (sDomains) {
        matchedConcepts.push(singular);
        for (const domain of sDomains) {
          matchedDomains.set(domain, (matchedDomains.get(domain) ?? 0) + 1);
        }
      }
    }
  }

  // Check bigrams (two-word concepts like "stable diffusion")
  for (let i = 0; i < allWords.length - 1; i++) {
    const bigram = `${allWords[i]} ${allWords[i + 1]}`;
    const domains = CONCEPT_DOMAINS[bigram];
    if (domains) {
      matchedConcepts.push(bigram);
      for (const domain of domains) {
        matchedDomains.set(domain, (matchedDomains.get(domain) ?? 0) + 2); // bigrams worth more
      }
    }
  }

  if (matchedDomains.size === 0) return null;

  // Sort by match count
  const sorted = [...matchedDomains.entries()].sort((a, b) => b[1] - a[1]);

  // For questions/status queries, prefer .status/.list/.check intents
  let bestIntent = sorted[0][0];
  if (isStatusQuery) {
    const statusIntents = sorted.filter(([intent]) =>
      intent.includes("status") || intent.includes("list") || intent.includes("check") || intent.includes("info")
    );
    if (statusIntents.length > 0) bestIntent = statusIntents[0][0];
  }

  // For action verbs, prefer action intents
  const hasActionVerb = verbs.some(v => ACTION_VERBS.has(v));
  if (hasActionVerb && !isStatusQuery) {
    const actionIntents = sorted.filter(([intent]) =>
      !intent.includes("status") && !intent.includes("list") && !intent.includes("info")
    );
    if (actionIntents.length > 0) bestIntent = actionIntents[0][0];
  }

  const confidence = Math.min(0.85, 0.5 + matchedConcepts.length * 0.1 + sorted[0][1] * 0.05);

  return {
    intent: bestIntent,
    confidence,
    concepts: matchedConcepts,
    isQuestion,
    reason: `Concepts: [${matchedConcepts.join(", ")}] → ${bestIntent}`,
  };
}
