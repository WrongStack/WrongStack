import { createRequire } from 'node:module';
import * as path from 'node:path';
import * as fs from 'node:fs/promises';
import { spawn } from 'node:child_process';
import type { CommitLLMProvider } from './slash-commands/commit-llm.js';
import { generateCommitMessageWithLLM } from './slash-commands/commit-llm.js';
import { makeProviderClassifier } from './slash-commands/dispatch-llm.js';
import {
  Agent,
  AutoCompactionMiddleware,
  type Config,
  Container,
  Context,
  DefaultAttachmentStore,
  DefaultConfigStore,
  DefaultErrorHandler,
  DefaultHealthRegistry,
  DefaultLogger,
  DefaultMemoryStore,
  DefaultModeStore,
  DefaultModelsRegistry,
  DefaultPathResolver,
  type DefaultPermissionPolicy,
  DefaultRetryPolicy,
  DefaultSecretScrubber,
  DefaultSessionStore,
  DefaultSkillLoader,
  DefaultSystemPromptBuilder,
  makeAutonomyPromptContributor,
  DefaultTokenCounter,
  type Director,
  EventBus,
  FLEET_ROSTER,
  HybridCompactor,
  type MetricsSink,
  type ProviderRegistry,
  QueueStore,
  RecoveryLock,
  SlashCommandRegistry,
  type SystemPromptBuilder,
  TOKENS,
  ToolRegistry,
  allServers,
  attachTodosCheckpoint,
  color,
  createContextManagerTool,
  EternalAutonomyEngine,
  ParallelEternalEngine,
  createDefaultPipelines,
  createDelegateTool,
  createMcpControlTool,
  loadDirectorState,
  loadPlan,
  loadPlugins,
  loadTodosCheckpoint,
} from '@wrongstack/core';
import { MCPRegistry } from '@wrongstack/mcp';
import { capabilitiesFor, makeProviderFromConfig } from '@wrongstack/providers';
import { createDefaultContainer } from '@wrongstack/runtime';
import { builtinToolsPack, forgetTool, rememberTool } from '@wrongstack/tools';
import { boot } from './boot.js';
import { type ExecutionDeps, execute } from './execution.js';
import type { ReadlineInputReader } from './input-reader.js';
import { MultiAgentHost } from './multi-agent.js';
import { makeConfirmAwaiter, makePromptDelegate } from './permission-prompt.js';
import { runPluginManagementCommand } from './plugin-management.js';
import { runMcpManagementCommand, parseMcpArgs } from './slash-commands/mcp-utils.js';
import { buildPickableProviders } from './provider-helpers.js';
import type { TerminalRenderer } from './renderer.js';
import { SessionStats } from './session-stats.js';
import { buildBuiltinSlashCommands } from './slash-commands/index.js';
import { createAutoPhaseHost } from './autophase-host.js';
import { buildStatuslineCommand, loadStatuslineConfig, saveStatuslineConfig } from './slash-commands/statusline.js';
import { Spinner } from './spinner.js';
import { fmtTaskResultLine, fmtTok, patchConfig } from './utils.js';
import { createAgent, setupCompaction, setupPipelines } from './wiring/pipeline.js';
import { setupMetrics } from './wiring/metrics.js';
import { setupPlugins } from './wiring/plugins.js';
import { setupProvider } from './wiring/provider.js';
import { setupSession } from './wiring/session.js';

function resolveBundledSkillsDir(): string | undefined {
  try {
    const req = createRequire(import.meta.url);
    const corePkg = req.resolve('@wrongstack/core/package.json');
    return path.join(path.dirname(corePkg), 'skills');
  } catch {
    return undefined;
  }
}

import { CLI_VERSION } from './version.js';
export { CLI_VERSION };

type ContainerPromptDelegate = (
  tool: unknown,
  input: unknown,
  suggestedPattern: string,
) => Promise<'yes' | 'no' | 'always' | 'deny'>;

/** Set of listeners for journal-entry events from the eternal engine. */
const eternalListeners = new Set<(entry: import('@wrongstack/core').JournalEntry) => void>();
/** Set of listeners for stage-transition events from the eternal engine. */
const stageListeners = new Set<(stage: {
  phase: 'idle';
} | {
  phase: 'decide';
  reason: string;
} | {
  phase: 'execute';
  task: string;
} | {
  phase: 'reflect';
  status: 'success' | 'failure' | 'aborted' | 'skipped';
  note?: string;
} | {
  phase: 'sleep';
  ms: number;
} | {
  phase: 'paused';
} | {
  phase: 'stopped';
} | {
  phase: 'error';
  message: string;
}) => void>();

type SddParallelRunGlobal = typeof globalThis & {
  __sddParallelRun?: import('@wrongstack/core').SddParallelRun;
};

