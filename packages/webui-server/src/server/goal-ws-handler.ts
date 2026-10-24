import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Logger } from '@wrongstack/contracts/types';
import type { Agent, Context } from '@wrongstack/core/agent';
import type { AgentFactory } from '@wrongstack/core/coordination';
import {
  GoalRunPersistence,
  type PhaseGraph,
  type PhaseNode,
  type PhaseOrchestrator,
  PhaseStore,
  type PhaseTemplate,
} from '@wrongstack/goal';
import type { WorktreeManager } from '@wrongstack/core/worktree';
import type { WebSocket } from 'ws';
import { type GoalRunHost, startGoalRun } from './goal-run.js';
import { buildGoalState } from './goal-state.js';
import {
  assessGoal,
  executeGoalTask,
  type GoalWorkerHost,
  repairGoalPhase,
} from './goal-workers.js';
import { broadcastGoalCatalog, routeToSelectedGoal } from './goal-ws-goal-routing.js';
import {
  broadcastGoalFrame,
  broadcastGoalState,
  sendGoalFrame,
  startGoalBroadcastTick,
} from './goal-ws-handler-broadcast.js';
import {
  buildGoalRunHost,
  buildGoalWorkerHost,
  planGoalPhases,
  runGoalChimeraReview,
} from './goal-ws-handler-hosts.js';
import type {
  GoalWSMessage,
  GoalWsHandlerInternals,
  WSClient,
} from './goal-ws-handler-internals.js';
import { attachGoalClient, disposeGoalHandler } from './goal-ws-handler-lifecycle.js';
import { dispatchGoalMessage } from './goal-ws-message-dispatch.js';
import {
  type GoalWsRunControlsHost,
  handleClear as handleClearFromHost,
  handleResumeGraph as handleResumeGraphFromHost,
  handleRevert as handleRevertFromHost,
  handleStart as handleStartFromHost,
  handleStop as handleStopFromHost,
} from './goal-ws-run-controls.js';
import { errMessage } from './ws-utils.js';

/**
 * GoalWebSocketHandler — WebSocket-based goal-driven phase execution.
 *
 * Message types:
 *   goal.start   → { title, phases?, autonomous? }
 *   goal.pause   → {}
 *   goal.resume  → {}
 *   goal.stop    → {}
 *   goal.status  → {}
 *   goal.selectPhase → { phaseId }
 *   goal.taskStatus  → { taskId, status }
 */
export class GoalWebSocketHandler {
  private readonly goals = new Map<string, GoalWebSocketHandler>();
  private readonly selections = new WeakMap<WebSocket, string>();
  private catalogTimer: ReturnType<typeof setInterval> | null = null;
  private catalogInFlight = false;
  private readOnly = false;
  private stopGeneration = 0;
  private orchestrator: PhaseOrchestrator | null = null;
  private runPromise: Promise<void> | null = null;
  private setupPromise: Promise<void> | null = null;
  private disposed = false;
  private graph: PhaseGraph | null = null;
  private store: PhaseStore;
  private persistence: GoalRunPersistence;
  private clients = new Set<WSClient>();
  private broadcastInterval: ReturnType<typeof setInterval> | null = null;
  /**
   * Change-detection state for the 2s broadcast tick: a cheap content
   * fingerprint of the graph and the last serialized progress payload, so an
   * idle run costs one small string build per tick instead of a full
   * buildState + serialize + fan-out every 2 seconds.
   */
  private lastGraphFingerprint = '';
  private lastProgressJson = '';
  /** Aborts in-flight task agents AND the planning turn when the run is stopped. */
  private abort: AbortController | null = null;
  /** Per-assessment AbortController so a newer assessment can abort the prior
   *  LLM call instead of waiting for it to finish (frees the Agent's single-flight
   *  guard sooner). */
  private assessAbort: AbortController | null = null;
  /** Monotonically increasing seq for stale-assessment detection. */
  private assessSeq = 0;
  /** Set the instant a stop/clear/revert is requested, so a planning turn that
   *  resolves afterwards never launches the orchestrator (the abort alone can't
   *  cover the window between the LLM call resolving and the orchestrator start). */
  private stopping = false;
  /** Optional per-phase git-worktree isolation (lazily created at start). */
  private worktrees: WorktreeManager | null = null;
  /** Base branch + tip SHA captured at run start so a revert can git-revert the
   *  run's squash commits (history-preserving) instead of a destructive reset. */
  private runBase: { branch: string; sha: string } | null = null;
  /** Per-run worker identities so the board can show "who is on what". */
  private usedNicknames = new Set<string>();
  /** Prevent overlapping planning/build sequences from installing competing runs. */
  private startInFlight = false;
  private runStatus: 'idle' | 'running' | 'paused' | 'completed' | 'failed' | 'stopped' = 'idle';
  private releaseRunLease: (() => Promise<void>) | null = null;
  private internalsChecked = false;

