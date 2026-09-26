import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { renderInstructionLayer } from '../core/instruction-template.js';
import { DirectorStateCheckpoint, type DirectorStateSnapshot } from '../storage/director-state.js';
import type { BridgeMessage } from '../types/agent-bridge.js';
import type { Config } from '../types/config.js';
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
import { InMemoryAgentBridge } from './agent-bridge.js';
import {
  acquireCheckpointLock as acquireDirectorCheckpointLock,
  appendSessionEvent as appendDirectorSessionEvent,
  type DirectorCheckpointHost,
  resumeFromCheckpoint as resumeDirectorFromCheckpoint,
  scheduleManifest as scheduleDirectorManifest,
  setCheckpointState as setDirectorCheckpointState,
  writeManifest as writeDirectorManifest,
} from './checkpoint-wiring.js';
import type { CollabDebugReport, CollabSessionOptions } from './collab-debug.js';
import { DirectorBtwNotes } from './director/director-btw-notes.js';
import { DirectorBudgetPolicy } from './director/director-budget-policy.js';
import { DirectorCollabController } from './director/director-collab.js';
import { FleetSpawnBudgetError } from './director/director-errors.js';
import { DirectorTaskRegistry } from './director/director-task-registry.js';
import { buildDirectorToolset } from './director/director-toolset.js';
import { DirectorIdleRetirement } from './director-idle-retirement.js';
import {
  type DirectorModelRoutingHost,
  hasExplicitMatrixRoute as delegateHasExplicitMatrixRoute,
  resolvedModelFor as delegateResolvedModelFor,
  resolveSpawnModel as delegateResolveSpawnModel,
} from './director-model-routing.js';
import type { DirectorOptions } from './director-options.js';
import {
  composeDirectorPrompt,
  composeSubagentPrompt,
  DEFAULT_DIRECTOR_PREAMBLE,
  DEFAULT_SUBAGENT_BASELINE,
  rosterSummaryFromConfigs,
} from './director-prompts.js';
import {
  type DirectorSubagentSessionSummary,
  readDirectorSubagentSession,
} from './director-session.js';
import { isHumanPinnedSpawn } from './director-spawn-model.js';
import { completeDirectorTask } from './director-task-completion.js';
import { FleetBus, type FleetUsage, FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import { type DirectorFleetHost, spawn as fleetSpawn, type ManifestEntry } from './fleet-spawn.js';
import type { ICoordinator } from './icoordinator.js';
import { InMemoryBridgeTransport } from './in-memory-transport.js';
import { LargeAnswerStore } from './large-answer-store.js';
import type { ModelMatrixSource } from './model-matrix.js';
import { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import type { ProviderModelStatusTracker } from './provider-status-tracker.js';
import {
  claimSubagentSlot,
  releaseSubagentSlot,
  type SubagentSlotClaim,
} from './session-subagent-models.js';
import {
  areSubagentsAllowedForSession,
  lockSessionSubagentPolicyForSession,
} from './session-subagent-policy.js';
import { resolveMaxSpawnDepth } from './spawn-budget.js';
import { nicknameKeyFromDisplay } from './subagent-nicknames.js';
import {
  type WorktreeTaskStateUpdate,
  wrapSubagentRunnerWithWorktrees,
} from './worktree-task-runner.js';

export {
  FleetContextOverflowError,
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
} from './director/director-errors.js';
export type { DirectorOptions, TaskResultNotification } from './director-options.js';

export type { ModelMatrixSource } from './model-matrix.js';

export class Director implements DirectorFleetHost, ICoordinator {
  /* eslint-disable-next-line @typescript-eslint/no-unused-vars — just a cast helper */
  private static _asManifestEntry(v: unknown): ManifestEntry {
    return v as ManifestEntry;
  }
  get coordinatorId(): string {
    return this.id;
  }
  readonly id: string;
  readonly fleet: FleetBus;
  readonly usage: FleetUsageAggregator;

  setLeaderContextPressure(tokens: number): void {
    this.leaderContextPressure = tokens;
    this.fleetManager?.setLeaderContextPressure(tokens);
  }

  getLeaderContextPressure(): number {
    return this.leaderContextPressure;
  }

  getRemainingBudgetUsd(): number | undefined {
    if (this.maxFleetCostUsd === Number.POSITIVE_INFINITY) return undefined;
    const totalCost = this.usage.snapshot().total?.cost ?? 0;
    return Math.max(0, this.maxFleetCostUsd - totalCost);
  }

  /** The leader's window in tokens, or 0 when unknown (no invented default). */
  resolveMaxContext(): number {
    const resolved = typeof this.maxContext === 'function' ? this.maxContext() : this.maxContext;
    return resolved && resolved > 0 ? resolved : 0;
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
  readonly fleetManager: FleetManager | undefined;
  readonly bridge: InMemoryAgentBridge;
  readonly transport: InMemoryBridgeTransport;
  readonly coordinator: DefaultMultiAgentCoordinator;
  private readonly tasks: DirectorTaskRegistry;
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
  readonly subagentBridges = new Map<string, InMemoryAgentBridge>();
  readonly manifestEntries = new Map<string, unknown>();
  readonly usedNicknames = new Set<string>();
  private readonly manifestPath?: string | undefined;
  private readonly roster?: Record<string, SubagentConfig> | undefined;
  private readonly directorPreamble: string;
  private readonly subagentBaseline: string;
  private readonly taskResultNotifier?: DirectorOptions['taskResultNotifier'];
  private readonly subagentIdleTimeoutMs: number | undefined;
  private readonly retireSubagentOnTaskComplete: boolean;
  private readonly idleRetirement = new DirectorIdleRetirement(
    () => this.coordinator,
    (id) => this.remove(id),
    (err) => this.logShutdownError('subagent_idle_retirement', err),
  );
  /**
   * Effective idle window per subagent (spawn-time `idleTimeoutMs` override
   * or the Director-wide default; undefined = no window). Internal-task
   * completion re-arms with THIS value, not the Director-wide default, so
   * a subagent-configured window survives its first internal probe.
   */
  private readonly subagentIdleDelayMs = new Map<string, number | undefined>();
  readonly sharedScratchpadPath: string | null;
  readonly maxSpawns: number;
  readonly maxSpawnDepth: number;
  readonly spawnDepth: number;
  spawnCount = 0;
  readonly stateCheckpoint: DirectorStateCheckpoint | null;
  private readonly sessionWriter: SessionWriter | null;
  private readonly sessionIdSource: string | (() => string | undefined) | undefined;
  private manifestTimer: NodeJS.Timeout | null = null;
  private manifestWriteChain: Promise<unknown> = Promise.resolve();
  private readonly manifestDebounceMs: number;
  readonly maxFleetCostUsd: number;
  readonly maxFleetTokens: number;
  private readonly sessionsRoot?: string | undefined;
  private readonly directorRunId: string;
  private readonly logger: Logger | undefined;
  readonly taskWorktrees = new Map<string, WorktreeTaskStateUpdate>();
  private readonly budgetPolicy: DirectorBudgetPolicy;
  private taskCompletedListener:
    | ((payload: { task: TaskSpec; result: TaskResult }) => void)
    | null = null;
  readonly dispatchClassifier?:
    | import('../coordination/dispatcher.js').DispatchClassifier
    | undefined;
  readonly onSpawnRouted?:
    | ((entry: import('./agents/dispatch-log.js').DispatchLogEntry) => void)
    | undefined;
  leaderContextPressure = 0;
  readonly maxLeaderContextLoad: number;
  private readonly maxContext: number | (() => number | undefined);
  private readonly appConfig?: Config | (() => Config | undefined) | undefined;
  readonly modelMatrix?: ModelMatrixSource | undefined;
  workCompleteFlag = false;
  private readonly btwNotes = new DirectorBtwNotes();
  private readonly collab: DirectorCollabController;
  readonly largeAnswerStore: LargeAnswerStore;
  private readonly statusTracker: ProviderModelStatusTracker | undefined;
  /**
   * The session's own provider/model. Held as the option gave them — a getter
   * where the host can supply one — and resolved at SPAWN time, not at
   * construction: `/model` mid-session must reach the next worker, both for the
   * plan's "use my model" switch and for the final session fallback. A snapshot
   * here pinned every later subagent to whatever the leader ran on when the
   * fleet was first built.
   */
  private readonly sessionProvider: string | (() => string | undefined) | undefined;
  private readonly sessionModel: string | (() => string | undefined) | undefined;

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
    this.onSpawnRouted = opts.onSpawnRouted;
    this.maxFleetCostUsd = opts.directorBudget?.maxCostUsd ?? Number.POSITIVE_INFINITY;
    this.maxFleetTokens = opts.directorBudget?.maxTokens ?? Number.POSITIVE_INFINITY;
    this.maxLeaderContextLoad = opts.maxLeaderContextLoad ?? 0.85;
    this.maxContext = opts.maxContext ?? 0;
    this.appConfig = opts.appConfig;
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
      void fsp
        .mkdir(this.sharedScratchpadPath, { recursive: true })
        .catch((err) => this.logShutdownError('shared_scratchpad_mkdir', err));
    }
    this.transport = new InMemoryBridgeTransport();
    this.bridge = new InMemoryAgentBridge(
      { agentId: this.id, coordinatorId: this.id },
      this.transport,
    );
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
      dispatchableSubagentIds: () =>
        this.coordinator
          .getStatus()
          .subagents.filter((s) => s.status !== 'stopped')
          .map((s) => s.id),
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
      // FleetManager owns manifest state when injected. Scheduling the
      // Director's legacy writer here would race the FleetManager writer
      // against the same path with Director.manifestEntries (empty in the
      // delegated path), intermittently replacing live children with [].
      scheduleManifest: () => {
        if (this.fleetManager) {
          this.fleetManager.scheduleManifest();
        } else {
          this.scheduleManifest();
        }
      },
      getSubagentMeta: (subagentId) => this.subagentMeta.get(subagentId),
    });
    this.taskCompletedListener = (payload) => this.handleTaskCompleted(payload);
    this.coordinator.on('task.completed', this.taskCompletedListener);

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
    this.largeAnswerStore = new LargeAnswerStore(2000);
  }

  private handleTaskCompleted(payload: { task: TaskSpec; result: TaskResult }): void {
    completeDirectorTask(
      {
        tasks: this.tasks,
        subagentIdleDelayMs: this.subagentIdleDelayMs,
        subagentIdleTimeoutMs: this.subagentIdleTimeoutMs,
        taskResultNotifier: this.taskResultNotifier,
        manifestEntries: this.manifestEntries,
        logger: this.logger,
        stateCheckpoint: this.stateCheckpoint,
        usage: this.usage,
        fleetManager: this.fleetManager,
        retireSubagentOnTaskComplete: this.retireSubagentOnTaskComplete,
        armSubagentIdleRetirement: (id, delay) => this.armSubagentIdleRetirement(id, delay),
        appendSessionEvent: (event) => this.appendSessionEvent(event),
        scheduleManifest: () => this.scheduleManifest(),
      },
      payload,
    );
  }

  extensionsFor(subagentId: string): number {
    return this.budgetPolicy.extensionsFor(subagentId);
  }

  workComplete(): void {
    this.workCompleteFlag = true;
    this.fleet.emit({
      subagentId: this.id,
      ts: Date.now(),
      type: 'director.work_complete',
      payload: {},
    });
  }

  isWorkComplete(): boolean {
    return this.workCompleteFlag;
  }

  /**
   * Ask every running background subagent that opted into `gracefulFinish`
   * to finish its task in its own turn. In-band notification between tool
   * batches — no interrupt, no abort; each subagent keeps its time budget and
   * accelerates. Session shutdown calls this before draining Chimera work so
   * the post-session reviewer is nudged to complete rather than killed.
   * Returns the number of subagents notified.
   */
  requestFinish(reason: string): number {
    return this.coordinator.requestFinish(reason);
  }

  setLeaderBtwNote(note: string): number {
    return this.btwNotes.add(note);
  }

  getLeaderBtwNotes(): string[] {
    return this.btwNotes.drain();
  }

  peekLeaderBtwNotes(): string[] {
    return this.btwNotes.peek();
  }

  drainLeaderBtwNotes(): string[] {
    return this.getLeaderBtwNotes();
  }

  cancelCollabSession(sessionId: string, reason = 'Director cancelled'): void {
    this.collab.cancel(sessionId, reason);
  }

  onCollabAlert(handler: (alert: import('./collab-debug.js').DirectorAlert) => void): () => void {
    return this.collab.onAlert(handler);
  }

  activeCollabSessions(): string[] {
    return this.collab.activeSessionIds();
  }

  async appendSessionEvent(event: Parameters<SessionWriter['append']>[0]): Promise<void> {
    await appendDirectorSessionEvent(this.checkpointHost(), event);
  }

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

  async spawn(
    callerConfig: SubagentConfig,
    priceLookup?: {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    },
  ): Promise<string> {
    const policySessionId = callerConfig.originSessionId ?? this.currentSessionId();
    if (!areSubagentsAllowedForSession(policySessionId)) {
      throw new Error('Subagents are disabled for this session.');
    }
    lockSessionSubagentPolicyForSession(policySessionId);
    if (this.workCompleteFlag) {
      throw new FleetSpawnBudgetError(
        'max_spawns',
        this.maxSpawns,
        this.spawnCount + 1,
        'workComplete() has been called — director closed further spawning',
      );
    }
    const config: SubagentConfig = { ...callerConfig };
    // Session-scoped model plan: take a lane BEFORE resolution so the lane's
    // target participates in it, and hand the lane to the spawned subagent so
    // `remove()` can give it back. A spawn that never happens (budget caps,
    // coordinator refusal) must not strand the lane as permanently busy.
    const slotClaim = isHumanPinnedSpawn(config)
      ? undefined
      : claimSubagentSlot(policySessionId, {
          role: config.role,
          // `/setmodel` routing keeps its spawns: a role (or phase) the user
          // deliberately routed is not a "plain" spawn, so lanes and the
          // follow-session switch step aside for it. A session role override
          // still wins — that one names this role AND this session.
          routed: this.hasExplicitMatrixRoute(config.role),
        });
    this.resolveSpawnModel(config, slotClaim);
    let subagentId: string;
    try {
      subagentId = await fleetSpawn(this, config, priceLookup);
    } catch (err) {
      slotClaim?.abandon();
      throw err;
    }
    slotClaim?.bind(subagentId);
    // Per-subagent idle timeout override: if the caller supplied an
    // `idleTimeoutMs` in the SubagentConfig (e.g. via `spawn_subagent`'s
    // inputSchema), honor it. Otherwise fall back to the Director-wide
    // `subagentIdleTimeoutMs`. This lets callers keep spawned slots alive
    // across the gap between `spawn_subagent` and `assign_task` when the
    // leader's reasoning time exceeds the default.
    const perSubagentIdleMs =
      typeof config.idleTimeoutMs === 'number' &&
      Number.isFinite(config.idleTimeoutMs) &&
      config.idleTimeoutMs >= 0
        ? config.idleTimeoutMs
        : this.subagentIdleTimeoutMs;
    this.subagentIdleDelayMs.set(subagentId, perSubagentIdleMs);
    this.armSubagentIdleRetirement(subagentId, perSubagentIdleMs);
    return subagentId;
  }

  /**
   * True when `/setmodel` names this role or its phase explicitly. The `*`
   * wildcard does NOT count: it is the fallback for everything, not a routing
   * decision about this spawn, so a session lane may still take it.
   */
  private hasExplicitMatrixRoute(role: string | undefined): boolean {
    return delegateHasExplicitMatrixRoute(this.directorModelRoutingHost(), role);
  }

  /**
   * The provider/model a spawned worker actually runs on. `spawn()` resolves
   * into its own copy of the config, so this map — written at spawn time — is
   * the only honest answer for a caller that wants to report the pair back.
   */
  resolvedModelFor(
    subagentId: string,
  ): { provider?: string | undefined; model?: string | undefined } | undefined {
    return delegateResolvedModelFor(this.directorModelRoutingHost(), subagentId);
  }

  private resolveSpawnModel(
    config: SubagentConfig,
    slotClaim?: SubagentSlotClaim | undefined,
  ): void {
    delegateResolveSpawnModel(this.directorModelRoutingHost(), config, slotClaim);
  }

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

  rollUp(taskIds: string[], style: 'markdown' | 'json' = 'markdown'): string {
    return this.tasks.rollUp(taskIds, style);
  }

  async writeManifest(): Promise<string | null> {
    if (!this.manifestPath) return null;
    this.clearManifestTimer();
    const write = this.manifestWriteChain
      .catch(() => undefined)
      .then(() => writeDirectorManifest(this.checkpointHost()));
    this.manifestWriteChain = write.catch(() => undefined);
    return write;
  }

  async quiesceManifest(): Promise<void> {
    this.clearManifestTimer();
    await this.manifestWriteChain.catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    this.clearManifestTimer();
    if (this.taskCompletedListener) {
      this.coordinator.off('task.completed', this.taskCompletedListener);
      this.taskCompletedListener = null;
    }
    this.budgetPolicy.dispose();
    this.idleRetirement.dispose();
    this.subagentIdleDelayMs.clear();
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
      await this.manifestWriteChain.catch(() => undefined);
    } else if (this.manifestPath) {
      await this.writeManifest().catch((err) => this.logShutdownError('manifest_write', err));
    }
    if (this.stateCheckpoint) {
      this.stateCheckpoint.setUsage(this.usage.snapshot());
      await this.stateCheckpoint
        .flush()
        .catch((err) => this.logShutdownError('state_checkpoint_flush', err));
      await this.stateCheckpoint
        .releaseLock()
        .catch((err) => this.logShutdownError('state_checkpoint_lock_release', err));
    }
    this.largeAnswerStore.clear();
  }

  private logShutdownError(phase: string, err: unknown): void {
    const detail = toErrorMessage(err);
    process.emitWarning(
      `Director shutdown phase "${phase}" failed: ${detail}`,
      'DirectorShutdownWarning',
    );
  }

  async assign(task: TaskSpec): Promise<string> {
    return this.tasks.assign(task);
  }

  async assignInternal(task: TaskSpec): Promise<string> {
    return this.tasks.assignInternal(task);
  }

  awaitTasks(taskIds: string[]): Promise<TaskResult[]> {
    return this.tasks.awaitTasks(taskIds);
  }

  /**
   * Declare a task delegation-owned before assigning it. Its settlement then
   * never produces `taskResultNotifier` mail — the delegation publishes the
   * outcome itself.
   */
  markTaskOwned(taskId: string): void {
    this.tasks.markOwned(taskId);
  }

  private readonly sessionTerminateListeners = new Set<(sessionId: string) => void>();

  /** Called at the start of every `terminateSession(sessionId)`. */
  onSessionTerminate(listener: (sessionId: string) => void): () => void {
    this.sessionTerminateListeners.add(listener);
    return () => {
      this.sessionTerminateListeners.delete(listener);
    };
  }

  /**
   * Observe a task's settlement without registering as a waiter, so a leader
   * `await_tasks` on the same id remains distinguishable (`leaderConsumed`).
   */
  observeTask(
    taskId: string,
    cb: (result: TaskResult, info: { leaderConsumed: boolean }) => void,
  ): () => void {
    return this.tasks.observe(taskId, cb);
  }

  awaitTasksAny(taskIds: string[], opts?: { timeoutMs?: number }): Promise<AwaitAnyResult> {
    return this.tasks.awaitTasksAny(taskIds, opts);
  }

  listPendingTasks(): readonly TaskSpec[] {
    return this.tasks.listPendingTasks();
  }

  retargetPendingTask(taskId: string, subagentId: string | undefined): boolean {
    return this.tasks.retargetPendingTask(taskId, subagentId);
  }

  async terminate(subagentId: string): Promise<void> {
    await this.coordinator.stop(subagentId);
    void this.remove(subagentId).catch((err) => this.logShutdownError('terminate_remove', err));
  }

  async terminateAll(): Promise<void> {
    const ids = this.status().subagents.map((s) => s.id);
    await this.coordinator.stopAll();
    for (const id of ids) {
      void this.remove(id).catch((err) => this.logShutdownError('terminate_all_remove', err));
    }
  }

  /** Every live subagent one session spawned (what `terminateSession` would stop). */
  subagentIdsForSession(sessionId: string): string[] {
    return this.coordinator.subagentIdsForSession(sessionId);
  }

  /**
   * Terminate every subagent spawned by ONE session.
   *
   * What a tab's Stop button needs. `terminateAll()` is the wrong tool once
   * several sessions share a director: it would kill three other tabs' fleets
   * along with this one's. Aborting the leader's run only unwinds workers the
   * leader is BLOCKED on (the delegate tool terminates those itself); anything
   * started with `spawn_subagent` + `assign_task` keeps running because nobody
   * asked it to stop. This is that ask, scoped to the session that owns them.
   */
  async terminateSession(sessionId: string): Promise<void> {
    if (!sessionId) return;
    // Tell session-scoped owners first (the background delegation tracker),
    // so the `stopped` settlements that follow are attributed to the user.
    for (const listener of [...this.sessionTerminateListeners]) {
      try {
        listener(sessionId);
      } catch (err) {
        this.logger?.warn('[director] session terminate listener failed', { err });
      }
    }
    const ids = this.coordinator.subagentIdsForSession(sessionId);
    if (ids.length === 0) return;
    await this.coordinator.stopSession(sessionId);
    for (const id of ids) {
      void this.remove(id).catch((err) => this.logShutdownError('terminate_session_remove', err));
    }
  }

  async remove(subagentId: string): Promise<void> {
    // Single reclaim gate for every retirement path (idle reap,
    // retire-on-complete, session terminate, shutdown), so the session's model
    // lane is freed exactly once and the next spawn can reuse it.
    releaseSubagentSlot(subagentId);
    this.clearSubagentIdleRetirement(subagentId);
    this.subagentIdleDelayMs.delete(subagentId);
    void this.appendSessionEvent({
      type: 'agent_stopped',
      ts: new Date().toISOString(),
      agentId: subagentId,
    });
    await this.coordinator.remove(subagentId);

    const bridge = this.subagentBridges.get(subagentId);
    if (bridge) {
      await bridge.stop();
      this.subagentBridges.delete(subagentId);
    }

    this.usage.removeSubagent(subagentId);

    if (this.fleetManager) {
      this.fleetManager.removeSubagent(subagentId);
    } else {
      const entry = Director._asManifestEntry(this.manifestEntries.get(subagentId));
      if (entry?.name) {
        const nicknameKey = nicknameKeyFromDisplay(entry.name);
        if (nicknameKey) this.usedNicknames.delete(nicknameKey);
      }
    }

    const entryForCleanup = Director._asManifestEntry(this.manifestEntries.get(subagentId));
    if (entryForCleanup) {
      this.tasks.removeTasks(entryForCleanup.taskIds);
      for (const tid of entryForCleanup.taskIds) {
        this.taskWorktrees.delete(tid);
      }
    }
    // Path-independent reclaim for the default FleetManager path. The block
    // above only runs on the non-fleet fallback because manifestEntries is
    // populated solely when !host.fleetManager (fleet-spawn.ts:289); with a
    // FleetManager injected it is a no-op, so per-task state used to accumulate
    // for the Director's lifetime:
    //   - registry descriptions (full task briefs, KB-scale) + owners, one per
    //     assigned task;
    //   - taskWorktrees, one WorktreeTaskStateUpdate per worktree task.
    // The registry's owners index and each worktree update's subagentId are
    // populated on every path, so prune from both. Idempotent with the
    // manifest-entry cleanup above (double-delete is a no-op).
    this.tasks.removeTasksOwnedBy(subagentId);
    for (const [taskId, update] of this.taskWorktrees) {
      if (update.subagentId === subagentId) this.taskWorktrees.delete(taskId);
    }
    this.budgetPolicy.removeSubagent(subagentId);
    this.manifestEntries.delete(subagentId);
    // Drop the per-subagent metadata and price-lookup entries that
    // FleetManager records at spawn time (fleet-spawn.ts:254 and
    // fleet-manager.ts:361). When Director runs WITHOUT a fleetManager
    // (the non-fleet fallback path), these Maps live on the Director
    // itself and would otherwise accumulate one entry per retired
    // subagent — same leak FleetManager already fixed internally.
    //
    // priceLookups is keyed by `${provider}/${model}` (shared across
    // subagents using the same model), not by subagentId. Read the
    // provider/model from subagentMeta so we delete exactly the right
    // entry instead of guessing or deleting all entries.
    const meta = this.subagentMeta.get(subagentId);
    if (meta?.provider && meta.model) {
      this.priceLookups.delete(`${meta.provider}/${meta.model}`);
    }
    this.subagentMeta.delete(subagentId);
  }

  private clearSubagentIdleRetirement(subagentId: string): void {
    this.idleRetirement.clear(subagentId);
  }

  private armSubagentIdleRetirement(subagentId: string, delayMs: number | undefined): void {
    this.idleRetirement.arm(subagentId, delayMs);
  }

  status(): CoordinatorStatus {
    const base = this.coordinator.getStatus();
    return {
      ...base,
      subagents: base.subagents.map((s) => ({
        ...s,
        extensions: this.budgetPolicy.extensionsFor(s.id),
      })),
    };
  }

  on(
    event: 'task.completed',
    handler: (payload: { task: TaskSpec; result: TaskResult }) => void,
  ): () => void {
    this.coordinator.on(event, handler);
    return () => {
      this.coordinator.off(event, handler);
    };
  }

  completedResults(): TaskResult[] {
    return this.tasks.completedResults();
  }

  setCheckpointState(snapshot: DirectorStateSnapshot): void {
    setDirectorCheckpointState(this.checkpointHost(), snapshot);
    this.applyResumeBudget(snapshot);
  }

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

  leaderSystemPrompt(basePrompt?: string): string {
    return composeDirectorPrompt({
      basePrompt: basePrompt ?? this.coordinator.config.leaderSystemPrompt,
      directorPreamble: this.directorPreamble,
      rosterSummary: this.roster ? rosterSummaryFromConfigs(this.roster) : undefined,
    });
  }

  subagentSystemPrompt(config: SubagentConfig, taskBrief?: string): string {
    return composeSubagentPrompt({
      baseline: renderInstructionLayer(this.subagentBaseline, {
        toolNames: new Set(config.tools ?? []),
        tier: 'off',
        subagent: true,
        strictToolReferences: true,
      }),
      role: config.prompt,
      task: taskBrief,
      sharedScratchpad: this.sharedScratchpadPath ?? undefined,
      skills: config.skillContent,
      override: config.systemPromptOverride,
    });
  }

  tools(roster?: Record<string, SubagentConfig>): Tool[] {
    const effectiveRoster = roster ?? this.roster;
    return buildDirectorToolset(this, effectiveRoster);
  }

  async acquireCheckpointLock(): Promise<boolean> {
    return acquireDirectorCheckpointLock(this.checkpointHost());
  }

  async spawnCollab(options: CollabSessionOptions): Promise<CollabDebugReport> {
    return this.collab.spawn(options);
  }

  resumeFromCheckpoint(snapshot: DirectorStateSnapshot): void {
    resumeDirectorFromCheckpoint(this.checkpointHost(), snapshot);
    this.applyResumeBudget(snapshot);
  }

  /**
   * After re-attaching checkpoint metadata, pin the live maxSpawns ceiling
   * (profile/flag/env wins over historical checkpoint metadata). The
   * historical cumulative spawn counter is deliberately NOT restored — the
   * lifetime budget is scoped to this director run, so a restarted session
   * resumes with a fresh budget rather than a possibly-exhausted counter.
   */
  private applyResumeBudget(snapshot: DirectorStateSnapshot): void {
    if (this.fleetManager) {
      this.fleetManager.restoreFromCheckpoint(snapshot);
    }
    // Director owns a parallel checkpoint writer for task events — keep its
    // ceiling metadata aligned with the live construction-time maxSpawns.
    this.stateCheckpoint?.applyLiveMaxSpawns(
      Number.isFinite(this.maxSpawns) ? this.maxSpawns : undefined,
    );
  }

  private directorModelRoutingHost(): DirectorModelRoutingHost {
    return {
      modelMatrix: this.modelMatrix,
      fleetManager: this.fleetManager,
      subagentMeta: this.subagentMeta,
      appConfig: this.appConfig,
      sessionProvider: this.sessionProvider,
      sessionModel: this.sessionModel,
      statusTracker: this.statusTracker,
      logger: this.logger,
    };
  }
}
