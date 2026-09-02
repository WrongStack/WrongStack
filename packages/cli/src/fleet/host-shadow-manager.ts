/**
 * Host-level Shadow Agent lifecycle and observation management.
 *
 * ## One shadow review per conversation
 *
 * The shadow agent is a reactive reviewer: the host counts the work it sees
 * start and finish, and when a run or a subagent task ends badly it spawns a
 * one-shot reviewer once everything it was watching has settled.
 *
 * All of that state used to be flat fields on this class, which is exactly
 * right for the CLI and the TUI — one process, one conversation. The WebUI
 * puts up to four conversations on the same process, and flat fields made
 * them one conversation as far as the shadow agent was concerned:
 *
 *   - the depth counter mixed all four tabs, so a review triggered by tab 3
 *     was held back for as long as ANY other tab was still running, and the
 *     "problem" text it was eventually given was a semicolon-joined mix of
 *     failures from tabs that had nothing to do with each other;
 *   - the spawn carried no owning session, so the coordinator filed the
 *     reviewer under the host's own (boot) session: tab 3's failure grew a
 *     shadow agent in **tab 1's** roster, reporting to tab 1's leader, while
 *     the tab that actually failed saw nothing;
 *   - `shadowAgentId` was a single slot, so the second conversation to need a
 *     review either reused the first one's agent or quietly overwrote the
 *     pointer to it, leaving the first agent unstoppable.
 *
 * State is now keyed by the owning conversation. Every event this class
 * listens to already carries `sessionId` (the subagent bridges stamp the
 * spawning tab since the owning-session wave); an unstamped event — thin
 * embedders, and every single-session host — falls back to the host's own
 * session, which is why the CLI and the TUI behave exactly as before.
 *
 * The map is bounded the way the other per-session maps in the codebase are:
 * at most `MAX_TRACKED_SESSIONS` entries, evicting the oldest one that holds
 * nothing worth keeping (no live agent, no work in flight, no queued
 * problem). Losing such an entry loses nothing — the next run rebuilds it.
 *
 * @module fleet/host-shadow-manager
 */

import type { Config, SubagentConfig } from '@wrongstack/core/types';
import { areSubagentsAllowedForSession, type Director } from '@wrongstack/core/coordination';
import type { MultiAgentDeps, MultiAgentHostOptions } from './host-types.js';
import { runHostShadowPass, stopHostShadowAfterTask } from './host-shadow-pass.js';

interface HostShadowManagerContext {
  deps: MultiAgentDeps;
  opts: MultiAgentHostOptions;
  getDirector: () => Director | undefined;
  spawnAndAssign: (
    subagentConfig: SubagentConfig,
    description: string,
    opts?: {
      internalTask?: boolean;
      stopShadowAfterTask?: boolean;
      shadowIntervalMs?: number | undefined;
      taskContext?:
        | {
            kanban?: { boardId?: string; taskId?: string; projectRoot?: string };
          }
        | undefined;
    },
  ) => Promise<{ subagentId: string; taskId: string }>;
}

/** Conversations tracked at once. Four tabs, plus slack for handover churn. */
const MAX_TRACKED_SESSIONS = 8;

const DEFAULT_HEARTBEAT_INTERVAL_MS = 30_000;

/** Everything the shadow agent knows about ONE conversation. */
interface ShadowSessionState {
  agentId: string | null;
  taskId: string | null;
  heartbeatIntervalMs: number;
  autoStartSuppressions: number;
  observedWorkDepth: number;
  passInFlight: boolean;
  queuedProblem: string | null;
  outstandingTaskIds: Set<string>;
  stopAfterTaskIds: Set<string>;
}

function emptySessionState(heartbeatIntervalMs: number): ShadowSessionState {
  return {
    agentId: null,
    taskId: null,
    heartbeatIntervalMs,
    autoStartSuppressions: 0,
    observedWorkDepth: 0,
    passInFlight: false,
    queuedProblem: null,
    outstandingTaskIds: new Set(),
    stopAfterTaskIds: new Set(),
  };
}

