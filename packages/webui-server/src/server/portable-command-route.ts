import type { SessionStore, SlashCommand } from '@wrongstack/contracts/types';
import { buildPortableCommands } from '@wrongstack/runtime/commands';
import type { WebSocket } from 'ws';
import type { CommandRouteContext } from './command-routes.js';
import type { WSServerMessage } from './types.js';

type CommandContext = Parameters<SlashCommand['run']>[1];

/**
 * The command bridge of an engine without a terminal: the portable commands from
 * `@wrongstack/runtime/commands`, reading the engine's current session store and project.
 * Their progress lines are dropped; every command repeats them in its returned message.
 */
export function portableCommandRoute(host: {
  getSessionStore: () => SessionStore | undefined;
  getProjectRoot: () => string;
  getContext: (sessionId?: string) => unknown;
  send: (ws: WebSocket, message: WSServerMessage) => void;
}): CommandRouteContext {
  let commands: SlashCommand[] | undefined;
  const quiet = { write() {}, writeInfo() {}, writeWarning() {} };
  return {
    getCommands: () =>
      (commands ??= buildPortableCommands({
        get sessionStore() {
          return host.getSessionStore();
        },
        get projectRoot() {
          return host.getProjectRoot();
        },
        renderer: quiet,
      })),
    getContext: (sessionId) => host.getContext(sessionId) as CommandContext,
    send: host.send,
  };
}
