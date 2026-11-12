import { type Container, type EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type {
  Config,
  Logger,
  ModelsRegistry,
  SecretVault,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/contracts/types';
import { getSharedProjectMailbox } from '@wrongstack/coordination';
import type { Agent, AgentPipelines } from '@wrongstack/core/agent';
import type { HookRegistry } from '@wrongstack/core/hooks';
import { NotifierImpl } from '@wrongstack/core/notifications';
import type { PluginUiRegistry } from '@wrongstack/core/plugin';
import {
  type ProviderRegistry,
  SlashCommandRegistry,
  type ToolRegistry,
} from '@wrongstack/core/registry';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { MCPRegistry } from '@wrongstack/mcp';
import {
  createPluginLlm,
  type ExternalPluginReloadReport,
  type ManagedPluginHostHandle,
  pluginHostPaths,
  setupPlugins,
} from '@wrongstack/runtime/plugin-host';
import { buildSavedProvider } from './saved-provider.js';
import { PluginExtensionFanout } from './standalone-plugin-extensions.js';

/**
 * Built-ins this host serves through its own wiring instead of the shared
 * loader. Each is skipped with this reason in the log, never silently.
 */
export const STANDALONE_HOST_OWNED_PLUGINS: Readonly<Record<string, string>> = {
  'wstack-chimera':
    'Chimera runs per conversation through the standalone Chimera owner (standalone-chimera.ts)',
  'wstack-auto-review':
    'auto-review runs per conversation through the standalone Chimera owner (standalone-chimera.ts)',
  'wstack-specialist-triggers':
    'it only emits fleet.specialist_needed, which the CLI cascade handler spawns from; this host installs no such handler, so it would detect and do nothing',
};

export interface StandalonePluginsInput {
  config: Config;
  getConfig: () => Config;
  container: Container;
  events: EventBus;
  pipelines: AgentPipelines;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  modelsRegistry: ModelsRegistry;
  mcpRegistry?: MCPRegistry | undefined;
  /** The leader's registry: plugin hooks land beside the user's `config.hooks`. */
  hookRegistry: HookRegistry;
  logger: Logger;
  wpaths: WstackPaths;
  /** The boot conversation's agent; later ones join through `attach`. */
  agent: Agent;
  getSession: () => SessionWriter;
  skillLoader?: SkillLoader | undefined;
  vault?: SecretVault | undefined;
  safeMode: boolean;
  /** Test seam; production uses the shared loader. */
  setup?: typeof setupPlugins | undefined;
}

export interface StandalonePlugins {
  host: ManagedPluginHostHandle | undefined;
  uiRegistry: PluginUiRegistry | undefined;
  reloadExternal:
    | ((
        targetName?: string,
        opts?: { force?: boolean | undefined },
      ) => Promise<ExternalPluginReloadReport>)
    | undefined;
  /** Plugin slash commands land here; like the CLI-hosted WebUI, no route lists them. */
  slashRegistry: SlashCommandRegistry;
  /** Gives a conversation's agent the plugins' agent extensions. */
  attach(agent: Agent): void;
  /** Disposes every plugin (hooks, tools, extensions they registered) and the mailbox. */
  dispose(): Promise<void>;
}

/**
 * The plugin set for the standalone host (the desktop engine), loaded through
 * the same `setupPlugins` as the CLI (cli/src/wiring/lifecycle-plugins.ts):
 * same built-in list, same enablement gates (`features.plugins`, a
 * `config.plugins` entry, then `extensions.<name>.enabled`, then the catalog
 * default — and each plugin's own `enabled` switch), the same external-plugin
 * trust gate, and safe mode keeps third-party plugins off. Before this only
 * Chimera and auto-review ran here, so the default-on injection-shield,
 * secret-scanner and dep-guard never did, and the plugin toggles saved config
 * that changed nothing.
 */
export async function loadStandalonePlugins(
  input: StandalonePluginsInput,
): Promise<StandalonePlugins> {
  const { config, container, events, logger, wpaths, agent } = input;
  const extensions = new PluginExtensionFanout((message, error) =>
    logger.warn(message, { error: String(error) }),
  );
  extensions.attach(agent.extensions);
  const slashRegistry = new SlashCommandRegistry({ onNotice: (message) => logger.warn(message) });
  const configStore = container.safeResolve(TOKENS.ConfigStore);
  const mailbox = getSharedProjectMailbox(wpaths.projectDir, events);
  const fallbackProfileManager = container.safeResolve(TOKENS.FallbackProfileManager);
  const buildProvider = (providerId: string) =>
    buildSavedProvider(input.providerRegistry, input.getConfig(), providerId);
  const session = input.getSession();
  let host: ManagedPluginHostHandle | undefined;
  if (!configStore) {
    logger.warn('[WebUI] Plugins not loaded: the engine container has no ConfigStore');
  } else {
    host = await (input.setup ?? setupPlugins)({
      config,
      container,
      events,
      pipelines: input.pipelines,
      toolRegistry: input.toolRegistry,
      providerRegistry: input.providerRegistry,
      slashCommandRegistry: slashRegistry,
      mcpRegistry: input.mcpRegistry,
      log: logger,
      agent: { extensions },
      // The boot conversation's journal, as the CLI hands its plugins the leader's.
      sessionWriter: session,
      modelsRegistry: input.modelsRegistry,
      skillLoader: config.features.skills && !input.safeMode ? input.skillLoader : undefined,
      promptLoader:
        config.features.prompts === false ? undefined : container.safeResolve(TOKENS.PromptLoader),
      safeMode: input.safeMode,
      configStore,
      vault: input.vault,
      paths: pluginHostPaths(wpaths, config.activeProfile),
      hookRegistry: input.hookRegistry,
      mailbox,
      notifier: new NotifierImpl(),
      llm: fallbackProfileManager
        ? createPluginLlm({
            provider: agent.ctx.provider,
            model: config.model,
            getProvider: () => agent.ctx.provider,
            getModel: () => agent.ctx.model,
            createProvider: buildProvider,
            getConfig: input.getConfig,
            buildProvider,
            fallbackProfileManager,
            statusTracker: container.safeResolve(TOKENS.ProviderModelStatusTracker),
            logger,
            wrapProviderCall: (request, inner) =>
              agent.extensions.wrapProviderRunner((_ctx, req) => inner(req), {
                exclude: ['fallback-model'],
              })(agent.ctx, request),
          })
        : undefined,
      hostOwnedBuiltins: STANDALONE_HOST_OWNED_PLUGINS,
    });
    host?.uiRegistry?.setHandlers({
      onNotify: (owner, message, tone) => {
        if (tone === 'danger' || tone === 'warning') {
          logger.warn(`[plugin:${owner}] ${message}`);
        } else {
          logger.info(`[plugin:${owner}] ${message}`);
        }
      },
    });
    console.log(
      `[WebUI] Plugins loaded: ${host?.loaded.length ?? 0}${
        host?.failed.length ? `, ${host.failed.length} failed` : ''
      }`,
    );
  }
  let disposed: Promise<void> | undefined;
  return {
    host,
    uiRegistry: host?.uiRegistry,
    reloadExternal: host?.reloadExternal,
    slashRegistry,
    attach: (next) => extensions.attach(next.extensions),
    dispose() {
      disposed ??= (async () => {
        try {
          await host?.dispose();
        } finally {
          await mailbox.close();
        }
      })();
      return disposed;
    },
  };
}
