import { spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  type AutonomyStage,
  allServers,
  attachDepWatcherBridge,
  type BrainAutoRisk,
  BrainDecisionQueue,
  BrainMonitor,
  type Config,
  color,
  createAutonomyBrain,
  createDelegateTool,
  createMcpControlTool,
  createSessionEventBridge,
  createTieredBrainArbiter,
  DefaultBrainArbiter,
  type Director,
  EternalAutonomyEngine,
  expectDefined,
  type FileAuthorTrackerOptions,
  FLEET_ROSTER,
  GlobalMailbox,
  HookRegistry,
  HookRunner,
  HumanEscalatingBrainArbiter,
  isStdinTTY,
  loadDirectorState,
  mailboxSessionTag,
  ObservableBrainArbiter,
  type PackageAuthorTrackerOptions,
  ParallelEternalEngine,
  recordFileAction,
  resolveSessionLoggingConfig,
  type SessionEventBridge,
  SessionMemoryConsolidator,
  SlashCommandRegistry,
  type SystemPromptBuilder,
  startPackageOutdatedWatcher,
  startTechStackConsumer,
  TOKENS,
  ToolRegistry,
  writeErr,
  writeOut,
} from '@wrongstack/core';
import { MCPRegistry } from '@wrongstack/mcp';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { createAutoPhaseHost } from './autophase-host.js';
import { boot } from './boot.js';
import { registerBuiltinTools } from './boot/tool-registry.js';
import { parseArgs } from './arg-parser.js';
import { launchEternalFromFlag } from './cli-eternal-flag.js';
import { promptRecovery } from './cli-recovery-prompt.js';
import { runPreflight } from './preflight.js';
import { wireContainer } from './boot/container-wiring.js';
import { bindSystemPromptBuilder } from './boot/system-prompt-builder.js';
import { helpCmd, versionCmd } from './subcommands/handlers/version-help.js';
import { resolveRuntimeMaxContext } from './context-limit.js';
import { type ExecutionDeps, execute } from './execution.js';
import { createFallbackModelExtension } from './fallback-model.js';
import { createLifecycleHooksExtension, createUserPromptSubmitMiddleware } from './hooks-wiring.js';
import { MultiAgentHost } from './multi-agent.js';
import { makeConfirmAwaiter } from './permission-prompt.js';
import { runPluginManagementCommand } from './plugin-management.js';
import { buildPickableProviders } from './provider-helpers.js';
import { SessionStats } from './session-stats.js';
import type { CommitLLMProvider } from './slash-commands/commit-llm.js';
import { generateCommitMessageWithLLM } from './slash-commands/commit-llm.js';
import { makeProviderClassifier } from './slash-commands/dispatch-llm.js';
import { buildBuiltinSlashCommands } from './slash-commands/index.js';
import { parseMcpArgs, runMcpManagementCommand } from './slash-commands/mcp-utils.js';
import { loadStatuslineConfig, saveStatuslineConfig } from './slash-commands/statusline.js';
import { getSuggestions, setSuggestions } from './slash-commands/suggestion-store.js';
import { Spinner } from './spinner.js';
import { fmtTaskResultLine, patchConfig } from './utils.js';
import { CLI_VERSION } from './version.js';
import { setupCodebaseIndexing } from './wiring/codebase-index.js';
import { setupMetrics } from './wiring/metrics.js';
import { createAgent, setupCompaction, setupPipelines } from './wiring/pipeline.js';
import { setupPlugins } from './wiring/plugins.js';
import { bindReplayToContainer } from './wiring/replay.js';
import { setupSession } from './wiring/session.js';
import { resolveModeAndCapabilities } from './boot/system-prompt.js';

export { CLI_VERSION };

type SddParallelRunGlobal = typeof globalThis & {
  __sddParallelRun?: import('@wrongstack/core').SddParallelRun | undefined;
};

