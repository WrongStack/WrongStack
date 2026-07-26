import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { DirectorStateCheckpoint, type DirectorStateSnapshot } from '../storage/director-state.js';
import type { BridgeMessage } from '../types/agent-bridge.js';
import type { Logger } from '../types/logger.js';
import type {
  AwaitAnyResult,
  CoordinatorStatus,
  SubagentConfig,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import type { SessionWriter } from '../types/session.js';
import type { Tool } from '../types/tool.js';
import { toErrorMessage } from '../utils/error.js';
import { safeStringify } from '../utils/safe-json.js';
import {
  acquireCheckpointLock as acquireDirectorCheckpointLock,
  appendSessionEvent as appendDirectorSessionEvent,
  resumeFromCheckpoint as resumeDirectorFromCheckpoint,
  scheduleManifest as scheduleDirectorManifest,
  setCheckpointState as setDirectorCheckpointState,
  writeManifest as writeDirectorManifest,
  type DirectorCheckpointHost,
} from './checkpoint-wiring.js';
import { InMemoryAgentBridge } from './agent-bridge.js';
import type { CollabDebugReport, CollabSessionOptions } from './collab-debug.js';
import { DirectorBtwNotes } from './director/director-btw-notes.js';
import { DirectorBudgetPolicy } from './director/director-budget-policy.js';
import { DirectorCollabController } from './director/director-collab.js';
import { FleetSpawnBudgetError } from './director/director-errors.js';
import { DirectorTaskRegistry } from './director/director-task-registry.js';
import type { DirectorOptions } from './director-options.js';
import {
  composeDirectorPrompt,
  composeSubagentPrompt,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  rosterSummaryFromConfigs,
} from './director-prompts.js';
import { buildDirectorToolset } from './director/director-toolset.js';
import { FleetBus, type FleetUsage, FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import { type DirectorFleetHost, spawn as fleetSpawn, type ManifestEntry } from './fleet-spawn.js';
import type { ICoordinator } from './icoordinator.js';
import { InMemoryBridgeTransport } from './in-memory-transport.js';
import { LargeAnswerStore } from './large-answer-store.js';
import { resolveDirectorSpawnModel } from './director-spawn-model.js';
import { type ModelMatrixSource } from './model-matrix.js';
import { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import type { ProviderModelStatusTracker } from './provider-status-tracker.js';
import { resolveMaxSpawnDepth } from './spawn-budget.js';
import { nicknameKeyFromDisplay } from './subagent-nicknames.js';
import { type WorktreeTaskStateUpdate, wrapSubagentRunnerWithWorktrees } from './worktree-task-runner.js';
import {
  readDirectorSubagentSession,
  type DirectorSubagentSessionSummary,
} from './director-session.js';

/**
 * Director — high-level orchestrator that owns a `MultiAgentCoordinator`,
 * a `FleetBus`, and a `FleetUsageAggregator`. Exposes a small imperative
 * API (`spawn`, `assign`, `awaitTasks`, `terminate`, `status`, `usage`)
 * that's easy to test, and a `tools()` factory that wraps the same API
 * as agent-callable `Tool`s so an LLM can drive the orchestration.
 *
 * This class is intentionally *not* an `Agent`. It's a coordinator +
 * observability surface. To make it LLM-driven, construct an Agent
 * with `director.tools()` registered. That keeps the construction
 * symmetric with how other agents are built and avoids smuggling a
 * heavy LLM dependency into core just for the director path.
 */
// Re-exported from director-errors.ts for backward compatibility
export {
  FleetContextOverflowError,
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
} from './director/director-errors.js';
/** @deprecated Import from model-matrix.ts; retained for public compatibility. */
export type { ModelMatrixSource } from './model-matrix.js';
export type { DirectorOptions, TaskResultNotification } from './director-options.js';

export class Director implements DirectorFleetHost, ICoordinator {
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars — just a cast helper */
  private static _asManifestEntry(v: unknown): ManifestEntry {
    return v as ManifestEntry;
  }
  /** Alias for the ICoordinator contract. `id` is retained for backward compatibility. */
  get coordinatorId(): string {
    return this.id;
  }
  readonly id: string;
  /**
   * The fleet event bus. Backed by `fleetManager?.fleet` when a FleetManager
   * is injected; otherwise own FleetBus instance (preserves existing behavior).
   */
  readonly fleet: FleetBus;
  /**
   * Usage rollup. Backed by `fleetManager?.usage` when a FleetManager is
   * injected; otherwise own FleetUsageAggregator.
   */
  readonly usage: FleetUsageAggregator;

  /**
   * Update the leader agent's current context pressure (full request tokens:
   * messages + systemPrompt + toolDefs). The director checks this before every
   * spawn — if the pressure exceeds `maxLeaderContextLoad * maxContext`,
   * spawning is refused with a `FleetContextOverflowError`.
   *
   * Call this after each leader agent iteration to keep the pressure current.
   * The compactor's `CompactReport.fullRequestTokensAfter` is a natural source.
   */
  setLeaderContextPressure(tokens: number): void {
    this.leaderContextPressure = tokens;
    // Mirror to FleetManager when available so the check is centralized.
    this.fleetManager?.setLeaderContextPressure(tokens);
  }

  /**
   * Read the leader agent's current context pressure.
   */
  getLeaderContextPressure(): number {
    return this.leaderContextPressure;
  }

  /**
   * Remaining USD budget for the entire fleet (when a cap is configured).
   * Returns `undefined` when no cap was set (Infinity).
   */
  getRemainingBudgetUsd(): number | undefined {
    if (this.maxFleetCostUsd === Number.POSITIVE_INFINITY) return undefined;
    const totalCost = this.usage.snapshot().total?.cost ?? 0;
    return Math.max(0, this.maxFleetCostUsd - totalCost);
  }

  resolveMaxContext(): number {
    const resolved = typeof this.maxContext === 'function' ? this.maxContext() : this.maxContext;
    return resolved && resolved > 0 ? resolved : 128_000;
  }

  private currentSessionId(): string | undefined {
    const value =
      typeof this.sessionIdSource === 'function' ? this.sessionIdSource() : this.sessionIdSource;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  private checkpointHost(): DirectorCheckpointHost {
    return {
      id: this.id,
      manifestPath: this.manifestPath,
      manifestDebounceMs: this.manifestDebounceMs,
      stateCheckpoint: this.stateCheckpoint,
      sessionWriter: this.sessionWriter,
      usage: this.usage,
      manifestEntries: this.manifestEntries,
      completedResult: (taskId) => this.tasks.completedResult(taskId),
      logShutdownError: (phase, err) => this.logShutdownError(phase, err),
      onManifestTimerFired: () => {
        this.manifestTimer = null;
      },
    };
  }
  /**
   * Optional fleet-level policy container. When provided the Director
   * delegates spawn budgeting, manifest entries, and checkpointing to it
   * instead of managing those internally. All other behavior is unchanged.
   */
  readonly fleetManager: FleetManager | undefined;
  /**
   * Director-side bridge endpoint. Subagents are wired to the same
   * in-memory transport so the director can `ask()` them synchronously
   * and they can `send()` progress back. Exposed so external code (e.g.
   * the TUI) can subscribe to inbound messages.
   */
  readonly bridge: InMemoryAgentBridge;
  readonly transport: InMemoryBridgeTransport;
  readonly coordinator: DefaultMultiAgentCoordinator;
  /** Canonical task identity, ownership, result cache, and waiter state. */
  private readonly tasks: DirectorTaskRegistry;
  /** Per-subagent provider/model metadata, captured at spawn time so the
   *  FleetUsageAggregator's metaLookup can surface readable rows. */
  readonly subagentMeta = new Map<
    string,
    { provider?: string | undefined; model?: string | undefined }
  >();
  readonly priceLookups = new Map<
    string,
    {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    }
  >();
  /** Bridge endpoints we created per subagent (so we can `stop()` them
   *  on shutdown and free transport subscriptions). */
  readonly subagentBridges = new Map<string, InMemoryAgentBridge>();
  /** Tracks per-spawn config + assigned task ids for manifest writing. */
  readonly manifestEntries = new Map<string, unknown>();
  /** Tracks assigned nicknames so the same name is never reused in one fleet. */
  readonly usedNicknames = new Set<string>();
  private readonly manifestPath?: string | undefined;
  private readonly roster?: Record<string, SubagentConfig> | undefined;
  private readonly directorPreamble: string;
  private readonly subagentBaseline: string;
  /** See {@link DirectorOptions.taskResultNotifier}. */
  private readonly taskResultNotifier?: DirectorOptions['taskResultNotifier'];
  private readonly subagentIdleTimeoutMs: number | undefined;
  private readonly retireSubagentOnTaskComplete: boolean;
  private readonly subagentIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Absolute path to the fleet's shared scratchpad directory, or null
   *  when none was configured. Exposed as a readonly getter for callers
   *  that need to surface the path to the user (e.g. the CLI logging
   *  the location after `--director` boots). */
  readonly sharedScratchpadPath: string | null;
  /** Spawn cap (lifetime total). Infinity means unlimited. */
  readonly maxSpawns: number;
  /** Nesting cap. The N-th director in a chain has `spawnDepth = N-1`. */
  readonly maxSpawnDepth: number;
  /** This director's position in a director chain. Root director = 0. */
  readonly spawnDepth: number;
  /** Live spawn counter for `maxSpawns` enforcement. */
  spawnCount = 0;
  /** Optional checkpoint mirror — writes the live task graph + roster to disk. */
  readonly stateCheckpoint: DirectorStateCheckpoint | null;
  /** Optional session writer for emitting task_* / agent_* lifecycle events. */
  private readonly sessionWriter: SessionWriter | null;
  private readonly sessionIdSource: string | (() => string | undefined) | undefined;
  /** Debounce timer for periodic manifest writes. */
  private manifestTimer: NodeJS.Timeout | null = null;
  private manifestWriteChain: Promise<unknown> = Promise.resolve();
  private readonly manifestDebounceMs: number;
  /** Fleet-wide cost cap (entire fleet total, distinct from SubagentBudget limits). Infinity means no cap. */
  readonly maxFleetCostUsd: number;
  /** Fleet-wide input+output token cap. Infinity means no cap. */
  readonly maxFleetTokens: number;
  /** Sessions root for direct subagent JSONL reads (fleet tool, action: session). */
  private readonly sessionsRoot?: string | undefined;
  /** Director run id for JSONL path resolution. */
  private readonly directorRunId: string;
  /** Optional logger for structured logging. Falls back to noop when omitted. */
  private readonly logger: Logger | undefined;
  /** Latest worktree state per task id (allocated/committed/merged/conflict/etc.). */
  readonly taskWorktrees = new Map<string, WorktreeTaskStateUpdate>();
  /** Budget admission, progress heartbeat, and extension authority. */
  private readonly budgetPolicy: DirectorBudgetPolicy;
  /**
   * Handle to the coordinator-side `task.completed` listener so we can
   * unsubscribe in `shutdown()`. Without this, repeated Director
   * construction (e.g. tests, hot reloads) accumulates listeners on a
   * cached coordinator and slowly drifts the EventEmitter past its
   * default cap.
   */
  private taskCompletedListener:
    | ((payload: { task: TaskSpec; result: TaskResult }) => void)
    | null = null;
  /**
   * Unsub handles for the two `FleetBus.filter()` calls installed in the
   * constructor for timeout-heartbeat tracking. Without capturing these
   * and calling them in `shutdown()`, repeated Director construction
   * (tests, hot reloads, `--director` restarts) accumulates 2 dangling
   * listeners per Director on the FleetBus, slowly drifting the
   * EventEmitter past its default cap. Mirrors the rationale on
   * `taskCompletedListener` above.
   */
  /** Optional LLM classifier for smart dispatch. Passed from options. */
  readonly dispatchClassifier?:
    | import('../coordination/dispatcher.js').DispatchClassifier
    | undefined;
  /** Leader agent's current context pressure (full request tokens). */
  leaderContextPressure = 0;
  /** Maximum context load fraction before spawn is refused. */
  readonly maxLeaderContextLoad: number;
  /** Provider's max context window in tokens, or a live resolver for runtime model switches. */
  private readonly maxContext: number | (() => number | undefined);
  /** Per-task model matrix (static record or live getter); resolved
   *  per-spawn when no explicit model is set. */
  readonly modelMatrix?: ModelMatrixSource | undefined;
  /**
   * When set by `workComplete()`, the director stops dispatching new tasks
   * and terminates all running subagents. Used when the director's LLM decides
   * the goal is satisfied and no further spawns are needed — prevents the
   * coordinator from keeping workers alive for tasks that will never arrive.
   */
  workCompleteFlag = false;
  /** Pending /btw notes stashed by the leader agent (see setLeaderBtwNote).
   *  Owned by DirectorBtwNotes (R4); the public btw methods delegate to it. */
  private readonly btwNotes = new DirectorBtwNotes();
  /** Owns active collab-debug sessions (spawn/cancel/alert/list). Extracted
   *  from Director in R4; the public collab methods below delegate to it. */
  private readonly collab: DirectorCollabController;
  /** Prevents large `ask_subagent` answers from bloating the leader's context window. */
  readonly largeAnswerStore: LargeAnswerStore;
  /** Shared provider/model status tracker, or undefined. */
  private readonly statusTracker: ProviderModelStatusTracker | undefined;
  /** Session/leader's provider id — absolute last-resort fallback for every spawn. */
  private readonly sessionProvider: string | undefined;
  /** Session/leader's model id — paired with sessionProvider above. */
  private readonly sessionModel: string | undefined;

  constructor(opts: DirectorOptions) {
    this.id = opts.config.coordinatorId || randomUUID();
    this.manifestPath = opts.manifestPath;
    this.roster = opts.roster;
    this.directorPreamble = opts.directorPreamble ?? DEFAULT_DIRECTOR_PREAMBLE;
    this.subagentBaseline = opts.subagentBaseline ?? DEFAULT_SUBAGENT_BASELINE;
    this.taskResultNotifier = opts.taskResultNotifier;
    this.subagentIdleTimeoutMs =
      typeof opts.subagentIdleTimeoutMs === 'number' &&
      Number.isFinite(opts.subagentIdleTimeoutMs) &&
      opts.subagentIdleTimeoutMs >= 0
        ? opts.subagentIdleTimeoutMs
        : undefined;
    this.retireSubagentOnTaskComplete = opts.retireSubagentOnTaskComplete ?? true;
    this.sharedScratchpadPath = opts.sharedScratchpadPath ?? null;
    this.maxSpawns = opts.maxSpawns ?? Number.POSITIVE_INFINITY;
    this.maxSpawnDepth =
      opts.fleetManager?.maxSpawnDepth ?? resolveMaxSpawnDepth(opts.maxSpawnDepth);
    this.spawnDepth = opts.fleetManager?.spawnDepth ?? opts.spawnDepth ?? 0;
    this.sessionWriter = opts.sessionWriter ?? null;
    this.sessionIdSource = opts.sessionId ?? (() => opts.sessionWriter?.id);
    this.manifestDebounceMs = opts.manifestDebounceMs ?? 2000;
    this.dispatchClassifier = opts.dispatchClassifier;
    this.maxFleetCostUsd = opts.directorBudget?.maxCostUsd ?? Number.POSITIVE_INFINITY;
    this.maxFleetTokens = opts.directorBudget?.maxTokens ?? Number.POSITIVE_INFINITY;
    this.maxLeaderContextLoad = opts.maxLeaderContextLoad ?? 0.85;
    this.maxContext = opts.maxContext ?? 128_000;
    this.modelMatrix = opts.modelMatrix;
    this.sessionsRoot = opts.sessionsRoot;
    this.directorRunId = opts.directorRunId ?? this.id;
    this.stateCheckpoint = opts.stateCheckpointPath
      ? new DirectorStateCheckpoint(
          opts.stateCheckpointPath,
          {
            directorRunId: this.id,
            maxSpawns: opts.maxSpawns,
            spawnDepth: this.spawnDepth,
            maxSpawnDepth: this.maxSpawnDepth,
            directorBudget: opts.directorBudget,
          },
          opts.checkpointDebounceMs ?? 250,
        )
      : null;
    this.fleetManager = opts.fleetManager;
    this.statusTracker = opts.statusTracker;
    this.logger = opts.logger;
    this.sessionProvider = opts.sessionProvider;
    this.sessionModel = opts.sessionModel;
    if (this.sharedScratchpadPath) {
      // Create the directory eagerly so subagents that try to write
      // there on first iteration don't trip on ENOENT. Fire-and-forget,
      // but surface failures via process.emitWarning — the downstream
      // ENOENT a subagent hits is opaque without this signal.
      void fsp
        .mkdir(this.sharedScratchpadPath, { recursive: true })
        .catch((err) => this.logShutdownError('shared_scratchpad_mkdir', err));
    }
    this.transport = new InMemoryBridgeTransport();
    this.bridge = new InMemoryAgentBridge(
      { agentId: this.id, coordinatorId: this.id },
      this.transport,
    );
    // Delegate to FleetManager when injected; otherwise create own instances
    // (preserves existing behavior for callers that don't pass fleetManager).
    if (this.fleetManager) {
      this.fleet = this.fleetManager.fleet;
      this.usage = this.fleetManager.usage;
    } else {
      this.fleet = new FleetBus();
      this.usage = new FleetUsageAggregator(
        this.fleet,
        (_id, provider, model) => {
          if (provider && model) return this.priceLookups.get(`${provider}/${model}`);
          return undefined;
        },
        (id) => this.subagentMeta.get(id),
      );
    }
    const runner =
      opts.runner && (opts.worktrees || opts.worktreePolicy)
        ? wrapSubagentRunnerWithWorktrees({
            runner: opts.runner,
            worktrees: opts.worktrees,
            policy: opts.worktreePolicy,
            conflictResolver: opts.worktreeConflictResolver,
            onUpdate: (update) => this.recordWorktreeTaskUpdate(update),
          })
        : opts.runner;
    this.coordinator = new DefaultMultiAgentCoordinator(
      { ...opts.config, coordinatorId: this.id },
      { runner, sessionId: () => this.currentSessionId() },
    );
    this.coordinator.setFleetBus(this.fleet);
    this.fleetManager?.setCoordinator(this.coordinator);
    this.tasks = new DirectorTaskRegistry({
      coordinator: this.coordinator,
      stateCheckpoint: this.stateCheckpoint,
      isWorkComplete: () => this.workCompleteFlag,
      addTaskToManifest: (subagentId, taskId) => {
        if (this.fleetManager) {
          this.fleetManager.addTaskToSubagent(subagentId, taskId);
          return;
        }
        const entry = Director._asManifestEntry(this.manifestEntries.get(subagentId));
        if (entry && !entry.taskIds.includes(taskId)) entry.taskIds.push(taskId);
      },
      recordPendingTask: (taskId, subagentId, description) =>
        this.fleetManager?.addPendingTask(taskId, subagentId, description),
      appendSessionEvent: (event) => this.appendSessionEvent(event),
      scheduleManifest: () => this.scheduleManifest(),
      getSubagentMeta: (subagentId) => this.subagentMeta.get(subagentId),
    });
    // Mirror coordinator completion events into the waiter table. This
    // lets `awaitTasks([...])` resolve on the *next* completion event
    // without polling — and the `completed` cache covers the case where
    // a caller asks after the fact.
    //
    // The listener is captured in a field (`taskCompletedListener`) so
    // `shutdown()` can `coordinator.off(...)` it cleanly — otherwise
    // repeated Director construction against a cached coordinator
    // (tests, hot reloads) leaks listeners and eventually trips
    // EventEmitter's max-listener warning.
    this.taskCompletedListener = (payload) => this.handleTaskCompleted(payload);
    this.coordinator.on('task.completed', this.taskCompletedListener);

    // Collab controller first so the budget policy can ask it whether a
    // threshold event belongs to an active collab session (and should be
    // left alone) or a plain delegate of a collab-named role (must extend).
    this.collab = new DirectorCollabController({
      director: this,
      fleet: this.fleet,
      coordinator: this.coordinator,
      logger: this.logger,
    });
    this.budgetPolicy = new DirectorBudgetPolicy({
      fleet: this.fleet,
      usage: this.usage,
      brain: opts.brain,
      maxBudgetExtensions: opts.maxBudgetExtensions ?? 12,
      maxFleetCostUsd: this.maxFleetCostUsd,
      currentSessionId: () => this.currentSessionId(),
      isCollabOwned: (subagentId) => this.collab.ownsSubagent(subagentId),
    });
    this.budgetPolicy.start();
    // Large-answer store: prevents big `ask_subagent` responses from
    // bloating the leader's context window. Responses above 2K chars
    // are stored out-of-band; only a summary goes into ctx.messages.
    this.largeAnswerStore = new LargeAnswerStore(2000);
  }

  private handleTaskCompleted(payload: { task: TaskSpec; result: TaskResult }): void {
    const r = payload.result;
    const settled = this.tasks.settle(r);
    if (settled.internal) return;
    // Mirror into the on-disk checkpoint + session event stream so a
    // crashed director leaves a complete picture of which tasks landed.
    const title = this.tasks.descriptionFor(r.taskId, payload.task.description ?? r.taskId);
    // Fire-and-forget report-back: this result is not being returned
    // in-band (no batch waiter, not the winning result of an any-await),
    // so it would otherwise sit in the cache until the leader polls.
    // Hand it to the notifier (host wires this to the project mailbox,
    // which injects it into the leader's conversation before its next
    // step). In-band-consumed tasks skip this — their result returns
    // directly from await_tasks.
    if (!settled.consumedInBand && this.taskResultNotifier) {
      const resultText =
        typeof r.result === 'string'
          ? r.result
          : r.result !== undefined
            ? safeStringify(r.result)
            : undefined;
      try {
        void Promise.resolve(
          this.taskResultNotifier({
            taskId: r.taskId,
            title,
            status: r.status,
            subagentId: r.subagentId,
            subagentName: Director._asManifestEntry(this.manifestEntries.get(r.subagentId))?.name,
            resultText,
            errorText: r.error ? `${r.error.kind}: ${r.error.message}` : undefined,
            partialText: r.partial?.text,
            report: r.report,
            iterations: r.iterations,
            toolCalls: r.toolCalls,
            durationMs: r.durationMs,
          }),
        ).catch(() => {});
      } catch {
        // Notifier failures must never disturb task-completion bookkeeping.
      }
    }
    const failed = r.status !== 'success';
    // Disk-side state-checkpoint and session JSONL both store `error`
    // as a string for historical reasons. The structured SubagentError
    // envelope carries `kind`, `message`, `retryable`, etc. — flatten
    // to a `kind: message` string here so old readers stay valid and
    // grep-friendly. The full envelope is still available live via
    // the EventBus / TaskResult to in-process consumers.
    const errorString = r.error ? `${r.error.kind}: ${r.error.message}` : undefined;
    this.stateCheckpoint?.recordTaskStatus(r.taskId, {
      status: failed ? (r.status as 'failed' | 'timeout' | 'stopped') : 'completed',
      completedAt: new Date().toISOString(),
      iterations: r.iterations,
      toolCalls: r.toolCalls,
      durationMs: r.durationMs,
      error: errorString,
    });
    this.stateCheckpoint?.setUsage(this.usage.snapshot());
    void this.appendSessionEvent(
      failed
        ? {
            type: 'task_failed',
            ts: new Date().toISOString(),
            taskId: r.taskId,
            title,
            error: errorString ?? r.status,
          }
        : {
            type: 'task_completed',
            ts: new Date().toISOString(),
            taskId: r.taskId,
            title,
          },
    );
    // task_failed pins the failure to the task; agent_error pins it to the
    // agent, which is what the replay timeline renders per-subagent.
    if (failed) {
      void this.appendSessionEvent({
        type: 'agent_error',
        ts: new Date().toISOString(),
        agentId: r.subagentId,
        error: errorString ?? r.status,
      });
    }
    // Flush immediately on task completion — the result should be
    // visible in the manifest without waiting for the debounce window.
    // Use flushManifest() so any pending debounce timer is also cleared.
    if (this.fleetManager) {
      void this.fleetManager.flushManifest();
    } else {
      this.scheduleManifest();
    }
    this.armSubagentIdleRetirement(
      r.subagentId,
      this.retireSubagentOnTaskComplete ? 0 : this.subagentIdleTimeoutMs,
    );
  }

  /** Cumulative auto-extension count for one subagent (0 when never extended). */
  extensionsFor(subagentId: string): number {
    return this.budgetPolicy.extensionsFor(subagentId);
  }

  /**
   * Signal that the director's work is done. Once called:
   * - `spawn()` throws `FleetSpawnBudgetError('max_spawns', …)` — no new
   *   subagents can be created
   * - Running subagents are NOT forcibly stopped — they finish naturally,
   *   but no new tasks are dispatched to them
   *
   * This lets the director LLM say "I'm satisfied with the results, stop
   * spawning and wind down" — without killing in-flight work mid-execution.
   * Call `terminateAll()` separately if you need immediate teardown.
   *
   * Idempotent — calling twice is a no-op.
   */
  workComplete(): void {
    this.workCompleteFlag = true;
    this.fleet.emit({
      subagentId: this.id,
      ts: Date.now(),
      type: 'director.work_complete',
      payload: {},
    });
  }

  /** Returns true if `workComplete()` has been called on this director. */
  isWorkComplete(): boolean {
    return this.workCompleteFlag;
  }

  /**
   * Stashes a /btw note on the leader agent's context. The leader's agent loop
   * calls `consumeBtwNotes()` at each iteration boundary and folds pending notes
   * into the conversation as a visible block — no abort, no restart, just a
   * "by the way" nudge the model picks up on its next turn.
   *
   * This is the entry point for the host (CLI, TUI) to inject /btw notes
   * programmatically without going through the slash-command path.
   */
  setLeaderBtwNote(note: string): number {
    return this.btwNotes.add(note);
  }

  /**
   * Read and clear all pending /btw notes the leader has stashed.
   * Returns them in FIFO order (empty array when none).
   *
   * Called by CollabSession when a budget threshold event fires so the
   * Director can inspect accumulated /btw notes before deciding whether
   * to cancel the collab session or let it continue.
   */
  getLeaderBtwNotes(): string[] {
    return this.btwNotes.drain();
  }

  /**
   * Peek at pending /btw notes without consuming them.
   * Useful for UI to show "N pending notes" without clearing them.
   */
  peekLeaderBtwNotes(): string[] {
    return this.btwNotes.peek();
  }

  /**
   * Drain (read + clear) all /btw notes in one call.
   * Alias for getLeaderBtwNotes() — kept for symmetry with consumeBtwNotes()
   * in the agent's btw.ts. The Director calls this at the point where it
   * makes a cancellation decision, not on every budget event.
   */
  drainLeaderBtwNotes(): string[] {
    return this.getLeaderBtwNotes();
  }

  /**
   * Cancel an active collab session by its id.
   * Emits `director.cancel_collab` on the FleetBus so the session's agents
   * finish early with a 'cancelled' disposition.
   *
   * Returns silently if the session id is not tracked or already settled.
   * The CollabDebugReport will reflect 'cancelled' disposition when awaited.
   */
  cancelCollabSession(sessionId: string, reason = 'Director cancelled'): void {
    this.collab.cancel(sessionId, reason);
  }

  /**
   * Subscribe a callback to be notified whenever a collab session raises
   * an alert (warning level). The callback receives the full DirectorAlert
   * payload so the host (CLI, TUI) can display it to the user.
   * Returns an unsubscribe function.
   */
  onCollabAlert(handler: (alert: import('./collab-debug.js').DirectorAlert) => void): () => void {
    return this.collab.onAlert(handler);
  }

  /**
   * Returns all active (not yet settled) collab session ids.
   * Useful for the TUI to render a "N active sessions" badge and for
   * the host to know what can be cancelled.
   */
  activeCollabSessions(): string[] {
    return this.collab.activeSessionIds();
  }

  /** Best-effort session-writer append. Swallows failures — the director
   *  must not break a fleet run because the session JSONL handle closed. */
  async appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void> {
    await appendDirectorSessionEvent(this.checkpointHost(), event);
  }

  /** Debounced manifest writer. A burst of spawn/assign/complete events
   *  collapses into one write. Set `manifestDebounceMs` to 0 to write
   *  synchronously (no debounce); set to negative to disable entirely. */
  scheduleManifest(): void {
    if (this.manifestTimer) return;
    this.manifestTimer = scheduleDirectorManifest(this.checkpointHost());
  }

  private clearManifestTimer(): void {
    if (!this.manifestTimer) return;
    clearTimeout(this.manifestTimer);
    this.manifestTimer = null;
  }

  private recordWorktreeTaskUpdate(update: WorktreeTaskStateUpdate): void {
    this.taskWorktrees.set(update.taskId, update);
    const owner = this.tasks.ownerFor(update.taskId) ?? update.subagentId;
    const entry = Director._asManifestEntry(this.manifestEntries.get(owner));
    if (entry) {
      entry.worktrees = { ...(entry.worktrees ?? {}), [update.taskId]: update };
    }
    this.stateCheckpoint?.recordTaskWorktree(update.taskId, update);
    this.fleetManager?.recordTaskWorktree(update);
    if (!this.fleetManager) this.scheduleManifest();
  }

  /**
   * Spawn a subagent. Delegates the core spawn mechanics to `fleetSpawn()`
   * in fleet-spawn.ts which is the single source of truth for spawn logic.
   * Director-specific pre-processing (session fallback, status tracker) runs
   * before delegation; idle-retirement arming runs after.
   *
   * Task assignment, ownership, result retention, and waiting are owned by
   * DirectorTaskRegistry; this method delegates spawn admission to fleet-spawn.
   *
   * Caller-supplied `priceLookup` is optional but recommended — without
   * it the `cost` column in `usage.snapshot()` stays at 0.
   */
  async spawn(
    callerConfig: SubagentConfig,
    priceLookup?: {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    },
  ): Promise<string> {
    // Fail fast when workComplete was called — avoids the cost of
    // resolveSpawnModel when the director is already winding down.
    if (this.workCompleteFlag) {
      throw new FleetSpawnBudgetError(
        'max_spawns',
        this.maxSpawns,
        this.spawnCount + 1,
        'workComplete() has been called — director closed further spawning',
      );
    }
    // Clone the caller's config before any mutation. fleetSpawn rewrites
    // model/provider (model matrix) and name (nickname); doing that on
    // the caller's object would make a reused SubagentConfig "stick" to the
    // first spawn's resolved model/nickname. A shallow copy is enough.
    const config: SubagentConfig = { ...callerConfig };
    // Director-specific pre-processing: session fallback + status tracker
    // (fleetSpawn handles model matrix resolution, caps, nickname, and lineage).
    this.resolveSpawnModel(config);
    // Delegate everything else to the single source of truth.
    const subagentId = await fleetSpawn(this, config, priceLookup);
    // Post-processing: idle-retirement timer.
    this.armSubagentIdleRetirement(subagentId, this.subagentIdleTimeoutMs);
    return subagentId;
  }

  private resolveSpawnModel(config: SubagentConfig): void {
    resolveDirectorSpawnModel(config, {
      modelMatrix: this.modelMatrix,
      sessionProvider: this.sessionProvider,
      sessionModel: this.sessionModel,
      statusTracker: this.statusTracker,
      logger: this.logger,
    });
  }

  // NOTE: enforceSpawnCaps, assignSpawnNickname, applySpawnLineage were
  // extracted to fleet-spawn.ts — see Director.spawn() which delegates
  // to fleetSpawn(this, config, priceLookup).

  /**
   * Synchronously ask a subagent something via the bridge. Sends a
   * `task` message addressed to the subagent and awaits a matching
   * reply (matched by message id). Subagent runners that handle these
   * requests subscribe to `ctx.bridge` and reply with a message whose
   * `id` equals the incoming request's id (see `InMemoryAgentBridge`'s
   * `request<T>` implementation).
   *
   * Returns the response payload directly (the bridge wrapper is
   * unwrapped for ergonomics). Times out after `timeoutMs` (default
   * matches the bridge's own default of 30s) — surface those rejections
   * to the caller as actionable errors instead of letting tools hang.
   */
  async ask<T = unknown>(subagentId: string, payload: unknown, timeoutMs?: number): Promise<T> {
    if (!this.subagentBridges.has(subagentId)) {
      throw new Error(
        `ask: unknown subagent "${subagentId}" (spawn() it first; current fleet: ${Array.from(this.subagentBridges.keys()).join(', ') || '(empty)'})`,
      );
    }
    const msg: BridgeMessage = {
      id: randomUUID(),
      type: 'task',
      from: this.id,
      to: subagentId,
      payload,
      timestamp: Date.now(),
      priority: 'normal',
    };
    const reply = await this.bridge.request<T>(msg, timeoutMs);
    return reply.payload;
  }

  /**
   * Read completed task results and format them as a structured text
   * block the director's LLM can paste into its own context. The
   * Director keeps every completed `TaskResult` in `completed` so this
   * is a pure read — no bridge round-trip, cheap to call.
   *
   * The returned string is intentionally markdown-flavored: headers per
   * subagent, a one-line meta row (iter / tools / ms), and the task's
   * result text. Pass `style: 'json'` for a programmatic shape instead
   * (useful when the director model is doing structured-output work).
   */
  rollUp(taskIds: string[], style: 'markdown' | 'json' = 'markdown'): string {
    return this.tasks.rollUp(taskIds, style);
  }

  /**
   * Write the fleet manifest to `manifestPath`. Returns the path written
   * or null when no path was configured. Captures every spawn + its
   * assigned tasks — paired with per-subagent JSONLs, this is enough to
   * replay an entire director run.
   */
  async writeManifest(): Promise<string | null> {
    if (!this.manifestPath) return null;
    this.clearManifestTimer();
    const write = this.manifestWriteChain
      .catch(() => undefined)
      .then(() => writeDirectorManifest(this.checkpointHost()));
    this.manifestWriteChain = write.catch(() => undefined);
    return write;
  }

  /**
   * Cancel the pending manifest debounce timer and drain any in-flight
   * manifest write so that, once this resolves, no Director-owned manifest
   * write is armed or running.
   *
   * Unlike `shutdown()`, this does NOT tear down the coordinator, bridges,
   * or waiters — it is the lightweight quiesce that `MultiAgentHost.stopAll()`
   * needs. `stopAll()` flushes the FleetManager's manifest but never touched
   * the Director's own writer, leaving its armed debounce timer to fire ~2s
   * later. Under CPU starvation that late, un-awaited `atomicWrite` (temp
   * sibling + rename) races a caller that deletes the manifest directory,
   * producing an `ENOTEMPTY` on the parent `rmdir` (Windows especially).
   */
  async quiesceManifest(): Promise<void> {
    this.clearManifestTimer();
    await this.manifestWriteChain.catch(() => undefined);
  }

  /**
   * Tear down the director: stop every subagent, close every bridge
   * endpoint, and (when configured) write the final manifest. Idempotent
   * — calling shutdown twice is a no-op on the second invocation.
   */
  async shutdown(): Promise<void> {
    this.clearManifestTimer();
    // Detach the coordinator-side task.completed listener so a Director
    // that lives shorter than its coordinator (rare but possible in
    // tests + delegate auto-promotion) doesn't leak the closure on
    // the EventEmitter for the coordinator's remaining lifetime.
    if (this.taskCompletedListener) {
      this.coordinator.off('task.completed', this.taskCompletedListener);
      this.taskCompletedListener = null;
    }
    // Detach the FleetBus filters installed in the constructor. Same
    // rationale as the coordinator listener above — repeated Director
    // construction without these unsubs accumulates listeners on the
    // shared FleetBus and eventually trips the EventEmitter max-listener
    // warning.
    this.budgetPolicy.dispose();
    for (const timer of this.subagentIdleTimers.values()) clearTimeout(timer);
    this.subagentIdleTimers.clear();
    await this.coordinator.stopAll();
    this.tasks.resolveWaitersOnShutdown();
    for (const b of this.subagentBridges.values()) {
      await b.stop().catch((err) => this.logShutdownError('subagent_bridge_stop', err));
    }
    this.subagentBridges.clear();
    await this.bridge.stop().catch((err) => this.logShutdownError('director_bridge_stop', err));
    if (this.fleetManager) {
      await this.fleetManager
        .flushManifest()
        .catch((err) => this.logShutdownError('fleet_manifest_flush', err));
      // The FleetManager owns the canonical manifest here, but the Director
      // may still have a Director-format write in flight (a debounce timer
      // that fired just before `clearManifestTimer` above). Drain it so no
      // un-awaited `atomicWrite` outlives shutdown and races a directory
      // teardown by the caller.
      await this.manifestWriteChain.catch(() => undefined);
    } else if (this.manifestPath) {
      await this.writeManifest().catch((err) => this.logShutdownError('manifest_write', err));
    }
    if (this.stateCheckpoint) {
      this.stateCheckpoint.setUsage(this.usage.snapshot());
      await this.stateCheckpoint
        .flush()
        .catch((err) => this.logShutdownError('state_checkpoint_flush', err));
      // Release the lock so a subsequent --resume can claim this checkpoint.
      // Without this, the next director run sees a stale lock and refuses.
      await this.stateCheckpoint
        .releaseLock()
        .catch((err) => this.logShutdownError('state_checkpoint_lock_release', err));
    }
    // Free stored large answers so they don't accumulate across director
    // runs within the same session. The store holds full subagent responses
    // that were above 2K chars; keeping them past shutdown is pure waste.
    this.largeAnswerStore.clear();
  }

  /**
   * Funnel for shutdown-phase errors. We can't throw — `shutdown()` is
   * called from process-exit paths where an uncaught throw would lose
   * the manifest write that comes after. But we MUST NOT silently
   * swallow either — a persistent bridge-close failure would otherwise
   * mask a real bug. `process.emitWarning` is the right tier:
   * surfaces on stderr by default, lets the host plug a warning
   * listener for structured collection, and never affects exit code.
   */
  private logShutdownError(phase: string, err: unknown): void {
    const detail = toErrorMessage(err);
    process.emitWarning(
      `Director shutdown phase "${phase}" failed: ${detail}`,
      'DirectorShutdownWarning',
    );
  }

  /**
   * Hand a task to the coordinator. Returns the assigned task id so
   * callers can wait on it via `awaitTasks([id])`. The coordinator's
   * concurrency limit applies — the task may queue before running.
   */
  async assign(task: TaskSpec): Promise<string> {
    return this.tasks.assign(task);
  }

  /**
   * Assign infrastructure-owned work directly to the coordinator without
   * manifest/session/checkpoint bookkeeping. The task still uses the normal
   * subagent runner, budget, and completion events, but it is excluded from
   * rollups and persisted fleet task history.
   */
  async assignInternal(task: TaskSpec): Promise<string> {
    return this.tasks.assignInternal(task);
  }

  /**
   * Block until every task id resolves. Returns results in the same
   * order as the input. If any task hasn't completed by the time this
   * is called, the promise hangs until it does — pair with a timeout
   * at the caller if that's a concern. Resolves immediately for ids
   * whose results were already cached.
   */
  awaitTasks(taskIds: string[]): Promise<TaskResult[]> {
    return this.tasks.awaitTasks(taskIds);
  }

  /**
   * Wait until AT LEAST ONE of the named tasks completes, then return every
   * requested result already cached plus the still-pending ids. This is the
   * leader's "handle whichever finishes next" primitive — unlike
   * `awaitTasks` it never blocks on the slowest sibling, and the siblings
   * that complete later still reach the leader through the fire-and-forget
   * report-back (see the consumed-in-band rule in `taskCompletedListener`).
   *
   * Deliberately does NOT register `taskWaiters` entries for the pending
   * ids: a `taskWaiters` entry would mark those results as in-band-consumed
   * and silence the mailbox notifier for results this caller never receives.
   *
   * With `timeoutMs`, resolves (never rejects) `{timedOut: true}` and zero
   * completions when the window elapses first.
   */
  awaitTasksAny(taskIds: string[], opts?: { timeoutMs?: number }): Promise<AwaitAnyResult> {
    return this.tasks.awaitTasksAny(taskIds, opts);
  }

  /** Defensive snapshot of tasks still queued (not yet dispatched). */
  listPendingTasks(): readonly TaskSpec[] {
    return this.tasks.listPendingTasks();
  }

  /**
   * Re-pin a still-pending task to a different subagent (`undefined` =
   * unpin) — the rebalancing primitive used by the FleetSupervisor and
   * available to hosts. Only queued tasks can move; a dispatched task
   * returns `false` (steer or terminate its worker instead). Keeps
   * ownership bookkeeping (taskOwners, checkpoint, fleet manifest) in
   * sync with the coordinator's queue.
   */
  retargetPendingTask(taskId: string, subagentId: string | undefined): boolean {
    return this.tasks.retargetPendingTask(taskId, subagentId);
  }

  async terminate(subagentId: string): Promise<void> {
    await this.coordinator.stop(subagentId);
    // Remove the subagent fully — stop() only marks it 'stopped' in the
    // coordinator but keeps the entry, the bridge, nicknames, and fleet
    // state alive. Without remove(), every explicit terminate_subagent
    // call leaks a stopped agent that accumulates on HQ forever.
    void this.remove(subagentId).catch((err) => this.logShutdownError('terminate_remove', err));
  }

  async terminateAll(): Promise<void> {
    const ids = this.status().subagents.map((s) => s.id);
    await this.coordinator.stopAll();
    // Full cleanup for every subagent — same reasoning as terminate().
    // We re-read the id list BEFORE stopAll() because some may already
    // be gone by the time the stop completes; remove() is a no-op for
    // already-deleted ids.
    for (const id of ids) {
      void this.remove(id).catch((err) => this.logShutdownError('terminate_all_remove', err));
    }
  }

  async remove(subagentId: string): Promise<void> {
    this.clearSubagentIdleRetirement(subagentId);
    // The terminal counterpart to the agent_spawned written in spawn(). Without
    // it a resumed session replays every subagent starting and none of them
    // finishing, and a crash is indistinguishable from a run still in flight.
    void this.appendSessionEvent({
      type: 'agent_stopped',
      ts: new Date().toISOString(),
      agentId: subagentId,
    });
    await this.coordinator.remove(subagentId);

    // Clean up the bridge so it stops consuming resources.
    const bridge = this.subagentBridges.get(subagentId);
    if (bridge) {
      await bridge.stop();
      this.subagentBridges.delete(subagentId);
    }

    // Clean up the aggregator so terminated subagent data doesn't accumulate.
    this.usage.removeSubagent(subagentId);

    // Delegate nickname cleanup to FleetManager when available; otherwise handle
    // it directly here. This frees the slot so the same name can be reused.
    if (this.fleetManager) {
      this.fleetManager.removeSubagent(subagentId);
    } else {
      const entry = Director._asManifestEntry(this.manifestEntries.get(subagentId));
      if (entry?.name) {
        const nicknameKey = nicknameKeyFromDisplay(entry.name);
        if (nicknameKey) this.usedNicknames.delete(nicknameKey);
      }
    }

    // Remove all local state entries for this subagent.
    // taskOwners, taskDescriptions, and taskWorktrees are keyed by taskId —
    // iterate the subagent's owned task IDs rather than using subagentId as the
    // key (which would never match). Completed results intentionally survive
    // retirement so awaitTasks(), rollUp(), and completedResults() stay usable.
    const entryForCleanup = Director._asManifestEntry(this.manifestEntries.get(subagentId));
    if (entryForCleanup) {
      this.tasks.removeTasks(entryForCleanup.taskIds);
      for (const tid of entryForCleanup.taskIds) {
        this.taskWorktrees.delete(tid);
      }
    }
    this.budgetPolicy.removeSubagent(subagentId);
    this.manifestEntries.delete(subagentId);
  }

  private clearSubagentIdleRetirement(subagentId: string): void {
    const timer = this.subagentIdleTimers.get(subagentId);
    if (!timer) return;
    clearTimeout(timer);
    this.subagentIdleTimers.delete(subagentId);
  }

  /**
   * Arm one lifecycle timer per worker. The callback re-checks coordinator
   * state so a task assigned in the same turn always wins over retirement.
   */
  private armSubagentIdleRetirement(subagentId: string, delayMs: number | undefined): void {
    this.clearSubagentIdleRetirement(subagentId);
    if (delayMs === undefined) return;
    const timer = setTimeout(() => {
      this.subagentIdleTimers.delete(subagentId);
      const entry = this.coordinator.getStatus().subagents.find((a) => a.id === subagentId);
      if (entry?.status !== 'idle') return;
      if (this.coordinator.listPendingTasks().some((task) => task.subagentId === subagentId)) {
        this.armSubagentIdleRetirement(subagentId, this.subagentIdleTimeoutMs);
        return;
      }
      void this.remove(subagentId).catch((err) =>
        this.logShutdownError('subagent_idle_retirement', err),
      );
    }, delayMs);
    if (typeof timer.unref === 'function') timer.unref();
    this.subagentIdleTimers.set(subagentId, timer);
  }

  status(): CoordinatorStatus {
    const base = this.coordinator.getStatus();
    // Enrich each row with its cumulative auto-extension count so /fleet can
    // render "⚡×N" without a separate lookup.
    return {
      ...base,
      subagents: base.subagents.map((s) => ({
        ...s,
        extensions: this.budgetPolicy.extensionsFor(s.id),
      })),
    };
  }

  /**
   * Subscribe to coordinator events. Currently only `task.completed` is
   * exposed (the others are internal lifecycle). Returns an unsubscribe
   * function. External callers (e.g. the CLI's `MultiAgentHost`) use this
   * to drive their own pending/results tracking without poking the
   * coordinator directly.
   */
  on(
    event: 'task.completed',
    handler: (payload: { task: TaskSpec; result: TaskResult }) => void,
  ): () => void {
    // EventEmitter.on returns `this`; wrap so callers get a stable
    // unsubscribe closure (matches the rest of our event API).
    this.coordinator.on(event, handler);
    return () => {
      this.coordinator.off(event, handler);
    };
  }

  /**
   * Snapshot of every task that has resolved (success, failed, timeout,
   * stopped) since the director started. Returned in completion order
   * via the internal map's iteration order. Used by `/fleet status` to
   * paint the completed table without reaching into private state.
   */
  completedResults(): TaskResult[] {
    return this.tasks.completedResults();
  }

  /**
   * Inject a previously-saved checkpoint snapshot. Call this right after
   * constructing a Director during a `--resume` run so the in-memory state
   * (subagents, tasks, waiters) reflects the pre-crash reality instead of
   * starting from a blank slate. The director then resumes from there —
   * completing any in-flight tasks and ignoring tasks that already reached
   * a terminal state in the prior run.
   */
  setCheckpointState(snapshot: DirectorStateSnapshot): void {
    setDirectorCheckpointState(this.checkpointHost(), snapshot);
  }

  /**
   * Read a subagent's JSONL transcript directly from disk (no bridge
   * round-trip needed). Returns the last assistant text, stop reason,
   * tool-use count, and line count — or null if the file is unavailable.
   * Requires `sessionsRoot` to be set on construction.
   */
  async readSession(
    subagentId: string,
    tail?: number | undefined,
  ): Promise<DirectorSubagentSessionSummary | null> {
    return readDirectorSubagentSession({
      sessionsRoot: this.sessionsRoot,
      directorRunId: this.directorRunId,
      subagentId,
      tail,
    });
  }

  snapshot(): FleetUsage {
    return this.usage.snapshot();
  }

  /**
   * Look up provider/model metadata for a spawned subagent. Returns
   * undefined when the subagent id is unknown (not yet spawned, or
   * already torn down). Callers — notably the TUI fleet panel — use
   * this to render human-readable provider/model tags next to each
   * subagent row without reaching into private state.
   */
  getSubagentMeta(
    id: string,
  ):
    | { provider?: string | undefined; model?: string | undefined; name?: string | undefined }
    | undefined {
    const usage = this.subagentMeta.get(id);
    const manifest = Director._asManifestEntry(this.manifestEntries.get(id));
    if (!usage && !manifest) return undefined;
    return {
      provider: usage?.provider ?? manifest?.provider,
      model: usage?.model ?? manifest?.model,
      name: manifest?.name,
    };
  }

  /**
   * Compose the leader/director-agent system prompt: fleet preamble +
   * (optional) roster summary + user base prompt. Pass the result to your
   * leader Agent's `ctx.systemPrompt` when constructing it.
   *
   * `basePrompt` defaults to `config.leaderSystemPrompt` so callers can
   * use the no-arg form when the multi-agent config already carries it.
   */
  leaderSystemPrompt(basePrompt?: string): string {
    return composeDirectorPrompt({
      basePrompt: basePrompt ?? this.coordinator.config.leaderSystemPrompt,
      directorPreamble: this.directorPreamble,
      rosterSummary: this.roster ? rosterSummaryFromConfigs(this.roster) : undefined,
    });
  }

  /**
   * Compose a subagent's system prompt for a given `SubagentConfig`:
   * baseline + role + task + per-spawn override. Returned by value — does
   * not mutate the config. Factories (the user-supplied `AgentFactory`)
   * should call this when building each subagent's Agent so the bridge
   * contract, role context, and override are all surfaced.
   *
   * When `taskBrief` is omitted the Task section is dropped. Pass the
   * actual task description here to reinforce it in the system prompt
   * (the runner already passes it as user input — duplicating in the
   * system prompt is optional but improves anchoring on small models).
   */
  subagentSystemPrompt(config: SubagentConfig, taskBrief?: string): string {
    return composeSubagentPrompt({
      baseline: this.subagentBaseline,
      role: config.prompt,
      task: taskBrief,
      sharedScratchpad: this.sharedScratchpadPath ?? undefined,
      skills: config.skillContent,
      override: config.systemPromptOverride,
    });
  }

  /**
   * Build the tool set the LLM-driven director uses to orchestrate.
   * Returns an array of `Tool` definitions; register these on the
   * director's `Agent` to expose `spawn_subagent`, `assign_task`, etc.
   * Each tool's `execute()` delegates straight to the matching method
   * above.
   *
   * Tools all carry `permission: 'auto'` — the *user* has already
   * approved running the director when they kicked off the run, so
   * gating individual orchestration calls behind a confirm prompt
   * would just be noise. The actual subagent tools they spawn are
   * still permission-checked normally.
   */
  tools(roster?: Record<string, SubagentConfig>): Tool[] {
    // Use stored roster as default — allows `director.tools()` to be
    // called without args when the roster was passed at construction.
    const effectiveRoster = roster ?? this.roster;
    return buildDirectorToolset(this, effectiveRoster);
  }

  /**
   * Attempt to acquire the checkpoint lock. Must be called before
   * resuming — if another director process is alive, this returns
   * false and the caller should not proceed with the resume.
   */
  async acquireCheckpointLock(): Promise<boolean> {
    return acquireDirectorCheckpointLock(this.checkpointHost());
  }

  /**
   * Start a collaborative debugging session: BugHunter, RefactorPlanner,
   * and Critic run in parallel on the same target files, with findings
   * flowing through the FleetBus (bug.found → refactor.plan →
   * critic.evaluation). Returns a structured CollabDebugReport when all
   * three agents complete or the session times out.
   */
  async spawnCollab(options: CollabSessionOptions): Promise<CollabDebugReport> {
    return this.collab.spawn(options);
  }

  /**
   * Resume from a prior checkpoint snapshot (loaded via
   * `loadDirectorState()`). Re-attach to the fleet mid-flight so
   * subsequent spawn/assign calls update the checkpoint normally.
   */
  resumeFromCheckpoint(snapshot: DirectorStateSnapshot): void {
    resumeDirectorFromCheckpoint(this.checkpointHost(), snapshot);
  }
}