  constructor(
    private agent: Agent,
    private context: Context,
    private logger: Logger,
    storeDir: string,
    private events?: EventBus | undefined,
    private projectRoot?: string | undefined,
    /**
     * Optional tap invoked on every board-state broadcast with the live
     * `buildState()` projection. Lets a KanbanRunMirror project the Goal
     * run into a kanban board without this handler knowing about kanban. The
     * WebUI orchestrator does NOT emit PhaseEventMap on the shared bus, so this
     * callback is the mirror's only live signal for Goal.
     */
    private onBoardState?: ((graphId: string, state: Record<string, unknown>) => void) | undefined,
    /** Fresh isolated worker factory; task execution never shares the chat Context when provided. */
    private taskAgentFactory?: AgentFactory | undefined,
    private readonly goalId?: string | undefined,
  ) {
    this.store = new PhaseStore({ baseDir: storeDir });
    this.persistence = new GoalRunPersistence(this.store);
  }

  addClient(ws: WebSocket): void {
    attachGoalClient(this.internals(), ws);
  }

  /** Release timers, in-flight work, and socket references owned by this host. */
  dispose(): void {
    disposeGoalHandler(this.internals());
  }

  async handleMessage(ws: WebSocket, msg: GoalWSMessage): Promise<void> {
    if (this.disposed) return;
    if (!this.goalId && msg.type === 'goal.list') {
      await this.broadcastCatalog();
      return;
    }
    if (
      !this.goalId &&
      (await routeToSelectedGoal(this.internals(), ws, msg, (selectedId) =>
        new GoalWebSocketHandler(
          this.agent,
          this.context,
          this.logger,
          this.store.baseDir,
          this.events,
          this.projectRoot,
          this.onBoardState,
          this.taskAgentFactory,
          selectedId,
        ).internals(),
      ))
    )
      return;
    await dispatchGoalMessage(this.internals(), ws, msg);
  }

  /**
   * Assess a goal prompt for duration realism. Runs a lightweight LLM call
   * (faster than planPhases) and returns the structured assessment to the
   * requesting client so the UI can warn about unrealistic durations before
   * the user submits the goal for planning. Sends only to the originating
   * client (unicast) and echoes the client's `seq` for response correlation.
   */
  private async handleAssess(ws: WebSocket, payload?: Record<string, unknown>): Promise<void> {
    return assessGoal(this.goalWorkerHost(), ws, payload);
  }

  private async handleStart(payload?: Record<string, unknown>): Promise<void> {
    if (this.setupPromise) return handleStartFromHost(this.goalWsRunControlsHost(), payload);
    const setup = handleStartFromHost(this.goalWsRunControlsHost(), payload);
    this.setupPromise = setup;
    try {
      await setup;
    } finally {
      if (this.setupPromise === setup) this.setupPromise = null;
    }
  }

  private async handleResumeGraph(graphId: string): Promise<void> {
    if (this.setupPromise) return handleResumeGraphFromHost(this.goalWsRunControlsHost(), graphId);
    const setup = handleResumeGraphFromHost(this.goalWsRunControlsHost(), graphId);
    this.setupPromise = setup;
    try {
      await setup;
    } finally {
      if (this.setupPromise === setup) this.setupPromise = null;
    }
  }

