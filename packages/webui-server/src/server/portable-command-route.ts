import type {
  ConfigStore,
  Provider,
  SessionStore,
  SlashCommand,
} from '@wrongstack/contracts/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import {
  buildPluginCommands,
  buildPortableCommands,
  type PluginCommandHost,
  type PortableCommandHost,
} from '@wrongstack/runtime/commands';
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
 * `@wrongstack/runtime/commands` and the builtin plugins' commands, reading the engine's
 * current session store, project, model and config. Progress lines are dropped; every command
 * repeats them in its returned message.
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
  /** The profile paths, the skill library and the vault the plugins' commands read. */
  getPaths?: (() => WstackPaths | undefined) | undefined;
  skillLoader?: PluginCommandHost['skillLoader'];
  vault?: PluginCommandHost['vault'];
  send: (ws: WebSocket, message: WSServerMessage) => void;
}): CommandRouteContext {
  let commands: Promise<SlashCommand[]> | undefined;
  const quiet = { write() {}, writeInfo() {}, writeWarning() {} };
  const leader = () => host.getContext() as LeaderContext | undefined;
  const portable: PortableCommandHost = {
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
  };
  return {
    getCommands: () =>
      (commands ??= buildCommands(portable, {
        skillLoader: host.skillLoader,
        paths: host.getPaths?.(),
        configStore: host.getConfigStore(),
        vault: host.vault,
      })),
    getContext: (sessionId) => host.getContext(sessionId) as CommandContext,
    send: host.send,
  };
}

/** The portable commands, then the plugins' commands whose names are still free. */
async function buildCommands(
  portable: PortableCommandHost,
  plugins: PluginCommandHost,
): Promise<SlashCommand[]> {
  const own = buildPortableCommands(portable);
  const taken = new Set(own.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  const extra = await buildPluginCommands(plugins).catch(() => []);
  return [...own, ...extra.filter((command) => !taken.has(command.name))];
}
