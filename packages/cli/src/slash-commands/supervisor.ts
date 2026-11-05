import type { SlashCommand } from '@wrongstack/contracts/types';
import { getActiveFleetSupervisor } from '@wrongstack/fleet';
import { buildSupervisorCommand as buildPortableSupervisorCommand } from '@wrongstack/runtime/commands';
import type { SlashCommandContext } from './command-context.js';

/** /supervisor as the TUI runs it: the portable command over this process's fleet supervisor. */
export function buildSupervisorCommand(opts: SlashCommandContext): SlashCommand {
  return buildPortableSupervisorCommand({
    renderer: opts.renderer,
    getFleetSupervisor: getActiveFleetSupervisor,
  });
}
