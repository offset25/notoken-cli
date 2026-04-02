/**
 * Plugin type definitions.
 *
 * A plugin is a plain object that conforms to this interface.
 * Minimum: { name, intents }
 * Everything else is optional.
 */

import type { IntentDef } from "../types/intent.js";

export interface PluginIntent {
  name: string;
  description: string;
  synonyms: string[];
  fields?: Record<string, { type: string; required: boolean; default?: unknown }>;
  command: string;
  execution?: "local" | "remote";
  requiresConfirmation?: boolean;
  riskLevel?: "low" | "medium" | "high";
  allowlist?: string[];
  examples?: string[];
}

export interface PluginPlaybook {
  name: string;
  description: string;
  steps: Array<{ command: string; label: string }>;
}

export interface PluginHooks {
  /** Called before any intent executes. Return false to cancel. */
  beforeExecute?: (intent: { intent: string; fields: Record<string, unknown>; rawText: string }) => Promise<boolean | void>;

  /** Called after any intent executes successfully. */
  afterExecute?: (intent: { intent: string; fields: Record<string, unknown> }, result: string) => Promise<void>;

  /** Called when an intent execution fails. */
  onError?: (intent: { intent: string; fields: Record<string, unknown> }, error: Error) => Promise<void>;

  /** Called when no intent matches. Return a result to handle it, or null to pass. */
  onUnknown?: (rawText: string) => Promise<{ intent: string; fields: Record<string, unknown>; confidence: number } | null>;

  /** Called on startup. */
  onLoad?: () => Promise<void>;

  /** Called on shutdown. */
  onUnload?: () => Promise<void>;
}

export interface PluginAliases {
  services?: Record<string, string[]>;
  environments?: Record<string, string[]>;
}

export interface PluginFileHints {
  [category: string]: {
    aliases: string[];
    configs?: Array<{ path: string; description: string }>;
    logs?: Array<{ path: string; description: string }>;
  };
}

export interface NotokenPlugin {
  /** Unique plugin name (e.g., "aws", "mycompany", "slack") */
  name: string;

  /** Plugin version */
  version?: string;

  /** Description */
  description?: string;

  /** Author */
  author?: string;

  /** New intents this plugin adds */
  intents?: PluginIntent[];

  /** New playbooks */
  playbooks?: PluginPlaybook[];

  /** Lifecycle hooks */
  hooks?: PluginHooks;

  /** New service/environment aliases */
  aliases?: PluginAliases;

  /** New file hint locations */
  fileHints?: PluginFileHints;

  /** Plugin configuration (user can set via notoken config set plugins.<name>.<key>) */
  config?: Record<string, unknown>;
}

export interface LoadedPlugin {
  plugin: NotokenPlugin;
  source: "npm" | "local" | "builtin";
  path: string;
  enabled: boolean;
}
