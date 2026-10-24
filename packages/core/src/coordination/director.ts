import type {
  AwaitAnyResult,
  CoordinatorStatus,
  SubagentConfig,
  TaskResult,
  TaskSpec,
} from '@wrongstack/contracts/types/multi-agent';
import type { Tool } from '@wrongstack/contracts/types/tool';
import {
  areSubagentCompanionsAllowedForSession,
  areSubagentsAllowedForSession,
} from '../security/session-subagent-policy.js';
import type { DirectorStateSnapshot } from '../storage/director-state.js';
import {
  acquireCheckpointLock as acquireDirectorCheckpointLock,
  resumeFromCheckpoint as resumeDirectorFromCheckpoint,
  setCheckpointState as setDirectorCheckpointState,
} from './checkpoint-wiring.js';
import type { CollabDebugReport, CollabSessionOptions } from './collab-debug.js';
import { buildDirectorToolset } from './director/director-toolset.js';
import {
  ask as askFromHost,
  extensionsFor as extensionsForFromHost,
  on as onFromHost,
} from './director-completion-listeners.js';
import { DirectorCore } from './director-core.js';
import { shutdownDirector, terminateDirectorSession } from './director-lifecycle.js';
import {
  hasExplicitMatrixRoute as delegateHasExplicitMatrixRoute,
  resolvedModelFor as delegateResolvedModelFor,
  resolveSpawnModel as delegateResolveSpawnModel,
} from './director-model-routing.js';
import { directorLeaderPrompt, directorSubagentPrompt } from './director-prompt-host.js';
import {
  type DirectorSubagentSessionSummary,
  readDirectorSubagentSession,
} from './director-session.js';
import { admitDirectorSpawn } from './director-spawn-admission.js';
import {
  applyResumeBudget as applyResumeBudgetFromHost,
  drainLeaderBtwNotes as drainLeaderBtwNotesFromHost,
  getLeaderBtwNotes as getLeaderBtwNotesFromHost,
  getSubagentMeta as getSubagentMetaFromHost,
  markTaskOwned as markTaskOwnedFromHost,
  observeTask as observeTaskFromHost,
  onSessionTerminate as onSessionTerminateFromHost,
  peekLeaderBtwNotes as peekLeaderBtwNotesFromHost,
  reopenWork as reopenWorkFromHost,
  requestFinish as requestFinishFromHost,
  setLeaderBtwNote as setLeaderBtwNoteFromHost,
  subagentIdsForSession as subagentIdsForSessionFromHost,
  workComplete as workCompleteFromHost,
} from './director-task-notes.js';
import type { FleetUsage } from './fleet-bus.js';
import type { DirectorFleetHost } from './fleet-spawn.js';
import type { ICoordinator } from './icoordinator.js';
import type { SubagentSlotClaim } from './session-subagent-models.js';

export {
  FleetContextOverflowError,
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
} from './director/director-errors.js';

export type { DirectorOptions, TaskResultNotification } from './director-options.js';

export type { ModelMatrixSource } from './model-matrix.js';

export class Director extends DirectorCore implements DirectorFleetHost, ICoordinator {
  get coordinatorId(): string {
    return this.id;
  }

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

  extensionsFor(subagentId: string): number {
    return extensionsForFromHost(this.directorCompletionListenersHost(), subagentId);
  }

  workComplete(): void {
    workCompleteFromHost(this.directorTaskNotesHost());
  }

  isWorkComplete(): boolean {
    return this.workCompleteFlag;
  }

  /** Lift a `work_complete` latch for the next job; see `reopenWork`. */
  reopenWork(): boolean {
    return reopenWorkFromHost(this.directorTaskNotesHost());
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
    return requestFinishFromHost(this.directorTaskNotesHost(), reason);
  }

  setLeaderBtwNote(note: string): number {
    return setLeaderBtwNoteFromHost(this.directorTaskNotesHost(), note);
  }

  getLeaderBtwNotes(): string[] {
    return getLeaderBtwNotesFromHost(this.directorTaskNotesHost());
  }

  peekLeaderBtwNotes(): string[] {
    return peekLeaderBtwNotesFromHost(this.directorTaskNotesHost());
  }

  drainLeaderBtwNotes(): string[] {
    return drainLeaderBtwNotesFromHost(this.directorTaskNotesHost());
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
    return this.spawnAdmitted(callerConfig, policySessionId, priceLookup);
  }

