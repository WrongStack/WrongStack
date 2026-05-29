/**
 * Execution phase — single-shot, TUI, REPL, and WebUI dispatch.
 * Extracted from index.ts so the main() function focuses on
 * boot + wiring; this file owns the three run modes and cleanup.
 */
import * as path from 'node:path';
import type {
  Agent,
  AttachmentStore,
  Config,
  Director,
  EventBus,
  ModelsRegistry,
  RecoveryLock,
  SessionWriter,
  SlashCommandRegistry,
  TokenCounter,
} from '@wrongstack/core';
import { color } from '@wrongstack/core';
import type { ProviderConfig, ResolvedProvider, WstackPaths } from '@wrongstack/core';
import type { MCPRegistry } from '@wrongstack/mcp';
import { createToolVisionAdapters } from '@wrongstack/runtime/vision';
import { capabilitiesFor } from '@wrongstack/providers';
import type { ReadlineInputReader } from './input-reader.js';
import type { TerminalRenderer } from './renderer.js';
import { FleetStatusLine } from './fleet-statusline.js';
import { runRepl } from './repl.js';
import type { SessionStats } from './session-stats.js';
import { fmtTok } from './utils.js';
import { CLI_VERSION } from './version.js';

export interface ExecutionDeps {
  agent: Agent;
  events: EventBus;
  slashRegistry: SlashCommandRegistry;
  attachments: AttachmentStore;
  tokenCounter: TokenCounter;
  config: Config;
  renderer: TerminalRenderer;
  reader: ReadlineInputReader;
  session: SessionWriter;
  mcpRegistry: MCPRegistry;
  recoveryLock: RecoveryLock;
  wpaths: WstackPaths;
  modelsRegistry: ModelsRegistry;
  projectRoot: string;
  flags: Record<string, string | boolean>;
  positional: string[];
  effectiveMaxContext: number;
  queueStore: import('@wrongstack/core').QueueStore;
  context: import('@wrongstack/core').Context;
  stats: SessionStats;
  detachTodosCheckpoint?: () => void | Promise<void>;
  savedProviderCfg: ProviderConfig | undefined;
  resolvedProvider: ResolvedProvider | undefined;
  getPickableProviders: () => Promise<Array<{ id: string; family: string; models: string[] }>>;
  switchProviderAndModel: (providerId: string, modelId: string) => string | null;
  /** Live director instance for the TUI fleet panel. Null when director mode is off. */
  director: Director | null;
  /** Fleet roster for human-readable subagent names. */
  fleetRoster?: Record<string, { name: string }>;
  /**
   * Shared controller object for the `/fleet stream on|off` toggle. The
   * TUI installs a dispatch-backed setter on mount; the slash command
   * reads/writes via this object so both surfaces stay synchronized.
   */
  fleetStreamController?: {
    enabled: boolean;
    setEnabled: (enabled: boolean) => void;
  };
  /** Status bar hidden items controller (passed to TUI). */
  statuslineHiddenItems: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>;
  setStatuslineHiddenItems: (items: Array<'todos' | 'plan' | 'fleet' | 'git' | 'elapsed' | 'context' | 'cost'>) => void;
  /** Agents monitor overlay controller (passed to TUI). */
  agentsMonitorController?: {
    visible: boolean;
    setVisible: (visible: boolean) => void;
  };
  /** Query the live YOLO state from the permission policy. */
  getYolo?: () => boolean;
  /** Query the live autonomy mode. */
  getAutonomy?: () => import('./slash-commands/autonomy.js').AutonomyMode;
  /** Set autonomy mode (used by SIGINT handler to flip back to 'off'). */
  onAutonomy?: (mode: import('./slash-commands/autonomy.js').AutonomyMode) => void;
  /**
   * Access the (possibly null) eternal-autonomy engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal'.
   */
  getEternalEngine?: () => import('@wrongstack/core').EternalAutonomyEngine | null;
  /**
   * Access the (possibly null) parallel-eternal engine. The REPL drives
   * `runOneIteration()` from its main loop when autonomy is 'eternal-parallel'.
   */
  getParallelEngine?: () => import('@wrongstack/core').ParallelEternalEngine | null;
  /**
   * Subscribe to live per-iteration events from the eternal engine.
   * Returns an unsubscribe function. The TUI uses this to render each
   * iteration as a live event entry instead of polling goal.json after
   * the fact. REPL doesn't need it (drives iterations sequentially).
   */
  subscribeEternalIteration?: (
    fn: (entry: import('@wrongstack/core').JournalEntry) => void,
  ) => () => void;
  /**
   * Subscribe to per-iteration stage transitions from the eternal engine.
   * Returns an unsubscribe function. TUI uses this to render live status
   * (decide → execute → reflect → sleep/paused/stopped) in the status bar.
   */
  subscribeEternalStage?: (
    fn: (stage: {
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
    }) => void,
  ) => () => void;
  /** Skill loader for the skill generator wizard. */
  skillLoader?: import('@wrongstack/core').SkillLoader;
}