export async function main(argv: string[]): Promise<number> {
  const ctx = await boot(argv);
  if (typeof ctx === 'number') return ctx;
  let {
    config,
    vault,
    wpaths,
    cwd,
    projectRoot,
    userHome,
    flags,
    positional,
    modelsRegistry,
    renderer,
    reader,
    logger,
    updateInfo,
  } = ctx;

  // Show update notification if outdated.
  // If boot's background check is still running (cache miss), fire a new
  // quick check and wait up to 2s — notification is non-critical.
  if (!updateInfo?.outdated) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 2000);
    try {
      const { checkForUpdate } = await import('./update-check.js');
      updateInfo = await checkForUpdate(ac.signal);
    } catch {
      // best-effort
    } finally {
      clearTimeout(timer);
    }
  }
  if (updateInfo?.outdated) {
    process.stderr.write(
      `\n  \x1b[33m↑ Update available: v${updateInfo.current} → v${updateInfo.latest}\x1b[0m  Run \`wrongstack update\` to upgrade.\n\n`,
    );
  }
  // PathResolver is created from the resolved projectRoot
  const pathResolver = new DefaultPathResolver(cwd);

  // Build container via shared factory
  const container = createDefaultContainer({
    config, wpaths, logger, modelsRegistry,
    permission: {
      yolo: config.yolo,
      forceAllYolo: flags['force-all-yolo'] === true,
      promptDelegate: makePromptDelegate(reader) as unknown as ContainerPromptDelegate,
    },
    compactor: { preserveK: config.context.preserveK, eliseThreshold: config.context.eliseThreshold },
    bundledSkillsDir: config.features.skills ? resolveBundledSkillsDir() : undefined,
  });
  const configStore = container.resolve(TOKENS.ConfigStore);
  container.bind(TOKENS.PathResolver, () => pathResolver);
  container.bind(TOKENS.Renderer, () => renderer);
  container.bind(TOKENS.InputReader, () => reader);

  // Resolve modeId and modelCapabilities before building system prompt.
  const modeStore = container.resolve(TOKENS.ModeStore);
  const activeMode = await modeStore.getActiveMode();
  let resolvedProvider: import('@wrongstack/core').ResolvedProvider | undefined;
  let providerRegistry: ProviderRegistry;
  let provider: ReturnType<ProviderRegistry['create']>;
  try {
    const result = await setupProvider({ config, modelsRegistry, logger });
    resolvedProvider = result.resolvedProvider;
    providerRegistry = result.providerRegistry;
    provider = result.provider;
  } catch (err) {
    process.stderr.write(`${err instanceof Error ? err.message : err}\n`);
    await reader.close();
    return 2;
  }
  const modeId = activeMode?.id ?? 'default';
  const modePrompt = activeMode?.prompt ?? '';
  const resolvedModel = await modelsRegistry.getModel(config.provider, config.model);
  const modelCapabilities = resolvedModel?.capabilities
    ? {
        maxContextTokens: resolvedModel.capabilities.maxContext,
        supportsTools: resolvedModel.capabilities.tools,
        supportsVision: resolvedModel.capabilities.vision,
        supportsReasoning: resolvedModel.capabilities.reasoning,
      }
    : undefined;

  const memoryStore = container.resolve(TOKENS.MemoryStore);
  const skillLoader = container.resolve(TOKENS.SkillLoader);
  const sessionRef: { current?: import('@wrongstack/core').SessionWriter } = {};
  // Forward declaration: the autonomy mode state lives later in this
  // function but the SystemPromptBuilder needs a reference to it NOW so
  // the autonomy contributor can read the current mode at build time.
  // Mutated by `onAutonomy` / `onEternalStart` below — the contributor
  // reads it on every system-prompt build (per turn).
  const autonomyModeRef: {
    current: import('./slash-commands/autonomy.js').AutonomyMode;
  } = { current: 'off' };
  const goalPathForPrompt = wpaths.projectGoal;
  container.bind(TOKENS.SystemPromptBuilder, () =>
    new DefaultSystemPromptBuilder({
      memoryStore,
      skillLoader: config.features.skills ? skillLoader : undefined,
      modeStore,
      modeId,
      modePrompt,
      modelCapabilities,
      planPath: () =>
        sessionRef.current
          ? path.join(wpaths.projectSessions, `${sessionRef.current.id}.plan.json`)
          : undefined,
      contributors: [
        // Injects the ETERNAL AUTONOMY block when the user has activated
        // `/autonomy eternal`. Without this, the per-iteration directive
        // is the only place the model sees the rules — compaction can
        // drop it and the model forgets it's in autonomy mode.
        makeAutonomyPromptContributor({
          goalPath: goalPathForPrompt,
          enabled: () => autonomyModeRef.current === 'eternal',
        }),
      ],
    }),
  );

  // Tool registry
  const toolRegistry = new ToolRegistry();
  toolRegistry.registerAllOrThrow([...(builtinToolsPack.tools ?? [])], builtinToolsPack.name);
  toolRegistry.registerDefault(
    createContextManagerTool({ compactor: container.resolve(TOKENS.Compactor) }),
  );
  if (config.features.memory) {
    toolRegistry.register(rememberTool(memoryStore));
    toolRegistry.register(forgetTool(memoryStore));
  }

  const events = new EventBus();
  events.setLogger(logger);

  // Metrics wiring — extracted to wiring/metrics.ts
  const { metricsSink, healthRegistry, metricsServerHandle } = (() => {
    const ms = setupMetrics({ flags, wpaths, events, logger, config: { provider: config.provider, model: config.model } });
    return ms;
  })();

  // Spinner: visible "thinking…" line during each model request.
  const spinner = new Spinner();
  // Track the latest provider request's input-token count so the spinner
  // can render a live context-window fullness bar (TUI parity).
  let lastInputTokens = 0;
  events.on('provider.response', (e) => {
    lastInputTokens = e.usage?.input ?? 0;
    updateSpinnerContext();
  });
  events.on('iteration.started', () => {
    updateSpinnerContext();
    spinner.start(color.dim(`${config.provider}/${config.model} thinking…`));
  });
  events.on('provider.response', () => {
    spinner.stop();
  });
  events.on('error', () => {
    spinner.stop();
  });

  // Live streaming output: first text_delta stops the spinner and starts
  // writing tokens directly so the user sees the model "type".
  let streamingActive = false;
  events.on('provider.text_delta', (p) => {
    if (!streamingActive) {
      spinner.stop();
      streamingActive = true;
    }
    renderer.write(p.text);
  });
  events.on('iteration.completed', () => {
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
  });

  // Provider hiccups — render a single friendly line instead of leaving the
  // raw JSON body in logger output. retry events show a countdown; error
  // events surface a final failure that won't be retried.
  events.on('provider.retry', (p) => {
    spinner.stop();
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
    const secs = (p.delayMs / 1000).toFixed(p.delayMs >= 1000 ? 1 : 2);
    process.stderr.write(color.yellow(`  ⟳ retry ${p.attempt} in ${secs}s — ${p.description}\n`));
    spinner.start(color.dim(`${config.provider}/${config.model} thinking…`));
  });
  events.on('provider.error', (p) => {
    spinner.stop();
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
    process.stderr.write(color.red(`  ✗ ${p.description}\n`));
  });

  // Provider instance — registry-driven by default, but falls through to
  // Build system prompt
  const promptBuilder = container.resolve(TOKENS.SystemPromptBuilder) as SystemPromptBuilder;
  const systemPrompt = await promptBuilder.build({
    cwd,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
  });

  // Session — extracted to wiring/session
  const sessionStore = container.resolve(TOKENS.SessionStore);
  const tokenCounter = container.resolve(TOKENS.TokenCounter);
  const sessResult = await setupSession({
    config: { model: config.model, provider: config.provider },
    wpaths,
    projectRoot,
    cwd,
    sessionStore,
    systemPrompt,
    provider,
    tokenCounter,
    renderer,
    flags,
    onRecovery: (abandoned, autoRecover) => promptRecovery(reader, renderer, abandoned, autoRecover),
  });
  const session = sessResult.session;
  sessionRef.current = session;
  const restoredMessages = sessResult.restoredMessages;
  const context = sessResult.context;
  const attachments = sessResult.attachments;
  const recoveryLock = sessResult.recoveryLock;
  const queueStore = sessResult.queueStore;
  const planPath = sessResult.planPath;
  const detachTodosCheckpoint = sessResult.detachTodosCheckpoint;
  const priorFleetState = sessResult.priorFleetState;

  const stats = new SessionStats(events, tokenCounter);

  // Last-N error ring buffer surfaced by /diag.
  const errorRing: { ts: string; phase: string; code: string; message: string }[] = [];
  events.on('error', (e) => {
    const err = e.err as unknown;
    const code =
      err && typeof err === 'object' && 'code' in err && typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    const message = e.err instanceof Error ? e.err.message : String(e.err);
    errorRing.push({ ts: new Date().toISOString(), phase: e.phase, code, message });
    if (errorRing.length > 5) errorRing.shift();
  });

  const pipelines = setupPipelines({ events, logger });
  const compactor = container.resolve(TOKENS.Compactor);
  const { effectiveMaxContext, autoCompactor } = await setupCompaction({ compactor, events, modelsRegistry, context, config, provider, pipelines });

  // Refresh AutoCompactionMiddleware denominator when the active model changes.
  const refreshMaxContext = async (providerId: string, modelId: string) => {
    if (!autoCompactor) return;
    const cap = await capabilitiesFor(modelsRegistry, providerId, modelId).catch(() => undefined);
    const mc = (cap as { maxContext?: number } | undefined)?.maxContext ?? config.context.effectiveMaxContext ?? 200_000;
    autoCompactor.setMaxContext(mc);
  };

  // Helper: keep the spinner's context chip in sync
  const updateSpinnerContext = () => {
    if (effectiveMaxContext > 0 && lastInputTokens > 0) {
      spinner.setContext({ used: lastInputTokens, max: effectiveMaxContext });
    } else spinner.setContext(undefined);
  };

  const agent = createAgent({ container, tools: toolRegistry, providers: providerRegistry, events, pipelines, context, config, confirmAwaiter: makeConfirmAwaiter(reader) });

  // MCP servers
  const mcpRegistry = new MCPRegistry({ toolRegistry, events, log: logger });
  if (config.features.mcp) {
    for (const cfg of Object.values(config.mcpServers ?? {})) {
      try {
        await mcpRegistry.start(cfg);
      } catch (err) {
        logger.warn(`MCP server "${cfg.name}" failed to start`, err);
      }
    }
  }

  // Slash registry — created before plugins so plugins can register commands.
  const slashRegistry = new SlashCommandRegistry();

  // Plugins — extracted to wiring/plugins.ts
  await setupPlugins({
    config,
    container,
    events,
    pipelines,
    toolRegistry,
    providerRegistry,
    slashCommandRegistry: slashRegistry,
    mcpRegistry,
    log: logger,
    agent: agent,
    sessionWriter: context.session,
    metricsSink,
    configStore,
  });

  // Build provider+model switch as a single callback. The TUI picker
  // calls this after the user confirms a (provider, model) pair; we
  // construct a fresh Provider instance, swap it onto the live context,
  // and rebuild the frozen config so other consumers see the new ids.
  const switchProviderAndModel = (providerId: string, modelId: string): string | null => {
    try {
      const savedCfg = config.providers?.[providerId];
      const resolvedProviderId = savedCfg?.type ?? providerId;
      const newCfg = savedCfg ?? {
        type: providerId,
        apiKey: config.apiKey,
        baseUrl: config.baseUrl,
      };
      const cfgWithType = { ...newCfg, type: resolvedProviderId };
      const newProvider =
        config.features.modelsRegistry && providerRegistry.has(resolvedProviderId)
          ? providerRegistry.create(cfgWithType)
          : makeProviderFromConfig(resolvedProviderId, cfgWithType);
      context.provider = newProvider;
      context.model = modelId;
      config = patchConfig(config, { provider: providerId, model: modelId });
      // L1-B: propagate the change to the ConfigStore so any subsystem
      // that subscribed via .watch() re-renders. Crucially, /diag now
      // reads the live provider via the store.
      configStore.update({ provider: providerId, model: modelId });
      // Refresh AutoCompactionMiddleware denominator for the new model's
      // maxContext so threshold triggers (warn/soft/hard) use the correct denominator.
      void refreshMaxContext(resolvedProviderId, modelId);
      return null;
    } catch (err) {
      return err instanceof Error ? err.message : String(err);
    }
  };

  // L1-E: lazily-instantiated multi-agent host. Wired into /spawn and
  // /agents slash commands; constructed on first invocation so users
  // who never spawn subagents pay nothing.
  //
  // `--director` upgrades the host to Director mode — same external API,
  // but task lifecycle flows through a `Director` so manifest writing
  // works and the FleetBus is available for observability hooks. Manifest
  // path defaults to `<projectSessions>/<sessionId>/fleet.json`; users can
  // override via `WRONGSTACK_FLEET_MANIFEST` if they want a fixed path.
  const directorMode = flags['director'] === true || typeof flags['resume'] === 'string';
  // Concurrent subagent ceiling. Order: CLI flag → env var → default (4).
  // Caps how many delegated tasks the coordinator dispatches at once;
  // extra tasks queue. Keeps the leader from spawning enough parallel
  // subagents to trip provider rate limits.
  const maxConcurrentFromFlag =
    typeof flags['max-concurrent'] === 'string'
      ? Number.parseInt(flags['max-concurrent'], 10)
      : undefined;
  const maxConcurrentFromEnv =
    typeof process.env['WRONGSTACK_MAX_CONCURRENT'] === 'string'
      ? Number.parseInt(process.env['WRONGSTACK_MAX_CONCURRENT'], 10)
      : undefined;
  const maxConcurrent =
    Number.isFinite(maxConcurrentFromFlag) && (maxConcurrentFromFlag as number) > 0
      ? (maxConcurrentFromFlag as number)
      : Number.isFinite(maxConcurrentFromEnv) && (maxConcurrentFromEnv as number) > 0
        ? (maxConcurrentFromEnv as number)
        : undefined;
  let director: Director | null = null;
  // Autonomy mode: 'off' (default), 'suggest' (show next steps), 'auto' (self-driving)
  // Initial value can be pinned via the launch prompt (or `--autonomy <mode>`),
  // which sets `flags['autonomy']` before we wire up. Keep the ref in sync
  // so the autonomy prompt contributor sees the same value from turn 1.
  let autonomyMode: import('./slash-commands/autonomy.js').AutonomyMode = (() => {
    const v = flags['autonomy'];
    if (v === 'auto' || v === 'suggest' || v === 'eternal' || v === 'eternal-parallel') return v;
    return 'off';
  })();
  autonomyModeRef.current = autonomyMode;
  // Eternal-autonomy engine instance — lazy, created when /autonomy eternal is invoked.
  // Lives at function scope so /autonomy stop and SIGINT handlers can reach it.
  let eternalEngine: import('@wrongstack/core').EternalAutonomyEngine | null = null;
  // Parallel-eternal engine instance — lazy, created when /autonomy parallel is invoked.
  let parallelEngine: import('@wrongstack/core').ParallelEternalEngine | null = null;
  // Listeners installed by the TUI / REPL to receive per-iteration events
  // from the engine. We support a list (not a single callback) so both
  // surfaces can subscribe without overwriting each other — TUI installs
  // one on mount, but the underlying engine is owned at CLI scope.
  const eternalListeners = new Set<(entry: import('@wrongstack/core').JournalEntry) => void>();
  const broadcastEternalIteration = (entry: import('@wrongstack/core').JournalEntry): void => {
    for (const fn of eternalListeners) {
      try {
        fn(entry);
      } catch {
        // listener failures must never break the engine — swallow
      }
    }
  };
  // Convention: director artifacts all live under the same fleet root —
  //   <projectSessions>/<sessionId>/
  //     ├─ fleet.json              (manifest)
  //     ├─ shared/                 (cross-agent scratchpad)
  //     └─ subagents/              (per-subagent JSONL transcripts)
  // The user can override the manifest path with WRONGSTACK_FLEET_MANIFEST
  // but the scratchpad + transcripts always sit relative to the session.
  const fleetRoot = directorMode ? path.join(wpaths.projectSessions, session.id) : undefined;
  const manifestPath = directorMode
    ? typeof process.env['WRONGSTACK_FLEET_MANIFEST'] === 'string'
      ? process.env['WRONGSTACK_FLEET_MANIFEST']
      : path.join(fleetRoot!, 'fleet.json')
    : undefined;
  const sharedScratchpadPath = directorMode ? path.join(fleetRoot!, 'shared') : undefined;
  const subagentSessionsRoot = directorMode ? path.join(fleetRoot!, 'subagents') : undefined;
  // Live director state checkpoint — written incrementally to disk on
  // every spawn/assign/complete event so a crashed director leaves a
  // recoverable snapshot. Distinct from manifestPath (final record).
  const stateCheckpointPath = directorMode
    ? path.join(fleetRoot!, 'director-state.json')
    : undefined;
  // Always derive a fleetRoot for runtime promotion — /director needs
  // a base dir to write manifest + scratchpad + per-subagent JSONLs into.
  const fleetRootForPromotion = path.join(wpaths.projectSessions, session.id);
  const multiAgentHost = new MultiAgentHost(
    {
      container,
      toolRegistry,
      providerRegistry,
      configStore,
      events,
      systemPromptBuilder: promptBuilder,
      session,
      tokenCounter,
      projectRoot,
      cwd,
      secretScrubber: container.resolve(TOKENS.SecretScrubber),
    },
    {
      directorMode,
      manifestPath,
      sharedScratchpadPath,
      sessionsRoot: subagentSessionsRoot,
      directorRunId: session.id,
      fleetRoot: fleetRootForPromotion,
      stateCheckpointPath,
      sessionWriter: session,
      maxConcurrent,
    },
  );
  // ALWAYS register the `delegate` tool, even in non-director mode. It
  // auto-promotes the host to director mode on first call so the LLM
  // never has to know upfront whether multi-agent is "on" — it just
  // calls `delegate({ role, task })` when it judges a subtask warrants
  // a dedicated subagent. The system-prompt builder picks up this tool
  // and surfaces a "Delegation" section teaching the model when to use
  // it; without that block, the tool sits idle.
  toolRegistry.register(
    createDelegateTool({
      host: multiAgentHost,
      roster: FLEET_ROSTER,
      // Wire the per-subagent transcript location so the tool can
      // extract partial output on timeout / budget exhaustion. Without
      // this, a subagent that hit its iteration cap returns an empty
      // result and the host LLM has no idea what work was done.
      sessionsRoot: subagentSessionsRoot,
      directorRunId: session.id,
    }),
  );

  // `mcp_control` — LLM-driven MCP server lifecycle.
  // The model uses this to autonomously enable/disable MCP servers
  // without requiring a slash command or manual intervention.
  toolRegistry.register(
    createMcpControlTool({
      getConfig: () => configStore.get(),
      configPath: wpaths.globalConfig,
      registry: mcpRegistry,
    }),
  );

  if (directorMode) {
    // Eagerly build the director so its 8 LLM-callable orchestration
    // tools (`spawn_subagent`, `assign_task`, `await_tasks`,
    // `ask_subagent`, `roll_up`, `terminate_subagent`, `fleet_status`,
    // `fleet_usage`) get registered into the leader's ToolRegistry
    // *before* the agent starts streaming. Without this the leader has
    // no way to discover the fleet surface and `--director` ends up as
    // a manifest-only flag with no orchestration. Pass `FLEET_ROSTER`
    // so `spawn_subagent` can accept `role: 'bug-hunter'` shortcuts.
    director = await multiAgentHost.ensureDirector();
    if (director) {
      // If we resumed a prior run, inject the checkpoint snapshot so the
      // director's in-memory state mirrors the pre-crash fleet.
      if (priorFleetState) director.setCheckpointState(priorFleetState);
      for (const tool of director.tools(FLEET_ROSTER)) {
        toolRegistry.register(tool);
      }
      renderer.writeInfo(`Director mode enabled. Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`);
      renderer.writeInfo(`  fleet root → ${fleetRoot}`);
      renderer.writeInfo(`  manifest   → ${manifestPath}`);
      renderer.writeInfo(`  scratchpad → ${sharedScratchpadPath}`);
      renderer.writeInfo(`  subagents  → ${subagentSessionsRoot}`);
    } else {
      renderer.writeInfo(`Director mode enabled. Fleet manifest → ${manifestPath}`);
    }
  }

  // Shared controller for the `/fleet stream on|off` toggle. The TUI
  // replaces `setEnabled` with a dispatch-backed setter on mount; before
  // that the no-op setter just keeps `enabled` in sync so callers see a
  // stable view even when invoked from a non-TUI surface.
  const fleetStreamController = {
    enabled: true,
    setEnabled(enabled: boolean) {
      this.enabled = enabled;
    },
  };

  // Statusline config — loaded once and shared with /statusline slash command
  const statuslineConfigDeps = {
    get: () => loadStatuslineConfig(),
    set: (cfg: import('./slash-commands/statusline.js').StatuslineConfig) => saveStatuslineConfig(cfg),
  };

  // Statusline hidden items — derived from the config file, kept in sync with the TUI
  const hiddenItemsFromConfig = await loadStatuslineConfig();
  const hiddenItemsList: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'> = [];
  const ALL_ITEMS = ['todos', 'plan', 'fleet', 'git', 'elapsed', 'context', 'cost'] as const;
  for (const k of ALL_ITEMS) {
    if (!hiddenItemsFromConfig[k]) hiddenItemsList.push(k);
  }
  const statuslineHiddenItems = hiddenItemsList;
  let currentHiddenItems = [...statuslineHiddenItems];
  const setStatuslineHiddenItems = (items: typeof statuslineHiddenItems) => {
    currentHiddenItems = items;
  };

  // Shared controller for the `/agents on|off` toggle. The TUI
  // replaces `setVisible` with a dispatch-backed setter on mount; before
  // that the no-op setter just keeps `visible` in sync so callers see a
  // stable view even when invoked from a non-TUI surface.
  const agentsMonitorController = {
    visible: false,
    setVisible(visible: boolean) {
      this.visible = visible;
    },
  };

  // AutoPhase host — plans phases+todos via a subagent, then drives the
  // PhaseOrchestrator (one subagent per task) in the background. `getConfig`
  // reads the live `config` (it can be patched, e.g. YOLO toggles).
  const autoPhaseHost = createAutoPhaseHost({
    multiAgentHost,
    getConfig: () => config,
    events,
    storeDir: wpaths.projectAutophase,
    log: (line) => renderer.write(`${line}\n`),
  });

  const slashCmds = buildBuiltinSlashCommands({
    registry: slashRegistry,
    toolRegistry,
    paths: wpaths,
    compactor: container.resolve(TOKENS.Compactor),
    sessionStore,
    skillLoader,
    tokenCounter,
    renderer,
    events,
    memoryStore,
    context,
    cwd,
    projectRoot,
    metricsSink,
    healthRegistry,
    planPath,
    modeStore,
    fleetStreamController,
    llmProvider: provider,
    llmModel: config.model,
    statuslineConfig: statuslineConfigDeps,
    statuslineHiddenItems: [...currentHiddenItems],
    setStatuslineHiddenItems,
    agentsMonitorController,
    confirm: async (question, defaultYes = true): Promise<boolean | null> => {
      // Non-TTY / piped stdin → don't block. For destructive or surprising
      // actions (e.g. starting eternal mode against a stale goal) the safe
      // non-interactive default is `false` — auto-confirming destructive
      // operations in scripts is dangerous. `null` signals "no user to ask"
      // only when the caller explicitly needs to distinguish cancel from
      // deny (which /autonomy eternal doesn't).
      if (!process.stdin.isTTY) return false;
      const hint = defaultYes ? '[Y/n/q]' : '[y/N/q]';
      try {
        const raw = await reader.readLine(`  ${color.amber('?')} ${question} ${color.dim(hint)} `);
        const ans = raw.trim().toLowerCase();
        if (ans === 'q' || ans === 'quit' || ans === 'cancel') return null;
        if (ans === '') return defaultYes;
        return ans === 'y' || ans === 'yes';
      } catch {
        return false;
      }
    },
    onSpawn: async (description, spawnOpts) => {
      const { subagentId, taskId } = await multiAgentHost.spawn(description, spawnOpts);
      const tags: string[] = [];
      if (spawnOpts?.provider) tags.push(spawnOpts.provider);
      if (spawnOpts?.model) tags.push(spawnOpts.model);
      if (spawnOpts?.name) tags.push(`"${spawnOpts.name}"`);
      const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';
      return `Spawned subagent ${subagentId}${tag} for task ${taskId}. Use /agents to track progress.`;
    },
    onAgents: (subagentId?: string) => {
      const s = multiAgentHost.status();
      // When given a specific subagent id, return a live monitor view.
      if (subagentId) {
        const live = s.live.find((a) => a.subagentId === subagentId);
        const completed = s.completed.filter((r) => r.subagentId === subagentId);
        const pending = s.pending.filter((p) => p.subagentId === subagentId);
        if (!live && completed.length === 0 && pending.length === 0) {
          return `No subagent found with id "${subagentId}".`;
        }
        const STATUS_ICON: Record<string, string> = {
          running: '●',
          idle: '○',
          stopped: '⊘',
        };
        const lines: string[] = [color.bold(`Agent ${subagentId.slice(0, 8)}`)];
        if (live) {
          lines.push(`  ${STATUS_ICON[live.status] ?? '?'}  status: ${live.status}`);
          if (live.task) lines.push(`  task: ${live.task}`);
        }
        for (const p of pending) {
          lines.push(`  ·  pending: ${p.taskId.slice(0, 8)} → ${p.description.slice(0, 60)}`);
        }
        for (const r of completed) {
          const fmt = fmtTaskResultLine(r, color);
          lines.push(`  ${fmt.mark}  ${r.taskId.slice(0, 8)} ${fmt.stats}${fmt.tail}`);
        }
        // Also surface per-subagent cost from fleet_usage if director is active.
        if (director) {
          const snap = director.snapshot();
          const per = snap.perSubagent?.[subagentId];
          if (per?.cost) lines.push(`  cost: ${per.cost.toFixed(4)}`);
          if (per?.iterations) lines.push(`  iterations: ${per.iterations}`);
          if (per?.toolCalls) lines.push(`  toolCalls: ${per.toolCalls}`);
        }
        return lines.join('\n');
      }
      // No id — return the summary table.
      const lines = [s.summary];
      const STATUS_ICON: Record<string, string> = {
        running: '●',
        idle: '○',
        stopped: '⊘',
      };
      for (const a of s.live) {
        if (a.status === 'running' || a.status === 'idle') {
          const task = a.task ? ` — ${a.task.slice(0, 60)}` : '';
          lines.push(`  ${STATUS_ICON[a.status] ?? '?'}  ${a.subagentId.slice(0, 8)} ${a.status}${task}`);
        }
      }
      for (const p of s.pending) {
        lines.push(`  ·  pending  ${p.taskId.slice(0, 8)} → ${p.description.slice(0, 60)}`);
      }
      for (const r of s.completed) {
        const fmt = fmtTaskResultLine(r, color);
        lines.push(`  ${fmt.mark}  ${r.taskId.slice(0, 8)} ${fmt.stats}${fmt.tail}`);
      }
      return lines.join('\n');
    },
    onFleet: async (action, target) => {
      if (action === 'status') {
        const s = multiAgentHost.status();
        const lines = [color.bold('Fleet status'), `  ${s.summary}`];
        const STATUS_ICON: Record<string, string> = {
          running: '●',
          idle: '○',
          stopped: '⊘',
        };
        const liveActive = s.live.filter((a) => a.status === 'running' || a.status === 'idle');
        if (liveActive.length > 0) {
          lines.push('', color.dim('  Active'));
          for (const a of liveActive) {
            const task = a.task ? ` · ${a.task.slice(0, 50)}` : '';
            lines.push(
              `    ${STATUS_ICON[a.status] ?? '?'} ${a.subagentId.slice(0, 8)} ${a.status}${task}`,
            );
          }
        }
        if (s.pending.length > 0) {
          lines.push('', color.dim('  Pending'));
          for (const p of s.pending) {
            lines.push(
              `    ·  ${p.taskId.slice(0, 8)} → ${p.subagentId.slice(0, 8)} · ${p.description.slice(0, 60)}`,
            );
          }
        }
        if (s.completed.length > 0) {
          lines.push('', color.dim('  Completed'));
          for (const r of s.completed) {
            const fmt = fmtTaskResultLine(r, color);
            lines.push(
              `    ${fmt.mark} ${r.taskId.slice(0, 8)} → ${r.subagentId.slice(0, 8)} · ${fmt.stats}${fmt.tail}`,
            );
          }
        }
        return lines.join('\n');
      }
      if (action === 'usage') {
        const u = multiAgentHost.usage();
        if (u.rows.length === 0) return 'No completed subagent tasks yet.';
        const lines = [
          color.bold('Fleet usage'),
          color.dim('  subagent          tasks  iter  tools     ms  status'),
        ];
        for (const r of u.rows) {
          lines.push(
            `  ${r.subagentId.slice(0, 14).padEnd(14)}  ${String(r.tasks).padStart(5)}  ${String(r.iterations).padStart(4)}  ${String(r.toolCalls).padStart(5)}  ${String(r.durationMs).padStart(5)}  ${r.status}`,
          );
        }
        lines.push(
          color.dim('  ─'.repeat(28)),
          `  ${'TOTAL'.padEnd(14)}  ${String(u.totals.tasks).padStart(5)}  ${String(u.totals.iterations).padStart(4)}  ${String(u.totals.toolCalls).padStart(5)}  ${String(u.totals.durationMs).padStart(5)}`,
        );
        return lines.join('\n');
      }
      if (action === 'kill') {
        if (!target) return 'Usage: /fleet kill <subagent-id>';
        const ok = await multiAgentHost.kill(target);
        return ok
          ? `Sent stop signal to ${target}.`
          : 'No coordinator is running yet — nothing to kill.';
      }
      if (action === 'manifest') {
        if (!multiAgentHost.isDirectorMode()) {
          return 'Manifest is only available when the run was started with --director.';
        }
        const p = await multiAgentHost.manifest();
        if (!p) {
          return 'Director is active but no subagents have been spawned — nothing to record yet.';
        }
        return `Manifest written → ${p}`;
      }
      if (action === 'concurrency') {
        const current = multiAgentHost.getMaxConcurrent();
        if (!target) {
          return `Concurrent-subagent ceiling: ${current}`;
        }
        const n = Number.parseInt(target, 10);
        if (!Number.isFinite(n) || n < 1) {
          return `Invalid value "${target}". Concurrency must be an integer >= 1.`;
        }
        try {
          multiAgentHost.setMaxConcurrent(n);
        } catch (err) {
          return err instanceof Error ? err.message : String(err);
        }
        return `Concurrent-subagent ceiling: ${current} → ${n}`;
      }
      return `Unknown fleet action: ${action}`;
    },
    onFleetStatus: () => {
      if (!director) return null;
      return director.status();
    },
    onFleetUsage: () => {
      if (!director) return null;
      return director.snapshot();
    },
    onFleetKill: () => {
      if (!director) return 0;
      const s = director.status();
      // Kill all running subagents
      let killed = 0;
      for (const sa of s.subagents) {
        if (sa.status === 'running' || sa.status === 'idle') {
          try { director.terminate(sa.id); killed++; } catch { /* best-effort */ }
        }
      }
      return killed;
    },
    onFleetTerminate: (subagentId) => {
      if (!director) return false;
      try { director.terminate(subagentId); return true; } catch { return false; }
    },
    onFleetSpawn: async (role) => {
      if (!director) throw new Error('No director active — start with --director or use /autonomy parallel.');
      const cfg = FLEET_ROSTER[role] ?? {
        id: `manual-${Date.now()}`,
        name: role,
        maxIterations: 50,
        maxToolCalls: 200,
      };
      return director.spawn(cfg);
    },
    onFleetLog: async (subagentId, mode) => {
      // Per-subagent JSONLs live under <fleetRoot>/subagents/<runId>/<subagentId>.jsonl
      // and the runId is namespace-stable (session id by default), so we
      // walk the subagents dir to discover both runs and subagents.
      const subagentsRoot = path.join(fleetRootForPromotion, 'subagents');
      let runDirs: string[];
      try {
        runDirs = await fs.readdir(subagentsRoot);
      } catch {
        return 'No fleet transcripts on disk — no subagents have been spawned for this session.';
      }
      // Collect every transcript across every run-dir for this session.
      const found: Array<{ runId: string; subagentId: string; file: string; size: number }> = [];
      for (const runId of runDirs) {
        const runDir = path.join(subagentsRoot, runId);
        let files: string[];
        try {
          files = await fs.readdir(runDir);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith('.jsonl')) continue;
          const full = path.join(runDir, f);
          try {
            const stat = await fs.stat(full);
            found.push({
              runId,
              subagentId: f.replace(/\.jsonl$/, ''),
              file: full,
              size: stat.size,
            });
          } catch {
            // skip
          }
        }
      }
      if (found.length === 0) {
        return 'No subagent transcripts found on disk.';
      }
      // Listing mode (no id provided).
      if (!subagentId) {
        const lines = [
          `${found.length} subagent transcript${found.length === 1 ? '' : 's'} on disk:`,
        ];
        for (const t of found) {
          lines.push(
            `  ${color.cyan(t.subagentId.padEnd(18))}  ${color.dim(t.runId.slice(0, 18))}  ${color.dim(`${(t.size / 1024).toFixed(1)} KB`)}`,
          );
        }
        lines.push('Use `/fleet log <subagentId>` for a summary, or append `raw` for the full JSONL.');
        return lines.join('\n');
      }
      // Match by exact id or prefix; ambiguous matches return the list.
      const matches = found.filter(
        (t) => t.subagentId === subagentId || t.subagentId.startsWith(subagentId),
      );
      if (matches.length === 0) {
        return `No transcript matched "${subagentId}". Run \`/fleet log\` to list available ids.`;
      }
      if (matches.length > 1) {
        return [
          `Ambiguous id "${subagentId}" — ${matches.length} matches:`,
          ...matches.map((m) => `  ${m.subagentId}  (${m.runId})`),
        ].join('\n');
      }
      const t = matches[0]!;
      const raw = await fs.readFile(t.file, 'utf8');
      if (mode === 'raw') return raw;

      // Summary: walk JSONL events, count types, list the first user/llm
      // pair + the last few iterations. Designed to fit in one terminal
      // screen even for verbose transcripts.
      const lines = raw.split('\n').filter((l) => l.trim());
      const counts: Record<string, number> = {};
      let firstUser: string | null = null;
      let lastResponse: string | null = null;
      let totalIterations = 0;
      const toolNames = new Map<string, number>();
      for (const line of lines) {
        try {
          const ev = JSON.parse(line) as { type: string; content?: unknown; name?: string };
          counts[ev.type] = (counts[ev.type] ?? 0) + 1;
          if (ev.type === 'user_input' && !firstUser) {
            const txt =
              typeof ev.content === 'string'
                ? ev.content
                : Array.isArray(ev.content)
                  ? ev.content
                      .filter((b): b is { type: 'text'; text: string } => (b as { type?: string }).type === 'text')
                      .map((b) => b.text)
                      .join(' ')
                  : '';
            firstUser = txt.slice(0, 120);
          }
          if (ev.type === 'llm_response') {
            if (Array.isArray(ev.content)) {
              const txt = (ev.content as Array<{ type?: string; text?: string }>)
                .filter((b) => b.type === 'text')
                .map((b) => b.text ?? '')
                .join(' ');
              if (txt) lastResponse = txt.slice(0, 240);
            }
            totalIterations += 1;
          }
          if (ev.type === 'tool_use' && typeof ev.name === 'string') {
            toolNames.set(ev.name, (toolNames.get(ev.name) ?? 0) + 1);
          }
        } catch {
          // skip malformed
        }
      }
      const toolBreakdown =
        toolNames.size > 0
          ? Array.from(toolNames.entries())
              .sort((a, b) => b[1] - a[1])
              .map(([n, c]) => `${n}×${c}`)
              .join(', ')
          : '(none)';
      const out: string[] = [
        color.bold(`Subagent ${t.subagentId}`) + color.dim(`  (run ${t.runId})`),
        `  ${lines.length} events  ·  ${totalIterations} llm iterations  ·  ${(t.size / 1024).toFixed(1)} KB`,
        `  tools: ${toolBreakdown}`,
      ];
      if (firstUser) out.push('', color.dim('  task:'), `  ${firstUser}`);
      if (lastResponse) out.push('', color.dim('  last response:'), `  ${lastResponse}`);
      out.push('', color.dim('  event mix:'));
      for (const [type, count] of Object.entries(counts).sort((a, b) => b[1] - a[1])) {
        out.push(`    ${type.padEnd(20)} ${count}`);
      }
      out.push('', color.dim('Use `/fleet log <id> raw` for the full JSONL.'));
      return out.join('\n');
    },
    onFleetRetry: async (taskId) => {
      if (!multiAgentHost.isDirectorMode()) {
        const promoted = await multiAgentHost.promoteToDirector();
        if (!promoted) {
          return 'Cannot retry: a coordinator already exists in non-director mode.';
        }
        for (const tool of promoted.tools(FLEET_ROSTER)) {
          toolRegistry.register(tool);
        }
      }
      const dir = await multiAgentHost.ensureDirector();
      if (!dir) return 'Director is not available.';
      const dirStatePath = path.join(fleetRootForPromotion, 'director-state.json');
      const prior = await loadDirectorState(dirStatePath);
      if (!prior) {
        return 'No prior director-state.json found — nothing to retry.';
      }
      // "Interrupted" = whatever was running/pending when the previous
      // process died. Completed/failed/timeout/stopped tasks are final.
      const interrupted = prior.tasks.filter(
        (t) => t.status === 'running' || t.status === 'pending',
      );
      if (interrupted.length === 0) {
        return 'No interrupted tasks: every prior task reached a terminal state.';
      }

      // List mode — no target given.
      if (!taskId) {
        const lines = [
          `${interrupted.length} interrupted task${interrupted.length === 1 ? '' : 's'} from prior run:`,
        ];
        for (const t of interrupted) {
          const owner = t.subagentId
            ? prior.subagents.find((s) => s.id === t.subagentId)
            : undefined;
          const tag = owner ? `${owner.name ?? owner.id} (${owner.role ?? 'no-role'})` : 'no-owner';
          lines.push(
            `  ${t.taskId.slice(0, 12)}  ${t.status.padEnd(8)} ${tag}  ${(t.description ?? '').slice(0, 60)}`,
          );
        }
        lines.push('Run `/fleet retry <taskId>` or `/fleet retry all` to re-assign.');
        return lines.join('\n');
      }

      const targets =
        taskId === 'all'
          ? interrupted
          : interrupted.filter(
              (t) => t.taskId === taskId || t.taskId.startsWith(taskId),
            );
      if (targets.length === 0) {
        return `No interrupted task matched "${taskId}".`;
      }

      const results: string[] = [];
      for (const t of targets) {
        const owner = t.subagentId
          ? prior.subagents.find((s) => s.id === t.subagentId)
          : undefined;
        if (!owner) {
          results.push(`  - ${t.taskId.slice(0, 12)}: no owner record, skipped.`);
          continue;
        }
        // Re-spawn from the roster when role is set (preferred path —
        // role-based spawns get their full prompt/tool slice). Otherwise
        // synthesize a minimal SubagentConfig from the prior record.
        const rosterCfg = owner.role ? FLEET_ROSTER[owner.role] : undefined;
        const cfg = rosterCfg
          ? { ...rosterCfg }
          : {
              name: owner.name ?? owner.id,
              role: owner.role,
              provider: owner.provider,
              model: owner.model,
            };
        try {
          const newSubId = await dir.spawn(cfg);
          const newTaskId = await dir.assign({
            id: '',
            description: t.description ?? '(no description)',
            subagentId: newSubId,
          });
          results.push(
            `  ${color.green('✓')} ${t.taskId.slice(0, 12)} → re-spawned ${newSubId.slice(0, 12)} (task ${newTaskId.slice(0, 12)})`,
          );
        } catch (err) {
          results.push(
            `  ${color.red('✗')} ${t.taskId.slice(0, 12)} → ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return [`Retried ${targets.length} task${targets.length === 1 ? '' : 's'}:`, ...results].join(
        '\n',
      );
    },
    onDirector: async () => {
      const director = await multiAgentHost.promoteToDirector();
      if (!director) return null;
      // Register the 8 LLM-callable orchestration tools into the leader's
      // ToolRegistry so the agent can discover fleet surface mid-session.
      for (const tool of director.tools(FLEET_ROSTER)) {
        toolRegistry.register(tool);
      }
      const mp = path.join(fleetRootForPromotion, 'fleet.json');
      const sp = path.join(fleetRootForPromotion, 'shared');
      const ss = path.join(fleetRootForPromotion, 'subagents');
      const lines = [
        `${color.green('✓')} Promoted to director mode.`,
        `  Roster: ${Object.keys(FLEET_ROSTER).join(', ')}`,
        `  Manifest → ${mp}`,
        `  Scratchpad → ${sp}`,
        `  Subagents → ${ss}`,
      ];
      return lines.join('\n');
    },
    onPlugin: async (args) => {
      const parsed = args.length === 0 ? [] : args.split(/\s+/).filter(Boolean);
      const result = await runPluginManagementCommand(parsed, {
        config,
        configPath: wpaths.globalConfig,
      });
      if (result.patch) {
        const patch = result.patch as Partial<Config>;
        config = patchConfig(config, patch);
        configStore.update(patch);
      }
      if (result.restartRequired && result.code === 0) {
        return `${result.message}\nRestart WrongStack to load or unload plugin code in this session.`;
      }
      return result.message;
    },
    onMcp: async (args) => {
      const parsed = parseMcpArgs(args);
      if (!parsed) {
        return [
          'Usage: /mcp [list|add <name>|remove <name>|enable <name>|disable <name>|restart <name>]',
          'Run `/mcp` without args to see available servers.',
        ].join('\n');
      }
      return runMcpManagementCommand(parsed, {
        config,
        configPath: wpaths.globalConfig,
        mcpRegistry,
        allServerPresets: allServers(),
      });
    },
    onYolo: (setTo?: boolean) => {
      const policy = container.resolve(TOKENS.PermissionPolicy) as DefaultPermissionPolicy;
      if (setTo !== undefined) {
        policy.setYolo(setTo);
        config = patchConfig(config, { yolo: setTo });
        return setTo;
      }
      return policy.getYolo();
    },
    onAutonomy: (setTo?) => {
      if (setTo !== undefined) {
        autonomyMode = setTo;
        // Mirror into the early ref so the system-prompt contributor
        // (constructed at line ~185) sees the current mode at build time.
        autonomyModeRef.current = setTo;
        return setTo;
      }
      return autonomyMode;
    },
    onEternalStart: (mode?: import('./slash-commands/autonomy.js').AutonomyMode) => {
      // Lazy-instantiate so the engine doesn't exist (and doesn't hold
      // references to the agent) until the user opts in. Re-uses an
      // existing instance if the user stops then restarts within the
      // same session — state lives on disk anyway.
      const effectiveMode = mode ?? 'eternal';
      if (effectiveMode === 'eternal-parallel') {
        if (!parallelEngine) {
          parallelEngine = new ParallelEternalEngine({
            agent,
            projectRoot,
            compactor: container.resolve(TOKENS.Compactor) as import('@wrongstack/core').Compactor,
            maxContextTokens: effectiveMaxContext > 0 ? effectiveMaxContext : undefined,
            onIteration: broadcastEternalIteration,
            // Real per-role factory: each dispatched slot runs as a fresh,
            // isolated agent with the role's filtered tools + persona prompt
            // (instead of sharing the leader agent's Context).
            subagentFactory: multiAgentHost.makeSubagentFactory(config),
          });
        }
        void parallelEngine.prime?.();
      } else {
        if (!eternalEngine) {
          eternalEngine = new EternalAutonomyEngine({
            agent,
            projectRoot,
            compactor: container.resolve(TOKENS.Compactor) as import('@wrongstack/core').Compactor,
            maxContextTokens: effectiveMaxContext > 0 ? effectiveMaxContext : undefined,
            onIteration: broadcastEternalIteration,
          });
        }
        void eternalEngine.prime();
      }
    },
    onEternalStop: () => {
      eternalEngine?.stop();
      parallelEngine?.stop();
    },
    onExit: () => {
      void mcpRegistry.stopAll();
    },
    onBeforeExit: async () => {
      // Check for uncommitted changes directly
      const { spawn } = await import('node:child_process');
      const cwd = projectRoot;

      const statusResult = await new Promise<{ stdout: string; code: number }>((resolve, reject) => {
        const child = spawn('git', ['status', '--porcelain'], { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
        let stdout = '';
        child.stdout?.on('data', (d) => { stdout += d; });
        child.on('error', reject);
        child.on('close', (code) => resolve({ stdout, code: code ?? 0 }));
      });

      if (statusResult.stdout.trim().length > 0) {
        const lines = statusResult.stdout.split('\n').filter(Boolean);
        return {
          abort: true, // signals there are uncommitted changes (used only for the message)
          message: `⚠ ${color.yellow(`${lines.length} uncommitted change${lines.length > 1 ? 's' : ''}`)} — session ended without commit`,
        };
      }
    },
    onClear: () => {
      // In TUI mode Ink owns the live area; writing `\x1b[2J` here would
      // fight Ink's cursor math and leave the status bar smeared. The
      // context/memory reset inside /clear is enough — the user can
      // scroll up to see prior turns in scrollback. In REPL we erase
      // the visible screen + scrollback (`\x1b[3J`) so the next prompt
      // starts on a fresh terminal.
      if (flags.tui && !flags['no-tui']) return;
      try {
        process.stdout.write('\x1b[2J\x1b[3J\x1b[H');
      } catch {
        // stdout may be closed during shutdown — ignore.
      }
    },
    onDiag: () => {
      const u = tokenCounter.total();
      const cost = tokenCounter.estimateCost();
      const errSection =
        errorRing.length === 0
          ? []
          : [
              '',
              `${color.bold('Recent errors')} (last ${errorRing.length}):`,
              ...errorRing.map((e) => `  [${e.ts}] ${e.phase} ${e.code} — ${e.message}`),
            ];
      // Read current provider from the ConfigStore so /diag always shows
      // the live value, even if /model swapped it mid-session (L1-B).
      const liveCfg = configStore.get();
      return [
        `${color.bold('WrongStack diag')}`,
        `  provider:     ${liveCfg.provider} / ${context.model}`,
        `  projectRoot:  ${projectRoot}`,
        `  tokens:       in ${u.input}  out ${u.output}  cacheR ${u.cacheRead ?? 0}`,
        `  cost:         $${cost.total.toFixed(4)}`,
        `  tools:        ${toolRegistry.list().length}`,
        `  mcpServers:   ${mcpRegistry.list().length}`,
        ...errSection,
      ].join('\n');
    },
    onStats: () => stats.format(),
    generateCommitMessage: async (diff: string) => {
      return generateCommitMessageWithLLM(diff, {
        provider: context.provider as CommitLLMProvider,
        model: context.model,
      });
    },
    onDispatchClassify: makeProviderClassifier(
      context.provider as CommitLLMProvider,
      context.model,
    ),
    onSddParallelRun: async (opts) => {
      const { SddParallelRun } = await import('@wrongstack/core');
      const sdd = await import('./slash-commands/sdd.js');
      const tracker = sdd.getTaskTracker();
      const builder = sdd.getActiveBuilder();
      if (!tracker || !builder) {
        return 'No active SDD session with tasks. Use /sdd new to start one.';
      }
      const session = builder.getSession();
      if (session.phase !== 'executing' && session.phase !== 'task_review') {
        return `Cannot run parallel in phase "${session.phase}". Use /sdd approve first.`;
      }
      const graphId = sdd.getTaskGraphId();
      const graphStore = new (await import('@wrongstack/core')).TaskGraphStore({
        baseDir: wpaths.projectTaskGraphs,
      });
      const graph = graphId ? await graphStore.load(graphId) : null;
      if (!graph) {
        return 'No task graph found for the current SDD session.';
      }
      const subagentFactory = multiAgentHost.makeSubagentFactory(config);
      const run = new SddParallelRun({
        tracker,
        graph,
        agent,
        projectRoot,
        parallelSlots: opts?.parallelSlots,
        subagentFactory,
        onProgress: (p: import('@wrongstack/core').SddProgress) => {
          renderer.write(`  ░ wave ${p.wave + 1} · ${p.completed}/${p.total} tasks · ${p.percent}% done\n`);
        },
      });
      (globalThis as SddParallelRunGlobal).__sddParallelRun = run;
      const result = await run.run();
      (globalThis as SddParallelRunGlobal).__sddParallelRun = undefined;
      const lines = [
        `SDD parallel run complete:`,
        `  ${result.totalWaves} waves · ${result.totalCompleted} done · ${result.totalFailed} failed`,
        `  ${(result.totalDurationMs / 1000).toFixed(1)}s total`,
      ];
      if (result.deadlocked) lines.push(color.red('  ⚠ deadlock — tasks blocked by failed tasks.'));
      if (result.stopRequested) lines.push(color.yellow('  ⚡ stopped by user.'));
      return lines.join('\n');
    },
    onSddParallelStop: () => {
      const run = (globalThis as SddParallelRunGlobal).__sddParallelRun;
      run?.stop();
    },
    onAutoPhaseStart: autoPhaseHost.onAutoPhaseStart,
    onAutoPhasePause: autoPhaseHost.onAutoPhasePause,
    onAutoPhaseResume: autoPhaseHost.onAutoPhaseResume,
    onAutoPhaseStop: autoPhaseHost.onAutoPhaseStop,
    getAutoPhaseRunner: autoPhaseHost.getAutoPhaseRunner,
  });
  for (const cmd of slashCmds) slashRegistry.register(cmd);

  // ── --eternal "<mission>" flag: one-shot launch into eternal autonomy. ──
  // Writes the mission as the goal (overwriting any prior goal), forces
  // YOLO on (consistent with /autonomy eternal), instantiates + primes the
  // engine, and flips autonomyMode='eternal' so the REPL's main loop drives
  // the engine instead of reading user input. The user can still /autonomy
  // stop or Ctrl+C to exit the loop normally.
  const eternalFlag = typeof flags['eternal'] === 'string' ? (flags['eternal'] as string).trim() : '';
  if (eternalFlag.length > 0) {
    const { saveGoal, emptyGoal, goalFilePath, loadGoal } = await import('@wrongstack/core');
    const goalPath = goalFilePath(projectRoot);
    const prior = await loadGoal(goalPath);
    // Preserve journal across flag-driven re-launches so the user can run
    // `wstack --eternal "<x>"`, ctrl-c, then `wstack --eternal "<y>"` and
    // still see the prior iteration history under /goal journal.
    const next = prior
      ? { ...prior, goal: eternalFlag, setAt: new Date().toISOString(), lastActivityAt: new Date().toISOString() }
      : emptyGoal(eternalFlag);
    await saveGoal(goalPath, next);
    // Force YOLO on for destructive ops, matching the /autonomy eternal path.
    const policy = container.resolve(TOKENS.PermissionPolicy) as DefaultPermissionPolicy;
    policy.setYolo(true);
    config = patchConfig(config, { yolo: true });
    eternalEngine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      compactor: container.resolve(TOKENS.Compactor) as import('@wrongstack/core').Compactor,
      maxContextTokens: effectiveMaxContext > 0 ? effectiveMaxContext : undefined,
      onIteration: broadcastEternalIteration,
    });
    await eternalEngine.prime();
    autonomyMode = 'eternal';
    autonomyModeRef.current = 'eternal';
    renderer.write(
      color.red('Eternal mode launching from --eternal flag.') +
        color.dim(` Goal: ${eternalFlag.slice(0, 80)}${eternalFlag.length > 80 ? '…' : ''}`) +
        '\n',
    );
  }

  // Dispatch to execution phase — single-shot, TUI, REPL, or WebUI.
  const savedProviderCfg = config.providers?.[config.provider];
  return execute({
    agent,
    events,
    slashRegistry,
    attachments,
    tokenCounter,
    config,
    renderer,
    reader,
    session,
    mcpRegistry,
    recoveryLock,
    wpaths,
    modelsRegistry,
    projectRoot,
    flags,
    positional,
    effectiveMaxContext,
    queueStore,
    context,
    stats,
    detachTodosCheckpoint,
    savedProviderCfg: savedProviderCfg as ExecutionDeps['savedProviderCfg'],
    resolvedProvider: resolvedProvider ?? undefined,
    getPickableProviders: () => buildPickableProviders(modelsRegistry, config),
    switchProviderAndModel,
    director: director ?? null,
    fleetRoster: FLEET_ROSTER as Record<string, { name: string }>,
    fleetStreamController,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    getYolo: () => {
      const policy = container.resolve(TOKENS.PermissionPolicy) as DefaultPermissionPolicy;
      return policy.getYolo();
    },
    getAutonomy: () => autonomyMode,
    onAutonomy: (setTo?) => {
      if (setTo !== undefined) {
        autonomyMode = setTo;
        return setTo;
      }
      return autonomyMode;
    },
    getEternalEngine: () => eternalEngine,
    getParallelEngine: () => parallelEngine,
    subscribeEternalIteration: (fn) => {
      eternalListeners.add(fn);
      return () => eternalListeners.delete(fn);
    },
    subscribeEternalStage: (fn) => {
      stageListeners.add(fn);
      return () => stageListeners.delete(fn);
    },
    skillLoader: config.features.skills ? skillLoader : undefined,
  });
}

/**
 * Prompt the user about an abandoned session. The lockfile lifecycle
 * guarantees we only get here when the previous instance died without
 * writing `session_end` AND there's real work on disk (≥1 message).
 *
 * `--recover` short-circuits to "resume" without asking; piped/non-TTY
 * input degrades to the same — the alternative is hanging on stdin or
 * forcing the user to remember a flag they never typed.
 */
async function promptRecovery(
  reader: ReadlineInputReader,
  renderer: TerminalRenderer,
  abandoned: import('@wrongstack/core').AbandonedSession,
  autoRecover: boolean,
): Promise<'resume' | 'delete' | 'skip'> {
  const minutes = Math.round(abandoned.ageMs / 60_000);
  const ageLabel =
    minutes < 1
      ? `${Math.round(abandoned.ageMs / 1000)}s ago`
      : minutes < 60
        ? `${minutes} min ago`
        : `${Math.round(minutes / 60)}h ago`;
  const summary = `Previous session was killed mid-run: ${abandoned.sessionId} (${abandoned.messageCount} messages, ${ageLabel}).`;
  if (autoRecover) {
    renderer.writeInfo(`${summary} Auto-resuming (--recover).`);
    return 'resume';
  }
  if (!process.stdin.isTTY) {
    renderer.writeInfo(
      `${summary} Non-interactive — leaving as-is. Use \`wstack resume ${abandoned.sessionId}\` or pass \`--recover\` to auto-resume.`,
    );
    return 'skip';
  }
  renderer.writeInfo(summary);
  const answer = await reader.readKey(
    `${color.amber('?')} Recover it? ${color.dim('[')}${color.bold('Y')}es / ${color.bold('n')}o / ${color.bold('d')}elete${color.dim(']')} `,
    [
      { key: 'y', label: 'yes', value: 'resume' },
      { key: 'Y', label: 'yes', value: 'resume' },
      { key: '\r', label: 'yes', value: 'resume' },
      { key: '\n', label: 'yes', value: 'resume' },
      { key: 'n', label: 'no', value: 'skip' },
      { key: 'N', label: 'no', value: 'skip' },
      { key: 'd', label: 'delete', value: 'delete' },
      { key: 'D', label: 'delete', value: 'delete' },
    ],
  );
  return answer as 'resume' | 'delete' | 'skip';
}

const isMain =
  import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` ||
  process.argv[1]?.endsWith('/cli/dist/index.js') ||
  process.argv[1]?.endsWith('\\cli\\dist\\index.js');
if (isMain) {
  main(process.argv.slice(2)).then(
    (c) => {
      // Set exitCode and let Node drain async handles (undici TLS, log file
      // flushes) naturally. Force-exit after a brief grace period so we don't
      // hang if a plugin or MCP server leaks. Avoids libuv UV_HANDLE_CLOSING
      // assertions seen on Windows when process.exit() races with handle teardown.
      process.exitCode = c;
      // 500ms grace: let undici TLS, log flushes, and plugin teardown complete.
      // The unref() prevents this timer from keeping the event loop alive
      // if everything else finishes first.
      setTimeout(() => process.exit(c), 500).unref();
    },
    (err) => {
      process.stderr.write((err instanceof Error ? err.stack : String(err)) + '\n');
      process.exitCode = 1;
      setTimeout(() => process.exit(1), 500).unref();
    },
  );
}
