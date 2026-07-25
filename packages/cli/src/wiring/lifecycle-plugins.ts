import * as path from 'node:path';
import { allServers } from '@wrongstack/core/infrastructure';
import type { Config, Logger, MetricsRuntimeStatus, ModelsRegistry, PromptLoader, Provider, ProviderConfig, SecretVault, SessionWriter, SkillLoader } from '@wrongstack/core/types';
import type { HqPublisher } from '@wrongstack/core/hq';
import { countShellHooks, HookRegistry, HookRunner, shellHooksEqual } from '@wrongstack/core/hooks';
import { GlobalMailbox } from '@wrongstack/core/coordination';
import type { HealthRegistry } from '@wrongstack/core/types';
import { NotifierImpl } from '@wrongstack/core/notifications';
import { normalizeTokenSavingTier } from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
import type { PluginHostHandle } from '@wrongstack/core/plugin';
import { type ProviderRegistry, SlashCommandRegistry, type ToolRegistry } from '@wrongstack/core/registry';
import { TOKENS } from '@wrongstack/core/kernel';
import {
  createVaultBackedMcpAuthorizationProviderFactory,
  MCPAuthorizationManager,
  MCPRegistry,
  MCPVaultTokenStore,
} from '@wrongstack/mcp';
import type { EventWiring } from '../boot/event-wiring.js';
import type { MaxContextBranch } from '../context-limit.js';
import {
  describeMaxContextChange,
  refreshRuntimeModelCatalog,
  resolveRuntimeMaxContextDetailed,
} from '../context-limit.js';
import {
  createLifecycleHooksExtension,
  createUserPromptSubmitMiddleware,
} from '../hooks-wiring.js';
import { makeConfirmAwaiter } from '../permission-prompt.js';
import { installDesignStudio } from './design-studio.js';
import { registerMcpObservability } from './metrics.js';
import { createAgent, setupCompaction } from './pipeline.js';
import { setupPlugins } from './plugins.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

// biome-ignore lint/suspicious/noExplicitAny: large dependency bag — exact types add no safety here
type AnyRecord = Record<string, any>;

export interface LifecyclePluginsDeps {
  flags: Record<string, string | boolean>;
  config: Config;
  // biome-ignore lint/suspicious/noExplicitAny: DI container shape
  container: any;
  // biome-ignore lint/suspicious/noExplicitAny: pipeline shape
  pipelines: any;
  logger: Logger;
  session: SessionWriter;
  sessionBridge: Parameters<typeof setupCompaction>[0]['sessionBridge'];
  // biome-ignore lint/suspicious/noExplicitAny: event bus
  events: any;
  modelsRegistry: ModelsRegistry;
  // biome-ignore lint/suspicious/noExplicitAny: context shape
  context: any;
  provider: Provider;
  modelCapabilitiesRef: AnyRecord;
  // biome-ignore lint/suspicious/noExplicitAny: reader
  reader: any;
  wpaths: WstackPaths;
  toolRegistry: ToolRegistry;
  providerRegistry: ProviderRegistry;
  // biome-ignore lint/suspicious/noExplicitAny: config store
  configStore: any;
  eventWiring: EventWiring;
  healthRegistry: HealthRegistry | undefined;
  skillLoader: SkillLoader;
  promptLoader: PromptLoader;
  vault: SecretVault;
  // biome-ignore lint/suspicious/noExplicitAny: metrics sink
  metricsSink: any;
  metricsStatus?: MetricsRuntimeStatus | undefined;
  // biome-ignore lint/suspicious/noExplicitAny: renderer
  renderer: any;
  // biome-ignore lint/suspicious/noExplicitAny: import
  buildProviderForIdRuntime: any;
}

export interface LifecyclePluginsResult {
  hookRegistry: HookRegistry;
  hookRunner: HookRunner;
  // biome-ignore lint/suspicious/noExplicitAny: auto-compactor
  autoCompactor: any;
  effectiveMaxContextRef: { current: number };
  applyMaxContext: (
    providerId: string,
    modelId: string,
    mc: number,
    seq?: number,
    branch?: MaxContextBranch,
  ) => void;
  refreshMaxContext: (
    providerId: string,
    modelId: string,
    runtimeProviderConfig?: ProviderConfig,
  ) => Promise<void>;
  // biome-ignore lint/suspicious/noExplicitAny: agent
  agent: any;
  mcpRegistry: MCPRegistry;
  slashRegistry: SlashCommandRegistry;
  hqPublisherRef: { current: HqPublisher | undefined };
  brainMailbox: GlobalMailbox;
  pluginHost: PluginHostHandle | undefined;
}

/**
 * Wire lifecycle hooks, compaction + max-context management, agent creation,
 * MCP servers, slash-registry, project mailbox, and plugins setup.
 *
 * Returns a result bag; the returned closures capture `effectiveMaxContext`
 * and `autoCompactor` internally so the caller can invoke `applyMaxContext`
 * / `refreshMaxContext` without needing those internals.
 */
