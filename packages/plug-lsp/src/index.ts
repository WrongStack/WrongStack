import type { Plugin } from '@wrongstack/core/types';
import { expectDefined } from '@wrongstack/core/utils';
import { autoDiscoverServers } from './auto-discover.js';
import { PLUGIN_NAME, plugLspConfigSchema, readPlugLSPConfig } from './config.js';
import { DocumentTracker } from './document-tracker.js';
import { LSPRegistry } from './registry.js';
import { supportsPullDiagnostics } from './server/capabilities.js';
import { registerSlashCommands } from './slash-commands/index.js';
import { makeLSPTools } from './tools/index.js';
import { resolveInputPath } from './tools/shared.js';
import { pathToUri } from './utils/uri.js';

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
    const tracker = new DocumentTracker(
      () => expectDefined(holder.registry),
      api.log,
      cwd,
      api.events,
    );
    let syncToolAvailability: (available: boolean) => void = () => {};
    const registry = new LSPRegistry(cfg, tracker, {
      cwd,
      log: api.log,
      events: api.events,
      onAvailabilityChange: (available) => syncToolAvailability(available),
    });
    holder.registry = registry;
    await registry.bind(cwd, cfg.autoStart);

    const tools = makeLSPTools({ registry, tracker, cfg, log: api.log });
    let toolsRegistered = false;
    syncToolAvailability = (available) => {
      if (available === toolsRegistered) return;
      toolsRegistered = available;
      if (available) {
        for (const tool of tools) api.tools.register(tool);
      } else {
        for (const tool of tools) api.tools.unregister(tool.name);
      }
    };
    syncToolAvailability(registry.list().length > 0);
    const commandNames = registerSlashCommands(api, registry, tracker, cfg, cwd);

    const unregisterPrompt = api.registerSystemPromptContributor(async () =>
      toolsRegistered
        ? [
            {
              type: 'text',
              text:
                '[LSP code intelligence]\n' +
                'For supported source files, use semantic LSP tools when they are more precise than text search: lsp_definition, lsp_references, lsp_hover, lsp_symbols, lsp_completion, and codebase-lsp-search with preferLsp=true. Use lsp_code_actions to inspect server fixes, lsp_rename for symbol-safe renames, and only execute commands the server advertised. Use confirmed lsp_request only for documented vendor methods with no typed tool. After editing supported code, use lsp_diagnostics as a focused check before declaring verification; tests and typecheck remain the authoritative gates. LSP servers start lazily when path-scoped tools target their language.',
            },
          ]
        : [],
    );

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
          .then(async () => {
            if (
              cfg.diagnosticsAfterEdit !== 'background' ||
              !event.ok ||
              (event.name !== 'edit' && event.name !== 'write')
            ) {
              return;
            }
            const input = event.input as { path?: unknown | undefined } | undefined;
            if (typeof input?.path !== 'string') return;
            const activeCwd = api.config.cwd ?? process.cwd();
            const file = resolveInputPath(input.path, { cwd: activeCwd });
            // findForPath starts the matching server in lazy mode. The tracker
            // has already captured the edited file, so startup reopens it and
            // lets the server publish diagnostics into the shared buffer.
            const server = await registry.findForPath(file);
            if (!server) return;
            const uri = pathToUri(file);
            if (server.capabilities && supportsPullDiagnostics(server.capabilities)) {
              await server.pullDiagnostics(
                uri,
                cfg.diagnosticsWaitMs,
                new AbortController().signal,
              );
            } else {
              await server.waitForDiagnostics(uri, cfg.diagnosticsWaitMs);
            }
          })
          .catch((err) => api.log.debug('LSP tracker failed to handle tool event', err));
      }),
      unregisterPrompt,
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
  async health() {
    const state = teardownState;
    if (!state) return { ok: false, message: 'LSP plugin is not initialized.' };
    const servers = state.registry.list();
    const failed = servers.filter((server) => server.state === 'failed');
    if (failed.length > 0) {
      return {
        ok: false,
        message: `Failed LSP servers: ${failed.map((server) => server.name).join(', ')}`,
      };
    }
    const ready = servers.filter((server) => server.state === 'ready').length;
    const idle = servers.filter((server) => server.state === 'exited').length;
    return {
      ok: true,
      message: `${servers.length} configured; ${ready} ready; ${idle} idle (lazy).`,
    };
  },
};

export default plugin;
