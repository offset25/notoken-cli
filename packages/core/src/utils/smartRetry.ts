/**
 * Smart Retry — analyzes command failures and suggests fixes.
 *
 * When a command fails, this module inspects the error message,
 * identifies common patterns, and suggests an actionable fix
 * that can be registered as a pending action.
 */

export interface FailureAnalysis {
  /** Whether this failure has an automated fix */
  canFix: boolean;
  /** Short human-friendly suggestion shown to the user */
  suggestion: string;
  /** The command/intent text to execute as the fix */
  fixCommand: string;
  /** Why this fix should help */
  explanation: string;
}

interface FailurePattern {
  /** Regex to match against the error message */
  pattern: RegExp;
  /** Build the analysis from the match and original context */
  build: (match: RegExpMatchArray, intent: string, fields: Record<string, unknown>) => FailureAnalysis;
}

const patterns: FailurePattern[] = [
  {
    pattern: /command not found[:\s]*(\S+)|(\S+):\s*not found|'(\S+)' is not recognized/i,
    build: (m) => {
      const tool = (m[1] || m[2] || m[3]).replace(/['"]/g, "");
      return {
        canFix: true,
        suggestion: `${tool} is not installed. Install it?`,
        fixCommand: `install ${tool}`,
        explanation: `The command "${tool}" was not found on this system. Installing it should fix the issue.`,
      };
    },
  },
  {
    pattern: /connection refused|ECONNREFUSED/i,
    build: (_m, _intent, fields) => {
      const service = (fields.service as string) || (fields.tool as string) || "the service";
      return {
        canFix: true,
        suggestion: `Can't connect — ${service} may not be running. Start it?`,
        fixCommand: `start ${service}`,
        explanation: `Connection was refused, which usually means the target service is not running.`,
      };
    },
  },
  {
    pattern: /permission denied|EACCES|access denied/i,
    build: (_m, intent) => ({
      canFix: true,
      suggestion: "Permission denied. Retry with elevated privileges?",
      fixCommand: `sudo ${intent}`,
      explanation: "The command failed due to insufficient permissions. Running with sudo may resolve it.",
    }),
  },
  {
    pattern: /no such file or directory[:\s]*(.+)|ENOENT[:\s]*(.+)/i,
    build: (m) => {
      const raw = (m[1] || m[2] || "").trim().replace(/['"]/g, "");
      const filename = raw.split("/").pop() || raw;
      return {
        canFix: true,
        suggestion: `File not found: ${filename}. Search for it?`,
        fixCommand: `find ${filename}`,
        explanation: `The path "${raw}" does not exist. A search may locate the correct path.`,
      };
    },
  },
  {
    pattern: /address already in use|port.*already in use|EADDRINUSE/i,
    build: () => ({
      canFix: true,
      suggestion: "Port already in use. Check what's using it?",
      fixCommand: "check ports",
      explanation: "Another process is occupying the required port.",
    }),
  },
  {
    pattern: /no space left|disk full|ENOSPC/i,
    build: () => ({
      canFix: true,
      suggestion: "Disk is full. Free up space?",
      fixCommand: "free up space",
      explanation: "The disk has no remaining space. Clearing caches or temp files may help.",
    }),
  },
  {
    pattern: /timed?\s*out|ETIMEDOUT|ESOCKETTIMEDOUT/i,
    build: (_m, intent) => ({
      canFix: true,
      suggestion: "Command timed out. Try again?",
      fixCommand: intent,
      explanation: "The operation exceeded its time limit. A retry may succeed if the issue was transient.",
    }),
  },
  {
    pattern: /ECONNREFUSED/i,
    build: (_m, _intent, fields) => {
      const service = (fields.service as string) || (fields.tool as string) || "the service";
      return {
        canFix: true,
        suggestion: `Can't connect to ${service}. Check if it's running?`,
        fixCommand: `check status ${service}`,
        explanation: "The connection was actively refused — the target service may be down.",
      };
    },
  },
];

/**
 * Analyze a command failure and suggest a fix.
 *
 * @param intent  - The intent name or raw text that failed
 * @param error   - The error (string or Error)
 * @param fields  - Parsed intent fields (service name, tool, path, etc.)
 * @returns A FailureAnalysis if a known pattern matches, or null
 */
export function analyzeFailure(
  intent: string,
  error: string | Error,
  fields: Record<string, unknown> = {},
): FailureAnalysis | null {
  const message = error instanceof Error ? error.message : String(error);
  if (!message) return null;

  for (const { pattern, build } of patterns) {
    const match = message.match(pattern);
    if (match) {
      return build(match, intent, fields);
    }
  }

  return null;
}
