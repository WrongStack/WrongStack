import { expectDefined } from '@wrongstack/core';
import type { Plugin } from '@wrongstack/core';
import { autoDiscoverServers } from './auto-discover.js';
import { PLUGIN_NAME, plugLspConfigSchema, readPlugLSPConfig } from './config.js';
import { DocumentTracker } from './document-tracker.js';
import { LSPRegistry } from './registry.js';
import { registerSlashCommands } from './slash-commands/index.js';
import { makeLSPTools } from './tools/index.js';
export type {
  AutoStartMode,
  DiagnosticsAfterEdit,
  PlugLSPConfig,
  ServerConfig,
} from './types.js';

let teardownState: {
  offs: Array<() => void>;
  toolNames: string[];
  commandNames: string[];
  registry: LSPRegistry;
  tracker: DocumentTracker;
} | null = null;

const plugin: Plugin = {
  name: PLUGIN_NAME,
  version: '0.1.0',
  description: 'Language Server Protocol tools for WrongStack.',
  apiVersion: '^0.1.1',
  capabilities: {
    tools: true,
    slashCommands: true,
    pipelines: [],
  },
  configSchema: plugLspConfigSchema,
  async setup(api) {
    const cfg = readPlugLSPConfig(api);
    const cwd = api.config.cwd ?? process.cwd();
    if (cfg.autoDiscover) {
      cfg.servers = await autoDiscoverServers(cfg.servers, cwd);
    }
    const holder: { registry?: LSPRegistry | undefined } = {};
    const tracker = new DocumentTracker(() => expectDefined(holder.registry), api.log, cwd, api.events);
    const registry = new LSPRegistry(cfg, tracker, { cwd, log: api.log, events: api.events });
    holder.registry = registry;
    await registry.bind(cwd, cfg.autoStart);

    const tools = makeLSPTools({ registry, tracker, cfg, log: api.log });
    for (const tool of tools) api.tools.register(tool);
    const commandNames = registerSlashCommands(api, registry, tracker, cfg, cwd);

    const offs = [
      api.events.on('session.started', () => {
        const nextCwd = api.config.cwd ?? process.cwd();
        tracker.setCwd(nextCwd);
        void registry.bind(nextCwd, cfg.autoStart);
      }),
      api.events.on('session.ended', () => {
        void tracker.forceCloseAll().finally(() => registry.shutdown());
      }),
      api.events.on('tool.executed', (event) => {
        void tracker
          .handleToolExecuted(event)
          .catch((err) => api.log.debug('LSP tracker failed to handle tool event', err));
      }),
    ];

    teardownState = {
      offs,
      toolNames: tools.map((t) => t.name),
      commandNames,
      registry,
      tracker,
    };
  },
  async teardown(api) {
    const state = teardownState;
    if (!state) return;
    teardownState = null;
    for (const off of state.offs) off();
    for (const name of state.toolNames) api.tools.unregister(name);
    for (const name of state.commandNames) api.slashCommands.unregister(`${PLUGIN_NAME}:${name}`);
    await state.tracker.forceCloseAll();
    await state.registry.shutdown();
  },
};

export default plugin;
