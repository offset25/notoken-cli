/**
 * Plugin system public API.
 */

export { pluginRegistry } from "./registry.js";
export type {
  NotokenPlugin,
  PluginIntent,
  PluginPlaybook,
  PluginHooks,
  PluginAliases,
  PluginFileHints,
  LoadedPlugin,
} from "./types.js";