export async function setupLifecycleAndPlugins(
  deps: LifecyclePluginsDeps,
): Promise<LifecyclePluginsResult> {
  const {
    flags,
    config,
    container,
    pipelines,
    logger,
    session,
    events,
    modelsRegistry,
    context,
    provider,
    modelCapabilitiesRef,
    reader,
    wpaths,
    toolRegistry,
    providerRegistry,
    configStore,
    sessionBridge,
    eventWiring,
    healthRegistry,
    skillLoader,
    promptLoader,
    vault,
    metricsSink,
    metricsStatus,
    buildProviderForIdRuntime: buildProviderForIdRuntimeFn,
  } = deps;

  // ── Lifecycle hooks ──────────────────────────────────────────────────────
  const hooksEnabled = flags['no-hooks'] !== true;
  const hookRegistry = new HookRegistry();
  // `--no-hooks` disables ordinary automation, not trusted enforcement.
  // Explicit `policy: true` hooks remain active and never ask for approval;
  // they only allow/mutate silently or deny with a model-visible reason.
  hookRegistry.loadShellHooks(config.hooks, { policyOnly: !hooksEnabled });
  container.bind(TOKENS.HookRegistry, () => hookRegistry);
  const hookRunner = new HookRunner({
    registry: hookRegistry,
    logger,
    allowNonPolicy: hooksEnabled,
    sessionId: () => session.id,
  });
  // Install the dispatch points even under --no-hooks: ordinary entries are
  // filtered by HookRunner, while policy hooks may be registered later by a
  // plugin and still need a live UserPromptSubmit interception point.
  pipelines.userInput.use(createUserPromptSubmitMiddleware(hookRunner));

  // Hot-reload configured hooks, preserving the --no-hooks policy filter.
  configStore.watch((next: Config, prev: Config) => {
    if (!shellHooksEqual(next.hooks, prev.hooks)) {
      try {
        hookRegistry.replaceShellHooks(next.hooks, { policyOnly: !hooksEnabled });
        logger.info(
          `Hooks reloaded (${countShellHooks(next.hooks)} configured entries across ${
            Object.keys(next.hooks ?? {}).length
          } events)`,
        );
      } catch (err) {
        logger.warn(`Hook hot-reload failed: ${(err as Error).message ?? String(err)}`);
      }
    }
  });

  // Design Studio — per-turn UI-intent detection + kit-menu injection.
  installDesignStudio({ pipelines, context });

  // ── Compaction + max context ─────────────────────────────────────────────
  const compactor = container.resolve(TOKENS.Compactor);
  const compactionSetup = await setupCompaction({
    compactor,
    events,
    modelsRegistry,
    context,
    config,
    provider,
    pipelines,
    fullConfig: config as never,
    sessionBridge,
  });
  const effectiveMaxContextRef = { current: compactionSetup.effectiveMaxContext };
  context.provider.capabilities.maxContext = effectiveMaxContextRef.current;
  modelCapabilitiesRef.current =
    effectiveMaxContextRef.current > 0
      ? {
          maxContextTokens: effectiveMaxContextRef.current,
          supportsTools: !!context.provider.capabilities.tools,
          supportsVision: !!context.provider.capabilities.vision,
          supportsReasoning: !!context.provider.capabilities.reasoning,
        }
      : undefined;
  const { autoCompactor } = compactionSetup;

  let maxContextRefreshSeq = 0;
  const applyMaxContext = (
    providerId: string,
    modelId: string,
    mc: number,
    seq?: number | undefined,
    branch?: MaxContextBranch | undefined,
  ): void => {
    if (seq !== undefined && seq !== maxContextRefreshSeq) return;
    const previous = effectiveMaxContextRef.current;
    effectiveMaxContextRef.current = mc;
    context.provider.capabilities.maxContext = effectiveMaxContextRef.current;
    modelCapabilitiesRef.current =
      effectiveMaxContextRef.current > 0
        ? {
            maxContextTokens: effectiveMaxContextRef.current,
            supportsTools: !!context.provider.capabilities.tools,
            supportsVision: !!context.provider.capabilities.vision,
            supportsReasoning: !!context.provider.capabilities.reasoning,
          }
        : undefined;
    if (effectiveMaxContextRef.current > 0) {
      context.meta['effectiveMaxContext'] = effectiveMaxContextRef.current;
      autoCompactor?.setMaxContext(effectiveMaxContextRef.current);
      autoCompactor?.setEnabled(config.context.autoCompact !== false);
    } else {
      delete context.meta['effectiveMaxContext'];
      autoCompactor?.setEnabled(false);
    }
    events.emit('ctx.max_context', {
      sessionId: context.session.id,
      providerId,
      modelId,
      maxContext: effectiveMaxContextRef.current,
    });
    eventWiring.setEffectiveMaxContext(effectiveMaxContextRef.current);

    // Debug telemetry: trace every mid-session max-context change to the
    // resolution branch that produced it. A *decrease* via a non-catalog branch
    // is the fingerprint of the "context window shrinks mid-session" bug class,
    // so it is escalated to warn; benign/increasing changes stay at debug. The
    // decision lives in the shared, unit-tested describeMaxContextChange helper.
    const telemetry = describeMaxContextChange({
      previous,
      current: effectiveMaxContextRef.current,
      providerId,
      modelId,
      branch,
    });
    if (telemetry) {
      logger[telemetry.level](telemetry.message);
    }
  };

  const refreshMaxContext = async (
    providerId: string,
    modelId: string,
    runtimeProviderConfig?: ProviderConfig | undefined,
  ): Promise<void> => {
    const seq = ++maxContextRefreshSeq;
    const resolveAndApply = async (): Promise<void> => {
      const { maxContext, branch } = await resolveRuntimeMaxContextDetailed({
        modelsRegistry,
        config,
        provider: context.provider,
        runtimeProviderConfig,
        providerId,
        modelId,
      });
      applyMaxContext(providerId, modelId, maxContext, seq, branch);
    };
    await resolveAndApply();
    const refreshed = await refreshRuntimeModelCatalog({
      modelsRegistry,
      logger,
      reason: `${providerId}/${modelId}`,
    });
    if (refreshed) await resolveAndApply();
  };

  // ── Agent ────────────────────────────────────────────────────────────────
  const agent = createAgent({
    container,
    tools: toolRegistry,
    providers: providerRegistry,
    events,
    pipelines,
    context,
    config,
    confirmAwaiter: makeConfirmAwaiter(reader),
    hookRunner,
    fullConfig: config,
    source: 'cli',
  });

  // Same late-registration rule for plugin SessionStart/Stop policy hooks.
  agent.extensions.register(createLifecycleHooksExtension(hookRunner));

  // ── MCP servers ──────────────────────────────────────────────────────────
  const mcpTokenStore = new MCPVaultTokenStore(
    path.join(wpaths.projectDir, 'mcp-auth.json'),
    vault,
  );
  const mcpAuthorizationManager = new MCPAuthorizationManager({ store: mcpTokenStore });
  const mcpRegistry = new MCPRegistry({
    toolRegistry,
    events,
    log: logger,
    lazyMode: normalizeTokenSavingTier(config.features.tokenSavingMode) !== 'off',
    cacheDir: wpaths.cacheDir,
    authorizationProviderFactory: createVaultBackedMcpAuthorizationProviderFactory({
      store: mcpTokenStore,
    }),
    authorizationManager: mcpAuthorizationManager,
  });
  if (config.features.mcp) {
    const presets = allServers();
    for (const cfg of Object.values(config.mcpServers ?? {})) {
      const preset = presets[cfg.name];
      const merged = preset ? { ...preset, ...cfg } : cfg;
      try {
        await mcpRegistry.start(merged);
      } catch (err) {
        logger.warn(`MCP server "${cfg.name}" failed to start`, err);
      }
    }
  }
  registerMcpObservability(healthRegistry, metricsSink, mcpRegistry);

  // ── Slash registry + mailbox + plugins ───────────────────────────────────
  const slashRegistry = new SlashCommandRegistry();
  const hqPublisherRef: { current: HqPublisher | undefined } = { current: undefined };
  const brainMailbox = new GlobalMailbox(wpaths.projectDir, events, () => hqPublisherRef.current);
  const notifier = new NotifierImpl();

  const pluginHost = await setupPlugins({
    config,
    container,
    events,
    pipelines,
    toolRegistry,
    providerRegistry,
    slashCommandRegistry: slashRegistry,
    mcpRegistry,
    log: logger,
    agent,
    sessionWriter: context.session,
    metricsSink,
    metricsStatus,
    modelsRegistry,
    healthRegistry,
    skillLoader: config.features.skills ? skillLoader : undefined,
    promptLoader: config.features.prompts === false ? undefined : promptLoader,
    configStore,
    vault,
    paths: {
      globalRoot: wpaths.globalRoot,
      configDir: wpaths.configDir,
      globalConfig: wpaths.profileConfig(config.activeProfile ?? 'default'),
      globalSkills: wpaths.globalSkills,
      globalPrompts: wpaths.globalPrompts,
      globalMemory: wpaths.globalMemory,
      historyFile: wpaths.historyFile,
      syncConfig: wpaths.syncConfig,
      projectDir: wpaths.projectDir,
      projectGoal: wpaths.projectGoal,
    },
    hookRegistry,
    mailbox: brainMailbox,
    notifier,
    llm: {
      provider,
      model: config.model,
      getProvider: () => context.provider,
      getModel: () => context.model,
      createProvider: (name: string) =>
        buildProviderForIdRuntimeFn({ config: configStore.get(), providerRegistry }, name),
    },
  });

  return {
    hookRegistry,
    hookRunner,
    autoCompactor,
    effectiveMaxContextRef,
    applyMaxContext,
    refreshMaxContext,
    agent,
    mcpRegistry,
    slashRegistry,
    hqPublisherRef,
    brainMailbox,
    pluginHost,
  };
}