/** An entry with nothing in flight and nothing to remember is free to evict. */
function isDisposable(state: ShadowSessionState): boolean {
  return (
    state.agentId === null &&
    state.observedWorkDepth === 0 &&
    state.autoStartSuppressions === 0 &&
    !state.passInFlight &&
    state.queuedProblem === null &&
    state.outstandingTaskIds.size === 0 &&
    state.stopAfterTaskIds.size === 0
  );
}

export class HostShadowManager {
  private readonly sessions = new Map<string, ShadowSessionState>();
  /** Shadow task id → owning conversation. Also the `isShadowTask` index. */
  private readonly taskSessions = new Map<string, string>();
  /** Live shadow agent id → owning conversation. */
  private readonly agentSessions = new Map<string, string>();
  private readonly shadowActivityOffHandles: Array<() => void> = [];

  constructor(private readonly ctx: HostShadowManagerContext) {}

  /**
   * The conversation an unstamped caller means.
   *
   * Single-session hosts never name one, and for them this is the only
   * session there is.
   */
  private hostSessionId(): string {
    return this.ctx.deps.session.id;
  }

  private resolve(sessionId?: string | undefined): string {
    return sessionId && sessionId.length > 0 ? sessionId : this.hostSessionId();
  }

  /** Existing state for a conversation, without creating one. */
  private peek(sessionId?: string | undefined): ShadowSessionState | undefined {
    return this.sessions.get(this.resolve(sessionId));
  }

  private stateFor(sessionId?: string | undefined): ShadowSessionState {
    const id = this.resolve(sessionId);
    const existing = this.sessions.get(id);
    if (existing) return existing;
    this.evictIfFull(id);
    const created = emptySessionState(DEFAULT_HEARTBEAT_INTERVAL_MS);
    this.sessions.set(id, created);
    return created;
  }

  private evictIfFull(keep: string): void {
    if (this.sessions.size < MAX_TRACKED_SESSIONS) return;
    for (const [sessionId, state] of this.sessions) {
      if (sessionId === keep) continue;
      if (!isDisposable(state)) continue;
      this.sessions.delete(sessionId);
      return;
    }
    // Every tracked conversation is still busy. Growing past the cap is the
    // lesser evil: dropping a busy entry loses a queued review and orphans a
    // live shadow agent, and the map is bounded in practice by the number of
    // conversations the process actually serves.
  }

  getTaskIds(): ReadonlySet<string> {
    // The map's keys ARE the shadow task ids; a Set view keeps the callers'
    // `.has()` contract without a second structure to keep in sync.
    return new Set(this.taskSessions.keys());
  }

  isShadowTask(taskId: string): boolean {
    return this.taskSessions.has(taskId);
  }

  /** Conversation that owns a shadow task, if it is one. */
  sessionForTask(taskId: string): string | undefined {
    return this.taskSessions.get(taskId);
  }

  /** True when this subagent is some conversation's live shadow agent. */
  isShadowAgent(subagentId: string): boolean {
    return this.agentSessions.has(subagentId);
  }

  getAgentId(sessionId?: string | undefined): string | null {
    return this.peek(sessionId)?.agentId ?? null;
  }

  getTaskId(sessionId?: string | undefined): string | null {
    return this.peek(sessionId)?.taskId ?? null;
  }

  enterShadowSpawn(sessionId?: string | undefined): void {
    this.stateFor(sessionId).autoStartSuppressions++;
  }

  exitShadowSpawn(sessionId?: string | undefined): void {
    const state = this.peek(sessionId);
    if (state) state.autoStartSuppressions--;
  }

  onShadowTaskCompleted(taskId: string, subagentId: string): void {
    const sessionId = this.taskSessions.get(taskId) ?? this.agentSessions.get(subagentId);
    const state = this.peek(sessionId);
    state?.outstandingTaskIds.delete(taskId);
    if (state?.stopAfterTaskIds.delete(taskId)) {
      void this.stopShadowAfterTask(subagentId, this.resolve(sessionId));
    }
  }

