import type { SlashCommand } from '@wrongstack/contracts/types';
import { wrongstackBridgeSetup } from '@wrongstack/fleet';
import {
  type AcpCommandHost,
  buildAcpCommand as buildPortableAcpCommand,
} from '@wrongstack/runtime/commands';
import type { SlashCommandContext } from './command-context.js';

/** /acp as the TUI runs it: inline tasks stream into the terminal and reach WrongStack's tools. */
export function buildAcpCommand(opts: SlashCommandContext): SlashCommand {
  const host: AcpCommandHost = Object.assign(Object.create(opts) as SlashCommandContext, {
    acpSessionSetup: wrongstackBridgeSetup,
  });
  return buildPortableAcpCommand(host);
}
