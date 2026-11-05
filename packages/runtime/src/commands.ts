/**
 * Slash commands that run wherever an engine runs, not only in the TUI: the WebUI and desktop
 * engines serve them through `command.list` / `command.run`, and the CLI registers the same
 * builders for its REPL. Each builder declares the host fields it reads.
 */
import type { SlashCommand } from '@wrongstack/contracts/types';
import {
  buildCommitCommand,
  buildGitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from './portable-commands/git.js';
import { buildGitIdCommand } from './portable-commands/gitid.js';
import type { PortableCommandHost } from './portable-commands/host.js';
import { buildInitCommand } from './portable-commands/init.js';
import { buildPruneCommand } from './portable-commands/prune.js';
import { buildSandboxCommand } from './portable-commands/sandbox.js';
import { buildScoutStatsCommand } from './portable-commands/scout-stats.js';
import { buildSecurityCommand } from './portable-commands/security.js';

export {
  buildCommitCommand,
  buildGitCommand,
  buildGitcheckCommand,
  buildPushCommand,
} from './portable-commands/git.js';
export { buildGitIdCommand } from './portable-commands/gitid.js';
export type {
  CommandNotices,
  GitCommandHost,
  GitIdCommandHost,
  InitCommandHost,
  PortableCommandHost,
  SessionCommandHost,
} from './portable-commands/host.js';
export { buildInitCommand } from './portable-commands/init.js';
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
  ];
}
