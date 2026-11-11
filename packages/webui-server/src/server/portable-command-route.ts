import type { EventBus } from '@wrongstack/contracts/kernel';
import type {
  ConfigStore,
  Logger,
  Message,
  Provider,
  SessionBranchDescriptor,
  SessionStore,
  SessionWriter,
  SlashCommand,
} from '@wrongstack/contracts/types';
import type { ExtensionRegistryPort } from '@wrongstack/contracts/types/extension-points';
import type { PluginUiRegistry } from '@wrongstack/core/plugin';
import type { SlashCommandRegistry } from '@wrongstack/core/registry';
import type { WstackPaths } from '@wrongstack/core/utils';
import { getActiveFleetSupervisor, wrongstackBridgeSetup } from '@wrongstack/fleet';
import {
  buildPluginCommands,
  buildPortableCommands,
  type FleetCommandHost,
  type PermissionsCommandHost,
  type PluginCommandHost,
  type PortableCommandHost,
  type TuneupHooks,
} from '@wrongstack/runtime/commands';
import { buildReplayPayload } from '@wrongstack/webui-protocol';
import type { WebSocket } from 'ws';
import { type CommandRouteContext, catalogEntry } from './command-routes.js';
import type { WSServerMessage } from './types.js';
import { errMessage } from './ws-utils.js';

type CommandContext = Parameters<SlashCommand['run']>[1];
/** The MCP servers as `/tuneup` sees them. */
interface McpServers {
  describe(): Array<{ name: string; state: string; enabled: boolean; toolCount: number }>;
}
/** The worker-starting part of the fleet commands' host. */
export type FleetCallbacks = Pick<FleetCommandHost, 'onSpawn' | 'onFleetSpawn' | 'onDirector'>;
interface LeaderContext {
  provider?: Provider | undefined;
  model?: string | undefined;
  session?: SessionWriter | { id?: string | undefined } | undefined;
  messages?: Message[] | undefined;
  state?: { replaceMessages(messages: Message[]): void } | undefined;
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
  /** How the engine starts workers (`/spawn`, `/delegate`, `/director`); absent without a fleet. */
  fleet?: (() => FleetCallbacks | undefined) | undefined;
  /** The policy and tools `/permissions` lists, explains and names. */
  getPermissionPolicy?: (() => PermissionsCommandHost['permissionPolicy']) | undefined;
  getToolRegistry?: (() => PermissionsCommandHost['toolRegistry']) | undefined;
  /** `/plugin`: back the profile config up before a write, and apply a change live. */
  backupConfig?: PortableCommandHost['backupConfig'];
  applyConfigPatch?: PortableCommandHost['applyConfigPatch'];
  reloadPlugins?: PortableCommandHost['reloadPlugins'];
  pluginUiRegistry?: PluginUiRegistry | (() => PluginUiRegistry | undefined) | undefined;
  pluginSlashRegistry?: SlashCommandRegistry | (() => SlashCommandRegistry | undefined) | undefined;
  events?: EventBus | (() => EventBus | undefined) | undefined;
  extensionRegistry?: ExtensionRegistryPort | (() => ExtensionRegistryPort | undefined) | undefined;
  onTreeMessagesReplaced?:
    | ((messages: Message[], branch: SessionBranchDescriptor) => void)
    | undefined;
  /** Broadcasts updated `command.catalog` frames whenever `plugin.reloaded` fires. */
  broadcast?: ((message: WSServerMessage) => void) | undefined;
  /** Commands the hosting process runs itself; they replace the engine's of the same name. */
  hostCommands?: (() => readonly SlashCommand[]) | undefined;
  /** The active profile's config file, which `/tuneup fix` writes. */
  getProfileConfigPath?: (() => string | undefined) | undefined;
  /** The MCP servers `/tuneup` weighs. */
  getMcpRegistry?: (() => McpServers | undefined) | undefined;
  /** The hosting process's version check, config doctor and history, where it has them. */
  tuneup?: TuneupHooks | undefined;
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
    get sessionRef() {
      const s = leader()?.session;
      return s && typeof (s as SessionWriter).append === 'function'
        ? { current: s as SessionWriter }
        : undefined;
    },
    get events() {
      return typeof host.events === 'function' ? host.events() : host.events;
    },
    get extensionRegistry() {
      return typeof host.extensionRegistry === 'function'
        ? host.extensionRegistry()
        : host.extensionRegistry;
    },
    onTreeMessagesReplaced: host.onTreeMessagesReplaced,
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
    get onSpawn() {
      return host.fleet?.()?.onSpawn;
    },
    get onFleetSpawn() {
      return host.fleet?.()?.onFleetSpawn;
    },
    get onDirector() {
      return host.fleet?.()?.onDirector;
    },
    getFleetSupervisor: getActiveFleetSupervisor,
    get permissionPolicy() {
      return host.getPermissionPolicy?.();
    },
    get toolRegistry() {
      return host.getToolRegistry?.();
    },
    backupConfig: host.backupConfig,
    applyConfigPatch: host.applyConfigPatch,
    reloadPlugins: host.reloadPlugins,
    pluginUiRegistry: host.pluginUiRegistry,
    get paths() {
      return host.getPaths?.();
    },
    // ACP agents reach WrongStack's tools as in the TUI; with no terminal to stream into, their
    // tasks run in the fleet, where the agents view shows the progress.
    acpSessionSetup: wrongstackBridgeSetup,
    inlineAcpRuns: false,
    ...host.tuneup,
    getProfileConfigPath: host.getProfileConfigPath,
    get skillLoader() {
      return host.skillLoader;
    },
    mcpStatus: () =>
      (host.getMcpRegistry?.()?.describe() ?? []).map((server) => ({
        name: server.name,
        state: server.state,
        enabled: server.enabled,
        toolCount: server.toolCount,
      })),
    renderer: quiet,
  };
  const resolveSlashRegistry = (): SlashCommandRegistry | undefined =>
    typeof host.pluginSlashRegistry === 'function'
      ? host.pluginSlashRegistry()
      : host.pluginSlashRegistry;

  let subscribedBus: EventBus | undefined;
  const getCommands = (): Promise<SlashCommand[]> => {
    ensureReloadSubscription();
    if (!commands) {
      commands = buildCommands(
        portable,
        {
          skillLoader: host.skillLoader,
          paths: host.getPaths?.(),
          configStore: host.getConfigStore(),
          vault: host.vault,
        },
        host.hostCommands?.() ?? [],
        resolveSlashRegistry(),
      );
    }
    return commands;
  };
  const ensureReloadSubscription = (): void => {
    const bus = portable.events;
    if (!bus || bus === subscribedBus) return;
    subscribedBus = bus;
    bus.on('plugin.reloaded', () => {
      commands = undefined;
      if (host.broadcast) {
        void getCommands()
          .then((list) => {
            host.broadcast?.({
              type: 'command.catalog',
              payload: { commands: list.map(catalogEntry) },
            });
          })
          .catch(() => {});
      }
    });
  };
  ensureReloadSubscription();

  return {
    getCommands,
    getContext: (sessionId) => host.getContext(sessionId) as CommandContext,
    send: host.send,
  };
}

