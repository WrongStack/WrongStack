import type { SlashCommand } from '@wrongstack/contracts/types';
import { stripAnsi } from '@wrongstack/core/utils';
import { advertisedNativeCommand } from '../acp-leader/acp-leader-commands.js';

export async function acpNativeCommand(
  action: 'commands' | 'command',
  input: string,
  ctx: Parameters<SlashCommand['run']>[1],
): Promise<{ message: string; runText?: string }> {
  if (!ctx?.provider?.listNativeCommands || !ctx.session?.id) {
    return { message: 'Select an ACP session leader in this conversation first.' };
  }
  if ((action === 'commands' && input) || (action === 'command' && !input)) {
    return { message: 'Usage: /acp commands or /acp command <name> [args]' };
  }
  const commands = await ctx.provider.listNativeCommands(ctx.model, ctx.session.id);
  if (action === 'commands') {
    if (commands.length === 0) {
      return {
        message: `ACP agent '${ctx.model}' has not advertised slash commands for this session.`,
      };
    }
    return {
      message: [
        `ACP commands from ${ctx.model}`,
        '',
        ...commands.map((command) => {
          const hint = oneLine(command.inputHint);
          const description = oneLine(command.description);
          return `  /${command.name}${hint ? ` [${hint}]` : ''}${description ? `  — ${description}` : ''}`;
        }),
        '',
        'Run /acp command <name> [args] to send one to this agent.',
      ].join('\n'),
    };
  }
  const runText = input.startsWith('/') ? input : `/${input}`;
  const command = advertisedNativeCommand(runText, commands);
  if (!command) return { message: 'The agent did not advertise that command. See /acp commands.' };
  return { message: `Running /${command.name} on ${ctx.model}.`, runText };
}

function oneLine(text: string | undefined): string {
  return text
    ? stripAnsi(text)
        .replace(/\p{Cc}/gu, ' ')
        .trim()
    : '';
}
