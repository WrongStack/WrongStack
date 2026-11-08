import type { SlashCommand } from '@wrongstack/contracts/types';
import { buildPermissionsCommand as buildPortablePermissionsCommand } from '@wrongstack/runtime/commands';
import type { SlashCommandContext } from './command-context.js';

/** `/permissions` is a portable command; the CLI hosts it with its policy and tools. */
export function buildPermissionsCommand(opts: SlashCommandContext): SlashCommand {
  return buildPortablePermissionsCommand(opts);
}
