import type {
  ConfigStore,
  Provider,
  SessionStore,
  SlashCommand,
} from '@wrongstack/contracts/types';
import { buildPortableCommands } from '@wrongstack/runtime/commands';
import type { WebSocket } from 'ws';
import type { CommandRouteContext } from './command-routes.js';
import type { WSServerMessage } from './types.js';

type CommandContext = Parameters<SlashCommand['run']>[1];
interface LeaderContext {
  provider?: Provider | undefined;
  model?: string | undefined;
  session?: { id?: string | undefined } | undefined;
}

/**
 * The command bridge of an engine without a terminal: the portable commands from
 * `@wrongstack/runtime/commands`, reading the engine's current session store, project, model
 * and config. Their progress lines are dropped; every command repeats them in its message.
 */
export function portableCommandRoute(host: {
  getSessionStore: () => SessionStore | undefined;
  getProjectRoot: () => string;
  /** The asking conversation's context; without an id, the engine's own conversation. */
  getContext: (sessionId?: string) => unknown;
  getConfigStore: () => ConfigStore | undefined;
  /** Writes the active profile's config file, as the engine's other settings do. */
  patchProfileConfig?:
    | ((mutate: (config: Record<string, unknown>) => void) => Promise<unknown>)
    | undefined;
  send: (ws: WebSocket, message: WSServerMessage) => void;
}): CommandRouteContext {
  let commands: SlashCommand[] | undefined;
  const quiet = { write() {}, writeInfo() {}, writeWarning() {} };
  const leader = () => host.getContext() as LeaderContext | undefined;
  return {
    getCommands: () =>
      (commands ??= buildPortableCommands({
        get sessionStore() {
          return host.getSessionStore();
        },
        get projectRoot() {
          return host.getProjectRoot();
        },
        get cwd() {
          return host.getProjectRoot();
        },
        get context() {
          return leader();
        },
        get llmProvider() {
          return leader()?.provider;
        },
        get llmModel() {
          return leader()?.model;
        },
        get configStore() {
          return host.getConfigStore();
        },
        patchProfileConfig: host.patchProfileConfig,
        renderer: quiet,
      })),
    getContext: (sessionId) => host.getContext(sessionId) as CommandContext,
    send: host.send,
  };
}