  private async startRun(
    payload?: Record<string, unknown>,
    resumeGraph?: PhaseGraph,
  ): Promise<void> {
    return startGoalRun(this.goalRunHost(), payload, resumeGraph);
  }

  /**
   * Halt the run NOW — at any phase. Sets `stopping` (so a planning turn that
   * resolves afterwards bails), aborts in-flight agents, stops the orchestrator,
   * and ends the live broadcast. The board is kept for review; use
   * `goal.clear` to reset or `goal.revert` to undo the changes.
   */
  private async handleStop(): Promise<void> {
    this.stopGeneration++;
    return handleStopFromHost(this.goalWsRunControlsHost());
  }

  /**
   * Stop + wipe: tear down phase worktrees and reset to an empty board so the UI
   * returns to the start screen ("new one"). Does NOT touch already-merged commits
   * on the base branch — that is `goal.revert`.
   */
  private async handleClear(): Promise<void> {
    return handleClearFromHost(this.goalWsRunControlsHost());
  }

  /**
   * Stop + undo: remove phase worktrees, then history-preservingly `git revert`
   * every commit this run landed on the base branch (captured `runBase`..HEAD),
   * then reset to an empty board. Refuses (reports a reason) on a dirty tree or a
   * conflicting revert rather than leaving the tree half-reverted.
   */
  private async handleRevert(): Promise<void> {
    return handleRevertFromHost(this.goalWsRunControlsHost());
  }

  /** Plan phases+todos for the goal via the LLM (see `planGoalPhases`). */
  private async planPhases(goal: string, signal?: AbortSignal): Promise<PhaseTemplate[]> {
    return planGoalPhases(this.internals(), goal, signal);
  }

  private async executeTaskWithAgent(
    task: import('@wrongstack/contracts/types').TaskNode,
    phaseId: string,
    env?: { cwd?: string | undefined; branch?: string | undefined },
    signal?: AbortSignal | undefined,
  ): Promise<unknown> {
    return executeGoalTask(this.goalWorkerHost(), task, phaseId, env, signal);
  }

  private async runRepairPhase(
    phase: PhaseNode,
    failure: string,
    attempt: number,
    env?: { cwd?: string | undefined; branch?: string | undefined },
  ): Promise<void> {
    return repairGoalPhase(this.goalWorkerHost(), phase, failure, attempt, env);
  }

  /** Run a lightweight chimera-style review before the task is settled. */
  private async runChimeraReview(
    task: import('@wrongstack/contracts/types').TaskNode,
    phaseId: string,
    result: unknown,
    cwd?: string | undefined,
  ): Promise<void> {
    return runGoalChimeraReview(this.internals(), task, phaseId, result, cwd);
  }

  /**
   * Fire-and-forget persist.
   *
   * Every detached `store.save()` used to be a bare `void`, so a rejection
   * became an unhandled rejection and — under Node 22's default
   * `--unhandled-rejections=throw` — killed the process mid-run. On Windows an
   * AV scanner or indexer holding the `.wrongstack/phases/<id>.json` rename
   * target for a few hundred ms is enough (EPERM from `atomicWrite`), and in
   * `--webui` mode that takes the CLI session down with it. `handleStop` at
   * `:549` already had the `.catch`; these call sites did not.
   */
  private persistDetached(graph: Parameters<typeof this.store.save>[0]): void {
    void this.persistence.save(graph).catch((err: unknown) => {
      this.logger.warn(`[Goal] Failed to persist phase graph: ${errMessage(err)}`);
    });
  }

  /** Persist + broadcast after an interactive board mutation. */
  private afterBoardMutation(): void {
    if (this.graph) this.persistDetached(this.graph);
    this.broadcastState();
  }

  private async releaseActiveRunLease(): Promise<void> {
    const release = this.releaseRunLease;
    this.releaseRunLease = null;
    await release?.();
  }

  private startBroadcast(): void {
    startGoalBroadcastTick(this.internals());
  }

  private stopBroadcast(): void {
    if (this.broadcastInterval) {
      clearInterval(this.broadcastInterval);
      this.broadcastInterval = null;
    }
  }

