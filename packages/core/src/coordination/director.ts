import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import { renderInstructionLayer } from '../core/instruction-template.js';
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
import { resolveDirectorSpawnModel } from './director-spawn-model.js';
import { FleetBus, type FleetUsage, FleetUsageAggregator } from './fleet-bus.js';
import type { FleetManager } from './fleet-manager.js';
import { type DirectorFleetHost, spawn as fleetSpawn, type ManifestEntry } from './fleet-spawn.js';
import type { ICoordinator } from './icoordinator.js';
import { InMemoryBridgeTransport } from './in-memory-transport.js';
import { LargeAnswerStore } from './large-answer-store.js';
import type { ModelMatrixSource } from './model-matrix.js';
import { DefaultMultiAgentCoordinator } from './multi-agent-coordinator.js';
import type { ProviderModelStatusTracker } from './provider-status-tracker.js';
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

/**
 * Minimum delay for re-arming an idle-retirement check that fired while the
 * subagent was still busy. Re-arms reuse the caller's window; this floor only
 * prevents a retire-on-complete (0ms) check from spinning sub-millisecond
 * while the subagent keeps working.
 */
const BUSY_REARM_FLOOR_MS = 1_000;

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
  private readonly subagentIdleTimers = new Map<string, ReturnType<typeof setTimeout>>();
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
  leaderContextPressure = 0;
  readonly maxLeaderContextLoad: number;
  private readonly maxContext: number | (() => number | undefined);
  readonly modelMatrix?: ModelMatrixSource | undefined;
  workCompleteFlag = false;
  private readonly btwNotes = new DirectorBtwNotes();
  private readonly collab: DirectorCollabController;
  readonly largeAnswerStore: LargeAnswerStore;
  private readonly statusTracker: ProviderModelStatusTracker | undefined;
  private readonly sessionProvider: string | undefined;
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
    const r = payload.result;
    const settled = this.tasks.settle(r);
    if (settled.internal) {
      // Internal tasks (background probes, shadow passes) are exempt from
      // retire-on-complete — that policy is for the leader-visible one-shot
      // surface. But exemption must not mean "no bound": arm the subagent's
      // OWN idle window (spawn-time override or Director-wide default) so an
      // internal-only resident (e.g. the resident `explore-companion`) is
      // reaped after that window instead of living forever. Never retire-0
      // here — that would kill the resident mid-session, the opposite of
      // the exemption's intent.
      this.armSubagentIdleRetirement(
        r.subagentId,
        this.subagentIdleDelayMs.get(r.subagentId) ?? this.subagentIdleTimeoutMs,
      );
      return;
    }
    const title = this.tasks.descriptionFor(r.taskId, payload.task.description ?? r.taskId);
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
      } catch {}
    }
    const failed = r.status !== 'success';
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
    if (failed) {
      void this.appendSessionEvent({
        type: 'agent_error',
        ts: new Date().toISOString(),
        agentId: r.subagentId,
        error: errorString ?? r.status,
      });
    }
    if (this.fleetManager) {
      void this.fleetManager.flushManifest();
    } else {
      this.scheduleManifest();
    }
    this.armSubagentIdleRetirement(
      r.subagentId,
      this.retireSubagentOnTaskComplete
        ? 0
        : (this.subagentIdleDelayMs.get(r.subagentId) ?? this.subagentIdleTimeoutMs),
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
    if (this.workCompleteFlag) {
      throw new FleetSpawnBudgetError(
        'max_spawns',
        this.maxSpawns,
        this.spawnCount + 1,
        'workComplete() has been called — director closed further spawning',
      );
    }
    const config: SubagentConfig = { ...callerConfig };
    this.resolveSpawnModel(config);
    const subagentId = await fleetSpawn(this, config, priceLookup);
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

  private resolveSpawnModel(config: SubagentConfig): void {
    resolveDirectorSpawnModel(config, {
      modelMatrix: this.modelMatrix,
      sessionProvider: this.sessionProvider,
      sessionModel: this.sessionModel,
      statusTracker: this.statusTracker,
      logger: this.logger,
    });
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
    for (const timer of this.subagentIdleTimers.values()) clearTimeout(timer);
    this.subagentIdleTimers.clear();
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

  async remove(subagentId: string): Promise<void> {
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
    const timer = this.subagentIdleTimers.get(subagentId);
    if (!timer) return;
    clearTimeout(timer);
    this.subagentIdleTimers.delete(subagentId);
  }

  private armSubagentIdleRetirement(subagentId: string, delayMs: number | undefined): void {
    this.clearSubagentIdleRetirement(subagentId);
    if (delayMs === undefined) return;
    const timer = setTimeout(() => {
      this.subagentIdleTimers.delete(subagentId);
      const entry = this.coordinator.getStatus().subagents.find((a) => a.id === subagentId);
      // Already gone: nothing to retire. (The normal removal path clears the
      // armed timer itself; re-arming here would chain 1s timers on a dead id.)
      if (entry === undefined) return;
      // Busy at the tick: re-arm, never drop. Dropping stranded a resident
      // mid-flight on its only armed timer — it stayed in the fleet forever
      // with nothing left to retire it. Re-arm reuses the SAME window the
      // caller chose; the floor keeps a retire-on-complete (0ms) check from
      // becoming a sub-millisecond spin while the subagent keeps working. A
      // task completing on the subagent re-arms retirement itself
      // (handleTaskCompleted), so this re-arm is only the safety net between
      // status flips.
      if (entry.status !== 'idle') {
        this.armSubagentIdleRetirement(subagentId, Math.max(delayMs, BUSY_REARM_FLOOR_MS));
        return;
      }
      if (this.coordinator.listPendingTasks().some((task) => task.subagentId === subagentId)) {
        this.armSubagentIdleRetirement(subagentId, Math.max(delayMs, BUSY_REARM_FLOOR_MS));
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
}
