import {
  type PluginManagementDeps,
  type PluginManagementResult,
  runPluginManagementCommand as runSharedPluginManagementCommand,
} from '@wrongstack/runtime/plugin-management';
import { backupCurrent } from './config-history.js';

/**
 * The plugin manager moved to `@wrongstack/runtime/plugin-management`, shared
 * with the WebUI engines. The CLI keeps its config backups (`.last` and
 * timestamped copies) on every write.
 */
export {
  PLUGIN_AUDIT_ENTRIES,
  type PluginAuditEntry,
  renderConfiguredPlugins,
  renderPluginAuditReport,
} from '@wrongstack/runtime/plugin-management';

export function runPluginManagementCommand(
  args: string[],
  deps: PluginManagementDeps,
): Promise<PluginManagementResult> {
  return runSharedPluginManagementCommand(args, {
    backupConfig: (configPath) => backupCurrent(undefined, configPath),
    ...deps,
  });
}