  armIfNeeded(): void {
    if (this.shadowActivityOffHandles.length > 0) return;

    this.shadowActivityOffHandles.push(
      this.ctx.deps.events.on('agent.run.started', (e) => this.noteShadowWorkStarted(e.sessionId)),
      this.ctx.deps.events.on('agent.run.completed', (e) => {
        const problem =
          e.status === 'failed' || e.status === 'max_iterations'
            ? `leader run ended with ${e.status}`
            : undefined;
        this.noteShadowWorkCompleted(e.sessionId, problem);
      }),
      this.ctx.deps.events.on('subagent.task_started', (e) =>
        this.noteShadowWorkStarted(e.sessionId),
      ),
      this.ctx.deps.events.on('subagent.task_completed', (e) => {
        const problem =
          e.status === 'failed' || e.status === 'timeout'
            ? `subagent ${e.subagentId} task ${e.taskId} ended with ${e.status}${e.error?.message ? `: ${e.error.message}` : ''}`
            : undefined;
        this.noteShadowWorkCompleted(e.sessionId, problem);
      }),
    );
  }

  recordShadowAgent(
    subagentId: string,
    taskId: string,
    intervalMs?: number | undefined,
    sessionId?: string | undefined,
  ): void {
    const id = this.resolve(sessionId);
    const state = this.stateFor(id);
    state.agentId = subagentId;
    state.taskId = taskId;
    state.heartbeatIntervalMs = intervalMs ?? state.heartbeatIntervalMs;
    this.agentSessions.set(subagentId, id);
    this.markShadowTask(taskId, id);
    this.ctx.opts.onShadowAgentStarted?.(subagentId);
  }

  /**
   * Forget a shadow agent.
   *
   * With an id, only the conversation that owns that agent is touched — the
   * flat version cleared the single slot whoever asked, so one tab's reaped
   * reviewer used to wipe another tab's live one.
   */
  clearShadowAgent(subagentId?: string): void {
    if (subagentId) {
      const sessionId = this.agentSessions.get(subagentId);
      if (!sessionId) return;
      this.clearSessionShadowAgent(sessionId);
      return;
    }
    for (const sessionId of [...this.sessions.keys()]) this.clearSessionShadowAgent(sessionId);
  }

  private clearSessionShadowAgent(sessionId: string): void {
    const state = this.sessions.get(sessionId);
    if (!state) return;
    const stoppedId = state.agentId;
    state.agentId = null;
    state.taskId = null;
    state.outstandingTaskIds.clear();
    state.stopAfterTaskIds.clear();
    if (stoppedId) {
      this.agentSessions.delete(stoppedId);
      this.ctx.opts.onShadowAgentStopped?.(stoppedId);
    }
  }

  markShadowTask(taskId: string, sessionId?: string | undefined): void {
    const id = this.resolve(sessionId);
    this.taskSessions.set(taskId, id);
    this.stateFor(id).outstandingTaskIds.add(taskId);
  }

  addStopAfterTaskId(taskId: string, sessionId?: string | undefined): void {
    this.stateFor(this.taskSessions.get(taskId) ?? this.resolve(sessionId)).stopAfterTaskIds.add(
      taskId,
    );
  }

  removeShadowTask(taskId: string): void {
    const sessionId = this.taskSessions.get(taskId);
    this.taskSessions.delete(taskId);
    const state = this.peek(sessionId);
    state?.outstandingTaskIds.delete(taskId);
    state?.stopAfterTaskIds.delete(taskId);
  }

  isActiveSubagent(subagentId: string): boolean {
    const director = this.ctx.getDirector();
    if (!director) return false;
    const coordinator = (
      director as never as {
        coordinator: { getStatus: () => { subagents: Array<{ id: string; status: string }> } };
      }
    ).coordinator;
    const status = coordinator.getStatus().subagents.find((a) => a.id === subagentId)?.status;
    return status === 'running' || status === 'idle';
  }

