import type { SlashCommand } from '@wrongstack/contracts/types';
import { stripAnsi } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { WSClientMessage, WSServerMessage } from './types.js';
import { errMessage, messageSessionId, withRequestId } from './ws-utils.js';

/**
 * Commands that change or delete something. A client asks before it runs one; `--dry-run`
 * variants still count, so the question names what the command would do.
 */
const DESTRUCTIVE = new Set(['prune', 'push', 'commit', 'init']);
/** The longest message a result carries; the rest is cut with a note. */
const MESSAGE_LIMIT = 64_000;

export interface CommandRouteContext {
  /** The slash commands this engine runs, built once for its host. */
  getCommands: () => readonly SlashCommand[];
  /** The asking conversation's agent context, for commands that read the active project. */
  getContext?: ((sessionId?: string) => Parameters<SlashCommand['run']>[1]) | undefined;
  send: (ws: WebSocket, message: WSServerMessage) => void;
}

/** One command as `command.catalog` lists it. */
export function catalogEntry(command: SlashCommand) {
  return {
    name: command.name,
    aliases: command.aliases ?? [],
    description: command.description,
    category: command.category ?? 'App',
    ...(command.argsHint ? { argsHint: command.argsHint } : {}),
    ...(command.help ? { help: stripAnsi(command.help) } : {}),
    destructive: DESTRUCTIVE.has(command.name),
  };
}

function find(commands: readonly SlashCommand[], name: string) {
  const bare = name.replace(/^\//, '');
  return commands.find(
    (command) => command.name === bare || (command.aliases ?? []).includes(bare),
  );
}

/**
 * `command.list` answers with the engine's commands; `command.run` runs one and answers with
 * its message (terminal colours removed) and any follow-up turn it asks for (`runText`), which
 * the client sends as the conversation's next message. A failing command answers with `error`.
 */
export async function handleCommandRoute(
  ctx: CommandRouteContext,
  ws: WebSocket,
  message: WSClientMessage,
): Promise<boolean> {
  if (message.type === 'command.list') {
    ctx.send(ws, {
      type: 'command.catalog',
      payload: withRequestId(message.payload, {
        commands: ctx.getCommands().map(catalogEntry),
      }),
    });
    return true;
  }
  if (message.type !== 'command.run') return false;
  const payload = (message.payload ?? {}) as Record<string, unknown>;
  const name = typeof payload['name'] === 'string' ? payload['name'] : '';
  const args = typeof payload['args'] === 'string' ? payload['args'].trim() : '';
  const reply = (fields: Record<string, unknown>) =>
    ctx.send(ws, {
      type: 'command.result',
      payload: withRequestId(message.payload, { name, ...fields }),
    });
  const command = find(ctx.getCommands(), name);
  if (!command) {
    reply({ error: `/${name.replace(/^\//, '')} is not a command this engine runs.` });
    return true;
  }
  try {
    const result = await command.run(args, ctx.getContext?.(messageSessionId(message)));
    const text = stripAnsi(result?.message ?? '');
    reply({
      name: command.name,
      message:
        text.length > MESSAGE_LIMIT
          ? `${text.slice(0, MESSAGE_LIMIT)}\n… (${text.length - MESSAGE_LIMIT} more characters)`
          : text,
      ...(result?.runText ? { runText: result.runText } : {}),
    });
  } catch (error) {
    reply({ name: command.name, error: errMessage(error) });
  }
  return true;
}
