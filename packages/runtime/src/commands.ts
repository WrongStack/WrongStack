/**
 * Slash commands that run wherever an engine runs, not only in the TUI: the WebUI and desktop
 * engines serve them through `command.list` / `command.run`, and the CLI registers the same
 * builders for its REPL. Each builder declares the host fields it reads.
 */
import type { SlashCommand } from '@wrongstack/contracts/types';
import { buildAcpCommand } from './portable-commands/acp.js';
import { buildDelegateCommand } from './portable-commands/delegate.js';
import { buildEnsembleCommand } from './portable-commands/ensemble.js';
import {
  buildDirectorCommand,
  buildSpawnCommand,
  buildSupervisorCommand,
} from './portable-commands/fleet.js';
import {
  buildCommitCommand,
  buildGitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from './portable-commands/git.js';
import { buildGitIdCommand } from './portable-commands/gitid.js';
import type { PortableCommandHost } from './portable-commands/host.js';
import { buildImageCommand } from './portable-commands/image.js';
import { buildInitCommand } from './portable-commands/init.js';
import { buildPanelCommand } from './portable-commands/panel.js';
import { buildPermissionsCommand } from './portable-commands/permissions.js';
import { buildPluginManagementCommand } from './portable-commands/plugin.js';
import { buildPruneCommand } from './portable-commands/prune.js';
import { buildSandboxCommand } from './portable-commands/sandbox.js';
import { buildScoutStatsCommand } from './portable-commands/scout-stats.js';
import { buildSecurityCommand } from './portable-commands/security.js';
import { buildTreeCommand } from './portable-commands/tree.js';
import { buildTuneupCommand } from './portable-commands/tuneup.js';

export { buildAcpCommand } from './portable-commands/acp.js';
export { formatAcpAgentList } from './portable-commands/acp-agent-list.js';
export {
  type LoadedAcpRegistry,
  loadCachedAcpRegistry,
  refreshAcpRegistry,
} from './portable-commands/acp-registry-cache.js';
export { buildDelegateCommand } from './portable-commands/delegate.js';
export { buildEnsembleCommand } from './portable-commands/ensemble.js';
export {
  askingSessionId,
  buildDirectorCommand,
  buildSpawnCommand,
  buildSupervisorCommand,
  parseSpawnFlags,
} from './portable-commands/fleet.js';
export { type FleetSpawnBackend, fleetSpawnCallbacks } from './portable-commands/fleet-host.js';
export {
  buildCommitCommand,
  buildGitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from './portable-commands/git.js';
export { buildGitIdCommand } from './portable-commands/gitid.js';
export type {
  AcpCommandHost,
  CommandNotices,
  CommandSessionContext,
  FleetCommandHost,
  GitCommandHost,
  GitIdCommandHost,
  InitCommandHost,
  PermissionsCommandHost,
  PluginManagementCommandHost,
  PortableCommandHost,
  SessionCommandHost,
  SpawnCommandOptions,
  TreeCommandHost,
  TuneupCommandHost,
  TuneupHooks,
} from './portable-commands/host.js';
export {
  buildImageCommand,
  IMAGE_COMMAND_ARGS_HINT,
  IMAGE_COMMAND_DESCRIPTION,
  IMAGE_COMMAND_HELP,
  type ImageCommandHost,
  inspectLocalImageFile,
  type LocalImageInspection,
} from './portable-commands/image.js';
export { buildInitCommand } from './portable-commands/init.js';
export {
  buildPanelCommand,
  formatPluginViewNodeText,
  PANEL_COMMAND_ARGS_HINT,
  PANEL_COMMAND_DESCRIPTION,
  PANEL_COMMAND_HELP,
  type PanelCommandHost,
} from './portable-commands/panel.js';
export {
  type ExplainedCall,
  explainCall,
  formatExplainedCall,
  formatPermissionRules,
} from './portable-commands/permission-rules-view.js';
export { buildPermissionsCommand } from './portable-commands/permissions.js';
export {
  buildPluginManagementCommand,
  extractPinnedTrustTarget,
  formatPluginReloadReport,
  PLUGIN_COMMAND_ARGS_HINT,
  PLUGIN_COMMAND_DESCRIPTION,
  PLUGIN_COMMAND_HELP,
} from './portable-commands/plugin.js';
export {
  buildPluginCommands,
  type PluginCommandHost,
} from './portable-commands/plugin-commands.js';
export {
  detectProjectFacts,
  type ProjectFacts,
  renderAgentsTemplate,
} from './portable-commands/project-facts.js';
export { buildPruneCommand } from './portable-commands/prune.js';
export { runGit } from './portable-commands/run-git.js';
export { buildSandboxCommand } from './portable-commands/sandbox.js';
export {
  buildScoutStatsCommand,
  formatVariantUsage,
  SOLO_HEAVY_TOOL_CALLS,
  summarizeVariantUsage,
  type VariantUsage,
} from './portable-commands/scout-stats.js';
export {
  buildSecurityCommand,
  type SecurityBackendCommand,
  type SecurityCommandHost,
} from './portable-commands/security.js';
export { unknownSubcommand } from './portable-commands/subcommands.js';
export {
  buildTreeCommand,
  formatSessionTreeAscii,
  TREE_COMMAND_ARGS_HINT,
  TREE_COMMAND_DESCRIPTION,
  TREE_COMMAND_HELP,
  tokenizeTreeArgs,
} from './portable-commands/tree.js';
export {
  createHostTreeFoldHooks,
  type HostTreeFoldHooksInput,
} from './portable-commands/tree-synthesis.js';
export { buildTuneupCommand } from './portable-commands/tuneup.js';
export type { TuneupUpdateInfo } from './portable-commands/tuneup-types.js';

/** Every portable command, built for one host. */
export function buildPortableCommands(host: PortableCommandHost): SlashCommand[] {
  return [
    buildSandboxCommand(host),
    buildPruneCommand(host),
    buildScoutStatsCommand(host),
    buildInitCommand(host),
    buildGitCommand(host),
    buildCommitCommand(host),
    buildGitcheckCommand(host),
    buildPushCommand(host),
    buildGitIdCommand(host),
    buildSecurityCommand(host),
    buildSpawnCommand(host),
    buildDelegateCommand(host),
    buildDirectorCommand(host),
    buildSupervisorCommand(host),
    buildAcpCommand(host),
    buildEnsembleCommand(host),
    buildTuneupCommand(host),
    buildPermissionsCommand(host),
    buildPluginManagementCommand(host),
    buildPanelCommand(host),
    buildImageCommand(host),
    buildTreeCommand(host),
  ];
}
