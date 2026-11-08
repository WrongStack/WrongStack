/**
 * Plugin management (`/plugin`, `wstack plugin`, the plugin_manager tool):
 * list, official catalog, install, enable/disable, remove, trust, manager locks
 * and per-plugin LLM routing. Moved from the CLI so the WebUI engines run the
 * same command.
 */
export {
  errorResult,
  globalPluginsRoot,
  isRecord,
  pluginName,
  readConfig,
  upsertPlugin,
} from './plugin-management/config.js';
export { runPluginLlmCommand } from './plugin-management/llm-command.js';
export {
  PLUGIN_AUDIT_ENTRIES,
  type PluginAuditEntry,
  renderConfiguredPlugins,
  renderPluginAuditReport,
  runPluginManagementCommand,
} from './plugin-management/management.js';
export { installPluginPackage } from './plugin-management/package-install.js';
export type {
  PackageManagerRunResult,
  PluginManagementDeps,
  PluginManagementResult,
} from './plugin-management/types.js';