export async function execute(deps: ExecutionDeps): Promise<number> {
  const {
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
    savedProviderCfg,
    resolvedProvider,
    getPickableProviders,
    switchProviderAndModel,
    director,
    fleetRoster,
    fleetStreamController,
    statuslineHiddenItems,
    setStatuslineHiddenItems,
    agentsMonitorController,
    getYolo,
    getAutonomy,
    onAutonomy,
    getEternalEngine,
    getParallelEngine,
    subscribeEternalIteration,
    subscribeEternalStage,
    skillLoader,
  } = deps;

  let code = 0;
  let fleetStatusLine: FleetStatusLine | null = null;
  try {
    const visionAdapters = () => createToolVisionAdapters(agent.tools);
    const supportsVision = async (): Promise<boolean> => {
      try {
        const caps = await capabilitiesFor(modelsRegistry, context.provider.id, context.model);
        return caps.vision;
      } catch {
        return context.provider.capabilities.vision;
      }
    };
    // --prompt flag takes precedence: treat it like a positional query
    const promptFlag = typeof flags['prompt'] === 'string' ? flags['prompt'] : undefined;
    if (promptFlag) {
      positional.unshift(promptFlag);
    }
    // --goal / --ask boot directly into the TUI in goal/ask mode. The TUI is
    // the only surface with the steering + fleet panel + Esc-redirect wiring
    // that goal mode depends on, so if the user passed a goal but forgot
    // --tui, we flip --tui on for them. Single-shot positional invocation
    // still wins: `wstack --goal X "literal prompt"` runs the positional as
    // a normal single-shot (positional is non-empty), which is consistent
    // with --prompt's existing semantics.
    const goalFlag = typeof flags['goal'] === 'string' ? flags['goal'] : undefined;
    const askFlag = typeof flags['ask'] === 'string' ? flags['ask'] : undefined;
    if ((goalFlag || askFlag) && positional.length === 0 && !promptFlag) {
      flags.tui = true;
    }
    // Live fleet status line for the plain terminal. The TUI owns its own
    // per-agent surface (and Ink owns stdout), so only run this on the
    // non-TUI paths: single-shot, plain REPL, and webui-backed REPL.
    const enteringTui =
      !(positional.length > 0 || promptFlag) && !!flags.tui && flags['no-tui'] !== true;
    if (!enteringTui) {
      fleetStatusLine = new FleetStatusLine({ events, version: CLI_VERSION });
      fleetStatusLine.start();
    }
    if (positional.length > 0 || promptFlag) {
      const query = positional.join(' ');
      const ctrl = new AbortController();
      const onSigint = () => ctrl.abort();
      process.on('SIGINT', onSigint);
      const startedAt = Date.now();
      const before = tokenCounter.total();
      const costBefore = tokenCounter.estimateCost().total;
      let result: import('@wrongstack/core').RunResult;
      try {
        result = await agent.run(query, { signal: ctrl.signal });
      } finally {
        process.off('SIGINT', onSigint);
        // Clean up any lingering bash/exec processes.
        const { getProcessRegistry } = await import('@wrongstack/tools');
        getProcessRegistry().killAll();
      }
      const after = tokenCounter.total();
      const costAfter = tokenCounter.estimateCost().total;
      const usage = {
        input: after.input - before.input,
        output: after.output - before.output,
        iterations: result.iterations,
        cost: costAfter - costBefore,
        elapsedMs: Date.now() - startedAt,
      };
      if (flags['output-json']) {
        const json = JSON.stringify({
          status: result.status,
          finalText: result.finalText ?? null,
          error: result.error
            ? {
                code: result.error.code,
                subsystem: result.error.subsystem,
                severity: result.error.severity,
                recoverable: result.error.recoverable,
                message: result.error.message,
                context: result.error.context ?? null,
              }
            : null,
          usage,
        });
        process.stdout.write(json + '\n');
      } else {
        if (result.status === 'failed') {
          code = 1;
          const err = result.error;
          if (err) {
            const tag = err.recoverable ? ' (recoverable)' : '';
            renderer.writeError(`Failed [${err.severity}]${tag}: ${err.describe()}`);
          } else {
            renderer.writeError('Failed.');
          }
        } else if (result.status === 'aborted') {
          code = 130;
          renderer.writeWarning('Aborted.');
        } else if (result.status === 'max_iterations') {
          code = 1;
          renderer.writeWarning(`Hit max iterations (${result.iterations}).`);
        }
        if (result.finalText) renderer.write('\n' + result.finalText + '\n');
        // Surface any delegate subagent completion banners.
        const r = result as { delegateSummaries?: Array<{ summary: string; ok: boolean }>; messages?: Array<unknown> };
        renderer.writeDelegateSummaries(r);
        renderer.write(
          '\n' +
            color.dim(
              `[in: ${fmtTok(usage.input)}  out: ${fmtTok(usage.output)}  iters: ${usage.iterations}  cost: ${usage.cost.toFixed(4)}  ${(usage.elapsedMs / 1000).toFixed(1)}s]`,
            ) +
            '\n',
        );
      }
    } else if (flags.tui && !flags['no-tui']) {
      // Switch from inline CLI prompts to event-driven confirmation.
      // Without this, the permission prompt writes to stdout and blocks
      // on stdin — both owned by Ink — making the prompt invisible and
      // the input deadlocked. After this call, tool.confirm_needed events
      // fire instead, which the TUI's ConfirmPrompt component handles.
      agent.disableInteractiveConfirmation();
      const { runTui } = await import('@wrongstack/tui') as {
        runTui: (opts: import('@wrongstack/tui').RunTuiOptions) => Promise<number>;
      };
      renderer.setSilent(true);
      const banneredFamily = savedProviderCfg?.family ?? resolvedProvider?.family;
      const banneredKey =
        savedProviderCfg?.apiKey ??
        config.apiKey ??
        (resolvedProvider?.envVars ?? savedProviderCfg?.envVars ?? [])
          .map((v) => process.env[v])
          .find((v): v is string => !!v);
      const banneredKeyTail =
        banneredKey && banneredKey.length >= 3 ? banneredKey.slice(-3) : undefined;

      // AutoPhase event forwarding — subscribes to PhaseOrchestrator events
      // on the main EventBus and forwards them to the TUI handler so the
      // PhaseMonitor/PhasePanel stay in sync with the running graph.
      const autoPhaseHandlers = new Map<string, (payload: unknown) => void>();
      const subscribeAutoPhase = (
        handler: (event: string, payload: unknown) => void,
      ): (() => void) => {
        const registrations: Array<() => void> = [];
        const autoPhaseEvents = [
          'phase.started',
          'phase.completed',
          'phase.failed',
          'phase.statusChange',
          'phase.taskCompleted',
          'phase.taskFailed',
          'phase.taskRetrying',
          'autonomous.tick',
          'graph.completed',
          'graph.failed',
          'agent.assigned',
          'agent.released',
        ];
        // AutoPhase events are emitted on the untyped surface of the bus
        // (the orchestrator casts `emit` to a string-keyed signature), so we
        // subscribe through the same untyped view rather than the typed
        // event-name overloads.
        const onUntyped = events.on as unknown as (
          event: string,
          handler: (payload: unknown) => void,
        ) => void;
        const offUntyped = events.off as unknown as (
          event: string,
          handler: (payload: unknown) => void,
        ) => void;
        for (const ev of autoPhaseEvents) {
          const h = (p: unknown) => handler(ev, p);
          autoPhaseHandlers.set(ev, h);
          onUntyped(ev, h);
          registrations.push(() => offUntyped(ev, h));
        }
        return () => {
          for (const unregister of registrations) unregister();
          autoPhaseHandlers.clear();
        };
      };

      try {
        code = await runTui({
          agent,
          events,
          slashRegistry,
          attachments,
          tokenCounter,
          visionAdapters,
          supportsVision,
          model: context.model,
          banner: !flags['no-banner'],
          queueStore,
          yolo: !!config.yolo,
          getYolo,
          getAutonomy,
          getEternalEngine,
          subscribeEternalIteration,
          subscribeEternalStage,
          subscribeAutoPhase,
          appVersion: CLI_VERSION,
          provider: config.provider,
          family: banneredFamily,
          keyTail: banneredKeyTail,
          getPickableProviders,
          switchProviderAndModel,
          switchAutonomy: (mode: 'off' | 'suggest' | 'auto' | 'eternal' | 'eternal-parallel') => {
            onAutonomy?.(mode);
            return null;
          },
          effectiveMaxContext,
          // Default OFF so the terminal's native scrollback works for chat
          // history out of the box (mouse wheel / Shift+PgUp). Users who hit
          // resize/overlay-leak artifacts can opt back into alt-screen with
          // `--alt-screen` or `/altscreen on`. `--no-alt-screen` still wins
          // when both are passed.
          altScreen: flags['alt-screen'] === true && flags['no-alt-screen'] !== true,
          director,
          fleetRoster,
          onAfterExit: () => {
            process.stdout.write(
              color.dim(`Session saved: ${session.id} — resume with `) +
                color.cyan(`wstack resume ${session.id}`) +
                '\n',
            );
          },
          onClearHistory: (dispatch: (action: { type: 'clearHistory' } | { type: 'resetContextChip' }) => void) => {
            dispatch({ type: 'clearHistory' });
            dispatch({ type: 'resetContextChip' });
          },
          fleetStreamController,
          statuslineHiddenItems,
          setStatuslineHiddenItems,
          agentsMonitorController,
          initialGoal: goalFlag,
          initialAsk: askFlag,
          projectRoot,
          getSDDContext: () => {
            const { getActiveSDDContext } = require('./slash-commands/sdd.js');
            return getActiveSDDContext();
          },
          onSDDOutput: async (output: string) => {
            const { trySaveSpecFromAIOutput, trySaveImplementationPlan, trySaveTasksFromAIOutput, autoDetectTaskCompletion, getTaskProgress, getActiveSDDPhase } = require('./slash-commands/sdd.js');
            const messages: string[] = [];
            const specSaved = await trySaveSpecFromAIOutput(output);
            if (specSaved) messages.push('✓ Spec detected and saved! Use /sdd approve to continue.');
            const planSaved = trySaveImplementationPlan(output);
            if (planSaved) messages.push('✓ Implementation plan saved!');
            const tasksSaved = await trySaveTasksFromAIOutput(output);
            if (tasksSaved) {
              const progress = getTaskProgress();
              const count = progress?.total ?? 0;
              messages.push(`✓ ${count} tasks detected and saved! Use /sdd approve to execute.`);
            }
            const sddPhase = getActiveSDDPhase();
            if (sddPhase === 'executing') {
              const autoCompleted = autoDetectTaskCompletion(output);
              if (autoCompleted > 0) {
                const progress = getTaskProgress();
                if (progress) {
                  messages.push(`✓ ${autoCompleted} task(s) auto-completed! Progress: ${progress.completed}/${progress.total} (${progress.percentComplete}%)`);
                }
              }
            }
            return messages;
          },
        });
      } finally {
        renderer.setSilent(false);
      }
    } else if (flags.webui) {
      const { runWebUI } = await import('./webui-server.js');
      const webuiPromise = runWebUI({
        agent,
        events,
        session,
        port: Number.parseInt(String(flags.port ?? '3457'), 10),
        modelsRegistry,
        globalConfigPath: wpaths.globalConfig,
        subscribeEternalIteration,
      });
      try {
        code = await runRepl({
          agent,
          renderer,
          reader,
          slashRegistry,
          tokenCounter,
          visionAdapters,
          supportsVision,
          attachments,
          effectiveMaxContext,
          projectName: path.basename(projectRoot) || undefined,
          projectRoot,
          getAutonomy,
          onAutonomy,
          getEternalEngine,
          getParallelEngine,
          skillLoader,
          agentsMonitorController,
          fleetStreamController,
        });
      } finally {
        // webuiPromise must be awaited regardless of whether runRepl threw,
        // so the HTTP/WS server can shut down cleanly.
        await webuiPromise.catch(() => undefined);
      }
    } else {
      code = await runRepl({
        agent,
        renderer,
        reader,
        slashRegistry,
        tokenCounter,
        visionAdapters,
        supportsVision,
        attachments,
        effectiveMaxContext,
        projectName: path.basename(projectRoot) || undefined,
        getAutonomy,
        onAutonomy,
        getEternalEngine,
        getParallelEngine,
        skillLoader,
        agentsMonitorController,
        fleetStreamController,
      });
    }
  } finally {
    // Tear down the live fleet status line first so the scroll region is
    // restored before any end-of-session output prints.
    fleetStatusLine?.stop();
    // stats.render is synchronous but can throw — isolate it so cleanup
    // always runs regardless.
    try { stats.render(renderer); } catch (err) { /* best-effort */ }
    await Promise.resolve(detachTodosCheckpoint?.()).catch(() => undefined);
    await mcpRegistry.stopAll();
    await session.append({
      type: 'session_end',
      ts: new Date().toISOString(),
      usage: tokenCounter.total(),
    });
    await session.close();
    await recoveryLock.clear().catch(() => undefined);
    await reader.close();
  }
  return code;
}