export async function main(argv: string[]): Promise<number> {
  // PR 2 of Issue #29 extracted the three pre-boot side effects
  // (NODE_ENV defaulting, update-notice quick-check, debug-stream
  // seed) into `preflight.ts`. The order is documented there; the
  // orchestrator runs `applyNodeEnvDefault()` synchronously
  // *before* the lazy `--tui` import evaluates ink/react (see the
  // preflight module docstring for the long rationale). We *don't*
  // call `runPreflight` here at the top of main() because the
  // `--help` / `--version` short-circuit below needs to fire
  // without paying for the 2-second update-notice network call.
  if (process.env['NODE_ENV'] === undefined) {
    process.env['NODE_ENV'] = 'production';
    process.env['WRONGSTACK_NODE_ENV_DEFAULTED'] = '1';
  }

  // --help / --version short-circuit (PR 1 of Issue #29):
  //
  // The baseline boot-shape integration test (PR 0, merged as #36) showed
  // that `wstack --help` previously returned exit 2 with a
  // "No provider or model configured" notice on stderr — the help
  // subcommand was *registered*, but `boot()` only reached it after
  // `bootConfig()` had read/written the global config and warned
  // about the missing provider, so the user-visible exit code wasn't
  // 0. For a one-line flag like `--help` that should print text and
  // exit, the bare flag should bypass config I/O entirely.
  //
  // We re-parse argv here with the same `parseArgs` shape `boot()`
  // uses (so the flag-name matrix stays in lockstep) and dispatch to
  // the existing `helpCmd` / `versionCmd` handlers directly. The
  // handler closure is set up in `boot()`'s `subcommands` map; we
  // import it here so we don't have to duplicate the help/version
  // strings. The renderer is a stub because the help text is plain
  // `write` calls — we don't need a TTY-aware renderer for `--help`
  // to `wstack --help` on stdout.
  const earlyFlags = parseArgs(argv).flags;
  if (earlyFlags['help'] === true || earlyFlags['version'] === true) {
    const stubRenderer = {
      write: (line: string) => { process.stdout.write(line); },
    } as unknown as Parameters<typeof helpCmd>[1]['renderer'];
    const handler = earlyFlags['help'] === true ? helpCmd : versionCmd;
    return await handler([], { renderer: stubRenderer } as Parameters<typeof helpCmd>[1]);
  }

  const ctx = await boot(argv);
  // `wrongstack quick` sets flags.quick = true in boot() and removes 'quick' from
  // positional, so boot() returns BootContext (not a number). Proceed to execute().
  if (typeof ctx === 'number') return ctx;
  // At this point TypeScript knows ctx is BootContext. Proceed with execute().
  let {
    config,
    vault,
    wpaths,
    cwd,
    projectRoot,
    flags,
    positional,
    modelsRegistry,
    renderer,
    reader,
    logger,
    updateInfo,
    needsSetup,
  } = ctx;

  // PR 2 of Issue #29: pre-boot side effects (update-notice
  // quick-check, debug-stream seed) are now in `runPreflight()`. The
  // NODE_ENV defaulting stayed at the top of main() because it has
  // to fire *before* the lazy `--tui` import and also before the
  // --help / --version short-circuit (the TUI-less paths still
  // hit it on a cold start). Everything else runs after `boot()`
  // returns the BootContext and the early-return short-circuit has
  // been ruled out.
  const { updateInfo: refreshedUpdateInfo } = await runPreflight(config, updateInfo);
  updateInfo = refreshedUpdateInfo;

  // PR 3 of Issue #29: PathResolver + EventBus + container
  // setup is now in `wireContainer()`. The function returns
  // the PathResolver, the new EventBus, and the container;
  // main() resolves the bootstrap-level services out of the
  // container below. Replay wiring (next block) still lives
  // here because it gates on CLI flags and isn't a
  // container-binding step.
  const { events, container } = wireContainer({
    config,
    wpaths,
    cwd,
    logger,
    reader,
    renderer,
    modelsRegistry,
    yoloDestructive:
      flags['yolo-destructive'] === true || flags['force-all-yolo'] === true,
    confirmDestructive: flags['confirm-destructive'] === true,
  });

  // Replay wiring (idea #2). When `--replay <sessionId>` is set, every
  // provider call is served from the recorded log; `--record` writes
  // a fresh log; `--replay=auto <sessionId>` does both. The
  // ReplayProviderRunner is bound under TOKENS.ProviderRunner so the
  // agent picks it up transparently.
  const replayFlag = flags['replay'];
  const recordFlag = flags['record'];
  if (typeof replayFlag === 'string' || recordFlag === true) {
    const sessionId = typeof replayFlag === 'string' ? replayFlag : `record-${Date.now()}`;
    const mode = recordFlag === true ? 'record' : 'replay';
    bindReplayToContainer({
      container,
      wpaths,
      sessionId,
      mode,
      logger,
    });
    logger.info(`replay: ProviderRunner bound in '${mode}' mode for session ${sessionId}`);
  }

  const configStore = container.resolve(TOKENS.ConfigStore);

  // PR 4 of Issue #29: mode + provider + modelCapabilities
  // resolution is now in `resolveModeAndCapabilities()`. The
  // helper returns a discriminated union; on `kind: 'exit'`
  // we teardown the reader and return the exit code (the
  // pre-refactor inline writeErr + reader.close + return 2
  // shape, now in one place).
  const modeStore = container.resolve(TOKENS.ModeStore);
  const activeMode = await modeStore.getActiveMode();
  const modeResult = await resolveModeAndCapabilities({
    config,
    modelsRegistry,
    logger,
    activeMode,
  });
  if (modeResult.kind === 'exit') {
    writeErr(`${modeResult.message}\n`);
    await reader.close();
    return modeResult.code;
  }
  const {
    resolvedProvider,
    providerRegistry,
    provider,
    modeId,
    modePrompt,
    modelCapabilities,
  } = modeResult;

  const memoryStore = container.resolve(TOKENS.MemoryStore);
  const skillLoader = container.resolve(TOKENS.SkillLoader);
  const sessionRef: { current: import('@wrongstack/core').SessionWriter | undefined } = { current: undefined };
  // Forward declaration: the autonomy mode state lives later in this
  // function but the SystemPromptBuilder needs a reference to it NOW so
  // the autonomy contributor can read the current mode at build time.
  // Mutated by `onAutonomy` / `onEternalStart` below — the contributor
  // reads it on every system-prompt build (per turn).
  const autonomyModeRef: {
    current: import('./slash-commands/autonomy.js').AutonomyMode;
  } = { current: 'off' };
  // PR 5 of Issue #29: SystemPromptBuilder binding is now
  // a single helper call. The helper takes the same forward
  // declarations and reads them lazily through the same
  // closure shape — no behavior change.
  bindSystemPromptBuilder({
    container,
    modeStore,
    memoryStore,
    skillLoader,
    sessionRef,
    autonomyModeRef,
    modeId,
    modePrompt,
    modelCapabilities,
    skillsEnabled: config.features.skills,
    paths: {
      projectGoal: wpaths.projectGoal,
      projectSessions: wpaths.projectSessions,
    },
    pathJoiner: { join: (a, b) => path.join(a, b) },
    systemPromptBuilderToken: TOKENS.SystemPromptBuilder,
  });

  // Tool registry — PR 6 of Issue #29. The 18-line
  // registration block (context manager + memory tools +
  // mailbox tools) is now a single helper call. The helper
  // takes the pre-constructed ToolRegistry, the feature
  // flags, the memory store, the events bus, and the
  // project dir; it does not touch the container.
  const toolRegistry = new ToolRegistry();
  registerBuiltinTools({
    toolRegistry,
    compactor: container.resolve(TOKENS.Compactor),
    config,
    memoryStore,
    events,
    wpaths,
  });

  // Metrics wiring — extracted to wiring/metrics.ts
  const { metricsSink, healthRegistry } = (() => {
    const ms = setupMetrics({
      flags,
      wpaths,
      events,
      logger,
      config: { provider: config.provider, model: config.model },
    });
    return ms;
  })();

  // True when the Ink TUI owns the screen. The TUI renders its own status,
  // streaming, and delegate lines, so the REPL-presentation handlers below
  // (spinner + inline streaming + retry/error lines) must stand down to avoid
  // fighting Ink's cursor math.
  const tuiOwnsScreen = flags.tui === true && flags['no-tui'] !== true;

  // Spinner: visible "thinking…" line during each model request. Disabled
  // under the TUI — it writes to stderr on an 80ms timer, which the Ink
  // renderer can't account for, leaking the input row into scrollback and
  // painting a stray bottom-of-screen tracker.
  const spinner = new Spinner(process.stderr, { enabled: !tuiOwnsScreen });
  // Track the latest provider request's input-token count so the spinner
  // can render a live context-window fullness bar (TUI parity).
  let lastInputTokens = 0;

  // Collect unsubscriber handles so we can detach on process exit. In the
  // default single-shot flow the process exits right after agent.run(), but
  // REPL/TUI modes keep the EventBus alive across multiple runs — stale
  // handlers from a re-entrant main() would otherwise accumulate.
  const teardownHandlers: Array<() => void> = [];
  // Variadic helper: EventBus is dynamically typed per-event, but evOn needs to
  // register many events with different payload shapes. (...args: any) keeps the
  // handler body type-safe while Biome only flags the parameter declaration line.
  const evOn = (
    event: string,
    handler: (
      // biome-ignore lint/suspicious/noExplicitAny: dynamic event dispatch — callers use typed payloads
      ...args: any
    ) => void,
  ) => {
    (events.on as (e: string, h: (...args: any) => void) => void)(event, handler);
    teardownHandlers.push(() =>
      (events.off as (e: string, h: (...args: any) => void) => void)(event, handler),
    );
  };

  evOn('provider.response', (e) => {
    lastInputTokens = e.usage?.input ?? 0;
    updateSpinnerContext();
  });
  evOn('iteration.started', () => {
    updateSpinnerContext();
    spinner.start(color.dim(`${config.provider}/${config.model} thinking…`));
  });
  evOn('provider.response', () => {
    spinner.stop();
  });
  evOn('error', () => {
    spinner.stop();
  });

  // Live streaming output: first text_delta stops the spinner and starts
  // writing tokens directly so the user sees the model "type".
  let streamingActive = false;
  evOn('provider.text_delta', (p) => {
    if (!streamingActive) {
      spinner.stop();
      streamingActive = true;
    }
    renderer.write(p.text);
  });
  evOn('iteration.completed', () => {
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
  });

  // Provider hiccups — render a single friendly line instead of leaving the
  // raw JSON body in logger output. retry events show a countdown; error
  // events surface a final failure that won't be retried.
  evOn('provider.retry', (p) => {
    spinner.stop();
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
    const secs = (p.delayMs / 1000).toFixed(p.delayMs >= 1000 ? 1 : 2);
    writeErr(color.yellow(`  ⟳ retry ${p.attempt} in ${secs}s — ${p.description}\n`));
    spinner.start(color.dim(`${config.provider}/${config.model} thinking…`));
  });
  evOn('provider.error', (p) => {
    spinner.stop();
    if (streamingActive) {
      renderer.write('\n');
      streamingActive = false;
    }
    writeErr(color.red(`  ✗ ${p.description}\n`));
  });

  // Provider instance — registry-driven by default, but falls through to
  // Build system prompt
  const promptBuilder = container.resolve(TOKENS.SystemPromptBuilder) as SystemPromptBuilder;

  // Fetch online agents from the shared mailbox to include in system prompt
  let onlineAgents: Awaited<ReturnType<GlobalMailbox['getAgentStatuses']>> = [];
  try {
    const systemMailbox = new GlobalMailbox(wpaths.projectDir);
    onlineAgents = await systemMailbox.getAgentStatuses();
  } catch {
    // Non-fatal — mailbox errors should not block prompt building
  }

  const systemPrompt = await promptBuilder.build({
    cwd,
    projectRoot,
    tools: toolRegistry.list(),
    provider: config.provider,
    model: config.model,
    onlineAgents,
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
    onRecovery: (abandoned, autoRecover) =>
      promptRecovery(reader, renderer, abandoned, autoRecover),
  });
  const session = sessResult.session;
  sessionRef.current = session;
  const context = sessResult.context;
  const attachments = sessResult.attachments;
  const recoveryLock = sessResult.recoveryLock;
  const queueStore = sessResult.queueStore;
  const planPath = sessResult.planPath;
  const detachTodosCheckpoint = sessResult.detachTodosCheckpoint;
  const priorFleetState = sessResult.priorFleetState;

  // ── SessionRegistry + AgentStatusTracker ──────────────────────────
  // Register this session in the cross-process registry so /sessions status
  // and the WebUI can discover it. Start the agent status tracker that
  // listens to EventBus events and pushes live status to the registry.
  let tracker: import('@wrongstack/core').AgentStatusTracker | undefined;
  try {
    const { getSessionRegistry, AgentStatusTracker } = await import('@wrongstack/core');
    const registry = getSessionRegistry(wpaths.globalRoot);
    const projectSlug = path.basename(wpaths.projectDir);
    const projectName = path.basename(projectRoot);

    // Detect current git branch (best-effort, non-blocking)
    let gitBranch: string | undefined;
    try {
      const { execSync } = await import('node:child_process');
      gitBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: projectRoot,
        timeout: 3000,
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      })
        .toString()
        .trim();
      if (gitBranch === 'HEAD') gitBranch = undefined; // detached HEAD
    } catch {
      // Not a git repo or git not available — leave undefined
    }

    await registry.register({
      sessionId: session.id,
      projectSlug,
      projectRoot,
      projectName,
      workingDir: context.workingDir,
      gitBranch,
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });

    tracker = new AgentStatusTracker({ events, registry });
    tracker.start();

    // Clean up on process exit
    const cleanup = async () => {
      try {
        await registry.markClosing();
        tracker?.stop();
      } catch {
        /* ignore */
      }
    };
    process.once('beforeExit', () => {
      void cleanup();
    });
    process.once('SIGINT', () => {
      void cleanup();
      process.exit(0);
    });
    process.once('SIGTERM', () => {
      void cleanup();
      process.exit(0);
    });
  } catch {
    // Non-critical — session tracking degrades gracefully
  }

  // Central SessionEventBridge — used for compaction, errors, and future audit events.
  // This ensures consistent auditLevel behavior and a single writer.
  // Sampling configuration (especially for tool_progress) is now read from config.
  const sessionConfig = resolveSessionLoggingConfig(
    config as unknown as Parameters<typeof resolveSessionLoggingConfig>[0],
  );
  // Resolve the CURRENT writer on every append (getter form): when the user
  // resumes another session mid-run, agent.ctx.session is swapped to the
  // resumed writer — audit events must follow the swap instead of being
  // dropped into the old, closed writer.
  const sessionBridge: SessionEventBridge = createSessionEventBridge(
    () => context.session ?? session,
    sessionConfig.auditLevel,
    {
      sampling: sessionConfig.sampling,
    },
  );

  const stats = new SessionStats(events, tokenCounter);

  // Last-N error ring buffer surfaced by /diag.
  const errorRing: { ts: string; phase: string; code: string; message: string }[] = [];
  evOn('error', (e) => {
    const err = e.err as unknown;
    const code =
      err &&
      typeof err === 'object' &&
      'code' in err &&
      typeof (err as { code: unknown }).code === 'string'
        ? (err as { code: string }).code
        : 'UNKNOWN';
    const message = e.err instanceof Error ? e.err.message : String(e.err);
    const ts = new Date().toISOString();

    errorRing.push({ ts, phase: e.phase, code, message });
    if (errorRing.length > 5) errorRing.shift();

    // Also persist to the session log via the central bridge (respects auditLevel).
    // This gives us error history in the JSONL for forensics / post-mortems.
    sessionBridge
      .append({
        type: 'error',
        ts,
        message,
        phase: e.phase,
      })
      .catch(() => {
        // best-effort, never block on session logging
      });
  });

  // Persist tool execution start/end to the session log for audit + timing forensics.
  // Uses the same central bridge (respects auditLevel).
  evOn('tool.started', (e) => {
    sessionBridge
      .append({
        type: 'tool_call_start',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id,
        input: e.input,
      })
      .catch(() => {
        // best-effort
      });
  });

  evOn('tool.executed', (e) => {
    sessionBridge
      .append({
        type: 'tool_call_end',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id ?? '',
        durationMs: e.durationMs,
        outputSize: e.outputBytes ?? 0,
        ok: e.ok,
        outputBytes: e.outputBytes,
        outputTokens: e.outputTokens,
        outputLines: e.outputLines,
      })
      .catch(() => {
        // best-effort
      });

    // ── File-author tracking: record which agent wrote/edited files ──
    if (
      e.ok &&
      (e.name === 'write' || e.name === 'edit' || e.name === 'replace' || e.name === 'patch')
    ) {
      const filePath = (e.input as Record<string, unknown>)?.path as string | undefined;
      if (filePath) {
        const projectDir = path.join(wpaths.globalRoot, 'projects', wpaths.projectSlug);
        void recordFileAction(
          { storageDir: projectDir, projectRoot },
          {
            filePath,
            action: e.name === 'write' ? 'create' : 'edit',
            agentId: 'leader',
            agentName: 'Leader',
            // Live writer id — after an in-app resume the active session is
            // context.session, not the startup writer.
            sessionId: context.session?.id ?? session.id,
          },
        ).catch(() => {
          // best-effort tracking
        });
      }
    }
  });

  // Humanized `delegate` lifecycle lines for the plain (non-TUI) CLI. The
  // Ink TUI renders its own delegate history entries, so skip these when it
  // owns the screen to avoid double-printing.
  if (!tuiOwnsScreen) {
    evOn('delegate.started', (e) => {
      const task = e.task.length > 100 ? `${e.task.slice(0, 99)}…` : e.task;
      renderer.writeInfo(`🤝 Delegating → ${e.target}: ${task}`);
    });
    evOn('delegate.completed', (e) => {
      const cost = e.costUsd && e.costUsd > 0 ? ` · $${e.costUsd.toFixed(4)}` : '';
      renderer.writeInfo(`${e.ok ? '✅' : '❌'} ${e.summary}${cost}`);
    });
  }

  // Forward tool progress events.
  // Sampling + "full" level filtering is now handled inside the SessionEventBridge
  // for consistency and reusability across CLI / TUI / WebUI etc.
  evOn('tool.progress', (e) => {
    sessionBridge
      .append({
        type: 'tool_progress',
        ts: new Date().toISOString(),
        name: e.name,
        id: e.id,
        event: { type: e.event.type, text: e.event.text, data: e.event.data },
      })
      .catch(() => {
        // best-effort
      });
  });

  // Provider visibility — very valuable for debugging retry storms and provider failures.
  evOn('provider.retry', (e) => {
    sessionBridge
      .append({
        type: 'provider_retry',
        ts: new Date().toISOString(),
        providerId: e.providerId,
        attempt: e.attempt,
        delayMs: e.delayMs,
        status: e.status,
        description: e.description,
      })
      .catch(() => {
        // best-effort
      });
  });

  evOn('provider.error', (e) => {
    sessionBridge
      .append({
        type: 'provider_error',
        ts: new Date().toISOString(),
        providerId: e.providerId,
        status: e.status,
        description: e.description,
        retryable: e.retryable,
      })
      .catch(() => {
        // best-effort
      });
  });

  const pipelines = setupPipelines({ events, logger });

  // ── Lifecycle hooks ──────────────────────────────────────────────────────
  // `--no-hooks` disables everything (shell + in-process). Otherwise shell
  // hooks are loaded from `config.hooks`; plugins add in-process hooks via
  // `api.registerHook`. The runner is wired into the tool executor
  // (PreToolUse/PostToolUse), the userInput pipeline (UserPromptSubmit), and an
  // agent extension (SessionStart/Stop, registered after the agent is built).
  const hooksEnabled = flags['no-hooks'] !== true;
  const hookRegistry = new HookRegistry();
  if (hooksEnabled) hookRegistry.loadShellHooks(config.hooks);
  container.bind(TOKENS.HookRegistry, () => hookRegistry);
  const hookRunner = new HookRunner({
    registry: hookRegistry,
    logger,
    allowShell: hooksEnabled,
    sessionId: () => session.id,
  });
  if (hooksEnabled) {
    pipelines.userInput.use(createUserPromptSubmitMiddleware(hookRunner));
  }

  const compactor = container.resolve(TOKENS.Compactor);
  const compactionSetup = await setupCompaction({
    compactor,
    events,
    modelsRegistry,
    context,
    config,
    provider,
    pipelines,
    fullConfig: config as unknown as Parameters<typeof setupCompaction>[0]['fullConfig'],
    sessionBridge, // share the same bridge for consistent audit logging (compaction + errors + future)
  });
  let effectiveMaxContext = compactionSetup.effectiveMaxContext;
  context.provider.capabilities.maxContext = effectiveMaxContext;
  const { autoCompactor } = compactionSetup;

  // Refresh the active model's context denominator when provider/model changes.
  // This feeds auto-compaction, the leader context chip, and Director spawn guards.
  const refreshMaxContext = async (
    providerId: string,
    modelId: string,
    runtimeProviderConfig?: import('@wrongstack/core').ProviderConfig | undefined,
  ) => {
    const mc = await resolveRuntimeMaxContext({
      modelsRegistry,
      config,
      provider: context.provider,
      runtimeProviderConfig,
      providerId,
      modelId,
    });
    effectiveMaxContext = mc;
    context.provider.capabilities.maxContext = effectiveMaxContext; // may be 0 (unknown)
    if (effectiveMaxContext > 0) {
      autoCompactor?.setMaxContext(effectiveMaxContext);
    }
    events.emit('ctx.max_context', { providerId, modelId, maxContext: effectiveMaxContext });
    updateSpinnerContext();
  };

  // Helper: keep the spinner's context chip in sync
  const updateSpinnerContext = () => {
    if (effectiveMaxContext > 0 && lastInputTokens > 0) {
      spinner.setContext({ used: lastInputTokens, max: effectiveMaxContext });
    } else spinner.setContext(undefined);
  };

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
  });

  // SessionStart / Stop lifecycle hooks (PreToolUse/PostToolUse live in the
  // tool executor; UserPromptSubmit in the userInput pipeline above).
  if (hooksEnabled) {
    agent.extensions.register(createLifecycleHooksExtension(hookRunner));
  }

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
    healthRegistry,
    skillLoader: config.features.skills ? skillLoader : undefined,
    configStore,
    vault,
    paths: wpaths,
    hookRegistry,
  });

  // ── Dep-watcher bridge: wire file-watcher events into the mailbox ────
  // When the file-watcher plugin's depWatcher.enabled config is true,
  // dependency manifest changes (package.json, go.mod, etc.) are posted
  // to the project-level mailbox for tech-stack audit.
  const fwCfg = config.extensions?.['file-watcher'] as Record<string, unknown> | undefined;
  const dwCfg = fwCfg?.['depWatcher'] as Record<string, unknown> | undefined;
  let depWatcherDispose: (() => void) | undefined;
  if (dwCfg?.['enabled'] === true) {
    try {
      const projectDir = path.join(wpaths.globalRoot, 'projects', wpaths.projectSlug);
      const dwMailbox = new GlobalMailbox(projectDir, events);
      depWatcherDispose = attachDepWatcherBridge({
        events,
        mailbox: dwMailbox,
        projectRoot,
        targetAgent: (dwCfg['targetAgent'] as string) ?? 'tech-stack',
        watcherAgentId: 'dep-watcher',
        debounceMs: (dwCfg['debounceMs'] as number) ?? 3000,
      });
      logger.info(
        'Dep-watcher bridge activated — dependency changes will trigger tech-stack audits',
      );
    } catch (err) {
      logger.warn(`Failed to wire dep-watcher bridge: ${err}`);
    }
  }

  // Clean up dep-watcher bridge on teardown
  if (depWatcherDispose) {
    teardownHandlers.push(depWatcherDispose);
  }

  // Resolve a provider id (alias-resolved via `providers[id].type`) to the
  // concrete provider id + the runtime ProviderConfig used to build it and to
  // refresh the context-window denominator. Single source of truth so the
  // `/model` switch and the fallback extension can't drift apart.
  const resolveProviderCfg = (providerId: string) => {
    const savedCfg = config.providers?.[providerId];
    const resolvedProviderId = savedCfg?.type ?? providerId;
    const cfgWithType = {
      ...(savedCfg ?? { type: providerId, apiKey: config.apiKey, baseUrl: config.baseUrl }),
      type: resolvedProviderId,
    };
    return { resolvedProviderId, cfgWithType };
  };

  // Construct a credential-resolved Provider for a provider id, WITHOUT
  // persisting anything. Shared by the `/model` switch and the fallback extension.
  const buildProviderForId = (providerId: string): import('@wrongstack/core').Provider => {
    const { resolvedProviderId, cfgWithType } = resolveProviderCfg(providerId);
    return config.features.modelsRegistry && providerRegistry.has(resolvedProviderId)
      ? providerRegistry.create(cfgWithType)
      : makeProviderFromConfig(resolvedProviderId, cfgWithType);
  };

  // Refresh the auto-compaction / context-chip denominator for a (provider,
  // model) pair. Used by both the `/model` switch and the fallback extension so
  // a switch to a smaller-window model recomputes thresholds.
  const refreshMaxContextFor = (providerId: string, modelId: string): void => {
    const { resolvedProviderId, cfgWithType } = resolveProviderCfg(providerId);
    void refreshMaxContext(resolvedProviderId, modelId, cfgWithType);
  };

  // Cross-provider fallback: switch to the next configured model when the
  // primary is overloaded. No-op (null) when `fallbackModels` is empty.
  const fallbackExtension = createFallbackModelExtension({
    getConfig: () => config,
    buildProvider: buildProviderForId,
    onModelSwitch: refreshMaxContextFor,
    events,
    logger,
  });
  if (fallbackExtension) agent.extensions.register(fallbackExtension);

  // Session-end memory consolidation — extracts key learnings from the
  // completed session and persists them as memory entries.
  if (config.features.memory && config.features.memoryConsolidation !== false) {
    agent.extensions.register(
      new SessionMemoryConsolidator({
        memoryStore,
      }),
    );
  }

  // Build provider+model switch as a single callback. The TUI picker
  // calls this after the user confirms a (provider, model) pair; we
  // construct a fresh Provider instance, swap it onto the live context,
  // and rebuild the frozen config so other consumers see the new ids.
  const switchProviderAndModel = (providerId: string, modelId: string): string | null => {
    try {
      context.provider = buildProviderForId(providerId);
      context.model = modelId;
      config = patchConfig(config, { provider: providerId, model: modelId });
      // L1-B: propagate the change to the ConfigStore so any subsystem
      // that subscribed via .watch() re-renders. Crucially, /diag now
      // reads the live provider via the store.
      configStore.update({ provider: providerId, model: modelId });
      // Refresh AutoCompactionMiddleware denominator for the new model's
      // maxContext so threshold triggers (warn/soft/hard) use the correct denominator.
      refreshMaxContextFor(providerId, modelId);
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
  // Concurrent subagent ceiling. Priority: CLI flag → env var → config → default (4).
  // Caps how many delegated tasks the coordinator dispatches at once;
  // extra tasks queue. Keeps the leader from spawning enough parallel
  // subagents to trip provider rate limits. Persist a default in config.json
  // via `maxConcurrent` or change live with /fleet concurrency <n>.
  const maxConcurrentFromFlag =
    typeof flags['max-concurrent'] === 'string'
      ? Number.parseInt(flags['max-concurrent'], 10)
      : undefined;
  const maxConcurrentFromEnv =
    typeof process.env['WRONGSTACK_MAX_CONCURRENT'] === 'string'
      ? Number.parseInt(process.env['WRONGSTACK_MAX_CONCURRENT'], 10)
      : undefined;
  const maxConcurrentFromConfig =
    typeof config.maxConcurrent === 'number' && config.maxConcurrent > 0
      ? config.maxConcurrent
      : undefined;
  const maxConcurrent =
    Number.isFinite(maxConcurrentFromFlag) && (maxConcurrentFromFlag as number) > 0
      ? (maxConcurrentFromFlag as number)
      : Number.isFinite(maxConcurrentFromEnv) && (maxConcurrentFromEnv as number) > 0
        ? (maxConcurrentFromEnv as number)
        : Number.isFinite(maxConcurrentFromConfig) && (maxConcurrentFromConfig as number) > 0
          ? (maxConcurrentFromConfig as number)
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
  // Next-task prediction toggle — persisted in config so it survives restarts.
  // Read/written via `onNextPredict`, read by the REPL via `getNextPredict`.
  let nextPredictEnabled = config.nextPrediction === true;
  // Suggestion list for /next selection — ephemeral, cleared each cycle.
  // Read/written via `onSuggestions`.
  let currentSuggestions: string[] = [];
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
  const stageListeners = new Set<(stage: AutonomyStage) => void>();
  const broadcastAutonomyStage = (stage: AutonomyStage): void => {
    for (const fn of stageListeners) {
      try {
        fn(stage);
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
      : path.join(expectDefined(fleetRoot), 'fleet.json')
    : undefined;
  const sharedScratchpadPath = directorMode
    ? path.join(expectDefined(fleetRoot), 'shared')
    : undefined;
  const subagentSessionsRoot = directorMode
    ? path.join(expectDefined(fleetRoot), 'subagents')
    : undefined;
  // Live director state checkpoint — written incrementally to disk on
  // every spawn/assign/complete event so a crashed director leaves a
  // recoverable snapshot. Distinct from manifestPath (final record).
  const stateCheckpointPath = directorMode
    ? path.join(expectDefined(fleetRoot), 'director-state.json')
    : undefined;
  // Always derive a fleetRoot for runtime promotion — /director needs
  // a base dir to write manifest + scratchpad + per-subagent JSONLs into.
  const fleetRootForPromotion = path.join(wpaths.projectSessions, session.id);

  // ── Global Brain chain — policy → LLM → human ──────────────────────────
  // Positioning: the Brain is the authority layer above the leader/director
  // and below the human. One instance serves every consumer (director,
  // autophase, eternal engine, BrainMonitor, /brain) via TOKENS.BrainArbiter.
  //   1. DefaultBrainArbiter — deterministic policy (low-risk fast path)
  //   2. createAutonomyBrain — LLM decision support within the live risk
  //      ceiling (adjust at runtime with /brain risk <level>)
  //   3. HumanEscalating + Observable — escalation prompt + UI events
  const brainSettings: { maxAutoRisk: BrainAutoRisk } = {
    maxAutoRisk: 'medium',
  };
  const brainQueue = new BrainDecisionQueue(events);
  // Lazy wrapper so the LLM layer always sees the LIVE provider/model —
  // `provider` and `config` are reassigned when the user switches models.
  const autonomousBrain: import('@wrongstack/core').BrainArbiter = {
    decide: (request) =>
      createAutonomyBrain({
        provider,
        model: config.model,
        maxAutoRisk: 'all', // the tiered ceiling gates risk — keep inner permissive
      }).decide(request),
  };
  const brain = new ObservableBrainArbiter(
    new HumanEscalatingBrainArbiter(
      createTieredBrainArbiter({
        policy: new DefaultBrainArbiter(),
        autonomous: autonomousBrain,
        getMaxAutoRisk: () => brainSettings.maxAutoRisk,
      }),
      brainQueue,
    ),
    events,
  );
  container.bind(TOKENS.BrainArbiter, () => brain);

  // Decision log for /brain status — last 20 decisions across all sources.
  const brainLog: Array<{
    at: number;
    kind: 'answered' | 'ask_human' | 'denied' | 'intervention';
    question: string;
    outcome: string;
  }> = [];
  const pushBrainLog = (entry: (typeof brainLog)[number]) => {
    brainLog.push(entry);
    if (brainLog.length > 20) brainLog.shift();
  };
  evOn('brain.decision_answered', (e) => {
    pushBrainLog({
      at: e.at,
      kind: 'answered',
      question: e.request.question,
      outcome: e.decision.type === 'answer' ? (e.decision.optionId ?? e.decision.text) : '',
    });
  });
  evOn('brain.decision_ask_human', (e) => {
    pushBrainLog({
      at: e.at,
      kind: 'ask_human',
      question: e.request.question,
      outcome: 'escalated to human',
    });
  });
  evOn('brain.decision_denied', (e) => {
    pushBrainLog({
      at: e.at,
      kind: 'denied',
      question: e.request.question,
      outcome: e.decision.type === 'deny' ? e.decision.reason : '',
    });
  });
  evOn('brain.intervention', (e) => {
    pushBrainLog({
      at: e.at,
      kind: 'intervention',
      question: e.request.question,
      outcome: e.intervened ? 'steered the agent' : 'observed (no action)',
    });
  });

  // ── Brain self-activation — watch the bus, intervene via mailbox steer ──
  // Tool-failure streaks and error storms engage the Brain proactively; a
  // "steer" decision lands in THIS session's leader inbox and is injected
  // before the agent's next step.
  const brainMailbox = new GlobalMailbox(wpaths.projectDir, events);
  const brainMonitor = new BrainMonitor({
    events,
    brain,
    intervene: async ({ subject, body }) => {
      const leaderUniqueId = `leader@${mailboxSessionTag(session.id)}`;
      await brainMailbox.send({
        from: `brain@${mailboxSessionTag(session.id)}`,
        to: leaderUniqueId,
        type: 'steer',
        subject,
        body,
        priority: 'high',
      });
    },
  });
  brainMonitor.start();

  const multiAgentHost = new MultiAgentHost(
    {
      container,
      toolRegistry,
      providerRegistry,
      configStore,
      modelsRegistry,
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
      getLeaderMaxContext: () => effectiveMaxContext,
      brain,
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
      // Host bus so `delegate` can emit start/finish events that the TUI,
      // plain CLI, and Telegram bridge render as readable lines.
      events,
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

  // ── Tech-stack mailbox consumer: auto-spawn agent on dep-watcher messages ──
  // When dep-watcher posts assign messages to the mailbox, this consumer
  // polls for them and spawns a tech-stack subagent to audit versions.
  let techStackConsumerDispose: (() => void) | undefined;
  if (dwCfg?.['enabled'] === true) {
    try {
      const projectDir = path.join(wpaths.globalRoot, 'projects', wpaths.projectSlug);
      const tsMailbox = new GlobalMailbox(projectDir, events);
      const fileAuthorOpts: FileAuthorTrackerOptions = {
        storageDir: projectDir,
        projectRoot,
      };
      techStackConsumerDispose = startTechStackConsumer({
        mailbox: tsMailbox,
        onSpawn: async (task, name) => {
          return multiAgentHost.spawn(task, { name, tools: ['read', 'fetch', 'mailbox'] });
        },
        targetAgent: (dwCfg['targetAgent'] as string) ?? 'tech-stack',
        consumerAgentId: 'tech-stack-consumer',
        pollIntervalMs: (dwCfg['pollIntervalMs'] as number) ?? 5000,
        fileAuthorOpts,
        sessionId: session.id,
        currentAgentId: 'leader',
        currentAgentName: 'Leader',
        onLog: (msg) => logger.debug(msg),
        onError: (err) =>
          logger.warn(
            `Tech-stack consumer error: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });
      logger.info(
        'Tech-stack mailbox consumer started — will auto-spawn agents on dependency changes',
      );
    } catch (err) {
      logger.warn(`Failed to start tech-stack consumer: ${err}`);
    }
  }

  // ── Package outdated watcher: notify original authors when packages are outdated ──
  // When the tech-stack agent posts outdated-package results to the mailbox,
  // this watcher looks up who originally added each package and notifies them.
  let pkgOutdatedDispose: (() => void) | undefined;
  if (dwCfg?.['enabled'] === true) {
    try {
      const projectDir = path.join(wpaths.globalRoot, 'projects', wpaths.projectSlug);
      const pkgMailbox = new GlobalMailbox(projectDir, events);
      const pkgTrackerOpts: Pick<PackageAuthorTrackerOptions, 'storageDir' | 'projectRoot'> = {
        storageDir: projectDir,
        projectRoot,
      };
      pkgOutdatedDispose = startPackageOutdatedWatcher({
        mailbox: pkgMailbox,
        packageTrackerOpts: pkgTrackerOpts,
        pollIntervalMs: (dwCfg['pollIntervalMs'] as number) ?? 60 * 60 * 1000, // 1 hour default
        watcherAgentId: 'pkg-outdated-watcher',
        onNotify: async (msg) => {
          await pkgMailbox.send({
            from: msg.from,
            to: msg.to,
            type: 'note',
            subject: msg.subject,
            body: msg.body,
            priority: msg.priority,
          });
        },
        onLog: (m) => logger.debug(m),
        onError: (err) =>
          logger.warn(
            `Pkg-outdated-watcher error: ${err instanceof Error ? err.message : String(err)}`,
          ),
      });
      logger.info(
        'Package outdated watcher started — will notify agents when their added packages are outdated',
      );
    } catch (err) {
      logger.warn(`Failed to start package outdated watcher: ${err}`);
    }
  }

  if (pkgOutdatedDispose) {
    teardownHandlers.push(pkgOutdatedDispose);
  }

  // Clean up tech-stack consumer on teardown
  if (techStackConsumerDispose) {
    teardownHandlers.push(techStackConsumerDispose);
  }

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

  // Shared controller for the `/enhance on|off` prompt-refinement toggle.
  // Same pattern as `fleetStreamController`: the TUI rebinds `setEnabled` to a
  // dispatch-backed setter on mount. Seeded from persisted config (default on).
  const enhanceController = {
    enabled:
      ((config.autonomy as Record<string, unknown> | undefined)?.['enhance'] as boolean) ?? true,
    setEnabled(enabled: boolean) {
      this.enabled = enabled;
    },
  };

  // Statusline config — loaded once and shared with /statusline slash command
  const statuslineConfigDeps = {
    get: () => loadStatuslineConfig(),
    set: (cfg: import('./slash-commands/statusline.js').StatuslineConfig) =>
      saveStatuslineConfig(cfg),
  };

  // Statusline hidden items — derived from the config file, kept in sync with the TUI
  const hiddenItemsFromConfig = await loadStatuslineConfig();
  const hiddenItemsList: Array<
    'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'
  > = [];
  const ALL_ITEMS = ['todos', 'plan', 'tasks', 'fleet', 'git', 'elapsed', 'context', 'cost'] as const;
  for (const k of ALL_ITEMS) {
    if (!hiddenItemsFromConfig[k]) hiddenItemsList.push(k);
  }
  const statuslineHiddenItems = hiddenItemsList;
  let currentHiddenItems = [...statuslineHiddenItems] as Array<
    'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
  >;
  const setStatuslineHiddenItems = (
    items: Array<
      'todos' | 'plan' | 'tasks' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost' | 'working_dir'
    >,
  ) => {
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
    projectRoot,
    brain,
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
    enhanceController,
    llmProvider: provider,
    llmModel: config.model,
    createProvider: (pid: string) => {
      try {
        return buildProviderForId(pid);
      } catch {
        return undefined;
      }
    },
    statuslineConfig: statuslineConfigDeps,
    statuslineHiddenItems: [...currentHiddenItems],
    setStatuslineHiddenItems,
    agentsMonitorController,
    configStore,
    reader,
    brain,
    brainSettings,
    getBrainLog: () => brainLog,
    confirm: async (question, defaultYes = true): Promise<boolean | null> => {
      // Non-TTY / piped stdin → don't block. For destructive or surprising
      // actions (e.g. starting eternal mode against a stale goal) the safe
      // non-interactive default is `false` — auto-confirming destructive
      // operations in scripts is dangerous. `null` signals "no user to ask"
      // only when the caller explicitly needs to distinguish cancel from
      // deny (which /autonomy eternal doesn't).
      if (!isStdinTTY()) return false;
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
    onSpawnAndWait: async (description, spawnOpts) => {
      const result = await multiAgentHost.spawnAndWait(description, spawnOpts);
      const tags: string[] = [];
      if (spawnOpts?.provider) tags.push(spawnOpts.provider);
      if (spawnOpts?.model) tags.push(spawnOpts.model);
      if (spawnOpts?.name) tags.push(spawnOpts.name);
      const tag = tags.length > 0 ? ` (${tags.join(' / ')})` : '';

      const secs = (result.durationMs / 1000).toFixed(result.durationMs < 10_000 ? 1 : 0);
      const icon =
        result.status === 'success'
          ? '✓'
          : result.status === 'timeout'
            ? '⏱'
            : result.status === 'stopped'
              ? '⊘'
              : '✗';
      const resultPreview =
        typeof result.result === 'string' && result.result.trim()
          ? `\n${color.dim('─'.repeat(40))}\n${result.result.trim().slice(0, 600)}${result.result.trim().length > 600 ? '\n…' : ''}\n${color.dim('─'.repeat(40))}`
          : '';

      return [
        `${icon} ${color.bold(tag ? tag.slice(1) : 'subagent')} ${result.status} (${result.iterations} iter · ${result.toolCalls} tools · ${secs}s)`,
        resultPreview,
        result.error ? `  ${color.amber(`error: ${result.error.message}`)}` : '',
      ]
        .filter(Boolean)
        .join('\n');
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
          lines.push(
            `  ${STATUS_ICON[a.status] ?? '?'}  ${a.subagentId.slice(0, 8)} ${a.status}${task}`,
          );
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
          events.emit('concurrency.changed', { n });
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
      // Kill and remove all subagents so their ids can be reused in future spawns.
      // Uses remove() rather than terminate() to also clean up the coordinator
      // entry and the usage aggregator, preventing resource accumulation.
      let killed = 0;
      for (const sa of s.subagents) {
        if (sa.status === 'running' || sa.status === 'idle') {
          try {
            director.remove(sa.id);
            killed++;
          } catch {
            /* best-effort */
          }
        }
      }
      return killed;
    },
    onFleetTerminate: (subagentId) => {
      if (!director) return false;
      try {
        director.terminate(subagentId);
        return true;
      } catch {
        return false;
      }
    },
    onFleetSpawn: async (role) => {
      if (!director)
        throw new Error('No director active — start with --director or use /autonomy parallel.');
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
        lines.push(
          'Use `/fleet log <subagentId>` for a summary, or append `raw` for the full JSONL.',
        );
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
      const t = expectDefined(matches[0]);
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
          const ev = JSON.parse(line) as {
            type: string;
            content?: unknown | undefined;
            name?: string | undefined;
          };
          counts[ev.type] = (counts[ev.type] ?? 0) + 1;
          if (ev.type === 'user_input' && !firstUser) {
            const txt =
              typeof ev.content === 'string'
                ? ev.content
                : Array.isArray(ev.content)
                  ? ev.content
                      .filter(
                        (b): b is { type: 'text'; text: string } =>
                          (b as { type?: string | undefined }).type === 'text',
                      )
                      .map((b) => b.text)
                      .join(' ')
                  : '';
            firstUser = txt.slice(0, 120);
          }
          if (ev.type === 'llm_response') {
            if (Array.isArray(ev.content)) {
              const txt = (
                ev.content as Array<{ type?: string | undefined; text?: string | undefined }>
              )
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
          : interrupted.filter((t) => t.taskId === taskId || t.taskId.startsWith(taskId));
      if (targets.length === 0) {
        return `No interrupted task matched "${taskId}".`;
      }

      const results: string[] = [];
      for (const t of targets) {
        const owner = t.subagentId ? prior.subagents.find((s) => s.id === t.subagentId) : undefined;
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
        const patch = result.patch as unknown as Partial<Config>;
        config = patchConfig(config, patch);
        configStore.update(patch);
      }
      if (result.restartRequired && result.code === 0) {
        return `${result.message}\nRestart WrongStack to load or unload plugin code in this session.`;
      }
      return result.message;
    },
    onContextLimit: (tokens?: number) => {
      if (typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0) {
        effectiveMaxContext = tokens;
        context.provider.capabilities.maxContext = tokens;
        context.meta['effectiveMaxContext'] = tokens;
        autoCompactor?.setMaxContext(tokens);
        events.emit('ctx.max_context', {
          providerId: config.provider,
          modelId: context.model,
          maxContext: tokens,
        });
        updateSpinnerContext();
      }
      return effectiveMaxContext;
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
      const policy = container.resolve(TOKENS.PermissionPolicy);
      if (setTo !== undefined) {
        policy.setYolo?.(setTo);
        config = patchConfig(config, { yolo: setTo });
        return setTo;
      }
      return policy.getYolo?.() ?? config.yolo ?? false;
    },
    onNextPredict: (setTo?: boolean) => {
      if (setTo !== undefined) {
        nextPredictEnabled = setTo;
        config = patchConfig(config, { nextPrediction: setTo });
        return setTo;
      }
      return nextPredictEnabled;
    },
    onSuggestions: (suggestions?: string[]) => {
      if (suggestions !== undefined) {
        currentSuggestions = suggestions;
        // Also sync to the shared module-level store so /next works
        // reliably across all surfaces (REPL, TUI, WebUI).
        setSuggestions(suggestions);
      }
      // Read from shared store first for consistency across surfaces
      const shared = getSuggestions();
      return shared.length > 0 ? shared : currentSuggestions;
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
          const parallelOptions: ConstructorParameters<typeof ParallelEternalEngine>[0] & {
            onStage?: ((stage: AutonomyStage) => void) | undefined;
          } = {
            agent,
            projectRoot,
            compactor: container.resolve(TOKENS.Compactor) as import('@wrongstack/core').Compactor,
            maxContextTokens: effectiveMaxContext > 0 ? effectiveMaxContext : undefined,
            onIteration: broadcastEternalIteration,
            onStage: broadcastAutonomyStage,
            // Real per-role factory: each dispatched slot runs as a fresh,
            // isolated agent with the role's filtered tools + persona prompt
            // (instead of sharing the leader agent's Context).
            subagentFactory: multiAgentHost.makeSubagentFactory(config),
          };
          parallelEngine = new ParallelEternalEngine(parallelOptions);
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
            onStage: broadcastAutonomyStage,
            brain,
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
      for (const teardown of teardownHandlers) teardown();
      teardownHandlers.length = 0;
      brainMonitor.stop();
      brainQueue.dispose();
      void mcpRegistry.stopAll();
    },
    onBeforeExit: async () => {
      // Check for uncommitted changes directly
      const cwd = projectRoot;

      const statusResult = await new Promise<{ stdout: string; code: number }>(
        (resolve, reject) => {
          const child = spawn('git', ['status', '--porcelain'], {
            cwd,
            stdio: ['ignore', 'pipe', 'pipe'],
            signal: AbortSignal.timeout(5000),
            windowsHide: true,
          });
          let stdout = '';
          child.stdout?.on('data', (d) => {
            stdout += d;
          });
          child.on('error', reject);
          child.on('close', (code) => resolve({ stdout, code: code ?? 0 }));
        },
      );

      if (statusResult.stdout.trim().length > 0) {
        const lines = statusResult.stdout.split('\n').filter(Boolean);
        return {
          abort: true, // signals there are uncommitted changes (used only for the message)
          message: `⚠ ${color.yellow(`${lines.length} uncommitted change${lines.length > 1 ? 's' : ''}`)} — session ended without commit`,
        };
      }
      return undefined;
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
        writeOut('\x1b[2J\x1b[3J\x1b[H');
      } catch {
        // stdout may be closed during shutdown — ignore.
      }
    },
    onNewSession: async () => {
      // TUI-only: signal the TUI to wipe its history entries and reset
      // cumulative fleet/leader stats. This is called from /clear after
      // the session has been cleared on disk so the UI state matches.
      // The TUI runs its own event-listener that dispatches the
      // 'clearHistory' + 'resetContextChip' actions in response.
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
          renderer.write(
            `  ░ wave ${p.wave + 1} · ${p.completed}/${p.total} tasks · ${p.percent}% done\n`,
          );
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
    onWorktree: autoPhaseHost.onWorktree,
  });
  for (const cmd of slashCmds) slashRegistry.register(cmd);

  // ── --eternal "<mission>" flag: one-shot launch into eternal autonomy. ──
  // See `cli-eternal-flag.ts` for the full contract. The flag is parsed
  // here so we can early-return without it; the side effects (YOLO on,
  // engine prime, autonomyMode flip) all live in the helper.
  const eternalFlag =
    typeof flags['eternal'] === 'string' ? (flags['eternal'] as string).trim() : '';
  const configRef = { current: config };
  await launchEternalFromFlag({
    eternalFlag,
    projectRoot,
    agent,
    container,
    renderer,
    broadcastEternalIteration,
    effectiveMaxContext,
    configRef,
    autonomyModeRef,
  });
  // Sync local `config` with any mutation the helper applied (e.g. yolo
  // flag flip). Using a ref keeps the helper's call site clean — no return
  // value juggling for callers that don't care about the update.
  config = configRef.current;
  if (eternalFlag.length > 0) {
    autonomyMode = 'eternal';
  }

  // Automatic codebase indexing: blocking startup index (with a visible
  // summary) + background reindex on agent edits and external file changes.
  // Runs here so the startup index completes before any front-end mounts.
  const disposeIndexing = await setupCodebaseIndexing({
    config,
    context,
    pipelines,
    projectRoot,
    logger,
  });
  process.once('exit', disposeIndexing);

  // Dispatch to execution phase — single-shot, TUI, REPL, or WebUI.
  const savedProviderCfg = config.providers?.[config.provider];
  return execute({
    agent,
    events,
    slashRegistry,
    attachments,
    tokenCounter,
    config,
    configStore,
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
    enhanceController,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    getYolo: () => {
      const policy = container.resolve(TOKENS.PermissionPolicy);
      return policy.getYolo?.() ?? config.yolo ?? false;
    },
    getAutonomy: () => autonomyMode,
    onAutonomy: (setTo?) => {
      if (setTo !== undefined) {
        autonomyMode = setTo;
        return setTo;
      }
      return autonomyMode;
    },
    getNextPredict: () => nextPredictEnabled,
    onSuggestionsParsed: (suggestions) => {
      // Always update — null means "no suggestions found", which must
      // clear the list so the auto-proceed loop doesn't get stuck
      // re-feeding stale suggestions.
      currentSuggestions = suggestions ?? [];
      setSuggestions(suggestions ?? []);
    },
    getSuggestions: () => {
      // Read from shared store first for cross-surface consistency
      const shared = getSuggestions();
      return shared.length > 0 ? shared : currentSuggestions;
    },
    autoProceedDelayMs:
      ((config.autonomy as Record<string, unknown> | undefined)?.autoProceedDelayMs as number) ??
      45_000,
    autoProceedMaxIterations:
      ((config.autonomy as Record<string, unknown> | undefined)
        ?.autoProceedMaxIterations as number) ?? 50,
    onValidateAutoProceed: async (suggestion, lastOutput) => {
      try {
        const resp = await context.provider.complete(
          {
            model: context.model,
            system: [
              {
                type: 'text',
                text: 'You are a safety validator for an autonomous coding agent. Your ONLY job is to decide whether the agent should auto-proceed with a suggested next step, or whether a human should review first. Reply with exactly one word: YES or NO.',
              },
            ],
            messages: [
              {
                role: 'user',
                content: [
                  {
                    type: 'text',
                    text: `The autonomous agent just completed a turn and generated this top-ranked next-step suggestion:\n\n"${suggestion}"\n\n${lastOutput ? `Recent agent output:\n${lastOutput.slice(0, 500)}\n\n` : ''}Should the agent auto-proceed with this suggestion, or should a human review first?\n\nReply YES to auto-proceed, NO to wait for human input.`,
                  },
                ],
              },
            ],
            maxTokens: 5,
            temperature: 0,
          },
          { signal: AbortSignal.timeout(10_000) },
        );
        const text = resp.content
          .filter((b) => b.type === 'text')
          .map((b) => ('text' in b ? b.text : ''))
          .join('')
          .trim()
          .toUpperCase();
        return text.startsWith('YES');
      } catch {
        // On any error (network, provider, timeout), err on the side
        // of safety — do NOT auto-proceed.
        return false;
      }
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
    onCountdownTick: (remaining) => {
      events.emit('countdown.tick', { remaining });
      return false;
    },
    skillLoader: config.features.skills ? skillLoader : undefined,
    modeId,
    sessionStore,
    memoryStore,
    modeStore,
    restoredMessages: sessResult.restoredMessages,
    restoredToolCalls: sessResult.restoredToolCalls,
    needsSetup,
    // Brain plumbing for the embedded WebUI server: the SAME settings object
    // the /brain slash command mutates, so the autonomy ceiling stays in sync
    // across surfaces; brainLog is the shared 20-entry decision log.
    brain,
    brainSettings,
    getBrainLog: () => brainLog,
    // Clean up SessionStats event listeners when the REPL exits.
    onDestroy: () => stats.destroy(events),
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
// promptRecovery lives in `cli-recovery-prompt.ts` (extracted so it can be
// unit-tested with a fake ReadlineInputReader + TerminalRenderer stub
// without spinning up the whole CLI). Imported at the top of this file.

// isMain detection + bounded exit-on-both-success-and-failure live in
// `index.ts` (the real entry point). This module exports `main` for
// library consumers; `index.ts` calls `runAsMain(main)` once.
