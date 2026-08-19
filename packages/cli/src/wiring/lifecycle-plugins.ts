import * as path from 'node:path';
import { getSharedProjectMailbox, type RemoteMailbox } from '@wrongstack/core/coordination';
import { CouncilOrchestrator, OneShotOrchestrator } from '@wrongstack/core/execution';
import { countShellHooks, HookRegistry, HookRunner, shellHooksEqual } from '@wrongstack/core/hooks';
import { allServers } from '@wrongstack/core/infrastructure';
import { TOKENS } from '@wrongstack/core/kernel';
import { NotifierImpl } from '@wrongstack/core/notifications';
import type { PluginHostHandle } from '@wrongstack/core/plugin';
import {
  type ProviderRegistry,
  SlashCommandRegistry,
  type ToolRegistry,
} from '@wrongstack/core/registry';
import type {
  Config,
  HealthRegistry,
  Logger,
  MetricsRuntimeStatus,
  ModelsRegistry,
  PromptLoader,
  Provider,
  ProviderConfig,
  SecretVault,
  SessionWriter,
  SkillLoader,
} from '@wrongstack/core/types';
import { normalizeTokenSavingTier } from '@wrongstack/core/types';
import {
  CONTEXT_WINDOW_MODE_PINNED_META_KEY,
  resolveContextWindowPolicy,
} from '@wrongstack/core/types';
import type { WstackPaths } from '@wrongstack/core/utils';
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
import { installVibeProtocol } from '../vibe-protocol-wiring.js';
import { installDesignStudio } from './design-studio.js';
import type { HqPublisherRef } from './hq-telemetry.js';
import { registerMcpObservability } from './metrics.js';
import { createAgent, setupCompaction } from './pipeline.js';
import { setupPlugins } from './plugins.js';
import { buildCouncilRegistries, createLiveModelRouter } from './provider-utility-tools.js';
import { createPromptJournalRecorder, createPromptJournalToolCallRecorder } from './prompt-journal-recorder.js';

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
  hqPublisherRef: HqPublisherRef;
  brainMailbox: RemoteMailbox;
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
  // The prompt-journal recorder must run BEFORE the hook middleware: a
  // blocking hook short-circuits the chain, so a recorder registered after it
  // would never consume the raw marker (stale misclassification on the next
  // turn) and an allowed hook's additionalContext would leak into the journal
  // as submitted user input. Recording first journals exactly what the user
  // submitted, and always consumes the marker.
  pipelines.userInput.use(createPromptJournalRecorder());
  pipelines.userInput.use(createUserPromptSubmitMiddleware(hookRunner));

  // The toolCall recorder captures the agent-driven journal categories
  // (clarify_interaction, subagent_delegation, autonomous_next_step) from the
  // tools that produce them. Every executed tool call flows through this
  // pipeline, so a single middleware covers all three emission points.
  pipelines.toolCall?.use(createPromptJournalToolCallRecorder());

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

  // VIBE protocol — synthesize/coder input contract + final-response audit.
  installVibeProtocol(pipelines);

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
      // Window changed (model switch): re-resolve the default policy so it
      // stays scaled to the window (≥1M defaults to Deep, smaller back to
      // Balanced). A policy the user pinned for this session is left alone.
      if (context.meta[CONTEXT_WINDOW_MODE_PINNED_META_KEY] !== true) {
        const policy = resolveContextWindowPolicy(
          config.context,
          undefined,
          effectiveMaxContextRef.current,
        );
        context.meta['contextWindowMode'] = policy.id;
        context.meta['contextWindowPolicy'] = policy;
      }
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
      void mcpRegistry.start(merged).catch((err) => {
        logger.warn(`MCP server "${cfg.name}" failed to start`, err);
      });
    }
  }
  registerMcpObservability(healthRegistry, metricsSink, mcpRegistry);

  // ── Slash registry + mailbox + plugins ───────────────────────────────────
  const slashRegistry = new SlashCommandRegistry();
  const hqPublisherRef: HqPublisherRef = { current: undefined };
  const brainMailbox = getSharedProjectMailbox(
    wpaths.projectDir,
    events,
    () => hqPublisherRef.current,
  );
  const notifier = new NotifierImpl();
  const getLiveConfig = (): Config => configStore.get();
  const fallbackProfileManager = container.resolve(TOKENS.FallbackProfileManager);
  const statusTracker = container.resolve(TOKENS.ProviderModelStatusTracker);
  const buildUtilityProvider = (providerId: string): Provider =>
    buildProviderForIdRuntimeFn({ config: getLiveConfig(), providerRegistry }, providerId);
  const pluginOneShot = new OneShotOrchestrator({
    buildProvider: buildUtilityProvider,
    getConfig: getLiveConfig,
    fallbackProfileManager,
    statusTracker,
    modelRouter: createLiveModelRouter(getLiveConfig),
    logger,
    // Route plugin completions through the same extension chain the agent loop
    // uses. `prompt-firewall` (credential redaction), `llm-cache`,
    // `model-router` and the token budgeter all live on `wrapProviderRunner`,
    // and `api.llm` reached the provider without any of them. Resolved per
    // call so a plugin enabled mid-session joins the chain.
    wrapProviderCall: (request, inner) =>
      agent.extensions.wrapProviderRunner((_ctx, req) => inner(req), {
        exclude: ['fallback-model'],
      })(agent.ctx, request),
  });
  const pluginCouncil = new CouncilOrchestrator({
    caller: pluginOneShot,
    fallbackProfileManager,
    ...buildCouncilRegistries(getLiveConfig().tools?.council),
  });

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
      projectRoot: wpaths.projectRoot,
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
      oneShot: (input) => pluginOneShot.call(input),
      council: (question) => pluginCouncil.ask(question),
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
