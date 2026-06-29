import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { Logger } from '../types/logger.js';
import type { BrainArbiter } from './brain.js';
import { DirectorStateCheckpoint, type DirectorStateSnapshot } from '../storage/director-state.js';
import type { BridgeMessage } from '../types/agent-bridge.js';
import type { ModelMatrixEntry } from '../types/config.js';
import type {
  CoordinatorStatus,
  MultiAgentConfig,
  SubagentConfig,
  SubagentRunner,
  TaskResult,
  TaskSpec,
} from '../types/multi-agent.js';
import type { SessionWriter } from '../types/session.js';
import type { Tool } from '../types/tool.js';
import { atomicWrite } from '../utils/atomic-write.js';
import { toErrorMessage } from '../utils/error.js';
import { safeParse } from '../utils/safe-json.js';
import { InMemoryAgentBridge } from './agent-bridge.js';
import {
  type CollabDebugReport,
  CollabSession,
  type CollabSessionOptions,
} from './collab-debug.js';
import {
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  composeDirectorPrompt,
  composeSubagentPrompt,
  rosterSummaryFromConfigs,
} from './director-prompts.js';
import {
  makeAskResultTool,
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeFleetTool,
  makeRollUpTool,
  makeSpawnTool,
  makeTerminateAllTool,
  makeTerminateTool,
  makeWorkCompleteTool,
} from './director-tools.js';
import { FleetBus, type FleetUsage, FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import type { ICoordinator } from './icoordinator.js';
import { InMemoryBridgeTransport } from './in-memory-transport.js';
import { LargeAnswerStore } from './large-answer-store.js';
import { resolveModelMatrix } from './model-matrix.js';
import { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import { assignNickname, nicknameKeyFromDisplay } from './subagent-nicknames.js';
import {
  FleetSpawnBudgetError,
  FleetCostCapError,
  FleetContextOverflowError,
} from './director/director-errors.js';

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
export interface DirectorOptions {
  config: MultiAgentConfig;
  runner?: SubagentRunner | undefined;
  /** Optional Brain arbiter above the director for policy/decision escalation. */
  brain?: BrainArbiter | undefined;
  /** Optional logger for structured debug/error logging. Falls back to console if omitted. */
  logger?: Logger | undefined;
  /**
   * When set, the director writes a `fleet.json` manifest to this path
   * recording every spawned subagent (id, provider, model, role, task
   * ids). Used by `wstack replay <runId>` to rehydrate a fleet. Pass an
   * absolute file path — the directory must already exist (the
   * director-session factory creates it when used together).
   */
  manifestPath?: string | undefined;
  /**
   * Optional roster used by `leaderSystemPrompt()` to render a roles
   * summary into the leader's preamble. Same shape as the roster passed
   * to `tools()` — typically the same value.
   */
  roster?: Record<string, SubagentConfig>;
  /**
   * Override the built-in fleet preamble (see `DEFAULT_DIRECTOR_PREAMBLE`).
   * Pass an empty string to suppress the preamble entirely.
   */
  directorPreamble?: string | undefined;
  /**
   * Override the built-in subagent baseline (see
   * `DEFAULT_SUBAGENT_BASELINE`). Pass an empty string to suppress.
   */
  subagentBaseline?: string | undefined;
  /**
   * Absolute path to a directory the fleet can use as a shared scratchpad
   * (read + write by every subagent). When set, the director creates it on
   * construction and `subagentSystemPrompt()` automatically injects a
   * "Shared notes" block telling subagents where to drop their findings.
   * This is the cheap fleet-coordination channel — agents don't need each
   * other's transcripts, just each other's conclusions.
   *
   * Convention: under a fleet run rooted at `<sessionsRoot>/<runId>/`,
   * pass `<sessionsRoot>/<runId>/shared/` here.
   */
  sharedScratchpadPath?: string | undefined;
  /**
   * Maximum number of spawns this director can perform across its
   * lifetime. Default: unlimited. Acts as a hard fleet-wide cost cap —
   * a runaway leader that keeps spawning workers gets cut off cleanly
   * instead of burning provider tokens until the user kills the
   * process. The N+1-th spawn call rejects with a `FleetSpawnBudgetError`.
   */
  maxSpawns?: number | undefined;
  /**
   * Maximum nesting depth for spawns. The director constructed by the
   * user is at depth `spawnDepth` (default 0); any subagent that itself
   * acts as a director would construct its own `Director` with
   * `spawnDepth: parent.spawnDepth + 1`. When `spawnDepth >= maxSpawnDepth`,
   * `spawn()` rejects. Default: 2 (root director can spawn workers; a
   * worker that becomes a sub-director cannot itself spawn further).
   * This stops infinite recursive director chains from a hostile or
   * confused prompt.
   */
  maxSpawnDepth?: number | undefined;
  /**
   * Current spawn-chain depth for this director instance. Defaults to 0.
   * A nested director should pass `parent.spawnDepth + 1`. Together with
   * `maxSpawnDepth` this bounds the chain.
   */
  spawnDepth?: number | undefined;
  /**
   * Absolute path to a director-state checkpoint file. When set, the
   * director writes an incremental snapshot of pending/running/completed
   * tasks + spawned subagents on every state mutation. Distinct from
   * `manifestPath`: the manifest is a final record written on shutdown,
   * the checkpoint is a live mirror useful for crash recovery and the
   * `wstack resume` "you had N tasks in flight" banner.
   */
  stateCheckpointPath?: string | undefined;
  /**
   * Session writer the director should forward task lifecycle events to
   * (`agent_spawned`, `task_created`, `task_completed`, `task_failed`).
   * When omitted these events stay in-memory only — useful for tests but
   * lossy in production. Production callers (the CLI) pass the same
   * writer the host Agent uses so all events land in a single JSONL.
   */
  sessionWriter?: SessionWriter | undefined;
  /**
   * Session id for live fleet/coordinator events. Defaults to
   * `sessionWriter.id` when a writer is available; accepts a getter so
   * embedding surfaces can follow session swaps.
   */
  sessionId?: string | (() => string | undefined) | undefined;
  /**
   * Debounce window for periodic manifest writes triggered by spawn/
   * assign/complete events. Default: 2000ms. Pass 0 to disable periodic
   * writes (the manifest will then only be written on `shutdown()`).
   */
  manifestDebounceMs?: number | undefined;
  /**
   * Fleet-wide cost ceiling. When set, `spawn()` refuses any new subagent
   * that would push the fleet's total cost above this limit. The cap
   * is checked BEFORE the spawn is recorded — a refused spawn must not
   * leak partial state into the manifest or fleet bus. Let in-flight
   * tasks complete; refuse new spawns only. When omitted or Infinity,
   * no cost cap applies.
   *
   * Distinct from SubagentBudget.maxCostUsd (per-subagent spend) — this
   * field caps the *entire fleet* total.
   */
  directorBudget?:
    | {
        /**
         * Maximum total USD the fleet may spend across all subagents.
         * Default: Infinity (no cap).
         */
        maxCostUsd?: number | undefined;
      }
    | undefined;
  /**
   * Maximum auto-extensions per subagent per budget kind before the
   * director denies further extensions. A subagent hitting the same
   * soft limit repeatedly (e.g. 3× budget.threshold_reached for
   * tool_calls) is likely looping on a prompt/config issue, not
   * making legitimate progress. Default: 5. Set to Infinity to
   * disable the cap (use with caution — a misconfigured subagent
   * could burn unlimited budget).
   */
  maxBudgetExtensions?: number | undefined;
  /**
   * Debounce window for state-checkpoint writes. Default: 250ms.
   * Bursts of spawn/assign/complete events collapse into one disk
   * hit. Higher values reduce write amplification on fast machines;
   * lower values improve crash-recovery fidelity (less state lost
   * on sudden process exit).
   */
  checkpointDebounceMs?: number | undefined;
  /**
   * Sessions root directory for per-subagent JSONL transcripts.
   * When set, the director can read subagent transcripts directly for
   * `fleet` tool (action: session) — no bridge round-trip needed. Path convention:
   * `<sessionsRoot>/<directorRunId>/<subagentId>.jsonl`.
   */
  sessionsRoot?: string | undefined;
  /**
   * Director run id — namespaced under `sessionsRoot` to locate per-subagent
   * JSONLs. Defaults to the director's own `id` when omitted.
   */
  directorRunId?: string | undefined;
  /**
   * Pre-built fleet manager. When provided the Director delegates all
   * fleet-level policy (spawn budgets, manifest assembly, checkpointing)
   * to this instance and takes ownership of the coordinator + bridge
   * layer only. This enables unit-testing fleet policy in isolation
   * and swapping implementations without changing the Director surface.
   *
   * When omitted the Director creates its own fleet infrastructure
   * (same behavior as before this field was added).
   */
  fleetManager?: FleetManager | undefined;
  /**
   * Optional LLM classifier for the smart dispatcher. When set, the
   * `spawn_subagent` tool can accept a free-form `description` field
   * and the director will automatically route to the best-matching
   * catalog agent using `dispatchAgent()`. When omitted, routing is
   * pure heuristic (no provider call) — sufficient for most tasks.
   *
   * Build from a `complete(prompt) => string` function using
   * `makeLLMClassifier(complete)` from the dispatcher module.
   */
  dispatchClassifier?: import('../coordination/dispatcher.js').DispatchClassifier | undefined;
  /**
   * Maximum context load (as a fraction of maxContext) the leader agent
   * is allowed to reach before a new spawn is rejected. Default: 0.85.
   * When the leader's context pressure exceeds this threshold, spawning
   * a new subagent is refused — the leader must compact first.
   * Only used when no `fleetManager` is provided (inline mode).
   * Set to 1.0 to disable this check.
   */
  maxLeaderContextLoad?: number | undefined;
  /**
   * Provider's max context window in tokens. Used with `maxLeaderContextLoad`
   * to compute the absolute token threshold. Default: 128_000.
   * Only used when no `fleetManager` is provided (inline mode).
   *
   * A function may be supplied when the leader can switch models at runtime;
   * spawn() reads it lazily so the threshold follows the active model.
   */
  maxContext?: number | (() => number | undefined) | undefined;
  /**
   * Per-task model matrix (Config.modelMatrix). When set, a spawn whose
   * config has no explicit `model` is resolved against this matrix by role
   * (→ phase → `*`) before the subagent is built — so the spawned event,
   * manifest, and the agent itself all run the matched model. Explicit
   * per-spawn `model` overrides always win.
   *
   * Pass a **function** (not a snapshot) when the matrix can change at
   * runtime (the CLI passes `() => configStore.get().modelMatrix`) so a
   * mid-session `/setmodel` takes effect on the next spawn. A static record
   * is also accepted for tests and one-shot runs.
   */
  modelMatrix?: ModelMatrixSource | undefined;
}

/** Either a static matrix or a live getter (re-read on every spawn). */
export type ModelMatrixSource =
  | Record<string, ModelMatrixEntry>
  | (() => Record<string, ModelMatrixEntry> | undefined);

// Re-exported from director-errors.ts for backward compatibility
export {
  FleetSpawnBudgetError,
  FleetCostCapError,
  FleetContextOverflowError,
} from './director/director-errors.js';

export class Director implements ICoordinator {
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

  private resolveMaxContext(): number {
    const resolved = typeof this.maxContext === 'function' ? this.maxContext() : this.maxContext;
    return resolved && resolved > 0 ? resolved : 128_000;
  }

  private currentSessionId(): string | undefined {
    const value =
      typeof this.sessionIdSource === 'function'
        ? this.sessionIdSource()
        : this.sessionIdSource;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }
  /** Optional Brain arbiter for director-level policy decisions. */
  private readonly brain?: BrainArbiter | undefined;
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
  private readonly transport: InMemoryBridgeTransport;
  private readonly coordinator: DefaultMultiAgentCoordinator;
  /** Resolves with the matching `TaskResult` the first time the
   *  coordinator emits `task.completed` for a given task id. Each entry
   *  is created lazily on first poll/await and cleared once consumed. */
  private readonly taskWaiters = new Map<
    string,
    {
      promise: Promise<TaskResult>;
      resolve: (r: TaskResult) => void;
    }
  >();
  /** Cache of completed results in case the consumer asks AFTER the
   *  coordinator already fired the event — `awaitTasks(['t-1'])` after
   *  t-1 finished should resolve immediately, not hang. */
  private readonly completed = new Map<string, TaskResult>();
  /** Prevents the completed Map from growing unbounded in long-running directors. */
  private static readonly MAX_COMPLETED = 10_000;
  /** Per-subagent provider/model metadata, captured at spawn time so the
   *  FleetUsageAggregator's metaLookup can surface readable rows. */
  private readonly subagentMeta = new Map<
    string,
    { provider?: string | undefined; model?: string | undefined }
  >();
  private readonly priceLookups = new Map<
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
  private readonly subagentBridges = new Map<string, InMemoryAgentBridge>();
  /** Tracks per-spawn config + assigned task ids for manifest writing. */
  private readonly manifestEntries = new Map<
    string,
    {
      subagentId: string;
      name: string;
      role?: string | undefined;
      provider?: string | undefined;
      model?: string | undefined;
      taskIds: string[];
    }
  >();
  /** Tracks assigned nicknames so the same name is never reused in one fleet. */
  private readonly _usedNicknames = new Set<string>();
  private readonly manifestPath?: string | undefined;
  private readonly roster?: Record<string, SubagentConfig> | undefined;
  private readonly directorPreamble: string;
  private readonly subagentBaseline: string;
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
  private spawnCount = 0;
  /** Optional checkpoint mirror — writes the live task graph + roster to disk. */
  private readonly stateCheckpoint: DirectorStateCheckpoint | null;
  /** Optional session writer for emitting task_* / agent_* lifecycle events. */
  private readonly sessionWriter: SessionWriter | null;
  private readonly sessionIdSource: string | (() => string | undefined) | undefined;
  /** Debounce timer for periodic manifest writes. */
  private manifestTimer: NodeJS.Timeout | null = null;
  private readonly manifestDebounceMs: number;
  /** Fleet-wide cost cap (entire fleet total, distinct from SubagentBudget limits). Infinity means no cap. */
  private readonly maxFleetCostUsd: number;
  /** Max auto-extensions per subagent per budget kind before denying. */
  private readonly maxBudgetExtensions: number;
  /** Sessions root for direct subagent JSONL reads (fleet tool, action: session). */
  private readonly sessionsRoot?: string | undefined;
  /** Director run id for JSONL path resolution. */
  private readonly directorRunId: string;
  /** Optional logger for structured logging. Falls back to noop when omitted. */
  private readonly logger: Logger | undefined;
  /** Resolves task descriptions back from `assign()` so completion events
   *  can also carry a human-readable title. */
  private readonly taskDescriptions = new Map<string, string>();
  /** Snapshot of which subagent owns each task — drives state-checkpoint
   *  status updates without re-walking the manifest. */
  private readonly taskOwners = new Map<string, string>();
  /** Infrastructure-owned task ids that should not appear in user-visible
   *  manifest/session/checkpoint/rollup state. */
  private readonly internalTaskIds = new Set<string>();
  /** Cumulative auto-extension grants per subagent (all budget kinds). Lets
   *  /fleet render "⚡ extended ×N" without replaying the event stream. */
  private readonly extendTotals = new Map<string, number>();
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
  private toolExecFilter: (() => void) | null = null;
  private budgetFilter: (() => void) | null = null;
  /** Optional LLM classifier for smart dispatch. Passed from options. */
  readonly dispatchClassifier?:
    | import('../coordination/dispatcher.js').DispatchClassifier
    | undefined;
  /** Leader agent's current context pressure (full request tokens). */
  private leaderContextPressure = 0;
  /** Maximum context load fraction before spawn is refused. */
  private readonly maxLeaderContextLoad: number;
  /** Provider's max context window in tokens, or a live resolver for runtime model switches. */
  private readonly maxContext: number | (() => number | undefined);
  /** Per-task model matrix (static record or live getter); resolved
   *  per-spawn when no explicit model is set. */
  private readonly modelMatrix?: ModelMatrixSource | undefined;
  /**
   * When set by `workComplete()`, the director stops dispatching new tasks
   * and terminates all running subagents. Used when the director's LLM decides
   * the goal is satisfied and no further spawns are needed — prevents the
   * coordinator from keeping workers alive for tasks that will never arrive.
   */
  private workCompleteFlag = false;
  /** Pending /btw notes stashed by the leader agent (see setLeaderBtwNote). */
  private _leaderBtwNotes: string[] = [];
  /** Active collab sessions tracked by sessionId (see spawnCollab).
   *  The tuple holds the session and its Director-registered listener unsubs.
   *  Calling the unsubs on cancel/premature-cleanup prevents listener accumulation
   *  on CollabSession (EventEmitter) across many spawnCollab() calls. */
  private readonly _activeCollabSessions = new Map<
    string,
    { session: import('./collab-debug.js').CollabSession; unsubs: (() => void)[] }
  >();
  /** Prevents large `ask_subagent` answers from bloating the leader's context window. */
  readonly largeAnswerStore: LargeAnswerStore;

  constructor(opts: DirectorOptions) {
    this.id = opts.config.coordinatorId || randomUUID();
    this.brain = opts.brain;
    this.manifestPath = opts.manifestPath;
    this.roster = opts.roster;
    this.directorPreamble = opts.directorPreamble ?? DEFAULT_DIRECTOR_PREAMBLE;
    this.subagentBaseline = opts.subagentBaseline ?? DEFAULT_SUBAGENT_BASELINE;
    this.sharedScratchpadPath = opts.sharedScratchpadPath ?? null;
    this.maxSpawns = opts.maxSpawns ?? Number.POSITIVE_INFINITY;
    this.maxSpawnDepth = opts.maxSpawnDepth ?? 2;
    this.spawnDepth = opts.spawnDepth ?? 0;
    this.sessionWriter = opts.sessionWriter ?? null;
    this.sessionIdSource = opts.sessionId ?? (() => opts.sessionWriter?.id);
    this.manifestDebounceMs = opts.manifestDebounceMs ?? 2000;
    this.dispatchClassifier = opts.dispatchClassifier;
    this.maxFleetCostUsd = opts.directorBudget?.maxCostUsd ?? Number.POSITIVE_INFINITY;
    this.maxBudgetExtensions = opts.maxBudgetExtensions ?? 5;
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
    this.logger = opts.logger;
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
    this.coordinator = new DefaultMultiAgentCoordinator(
      { ...opts.config, coordinatorId: this.id },
      { runner: opts.runner, sessionId: () => this.currentSessionId() },
    );
    this.coordinator.setFleetBus(this.fleet);
    this.fleetManager?.setCoordinator(this.coordinator);
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
    this.taskCompletedListener = (payload: { task: TaskSpec; result: TaskResult }) => {
      const r = payload.result;
      const internalTask = this.internalTaskIds.delete(r.taskId);
      if (!internalTask) {
        this.completed.set(r.taskId, r);
        // Trim oldest entries when the cap is exceeded — keep most recent results
        // so rollUp() and completedResults() still have data to return.
        if (this.completed.size > Director.MAX_COMPLETED) {
          const toDelete = this.completed.size - Director.MAX_COMPLETED;
          const keys = [...this.completed.keys()].slice(0, toDelete);
          for (const k of keys) this.completed.delete(k);
        }
      }
      const waiter = this.taskWaiters.get(r.taskId);
      if (waiter) {
        waiter.resolve(r);
        this.taskWaiters.delete(r.taskId);
      }
      if (internalTask) return;
      // Mirror into the on-disk checkpoint + session event stream so a
      // crashed director leaves a complete picture of which tasks landed.
      const title = this.taskDescriptions.get(r.taskId) ?? payload.task.description ?? r.taskId;
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
      // Flush immediately on task completion — the result should be
      // visible in the manifest without waiting for the debounce window.
      // Use flushManifest() so any pending debounce timer is also cleared.
      if (this.fleetManager) {
        this.fleetManager.flushManifest();
      } else {
        this.scheduleManifest();
      }
    };
    this.coordinator.on('task.completed', this.taskCompletedListener);

    // Wire budget.threshold_reached events from the FleetBus into the
    // coordinator's task completion path. When a subagent hits a soft
    // limit, the runner emits this event; we intercept it here, resolve
    // the decision promise (via extend/deny), and let the normal
    // task.completed flow handle the rest.
    //
    // Extension guard: a subagent that hits the same soft limit
    // `maxBudgetExtensions` times without completing its task is looping
    // on a prompt/config issue, not running out of budget legitimately.
    // After the configured number of extends we deny and let the task
    // fail — the host agent should then split the work or narrow the
    // scope. We track this per subagent+kind combination.
    const extendCounts = new Map<string, number>();
    // Per-subagent progress heartbeat: counts tool executions so the timeout
    // kind can extend indefinitely WHILE the agent is doing work, yet still
    // deny a wedged agent that produces no new tool calls between grants.
    // Wall-clock time always advances, so timeout alone is never a reliable
    // "stuck" signal — tool activity is.
    const progressBySubagent = new Map<string, number>();
    const lastTimeoutProgress = new Map<string, number>();
    this.toolExecFilter = this.fleet.filter('tool.executed', (e) => {
      progressBySubagent.set(e.subagentId, (progressBySubagent.get(e.subagentId) ?? 0) + 1);
    });
    this.budgetFilter = this.fleet.filter('budget.threshold_reached', (e) => {
      const payload = e.payload as {
        kind: 'timeout' | 'idle_timeout' | 'iterations' | 'tool_calls' | 'tokens' | 'cost';
        used: number;
        limit: number;
        timeoutMs: number;
        extend: (extra: Record<string, unknown>) => void;
        deny: () => void;
      };
      // -----------------------------------------------------------------------
      // Collab agents are NOT handled here. Their CollabSession owns the
      // budget.threshold_reached routing — it calls session.cancel() (never
      // payload.deny()) when the Director decides to stop, so the agent
      // finishes naturally. The Director's auto-extend/deny logic would
      // conflict with that decision and must not run for collab subagents.
      // -----------------------------------------------------------------------
      if (
        e.subagentId.startsWith('bug-hunter-') ||
        e.subagentId.startsWith('refactor-planner-') ||
        e.subagentId.startsWith('critic-')
      ) {
        // Skip — let the CollabSession's fleet handler deal with it.
        // The session calls session.cancel() on the FleetBus, which causes
        // the subagent to finish naturally without Director intervention.
        return;
      }
      // Both timeout kinds — wall-clock `timeout` and `idle_timeout` (the
      // default roster guard) — are governed by the heartbeat, not the
      // extension cap. While the subagent keeps executing tools it never dies
      // on time; once it stops making progress between grants, it's genuinely
      // stuck → deny. `timeout` extends the wall-clock cap; `idle_timeout`
      // extends the idle window. idle_timeout MUST be handled here: if it fell
      // through to the generic grantExtension() switch below (which has no case
      // for it) the Director would emit a no-op extend({}) — raising no limit
      // while still burning the extension counter and broadcasting a bogus
      // extension event. The collab handler treats both kinds the same way.
      if (payload.kind === 'timeout' || payload.kind === 'idle_timeout') {
        // Key the heartbeat by subagent+kind so a wall-clock grant and an idle
        // grant for the same subagent don't suppress each other.
        const heartbeatKey = `${e.subagentId}:${payload.kind}`;
        const progress = progressBySubagent.get(e.subagentId) ?? 0;
        const lastProgress = lastTimeoutProgress.get(heartbeatKey) ?? -1;
        if (progress <= lastProgress) {
          payload.deny();
          return;
        }
        lastTimeoutProgress.set(heartbeatKey, progress);
        const field = payload.kind === 'timeout' ? 'timeoutMs' : 'idleTimeoutMs';
        setImmediate(() => {
          const newLimit = Math.min(Math.ceil(payload.limit * 2), 24 * 60 * 60_000);
          this.recordExtension(e.subagentId, e.taskId, payload.kind, newLimit);
          payload.extend({ [field]: newLimit });
        });
        return;
      }
      const guardKey = `${e.subagentId}:${payload.kind}`;
      const prior = extendCounts.get(guardKey) ?? 0;
      if (prior >= this.maxBudgetExtensions) {
        payload.deny();
        extendCounts.delete(guardKey);
        return;
      }
      if (payload.kind === 'cost' && this.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
        const totalCost = this.usage.snapshot().total?.cost ?? 0;
        if (totalCost >= this.maxFleetCostUsd) {
          payload.deny();
          return;
        }
      }
      const grantExtension = () => {
        setImmediate(() => {
          const extra: Record<string, unknown> = {};
          const base = Math.max(payload.limit, payload.used);
          const grow = (ceiling: number) => Math.min(Math.ceil(base * 1.5), ceiling);
          let newLimit = base;
          switch (payload.kind) {
            case 'iterations':
              newLimit = grow(50_000);
              extra.maxIterations = newLimit;
              break;
            case 'tool_calls':
              newLimit = grow(100_000);
              extra.maxToolCalls = newLimit;
              break;
            case 'tokens':
              newLimit = grow(5_000_000);
              extra.maxTokens = newLimit;
              break;
            case 'cost':
              newLimit = Math.min(base * 1.5, 100);
              extra.maxCostUsd = newLimit;
              break;
          }
          extendCounts.set(guardKey, prior + 1);
          this.recordExtension(e.subagentId, e.taskId, payload.kind, newLimit);
          payload.extend(extra);
        });
      };
      if (this.brain) {
        void this.brain
          .decide({
            id: `director-budget-${e.subagentId}-${payload.kind}`,
            sessionId: this.currentSessionId(),
            source: 'director',
            question: `Should the director extend the ${payload.kind} budget for subagent ${e.subagentId}?`,
            context: [
              e.taskId ? `Task id: ${e.taskId}` : undefined,
              `Used: ${payload.used}`,
              `Limit: ${payload.limit}`,
              `Prior extensions for this kind: ${prior}`,
            ]
              .filter(Boolean)
              .join('\n'),
            risk: payload.kind === 'cost' ? 'high' : 'medium',
            fallback: 'continue',
            options: [
              {
                id: 'extend',
                label: 'Grant the director default budget extension',
                consequence: 'The subagent continues with a larger per-kind budget.',
                risk: payload.kind === 'cost' ? 'high' : 'medium',
                recommended: true,
              },
              {
                id: 'stop',
                label: 'Stop this subagent at the current budget limit',
                consequence: 'The current task will fail or stop due to budget pressure.',
                risk: 'low',
              },
            ],
          })
          .then((decision) => {
            if (decision.type === 'deny') {
              payload.deny();
              return;
            }
            if (decision.type === 'ask_human') {
              payload.deny();
              return;
            }
            if (decision.optionId === 'stop' || /\bstop\b/i.test(decision.text)) {
              payload.deny();
              return;
            }
            grantExtension();
          })
          .catch(() => payload.deny());
        return;
      }
      grantExtension();
    });
    // Large-answer store: prevents big `ask_subagent` responses from
    // bloating the leader's context window. Responses above 2K chars
    // are stored out-of-band; only a summary goes into ctx.messages.
    this.largeAnswerStore = new LargeAnswerStore(2000);
  }

  /**
   * Record a granted budget extension and broadcast it on the FleetBus so
   * the host can re-emit `subagent.budget_extended` for live UI badges.
   * Called from both the timeout heartbeat path and the per-kind grant path.
   */
  private recordExtension(
    subagentId: string,
    taskId: string | undefined,
    kind: string,
    newLimit: number,
  ): void {
    const total = (this.extendTotals.get(subagentId) ?? 0) + 1;
    this.extendTotals.set(subagentId, total);
    this.fleet.emit({
      subagentId,
      taskId,
      ts: Date.now(),
      type: 'budget.extended',
      payload: { kind, newLimit, totalExtensions: total },
    });
  }

  /** Cumulative auto-extension count for one subagent (0 when never extended). */
  extensionsFor(subagentId: string): number {
    return this.extendTotals.get(subagentId) ?? 0;
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
    const trimmed = note.trim();
    if (!trimmed) return this._leaderBtwNotes.length;
    this._leaderBtwNotes = [...this._leaderBtwNotes, trimmed].slice(-20);
    return this._leaderBtwNotes.length;
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
    const notes = this._leaderBtwNotes;
    this._leaderBtwNotes = [];
    return notes;
  }

  /**
   * Peek at pending /btw notes without consuming them.
   * Useful for UI to show "N pending notes" without clearing them.
   */
  peekLeaderBtwNotes(): string[] {
    return [...this._leaderBtwNotes];
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
    const entry = this._activeCollabSessions.get(sessionId);
    if (!entry || entry.session.isCancelled()) return;
    // Unsubscribe Director listeners first so they don't fire after cancel.
    for (const unsub of entry.unsubs) unsub();
    entry.session.cancel(reason);
    // Stop each collab agent via the coordinator so their run() aborts.
    // This is the critical difference from a natural finish: we call
    // abortController.abort() on each subagent's run signal, which
    // propagates into agent.run() → tool executor and kills the run
    // before the budget or natural iteration limit ends it.
    // The abort is cooperative — the agent finishes its current iteration
    // then sees the signal and exits with status 'aborted', so no context
    // is silently lost.
    for (const [_role, subagentId] of entry.session.getSubagentIds()) {
      this.coordinator.stop(subagentId).catch((err) => {
        this.logger?.debug(`stop subagent ${subagentId} failed (may have already completed)`, {
          subagentId,
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }
  }

  /**
   * Subscribe a callback to be notified whenever a collab session raises
   * an alert (warning level). The callback receives the full DirectorAlert
   * payload so the host (CLI, TUI) can display it to the user.
   * Returns an unsubscribe function.
   */
  onCollabAlert(handler: (alert: import('./collab-debug.js').DirectorAlert) => void): () => void {
    return this.fleet.filter('collab.warning', (e) => {
      handler(e.payload as import('./collab-debug.js').DirectorAlert);
    });
  }

  /**
   * Returns all active (not yet settled) collab session ids.
   * Useful for the TUI to render a "N active sessions" badge and for
   * the host to know what can be cancelled.
   */
  activeCollabSessions(): string[] {
    return Array.from(this._activeCollabSessions.keys());
  }

  /** Best-effort session-writer append. Swallows failures — the director
   *  must not break a fleet run because the session JSONL handle closed. */
  private async appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void> {
    if (!this.sessionWriter) return;
    try {
      await this.sessionWriter.append(event);
    } catch {
      // ignore
    }
  }

  /** Debounced manifest writer. A burst of spawn/assign/complete events
   *  collapses into one write. Set `manifestDebounceMs` to 0 to write
   *  synchronously (no debounce); set to negative to disable entirely. */
  private scheduleManifest(): void {
    if (!this.manifestPath) return;
    if (this.manifestDebounceMs === 0) {
      // 0 means instant flush — write synchronously, no timer.
      void this.writeManifest().catch((err) =>
        this.logShutdownError('manifest_write_debounced', err),
      );
      return;
    }
    if (this.manifestDebounceMs < 0) return;
    this.manifestTimer = setTimeout(() => {
      this.manifestTimer = null;
      void this.writeManifest().catch((err) =>
        this.logShutdownError('manifest_write_debounced', err),
      );
    }, this.manifestDebounceMs);
  }

  /**
   * Spawn a subagent. Identical to the coordinator's `spawn()` but
   * captures provider/model metadata for the usage aggregator and
   * lets the FleetBus attach to the runner's EventBus when the task
   * actually runs (see `attachSubagentBus`).
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
    // workComplete() signal: once the director decides the work is done,
    // refuse to spawn new subagents so the fleet winds down naturally.
    if (this.workCompleteFlag) {
      throw new FleetSpawnBudgetError(
        'max_spawns',
        this.maxSpawns,
        this.spawnCount + 1,
        'workComplete() has been called — director closed further spawning',
      );
    }
    // Clone the caller's config before any mutation. spawn() rewrites
    // model/provider (model matrix) and name (nickname) below; doing that on
    // the caller's object would make a reused SubagentConfig "stick" to the
    // first spawn's resolved model/nickname. A shallow copy is enough — only
    // top-level scalar fields are mutated here.
    const config: SubagentConfig = { ...callerConfig };
    // Per-task model matrix: when the caller didn't pin a model, resolve one
    // from the matrix by role (→ phase → `*`). Done here, before the spawned
    // event + manifest + coordinator handoff, so the fleet UI and the agent
    // itself all reflect the matched model. Explicit per-spawn models win.
    if (!config.model && this.modelMatrix) {
      const matrix = typeof this.modelMatrix === 'function' ? this.modelMatrix() : this.modelMatrix;
      const entry = resolveModelMatrix(matrix, config.role);
      if (entry?.model) {
        config.model = entry.model;
        if (entry.provider) config.provider = entry.provider;
      }
    }
    // Enforce safety caps BEFORE touching the coordinator — a refused
    // spawn must not leak partial state into the manifest or fleet bus.
    // Delegate to FleetManager when available; use inline checks otherwise.
    if (this.fleetManager) {
      const rejection = this.fleetManager.canSpawn(config);
      if (rejection) {
        if (rejection.kind === 'max_spawn_depth')
          throw new FleetSpawnBudgetError('max_spawn_depth', rejection.limit, rejection.observed);
        if (rejection.kind === 'max_spawns')
          throw new FleetSpawnBudgetError('max_spawns', rejection.limit, rejection.observed);
        if (rejection.kind === 'max_cost_usd')
          throw new FleetCostCapError(rejection.limit, rejection.observed);
        if (rejection.kind === 'max_context_load')
          throw new FleetContextOverflowError(rejection.limit, rejection.observed);
      }
    } else {
      if (this.spawnDepth >= this.maxSpawnDepth) {
        throw new FleetSpawnBudgetError('max_spawn_depth', this.maxSpawnDepth, this.spawnDepth);
      }
      if (this.spawnCount >= this.maxSpawns) {
        throw new FleetSpawnBudgetError('max_spawns', this.maxSpawns, this.spawnCount + 1);
      }
      if (this.maxFleetCostUsd < Number.POSITIVE_INFINITY) {
        const totalCost = this.usage.snapshot().total?.cost ?? 0;
        if (totalCost >= this.maxFleetCostUsd) {
          throw new FleetCostCapError(this.maxFleetCostUsd, totalCost);
        }
      }
      // Context pressure check: reject spawn if leader context is too full.
      // maxLeaderContextLoad === 1.0 disables this check.
      if (this.maxLeaderContextLoad < 1.0) {
        const maxContext = this.resolveMaxContext();
        const threshold = maxContext * this.maxLeaderContextLoad;
        if (this.leaderContextPressure >= threshold) {
          throw new FleetContextOverflowError(threshold, this.leaderContextPressure);
        }
      }
    }
    let result: { subagentId: string };
    // If the config came from the roster with the default "role-as-name" pattern,
    // OR the name is one of the synthetic defaults used by ad-hoc spawn paths,
    // upgrade to a memorable nickname before the coordinator sees it. This ensures
    // the manifest, fleet UI, and session logs all display human names like
    // "Einstein (Bug Hunter)" instead of "adhoc" or "general".
    const needsNickname =
      config.name === config.role ||
      !config.name ||
      config.name === 'subagent' ||
      config.name === 'adhoc';
    if (needsNickname) {
      const role = config.role ?? 'subagent';
      if (this.fleetManager) {
        // FleetManager owns the used-nicknames set — just assign the nickname.
        // recordSpawn is called after spawn regardless of needsNickname to ensure
        // the manifest is keyed by the real subagentId.
        this.fleetManager.assignNicknameAndRecord(config);
      } else {
        const { key, display } = assignNickname(role, this._usedNicknames);
        config.name = display;
        this._usedNicknames.add(key);
      }
    }
    result = await this.coordinator.spawn(config);
    // Record with FleetManager when available; otherwise manage inline.
    if (this.fleetManager) {
      // Always record the spawn with the real subagentId so the manifest is keyed correctly.
      this.fleetManager.recordSpawn(result.subagentId, config, priceLookup);
    } else {
      this.spawnCount += 1;
      this.subagentMeta.set(result.subagentId, {
        provider: config.provider,
        model: config.model,
      });
      if (priceLookup && config.provider && config.model) {
        this.priceLookups.set(`${config.provider}/${config.model}`, priceLookup);
      }
    }
    // Auto-wire a bridge per spawn — same transport as the director, so
    // `director.ask(subagentId, …)` and the subagent's own `bridge.send()`
    // round-trip without the caller having to plumb anything. Runners
    // grab their bridge from `ctx.bridge` (already populated by the
    // coordinator from `subagent.context.parentBridge`).
    const subagentBridge = new InMemoryAgentBridge(
      { agentId: result.subagentId, coordinatorId: this.id },
      this.transport,
    );
    this.coordinator.setSubagentBridge(result.subagentId, subagentBridge);
    this.subagentBridges.set(result.subagentId, subagentBridge);
    // Emit subagent.spawned on the FleetBus so the TUI can track collab agents
    // (which bypass MultiAgentHost.spawn and go through director.spawn directly).
    this.fleet.emit({
      subagentId: result.subagentId,
      ts: Date.now(),
      type: 'subagent.spawned',
      payload: {
        subagentId: result.subagentId,
        taskId: '', // taskId will be set when assign() is called
        name: config.name,
        role: config.role,
        provider: config.provider,
        model: config.model,
      },
    });
    // Record manifest entry only when not using FleetManager (it manages its own).
    if (!this.fleetManager) {
      this.manifestEntries.set(result.subagentId, {
        subagentId: result.subagentId,
        name: config.name,
        role: config.role,
        provider: config.provider,
        model: config.model,
        taskIds: [],
      });
      const spawnedAt = new Date().toISOString();
      this.stateCheckpoint?.recordSpawn(
        {
          id: result.subagentId,
          name: config.name,
          role: config.role,
          provider: config.provider,
          model: config.model,
          spawnedAt,
        },
        this.spawnCount,
      );
      void this.appendSessionEvent({
        type: 'agent_spawned',
        ts: spawnedAt,
        agentId: result.subagentId,
        role: config.role ?? config.name,
      });
      this.scheduleManifest();
    }
    return result.subagentId;
  }

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
    const rows = taskIds.map((id) => this.completed.get(id)).filter((r): r is TaskResult => !!r);
    if (style === 'json') {
      return JSON.stringify(
        rows.map((r) => ({
          taskId: r.taskId,
          subagentId: r.subagentId,
          status: r.status,
          iterations: r.iterations,
          toolCalls: r.toolCalls,
          durationMs: r.durationMs,
          result: r.result,
          error: r.error,
        })),
        null,
        2,
      );
    }
    if (rows.length === 0) {
      return '_No completed tasks for the requested ids — try waiting first._';
    }
    const lines: string[] = [];
    for (const r of rows) {
      const meta = this.subagentMeta.get(r.subagentId);
      const tag = meta?.provider && meta?.model ? ` · ${meta.provider}/${meta.model}` : '';
      lines.push(`### ${r.subagentId}${tag}`);
      lines.push(`_${r.status} — ${r.iterations} iter · ${r.toolCalls} tools · ${r.durationMs}ms_`);
      lines.push('');
      if (r.error) lines.push(`**Error:** ${r.error}`);
      else if (typeof r.result === 'string') lines.push(r.result);
      else if (r.result !== undefined)
        lines.push('```json\n' + JSON.stringify(r.result, null, 2) + '\n```');
      else lines.push('_(no output)_');
      lines.push('');
    }
    return lines.join('\n').trimEnd();
  }

  /**
   * Write the fleet manifest to `manifestPath`. Returns the path written
   * or null when no path was configured. Captures every spawn + its
   * assigned tasks — paired with per-subagent JSONLs, this is enough to
   * replay an entire director run.
   */
  async writeManifest(): Promise<string | null> {
    if (!this.manifestPath) return null;
    const manifest = {
      directorRunId: this.id,
      writtenAt: new Date().toISOString(),
      children: Array.from(this.manifestEntries.values()).map((e) => ({
        ...e,
        // Surface final status from `completed` when available — manifest
        // becomes much more useful for replay when it carries the
        // success/failure state.
        results: e.taskIds.map((tid) => {
          const r = this.completed.get(tid);
          return r
            ? {
                taskId: tid,
                status: r.status,
                iterations: r.iterations,
                toolCalls: r.toolCalls,
                durationMs: r.durationMs,
              }
            : { taskId: tid, status: 'pending' as const };
        }),
      })),
      usage: this.usage.snapshot(),
    };
    await fsp.mkdir(path.dirname(this.manifestPath), { recursive: true });
    await atomicWrite(this.manifestPath, JSON.stringify(manifest, null, 2), { mode: 0o600 });
    return this.manifestPath;
  }

  /**
   * Tear down the director: stop every subagent, close every bridge
   * endpoint, and (when configured) write the final manifest. Idempotent
   * — calling shutdown twice is a no-op on the second invocation.
   */
  async shutdown(): Promise<void> {
    if (this.manifestTimer) {
      clearTimeout(this.manifestTimer);
      this.manifestTimer = null;
    }
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
    if (this.toolExecFilter) {
      this.toolExecFilter();
      this.toolExecFilter = null;
    }
    if (this.budgetFilter) {
      this.budgetFilter();
      this.budgetFilter = null;
    }
    await this.coordinator.stopAll();
    for (const b of this.subagentBridges.values()) {
      await b.stop().catch((err) => this.logShutdownError('subagent_bridge_stop', err));
    }
    this.subagentBridges.clear();
    await this.bridge.stop().catch((err) => this.logShutdownError('director_bridge_stop', err));
    if (this.manifestPath)
      await this.writeManifest().catch((err) => this.logShutdownError('manifest_write', err));
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
    const taskWithId: TaskSpec = task.id ? task : { ...task, id: randomUUID() };
    // When workComplete() has been called, drain the pending queue as aborted
    // rather than dispatching new work. The director has decided the goal is
    // satisfied — queued tasks never get a chance to run, so synthesize their
    // completion now so any caller awaiting them unblocks immediately.
    if (this.workCompleteFlag) {
      const synthetic: TaskResult = {
        subagentId: taskWithId.subagentId ?? 'unassigned',
        taskId: taskWithId.id,
        status: 'stopped',
        error: {
          kind: 'aborted_by_parent',
          message: 'Director called workComplete() — no further tasks will run',
          retryable: false,
        },
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
      };
      this.completed.set(taskWithId.id, synthetic);
      const waiter = this.taskWaiters.get(taskWithId.id);
      if (waiter) {
        waiter.resolve(synthetic);
        this.taskWaiters.delete(taskWithId.id);
      }
      return taskWithId.id;
    }
    if (task.subagentId) {
      // Update manifest entry — delegate to FleetManager when available.
      if (this.fleetManager) {
        this.fleetManager.addTaskToSubagent(task.subagentId, taskWithId.id);
      } else {
        const entry = this.manifestEntries.get(task.subagentId);
        if (entry) entry.taskIds.push(taskWithId.id);
      }
    }
    await this.coordinator.assign(taskWithId);
    // Snapshot task metadata for completion-event titles + state checkpoint
    // bookkeeping. Done AFTER coordinator.assign() so we don't checkpoint a
    // task the coordinator rejected.
    this.taskDescriptions.set(taskWithId.id, taskWithId.description);
    if (taskWithId.subagentId) this.taskOwners.set(taskWithId.id, taskWithId.subagentId);
    const assignedAt = new Date().toISOString();
    this.stateCheckpoint?.recordTaskAssigned({
      taskId: taskWithId.id,
      subagentId: taskWithId.subagentId,
      description: taskWithId.description,
      status: 'running',
      assignedAt,
    });
    void this.appendSessionEvent({
      type: 'task_created',
      ts: assignedAt,
      taskId: taskWithId.id,
      title: taskWithId.description,
    });
    this.scheduleManifest();
    return taskWithId.id;
  }

  /**
   * Assign infrastructure-owned work directly to the coordinator without
   * manifest/session/checkpoint bookkeeping. The task still uses the normal
   * subagent runner, budget, and completion events, but it is excluded from
   * rollups and persisted fleet task history.
   */
  async assignInternal(task: TaskSpec): Promise<string> {
    const taskWithId: TaskSpec = task.id ? task : { ...task, id: randomUUID() };
    this.internalTaskIds.add(taskWithId.id);
    try {
      await this.coordinator.assign(taskWithId);
    } catch (err) {
      this.internalTaskIds.delete(taskWithId.id);
      throw err;
    }
    return taskWithId.id;
  }

  /**
   * Block until every task id resolves. Returns results in the same
   * order as the input. If any task hasn't completed by the time this
   * is called, the promise hangs until it does — pair with a timeout
   * at the caller if that's a concern. Resolves immediately for ids
   * whose results were already cached.
   */
  awaitTasks(taskIds: string[]): Promise<TaskResult[]> {
    return Promise.all(
      taskIds.map((id) => {
        const cached = this.completed.get(id);
        if (cached) return cached;
        const existing = this.taskWaiters.get(id);
        if (existing) return existing.promise;
        let resolve!: (r: TaskResult) => void;
        const promise = new Promise<TaskResult>((res) => {
          resolve = res;
        });
        this.taskWaiters.set(id, { promise, resolve });
        return promise;
      }),
    );
  }

  async terminate(subagentId: string): Promise<void> {
    await this.coordinator.stop(subagentId);
  }

  async terminateAll(): Promise<void> {
    await this.coordinator.stopAll();
  }

  async remove(subagentId: string): Promise<void> {
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
      const entry = this.manifestEntries.get(subagentId);
      if (entry?.name) {
        const nicknameKey = nicknameKeyFromDisplay(entry.name);
        if (nicknameKey) this._usedNicknames.delete(nicknameKey);
      }
    }

    // Remove all local state entries for this subagent.
    this.manifestEntries.delete(subagentId);
    this.taskOwners.delete(subagentId);
    this.taskDescriptions.delete(subagentId);
  }

  status(): CoordinatorStatus {
    const base = this.coordinator.getStatus();
    // Enrich each row with its cumulative auto-extension count so /fleet can
    // render "⚡×N" without a separate lookup.
    return {
      ...base,
      subagents: base.subagents.map((s) => ({
        ...s,
        extensions: this.extendTotals.get(s.id) ?? 0,
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
    return Array.from(this.completed.values());
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
    this.stateCheckpoint?.resume(snapshot);
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
  ): Promise<{
    lastAssistantText?: string | undefined;
    lastStopReason?: string | undefined;
    toolUsesObserved: number;
    events: number;
    path?: string | undefined;
  } | null> {
    if (!this.sessionsRoot) return null;
    const filePath = path.join(this.sessionsRoot, this.directorRunId, `${subagentId}.jsonl`);
    let raw: string;
    try {
      raw = await fsp.readFile(filePath, 'utf8');
    } catch {
      return null;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    const targetLines = tail ? lines.slice(-tail) : lines;
    let lastAssistantText: string | undefined;
    let lastStopReason: string | undefined;
    let toolUses = 0;
    for (const line of targetLines) {
      try {
        const parsed = safeParse<{
          type?: string | undefined;
          text?: string | undefined;
          stopReason?: string | undefined;
        }>(line);
        if (!parsed.ok || !parsed.value) continue;
        const ev = parsed.value;
        if (ev.type === 'assistant' && typeof ev.text === 'string') {
          lastAssistantText = ev.text;
        } else if (ev.type === 'stop' && ev.stopReason) {
          lastStopReason = ev.stopReason;
        } else if (ev.type === 'tool_use') {
          toolUses++;
        }
      } catch {
        // skip malformed lines
      }
    }
    return {
      lastAssistantText,
      lastStopReason,
      toolUsesObserved: toolUses,
      events: targetLines.length,
      path: filePath,
    };
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
    const manifest = this.manifestEntries.get(id);
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
    const t: Tool[] = [
      makeSpawnTool(this, effectiveRoster),
      makeAssignTool(this),
      makeAwaitTasksTool(this),
      makeAskTool(this),
      makeAskResultTool(this),
      makeRollUpTool(this),
      makeTerminateTool(this),
      makeTerminateAllTool(this),
      makeFleetTool(this),
      makeCollabDebugTool(this),
      makeFleetEmitTool(this),
      makeWorkCompleteTool(this),
    ];
    return t;
  }

  /**
   * Attempt to acquire the checkpoint lock. Must be called before
   * resuming — if another director process is alive, this returns
   * false and the caller should not proceed with the resume.
   */
  async acquireCheckpointLock(): Promise<boolean> {
    return this.stateCheckpoint ? this.stateCheckpoint.acquireLock() : true;
  }

  /**
   * Start a collaborative debugging session: BugHunter, RefactorPlanner,
   * and Critic run in parallel on the same target files, with findings
   * flowing through the FleetBus (bug.found → refactor.plan →
   * critic.evaluation). Returns a structured CollabDebugReport when all
   * three agents complete or the session times out.
   */
  async spawnCollab(options: CollabSessionOptions): Promise<CollabDebugReport> {
    const session = new CollabSession(this, this.fleet, {
      ...options,
      onBudgetWarning: (alert) => {
        // Delegate to the host-provided handler if set; 'ignore' by default.
        // Collab agents are excluded from the Director's
        // budget.threshold_reached handler, so the session's own wireFleetBus()
        // budget handler (progress-based timeout logic, session.cancel()) runs
        // instead of the Director's auto-extend/deny logic.
        return options.onBudgetWarning?.(alert) ?? 'ignore';
      },
    });
    // Track so cancelCollabSession(sessionId) works and Director knows what's active.
    // Store explicit unsubscribe wrappers so we can detach these listeners on cancel —
    // without cleanup, repeated spawnCollab() calls would accumulate listeners
    // on CollabSession (EventEmitter) for the Director's lifetime.
    // Note: EventEmitter.on() returns `this`, not an unsubscribe function,
    // so we create explicit wrappers that call .off() with the same handler ref.
    const doneHandler = () => this._activeCollabSessions.delete(session.sessionId);
    const errorHandler = () => this._activeCollabSessions.delete(session.sessionId);
    session.on('session.done', doneHandler);
    session.on('session.error', errorHandler);
    const unsubs: (() => void)[] = [
      () => session.off('session.done', doneHandler),
      () => session.off('session.error', errorHandler),
    ];
    this._activeCollabSessions.set(session.sessionId, { session, unsubs });
    return session.start();
  }

  /**
   * Resume from a prior checkpoint snapshot (loaded via
   * `loadDirectorState()`). Re-attach to the fleet mid-flight so
   * subsequent spawn/assign calls update the checkpoint normally.
   */
  resumeFromCheckpoint(snapshot: DirectorStateSnapshot): void {
    this.stateCheckpoint?.resume(snapshot);
  }
}
