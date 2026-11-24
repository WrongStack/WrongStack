import type { SlashCommand } from '@wrongstack/contracts/types';
import { buildEnsembleCommand as buildPortableEnsembleCommand } from '@wrongstack/runtime/commands';
import { buildSlashAcpCommandHost } from './acp.js';
import type { SlashCommandContext } from './command-context.js';

/** /ensemble as the TUI runs it: reaches WrongStack's MCP bridge and permission policy. */
export function buildEnsembleCommand(opts: SlashCommandContext): SlashCommand {
  return buildPortableEnsembleCommand(buildSlashAcpCommandHost(opts));
}