  private broadcastState(activePhaseId?: string): void {
    broadcastGoalState(this.internals(), activePhaseId);
  }

  private buildState(activePhaseId?: string): Record<string, unknown> {
    return {
      ...buildGoalState(this.graph, activePhaseId, this.runStatus),
      ...(this.goalId ? { readOnly: this.readOnly } : {}),
    };
  }

  private sendState(client: WSClient): void {
    if (!this.graph) return;
    const state = this.buildState();
    this.send(client, { type: 'goal.state', payload: state });
  }

  private broadcast(msg: { type: string; payload: unknown }): void {
    broadcastGoalFrame(this.internals(), msg);
  }

  private send(client: WSClient, msg: { type: string; payload: unknown }): void {
    sendGoalFrame(this.goalId, client, msg);
  }

  private goalRunHost(): GoalRunHost {
    return buildGoalRunHost(this.internals());
  }

  private goalWorkerHost(): GoalWorkerHost {
    return buildGoalWorkerHost(this.internals());
  }

  private goalWsRunControlsHost(): GoalWsRunControlsHost {
    return this.internals();
  }

  /**
   * The live instance as the extracted helper modules see it. The `satisfies`
   * check keeps the complete helper contract compile-checked while
   * preserving the owner's identity and receivers. The check object is built
   * once per instance (on first use), not on every helper call.
   */
  private internals(): GoalWsHandlerInternals {
    if (this.internalsChecked) return this as unknown as GoalWsHandlerInternals;
    this.internalsChecked = true;
    void ({
      startInFlight: this.startInFlight,
      goalId: this.goalId,
      orchestrator: this.orchestrator,
      stopping: this.stopping,
      runPromise: this.runPromise,
      setupPromise: this.setupPromise,
      broadcast: this.broadcast,
      runStatus: this.runStatus,
      releaseRunLease: this.releaseRunLease,
      store: this.store,
      startRun: this.startRun,
      releaseActiveRunLease: this.releaseActiveRunLease,
      graph: this.graph,
      projectRoot: this.projectRoot,
      broadcastState: this.broadcastState,
      abort: this.abort,
      assessAbort: this.assessAbort,
      stopBroadcast: this.stopBroadcast,
      persistence: this.persistence,
      handleStop: this.handleStop,
      worktrees: this.worktrees,
      runBase: this.runBase,
      usedNicknames: this.usedNicknames,
      buildState: this.buildState,
      goals: this.goals as unknown as Map<string, GoalWsHandlerInternals>,
      selections: this.selections,
      clients: this.clients,
      catalogInFlight: this.catalogInFlight,
      catalogTimer: this.catalogTimer,
      disposed: this.disposed,
      sendState: this.sendState,
      broadcastInterval: this.broadcastInterval,
      lastGraphFingerprint: this.lastGraphFingerprint,
      lastProgressJson: this.lastProgressJson,
      readOnly: this.readOnly,
      stopGeneration: this.stopGeneration,
      assessSeq: this.assessSeq,
      agent: this.agent,
      context: this.context,
      logger: this.logger,
      events: this.events,
      taskAgentFactory: this.taskAgentFactory,
      onBoardState: this.onBoardState,
      addClient: this.addClient,
      dispose: this.dispose,
      handleMessage: this.handleMessage,
      handleAssess: this.handleAssess,
      handleStart: this.handleStart,
      handleResumeGraph: this.handleResumeGraph,
      handleClear: this.handleClear,
      handleRevert: this.handleRevert,
      planPhases: this.planPhases,
      executeTaskWithAgent: this.executeTaskWithAgent,
      runRepairPhase: this.runRepairPhase,
      runChimeraReview: this.runChimeraReview,
      persistDetached: this.persistDetached,
      afterBoardMutation: this.afterBoardMutation,
      startBroadcast: this.startBroadcast,
      broadcastCatalog: this.broadcastCatalog,
    } satisfies GoalWsHandlerInternals);
    return this as unknown as GoalWsHandlerInternals;
  }

  private async broadcastCatalog(): Promise<void> {
    return broadcastGoalCatalog(this.internals());
  }
}