/** The host's commands, the portable ones it does not run, then the plugins' still-free names. */
async function buildCommands(
  portable: PortableCommandHost,
  plugins: PluginCommandHost,
  hosted: readonly SlashCommand[],
  pluginSlashRegistry?: SlashCommandRegistry,
): Promise<SlashCommand[]> {
  const replaced = new Set(hosted.map((command) => command.name));
  const own = [
    ...hosted,
    ...buildPortableCommands(portable).filter((command) => !replaced.has(command.name)),
  ];
  const taken = new Set(own.flatMap((command) => [command.name, ...(command.aliases ?? [])]));
  const extra = (await buildPluginCommands(plugins).catch(() => [])).filter(
    (command) => !taken.has(command.name),
  );
  for (const command of extra) {
    taken.add(command.name);
    for (const alias of command.aliases ?? []) taken.add(alias);
  }
  const dynamic = (pluginSlashRegistry?.listWithOwner() ?? [])
    .map(({ cmd, fullName }) => (cmd.name === fullName ? cmd : { ...cmd, name: fullName }))
    .filter((command) => !taken.has(command.name));
  return [...own, ...extra, ...dynamic];
}

/**
 * Broadcast a `session.start` reset payload carrying the newly materialized
 * branch transcript whenever `/tree switch` or `/tree fold` mutates messages.
 */
export function broadcastBranchReplay(opts: {
  sessionId: string;
  messages: Message[];
  sessionStartPayload?:
    | ((opts?: { reset?: boolean; sessionId?: string }) => unknown | Promise<unknown>)
    | undefined;
  broadcast: (msg: WSServerMessage) => void;
  logger: Logger;
  label?: string | undefined;
}): void {
  if (!opts.sessionStartPayload) return;
  const replay = buildReplayPayload({ messages: opts.messages });
  void Promise.resolve(opts.sessionStartPayload({ reset: true, sessionId: opts.sessionId }))
    .then((base) => {
      opts.broadcast({
        type: 'session.start',
        payload: {
          ...(base && typeof base === 'object' ? base : {}),
          ...replay,
          replayMessages: replay.replayMessages ?? [],
        } as never,
      });
    })
    .catch((error: unknown) => {
      opts.logger.warn(
        `${opts.label ?? 'webui'}: branch replay payload failed (session ${opts.sessionId}): ${errMessage(error)}`,
      );
    });
}
