import type { SlashCommand } from '@wrongstack/contracts/types';
import { AutoApprovePermissionPolicy, ToolCapabilities } from '@wrongstack/core/security';
import { wrongstackAcpPermissionPolicy, wrongstackBridgeSetup } from '@wrongstack/fleet';
import {
  type AcpCommandHost,
  buildAcpCommand as buildPortableAcpCommand,
} from '@wrongstack/runtime/commands';
import type { SlashCommandContext } from './command-context.js';

export function buildSlashAcpCommandHost(opts: SlashCommandContext): AcpCommandHost {
  const acpPermissionPolicy: AcpCommandHost['acpPermissionPolicy'] = opts.toolRegistry
    ? () => {
        const policy = new AutoApprovePermissionPolicy(Object.values(ToolCapabilities), {
          yoloPlus: () => opts.configStore?.get()?.autonomy?.yoloPlus === true,
        });
        return wrongstackAcpPermissionPolicy({
          evaluate: (tool, input, scope) => policy.evaluate(tool, input, scope),
          getTool: (name) => opts.toolRegistry?.get(name),
          projectRoot: opts.projectRoot,
          allowMcp: process.env['WRONGSTACK_RESTRICTED'] !== '1',
        });
      }
    : undefined;
  return Object.assign(Object.create(opts) as SlashCommandContext, {
    acpSessionSetup: wrongstackBridgeSetup,
    ...(acpPermissionPolicy ? { acpPermissionPolicy } : {}),
  });
}

/** /acp as the TUI runs it: inline tasks stream into the terminal and reach WrongStack's tools. */
export function buildAcpCommand(opts: SlashCommandContext): SlashCommand {
  return buildPortableAcpCommand(buildSlashAcpCommandHost(opts));
}