  private noteShadowWorkStarted(sessionId?: string | undefined): void {
    const state = this.stateFor(sessionId);
    if (state.autoStartSuppressions > 0) return;
    state.observedWorkDepth++;
  }

  private noteShadowWorkCompleted(
    sessionId?: string | undefined,
    problem?: string | undefined,
  ): void {
    const id = this.resolve(sessionId);
    const state = this.stateFor(id);
    if (problem) {
      state.queuedProblem = state.queuedProblem ? `${state.queuedProblem}; ${problem}` : problem;
    }
    if (state.observedWorkDepth > 0) {
      state.observedWorkDepth--;
    }
    if (state.observedWorkDepth === 0 && state.queuedProblem) {
      const queued = state.queuedProblem;
      state.queuedProblem = null;
      this.requestShadowPass(queued, id);
    }
  }

  requestShadowPass(reason: string, sessionId?: string | undefined): void {
    const id = this.resolve(sessionId);
    queueMicrotask(() => {
      void this.runShadowPass(reason, id);
    });
  }

  async runShadowPass(reason: string, sessionId?: string | undefined): Promise<void> {
    const director = this.ctx.getDirector();
    if (!director) return;
    const id = this.resolve(sessionId);
    if (!areSubagentsAllowedForSession(id)) return;
    const state = this.stateFor(id);
    if (state.passInFlight || (state.agentId && this.isActiveSubagent(state.agentId))) {
      state.queuedProblem = state.queuedProblem ? `${state.queuedProblem}; ${reason}` : reason;
      return;
    }

    state.passInFlight = true;
    return runHostShadowPass(
      {
        getDirector: () => this.ctx.getDirector(),
        getLiveConfig: () => this.ctx.deps.configStore.get() as Config,
        getObservedWorkDepth: () => state.observedWorkDepth,
        getQueuedProblem: () => state.queuedProblem,
        setQueuedProblem: (value) => {
          state.queuedProblem = value;
        },
        setPassInFlight: (value) => {
          state.passInFlight = value;
        },
        getHeartbeatIntervalMs: () => state.heartbeatIntervalMs,
        sessionId: id,
        spawnAndAssign: (subagentConfig, task, opts) =>
          this.ctx.spawnAndAssign(subagentConfig, task, opts),
        requestShadowPass: (queued) => this.requestShadowPass(queued, id),
      },
      reason,
    );
  }

  private async stopShadowAfterTask(subagentId: string, sessionId: string): Promise<void> {
    const director = this.ctx.getDirector();
    const coordinator = director
      ? (director as never as { coordinator: { stop: (id: string) => Promise<void> } }).coordinator
      : undefined;
    const state = this.stateFor(sessionId);
    return stopHostShadowAfterTask(
      (targetSubagentId) => coordinator?.stop(targetSubagentId) ?? Promise.resolve(),
      (targetSubagentId) => this.clearShadowAgent(targetSubagentId),
      () => state.observedWorkDepth,
      () => state.queuedProblem,
      (value) => {
        state.queuedProblem = value;
      },
      (queued) => this.requestShadowPass(queued, sessionId),
      subagentId,
    );
  }

  /**
   * Drop everything one conversation was tracking — its tab closed.
   *
   * The live agent is cleared through the normal path so `onShadowAgentStopped`
   * still fires; stopping the subagent itself belongs to the caller that owns
   * the fleet teardown.
   */
  releaseSession(sessionId: string): void {
    if (!this.sessions.has(sessionId)) return;
    this.clearSessionShadowAgent(sessionId);
    for (const [taskId, owner] of [...this.taskSessions]) {
      if (owner === sessionId) this.taskSessions.delete(taskId);
    }
    this.sessions.delete(sessionId);
  }

  dispose(): void {
    this.clearShadowAgent();
    this.sessions.clear();
    this.taskSessions.clear();
    this.agentSessions.clear();
    for (const off of this.shadowActivityOffHandles) {
      off();
    }
    this.shadowActivityOffHandles.length = 0;
  }
}
