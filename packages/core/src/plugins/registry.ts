/**
 * Plugin registry.
 *
 * Discovers, loads, validates, and manages plugins.
 *
 * Plugin sources (checked in order):
 * 1. ~/.notoken/plugins/         — local plugins (JS/TS files or directories)
 * 2. npm: notoken-plugin-*       — installed globally via npm
 * 3. Built-in plugins            — shipped with notoken-core
 *
 * Usage:
 *   import { pluginRegistry } from "notoken-core";
 *   await pluginRegistry.loadAll();
 *   const intents = pluginRegistry.getAllIntents();
 *   const playbooks = pluginRegistry.getAllPlaybooks();
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";
import { execSync } from "node:child_process";
import { createRequire } from "node:module";
import { USER_HOME } from "../utils/paths.js";
import type { NotokenPlugin, LoadedPlugin, PluginHooks } from "./types.js";

const require = createRequire(import.meta.url);

const PLUGIN_DIR = resolve(USER_HOME, "plugins");

class PluginRegistry {
  private plugins: Map<string, LoadedPlugin> = new Map();
  private loaded = false;

  /**
   * Load all plugins from all sources.
   */
  async loadAll(): Promise<void> {
    if (this.loaded) return;
    this.loaded = true;

    // 1. Local plugins
    await this.loadLocalPlugins();

    // 2. npm global plugins
    await this.loadNpmPlugins();

    // Report
    if (this.plugins.size > 0) {
      const names = Array.from(this.plugins.keys());
      console.error(`\x1b[2m[plugins] Loaded ${names.length}: ${names.join(", ")}\x1b[0m`);
    }
  }

  /**
   * Load a single plugin by path or module name.
   */
  async load(nameOrPath: string, source: "npm" | "local" = "local"): Promise<boolean> {
    try {
      let plugin: NotokenPlugin | null = null;
      let pluginPath = nameOrPath;

      // Try CJS require first (works for .js with module.exports), then ESM import
      try {
        const mod = require(nameOrPath);
        plugin = (mod && typeof mod.name === "string") ? mod :
                 (mod?.default && typeof mod.default.name === "string") ? mod.default : null;
      } catch {
        // Fall back to ESM import
        try {
          const mod = await import(nameOrPath) as Record<string, unknown>;
          plugin = (
            mod.default && typeof (mod.default as Record<string, unknown>).name === "string" ? mod.default :
            typeof mod.name === "string" ? mod :
            null
          ) as NotokenPlugin | null;
        } catch {}
      }

      if (!plugin || !plugin.name) {
        console.error(`[plugins] Invalid plugin (no name): ${nameOrPath}`);
        return false;
      }

      // Validate
      if (!this.validate(plugin)) return false;

      this.plugins.set(plugin!.name, {
        plugin: plugin!,
        source,
        path: pluginPath,
        enabled: true,
      });

      // Call onLoad hook
      if (plugin.hooks?.onLoad) {
        await plugin.hooks.onLoad();
      }

      return true;
    } catch (err) {
      console.error(`[plugins] Failed to load ${nameOrPath}: ${(err as Error).message}`);
      return false;
    }
  }

  /**
   * Unload a plugin by name.
   */
  async unload(name: string): Promise<boolean> {
    const loaded = this.plugins.get(name);
    if (!loaded) return false;

    if (loaded.plugin.hooks?.onUnload) {
      await loaded.plugin.hooks.onUnload();
    }

    this.plugins.delete(name);
    return true;
  }

  // ── Getters ──

  /** Get all intents from all plugins + core. */
  getAllIntents(): Array<{ name: string; [k: string]: unknown }> {
    const intents: Array<{ name: string; [k: string]: unknown }> = [];
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.intents) continue;
      for (const intent of plugin.intents) {
        intents.push({
          ...intent,
          fields: intent.fields ?? {},
          execution: intent.execution ?? "local",
          requiresConfirmation: intent.requiresConfirmation ?? false,
          riskLevel: intent.riskLevel ?? "low",
          examples: intent.examples ?? [],
          _plugin: plugin.name,
        });
      }
    }
    return intents;
  }

  /** Get all playbooks from all plugins. */
  getAllPlaybooks(): Array<{ name: string; description: string; steps: Array<{ command: string; label: string }>; _plugin: string }> {
    const playbooks: Array<{ name: string; description: string; steps: Array<{ command: string; label: string }>; _plugin: string }> = [];
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.playbooks) continue;
      for (const pb of plugin.playbooks) {
        playbooks.push({ ...pb, _plugin: plugin.name });
      }
    }
    return playbooks;
  }

  /** Get all service aliases from plugins. */
  getAllServiceAliases(): Record<string, string[]> {
    const aliases: Record<string, string[]> = {};
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.aliases?.services) continue;
      for (const [service, aliasList] of Object.entries(plugin.aliases.services)) {
        aliases[service] = [...(aliases[service] ?? []), ...aliasList];
      }
    }
    return aliases;
  }

  /** Get all environment aliases from plugins. */
  getAllEnvironmentAliases(): Record<string, string[]> {
    const aliases: Record<string, string[]> = {};
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.aliases?.environments) continue;
      for (const [env, aliasList] of Object.entries(plugin.aliases.environments)) {
        aliases[env] = [...(aliases[env] ?? []), ...aliasList];
      }
    }
    return aliases;
  }

  /** Run all beforeExecute hooks. Returns false if any hook cancels. */
  async runBeforeExecute(intent: { intent: string; fields: Record<string, unknown>; rawText: string }): Promise<boolean> {
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.hooks?.beforeExecute) continue;
      const result = await plugin.hooks.beforeExecute(intent);
      if (result === false) return false;
    }
    return true;
  }

  /** Run all afterExecute hooks. */
  async runAfterExecute(intent: { intent: string; fields: Record<string, unknown> }, result: string): Promise<void> {
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.hooks?.afterExecute) continue;
      try { await plugin.hooks.afterExecute(intent, result); } catch {}
    }
  }

  /** Run all onError hooks. */
  async runOnError(intent: { intent: string; fields: Record<string, unknown> }, error: Error): Promise<void> {
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.hooks?.onError) continue;
      try { await plugin.hooks.onError(intent, error); } catch {}
    }
  }

  /** Run all onUnknown hooks. Returns first non-null result. */
  async runOnUnknown(rawText: string): Promise<{ intent: string; fields: Record<string, unknown>; confidence: number } | null> {
    for (const { plugin, enabled } of this.plugins.values()) {
      if (!enabled || !plugin.hooks?.onUnknown) continue;
      try {
        const result = await plugin.hooks.onUnknown(rawText);
        if (result) return result;
      } catch {}
    }
    return null;
  }

  /** List all loaded plugins. */
  list(): LoadedPlugin[] {
    return Array.from(this.plugins.values());
  }

  /** Get a plugin by name. */
  get(name: string): LoadedPlugin | undefined {
    return this.plugins.get(name);
  }

  /** Get count of loaded plugins. */
  get count(): number {
    return this.plugins.size;
  }

  // ── Private ──

  private async loadLocalPlugins(): Promise<void> {
    if (!existsSync(PLUGIN_DIR)) return;

    const entries = readdirSync(PLUGIN_DIR, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = resolve(PLUGIN_DIR, entry.name);

      if (entry.isDirectory()) {
        // Directory plugin — look for index.js or index.mjs
        const indexPath = [
          join(fullPath, "index.js"),
          join(fullPath, "index.mjs"),
          join(fullPath, "index.cjs"),
        ].find((p) => existsSync(p));
        if (indexPath) await this.load(indexPath, "local");
      } else if (entry.name.endsWith(".js") || entry.name.endsWith(".mjs")) {
        await this.load(fullPath, "local");
      }
    }
  }

  private async loadNpmPlugins(): Promise<void> {
    try {
      const result = execSync("npm list -g --depth=0 --json 2>/dev/null", {
        encoding: "utf-8",
        timeout: 10_000,
        stdio: ["pipe", "pipe", "pipe"],
      });
      const parsed = JSON.parse(result);
      const deps = Object.keys(parsed.dependencies ?? {});

      for (const dep of deps) {
        if (dep.startsWith("notoken-plugin-")) {
          await this.load(dep, "npm");
        }
      }
    } catch {}
  }

  private validate(plugin: NotokenPlugin): boolean {
    if (!plugin.name || typeof plugin.name !== "string") {
      console.error("[plugins] Plugin missing name");
      return false;
    }

    if (plugin.name.includes(" ") || plugin.name.includes("/")) {
      console.error(`[plugins] Invalid plugin name: "${plugin.name}" (no spaces or slashes)`);
      return false;
    }

    if (plugin.intents) {
      for (const intent of plugin.intents) {
        if (!intent.name || !intent.command) {
          console.error(`[plugins] Plugin "${plugin.name}" has intent missing name or command`);
          return false;
        }
      }
    }

    return true;
  }
}

/** Singleton plugin registry. */
export const pluginRegistry = new PluginRegistry();