  /**
   * Spawn a resident read-only companion (memory, explore). A solo session in
   * `companions` mode admits these and nothing else. The exemption is its own
   * entry point, not a config field, so no caller-built config — a
   * `spawn_subagent` call, a project roster override — can claim it.
   */
  async spawnCompanion(callerConfig: SubagentConfig): Promise<string> {
    const policySessionId = callerConfig.originSessionId ?? this.currentSessionId();
    if (!areSubagentCompanionsAllowedForSession(policySessionId)) {
      throw new Error('Subagent companions are disabled for this session.');
    }
    return this.spawnAdmitted(callerConfig, policySessionId, undefined, { companion: true });
  }

  private async spawnAdmitted(
    callerConfig: SubagentConfig,
    policySessionId: string | undefined,
    priceLookup?: {
      input?: number | undefined;
      output?: number | undefined;
      cacheRead?: number | undefined;
      cacheWrite?: number | undefined;
    },
    opts?: { companion?: boolean | undefined },
  ): Promise<string> {
    const self = this;
    return admitDirectorSpawn(
      this,
      {
        get workCompleteFlag() {
          return self.workCompleteFlag;
        },
        maxSpawns: this.maxSpawns,
        get spawnCount() {
          return self.spawnCount;
        },
        hasExplicitMatrixRoute: (role) => this.hasExplicitMatrixRoute(role),
        resolveSpawnModel: (config, slot) => this.resolveSpawnModel(config, slot),
        subagentIdleTimeoutMs: this.subagentIdleTimeoutMs,
        subagentIdleDelayMs: this.subagentIdleDelayMs,
        armSubagentIdleRetirement: (id, delay) => this.armSubagentIdleRetirement(id, delay),
      },
      callerConfig,
      policySessionId,
      priceLookup,
      opts,
    );
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
  ):
    | { provider?: string | undefined; model?: string | undefined; effort?: string | undefined }
    | undefined {
    return delegateResolvedModelFor(this.directorModelRoutingHost(), subagentId);
  }

  private resolveSpawnModel(
    config: SubagentConfig,
    slotClaim?: SubagentSlotClaim | undefined,
  ): void {
    delegateResolveSpawnModel(this.directorModelRoutingHost(), config, slotClaim);
  }

  async ask<T = unknown>(subagentId: string, payload: unknown, timeoutMs?: number): Promise<T> {
    return askFromHost<T>(this.directorCompletionListenersHost(), subagentId, payload, timeoutMs);
  }

  rollUp(taskIds: string[], style: 'markdown' | 'json' = 'markdown'): string {
    return this.tasks.rollUp(taskIds, style);
  }

  async quiesceManifest(): Promise<void> {
    this.clearManifestTimer();
    await this.manifestWriteChain.catch(() => undefined);
  }

  async shutdown(): Promise<void> {
    return shutdownDirector(this.directorLifecycleHost());
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
    markTaskOwnedFromHost(this.directorTaskNotesHost(), taskId);
  }

  /** Called at the start of every `terminateSession(sessionId)`. */
  onSessionTerminate(listener: (sessionId: string) => void): () => void {
    return onSessionTerminateFromHost(this.directorTaskNotesHost(), listener);
  }

  /**
   * Observe a task's settlement without registering as a waiter, so a leader
   * `await_tasks` on the same id remains distinguishable (`leaderConsumed`).
   */
  observeTask(
    taskId: string,
    cb: (result: TaskResult, info: { leaderConsumed: boolean }) => void,
  ): () => void {
    return observeTaskFromHost(this.directorTaskNotesHost(), taskId, cb);
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
    return subagentIdsForSessionFromHost(this.directorTaskNotesHost(), sessionId);
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
    return terminateDirectorSession(this.directorLifecycleHost(), sessionId);
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
    return onFromHost(this.directorCompletionListenersHost(), event, handler);
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
    return getSubagentMetaFromHost(this.directorTaskNotesHost(), id);
  }

  leaderSystemPrompt(basePrompt?: string): string {
    return directorLeaderPrompt(this.directorPromptHost(), basePrompt);
  }

  subagentSystemPrompt(config: SubagentConfig, taskBrief?: string): string {
    return directorSubagentPrompt(this.directorPromptHost(), config, taskBrief);
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
    applyResumeBudgetFromHost(this.directorTaskNotesHost(), snapshot);
  }
}
