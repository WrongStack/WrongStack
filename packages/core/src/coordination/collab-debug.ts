import type { CollabAgentTasksHost } from './collab-agent-tasks.js';
import {
  budgetForRole as budgetForRoleFromHost,
  buildBugHunterTask as buildBugHunterTaskFromHost,
  buildCriticTask as buildCriticTaskFromHost,
  buildRefactorPlannerTask as buildRefactorPlannerTaskFromHost,
  extractJsonObjects as extractJsonObjectsFromHost,
} from './collab-agent-tasks.js';
import {
  type CollabDebugReportHost,
  assembleReport as delegateAssembleReport,
  buildMarkdownSummary as delegateBuildMarkdownSummary,
  checkSnapshotFreshness as delegateCheckSnapshotFreshness,
} from './collab-debug-report.js';
/**
 * Collaborative Debugging Session — parallel multi-agent debugging on the same problem.
 *
 * Architecture:
 * - BugHunter, RefactorPlanner, and Critic run in parallel on shared file snapshots.
 * - Findings flow through the FleetBus via structured events: bug.found → refactor.plan → critic.evaluation.
 * - The Director acts as ResultRouter, collecting outputs and routing them to dependents.
 * - A shared scratchpad stores intermediate results so agents can read each other's
 *   conclusions without needing each other's full transcripts.
 *
 * Flow:
 *   1. Director.spawnCollab() creates a CollabSession with a SharedFileSnapshot.
 *   2. All three agents are spawned simultaneously and receive the same file snapshot.
 *   3. BugHunter emits bug.found events → Director routes to RefactorPlanner.
 *   4. RefactorPlanner subscribes to bug.found and emits refactor.plan events.
 *   5. Critic subscribes to both bug.found and refactor.plan and emits critic.evaluation.
 *   6. Director collects all results and produces a structured CollabDebugReport.
 *
 * Timeout and cancellation:
 *   - CollabSession agents report budget threshold events to the Director via fleet events.
 *   - The Director's collabAlert() handler receives warnings for timeout/iteration/tool_call
 *     thresholds and can decide to cancel the session or let it continue.
 *   - Director.cancelCollabSession() sends director.cancel_collab to all collab agents,
 *     causing them to finish early with a 'cancelled' status in the report.
 *   - The Director reads /btw notes via getLeaderBtwNotes() and can inject them into
 *     collab agents via task context before making cancellation decisions.
 */

import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import type { SubagentConfig, TaskResult } from '@wrongstack/contracts/types/multi-agent';
import type { CollabDirectorHost } from './collab-director-host.js';
import {
  collabOwnsSubagent,
  collabRoleFromSubagentId,
  emitCollabResultEvents,
  wireCollabFleetBus,
} from './collab-fleet-wiring.js';
import { effectiveCollabFileLimit, readCollabSnapshotFiles } from './collab-snapshot.js';

export { DEFAULT_MAX_TARGET_FILES, resolveCollabTargetInsideRoot } from './collab-snapshot.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type {
  BugFinding,
  CollabBudgetConfig,
  CollabBudgetOverrides,
  CollabBudgetWarningPayload,
  CollabDebugReport,
  CollabSessionOptions,
  CriticConcern,
  CriticEvaluation,
  DirectorAlert,
  DirectorCancelCollabPayload,
  RefactorPhase,
  RefactorPlan,
  SharedFileEntry,
  SharedFileSnapshot,
} from './collab-debug-types.js';
/**
 * Alert levels the Director can emit when a collab session needs attention.
 * These flow through the FleetBus so the host can display them in the UI.
 */
export { DirectorAlertLevel } from './collab-debug-types.js';

import type {
  BugFinding,
  CollabDebugReport,
  CollabSessionOptions,
  CriticEvaluation,
  DirectorAlert,
  DirectorCancelCollabPayload,
  RefactorPlan,
  SharedFileSnapshot,
} from './collab-debug-types.js';

export class CollabSession extends EventEmitter {
  readonly sessionId: string;
  readonly options: CollabSessionOptions;
  readonly snapshot: SharedFileSnapshot;

  private readonly director: CollabDirectorHost;
  private readonly fleetBus: import('./fleet-bus.js').FleetBus;
  private readonly subagentIds = new Map<string, string>(); // role → subagentId
  private readonly bugs = new Map<string, BugFinding>();
  private readonly plans = new Map<string, RefactorPlan>();
  private readonly evaluations = new Map<string, CriticEvaluation>();
  private readonly disposers = [] as (() => void)[];
  private settled = false;
  private readonly timeoutMs: number;
  private cancelled = false;
  private _raceResolved = false;
  private readonly alerts: DirectorAlert[] = [];
  private snapshotWarnings: string[] = [];

  /** Tracks tool call counts per subagent for progress-based timeout decisions. */
  private readonly progressBySubagent = new Map<string, number>();
  /** Last tool call count when a timeout warning was handled. */
  private readonly lastTimeoutProgress = new Map<string, number>();
  /** Session-level timeout timer handle (cleared on cancel or natural completion). */
  private _timeoutTimer?: NodeJS.Timeout | undefined;

  constructor(
    director: CollabDirectorHost,
    fleetBus: import('./fleet-bus.js').FleetBus,
    options: CollabSessionOptions,
  ) {
    super();
    this.sessionId = randomUUID();
    this.options = options;
    this.director = director;
    this.fleetBus = fleetBus;
    this.timeoutMs = options.timeoutMs ?? 10 * 60 * 1000;

    if (options.prebuiltSnapshot) {
      this.snapshot = options.prebuiltSnapshot;
    } else {
      this.snapshot = {
        id: this.sessionId,
        createdAt: new Date().toISOString(),
        files: [],
      };
    }
  }

  get id(): string {
    return this.sessionId;
  }

  getSessionAlerts(): DirectorAlert[] {
    return [...this.alerts];
  }

  isCancelled(): boolean {
    return this.cancelled;
  }

  /**
   * Snapshot of role → subagentId map. The Director calls coordinator.stop()
   * for each agent when cancelling the session, using this map to enumerate
   * all three collab agents.
   */
  getSubagentIds(): ReadonlyMap<string, string> {
    return new Map(this.subagentIds);
  }

  /**
   * Returns the effective file limit for this session.
   * Priority: explicit `maxTargetFiles` > dynamic from `contextWindow` > `DEFAULT_MAX_TARGET_FILES`.
   */
  effectiveFileLimit(): number {
    return effectiveCollabFileLimit(this.options);
  }

  async buildSnapshot(): Promise<SharedFileSnapshot> {
    if (this.snapshot.files.length > 0) return this.snapshot;
    await readCollabSnapshotFiles(this.snapshot, this.options, this.effectiveFileLimit());
    return this.snapshot;
  }

  /**
   * Cancel the session. Emits director.cancel_collab on the FleetBus so all
   * collab agents finish early. The session-level timeout timer is also cleared.
   * Safe to call multiple times (idempotent after first call).
   */
  cancel(reason = 'Director cancelled collab session'): void {
    if (this.cancelled) return;
    this.cancelled = true;
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = undefined;
    }
    this.fleetBus.emit({
      subagentId: this.director.id,
      ts: Date.now(),
      type: 'director.cancel_collab',
      payload: {
        sessionId: this.sessionId,
        reason,
        cancelledAt: new Date().toISOString(),
      } as DirectorCancelCollabPayload,
    });
    this.fleetBus.emit({
      subagentId: this.director.id,
      ts: Date.now(),
      type: 'collab.cancelled',
      payload: { sessionId: this.sessionId, reason },
    });
  }

  async start(): Promise<CollabDebugReport> {
    if (this.settled) throw new Error('session already settled');
    this.settled = true;

    await this.buildSnapshot();
    this.wireFleetBus();

    // spawnAgent can fail (spawn cap, context overflow, assign rejection).
    // wireFleetBus() already registered 6 FleetBus subscriptions into
    // this.disposers — a throw here would bypass both cleanup() call sites
    // below and leak those listeners onto the shared FleetBus for the
    // Director's lifetime. Catch, clean up, emit session.error so the
    // controller can stop any already-spawned agents, and rethrow.
    //
    // spawnAgent records each successfully-spawned agent into subagentIds
    // immediately after spawn returns, before assign. Wait for every parallel
    // startup to settle before emitting session.error: Promise.all would reject
    // early, allowing a slower sibling to spawn after the controller had already
    // inspected getSubagentIds(), leaving that late success orphaned.
    let bugHunter: { subagentId: string; taskId: string };
    let refactorPlanner: { subagentId: string; taskId: string };
    let critic: { subagentId: string; taskId: string };
    try {
      const [bugHunterResult, refactorPlannerResult, criticResult] = await Promise.allSettled([
        this.spawnAgent('bug-hunter', this.buildBugHunterTask()),
        this.spawnAgent('refactor-planner', this.buildRefactorPlannerTask()),
        this.spawnAgent('critic', this.buildCriticTask()),
      ]);
      if (bugHunterResult.status === 'rejected') throw bugHunterResult.reason;
      if (refactorPlannerResult.status === 'rejected') throw refactorPlannerResult.reason;
      if (criticResult.status === 'rejected') throw criticResult.reason;
      bugHunter = bugHunterResult.value;
      refactorPlanner = refactorPlannerResult.value;
      critic = criticResult.value;
    } catch (err) {
      this.cleanup();
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('session.error', error);
      throw error;
    }

    this.subagentIds.set('bug-hunter', bugHunter.subagentId);
    this.subagentIds.set('refactor-planner', refactorPlanner.subagentId);
    this.subagentIds.set('critic', critic.subagentId);

    const timeout = new Promise<never>((_, reject) => {
      this._timeoutTimer = setTimeout(() => {
        if (this._raceResolved) return;
        this.cancel('Session-level timeout reached');
        reject(new Error(`CollabSession timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
    });

    let results: TaskResult[][] | null = null;
    try {
      results = await Promise.race([
        Promise.all([
          this.director.awaitTasks([bugHunter.taskId]),
          this.director.awaitTasks([refactorPlanner.taskId]),
          this.director.awaitTasks([critic.taskId]),
        ]),
        timeout,
      ]);
    } catch (err) {
      // Promise.race rejected — either the timeout fired or one of the
      // awaitTasks failed. In both cases `results` is unassigned. Clear the
      // timer if the timeout won the race, always clean up, then re-throw.
      // NOTE: we cannot distinguish timeout from awaitTasks failure here
      // without additional state. Both are treated as session failure.
      this._raceResolved = true;
      if (this._timeoutTimer) {
        clearTimeout(this._timeoutTimer);
        this._timeoutTimer = undefined;
      }
      this.cleanup();
      const error = err instanceof Error ? err : new Error(String(err));
      this.emit('session.error', error);
      throw error;
    }

    // If we are here, Promise.race resolved (not rejected) — results were assigned.
    // Guard with non-null assertion since TypeScript doesn't know the try/catch
    // guarantees this when we reach this line.
    for (const result of results?.flat() ?? []) {
      await this.parseAndEmit(result);
    }

    this.snapshotWarnings = await this.checkSnapshotFreshness();
    const report = this.assembleReport();
    this._raceResolved = true;
    this.cleanup();
    this.emit('session.done', report);
    return report;
  }
  private async parseAndEmit(result: TaskResult): Promise<void> {
    emitCollabResultEvents(
      this.fleetBus,
      result,
      (text) => this.extractJsonObjects(text),
      (id) => this.roleFromSubagentId(id),
    );
  }

  private extractJsonObjects(text: string): Array<Record<string, unknown>> {
    return extractJsonObjectsFromHost.call(this.collabAgentTasksHost(), text);
  }

  private budgetForRole(role: string): {
    maxIterations: number;
    maxToolCalls: number;
    timeoutMs: number;
  } {
    return budgetForRoleFromHost.call(this.collabAgentTasksHost(), role);
  }

  private async spawnAgent(
    role: string,
    taskBrief: string,
  ): Promise<{ subagentId: string; taskId: string }> {
    const budget = this.budgetForRole(role);
    const cfg: SubagentConfig = {
      id: `${role}-${this.sessionId}`,
      name: role,
      role,
      tools: ['fleet_emit', 'fleet', 'read', 'grep', 'glob', 'bash', 'write'],
      maxIterations: budget.maxIterations,
      maxToolCalls: budget.maxToolCalls,
      timeoutMs: budget.timeoutMs,
    };
    const subagentId = await this.director.spawn(cfg);
    // Record immediately so a partial-spawn failure (a sibling throw,
    // an assign rejection, a spawn cap) makes this agent visible to
    // getSubagentIds() — the controller uses it to stop orphans.
    this.subagentIds.set(role, subagentId);
    const taskId = await this.director.assign({
      id: randomUUID(),
      subagentId,
      description: taskBrief,
    });
    return { subagentId, taskId };
  }

  private buildBugHunterTask(): string {
    return buildBugHunterTaskFromHost.call(this.collabAgentTasksHost());
  }

  private buildRefactorPlannerTask(): string {
    return buildRefactorPlannerTaskFromHost.call(this.collabAgentTasksHost());
  }

  private buildCriticTask(): string {
    return buildCriticTaskFromHost.call(this.collabAgentTasksHost());
  }
  private wireFleetBus(): void {
    const self = this;
    wireCollabFleetBus({
      sessionId: this.sessionId,
      director: this.director,
      fleetBus: this.fleetBus,
      options: this.options,
      alerts: this.alerts,
      disposers: this.disposers,
      progressBySubagent: this.progressBySubagent,
      lastTimeoutProgress: this.lastTimeoutProgress,
      bugs: this.bugs,
      plans: this.plans,
      evaluations: this.evaluations,
      ownsSubagent: (id) => this.ownsSubagent(id),
      roleFromSubagentId: (id) => this.roleFromSubagentId(id),
      cancel: (reason) => this.cancel(reason),
      markCancelledByDirector() {
        self.cancelled = true;
        if (self._timeoutTimer) {
          clearTimeout(self._timeoutTimer);
          self._timeoutTimer = undefined;
        }
      },
      emit: (event, payload) => this.emit(event, payload),
    });
  }

  private roleFromSubagentId(subagentId: string): string | null {
    return collabRoleFromSubagentId(this.subagentIds, subagentId);
  }

  /**
   * True when `subagentId` belongs to THIS session. All wireFleetBus filters
   * MUST check this before processing an event — the FleetBus is shared across
   * the whole Director fleet, so a concurrent collab session's bug-hunter,
   * refactor-planner, and critic agents emit the same event types. Without
   * this guard, one session's findings cross-pollinate into another session's
   * report, and budget negotiations race when both sessions try to
   * extend/deny the same threshold event.
   *
   * Resolution: check the tracked `subagentIds` map (strict — distinguishes
   * `bug-hunter-<sessionA>` from `bug-hunter-<sessionB>`). Before the first
   * spawn resolves, only accept the deterministic ids configured by
   * `spawnAgent` (`${role}-${sessionId}`); a broad role-prefix fallback would
   * admit events from an already-running collab or ordinary delegate.
   */ private ownsSubagent(subagentId: string): boolean {
    return collabOwnsSubagent(this.subagentIds, this.sessionId, subagentId);
  }

  private assembleReport(): CollabDebugReport {
    return delegateAssembleReport(this.collabDebugReportHost());
  }

  private async checkSnapshotFreshness(): Promise<string[]> {
    return delegateCheckSnapshotFreshness(this.collabDebugReportHost());
  }

  private buildMarkdownSummary(
    bugs: BugFinding[],
    plans: RefactorPlan[],
    evals: CriticEvaluation[],
    overallVerdict: CollabDebugReport['overallVerdict'],
    disposition: CollabDebugReport['disposition'],
  ): string {
    return delegateBuildMarkdownSummary(
      this.collabDebugReportHost(),
      bugs,
      plans,
      evals,
      overallVerdict,
      disposition,
    );
  }

  private cleanup(): void {
    // Clear the session-level timeout timer. Without this, the SUCCESS path
    // (Promise.race resolved via awaitTasks) leaves the setTimeout armed: it
    // keeps the event loop alive for up to timeoutMs, then fires a spurious
    // cancel() and rejects the now-orphaned `timeout` promise — an unhandled
    // rejection after every completed session. cleanup() runs on both the
    // success and error paths, so it's the right single owner of the timer.
    if (this._timeoutTimer) {
      clearTimeout(this._timeoutTimer);
      this._timeoutTimer = undefined;
    }
    for (const dispose of this.disposers) dispose();
    this.disposers.length = 0;
    // Release snapshot file contents to free memory; keep the snapshot object
    // itself so the report (already assembled) remains valid.
    this.snapshot.files.length = 0;
  }

  private collabDebugReportHost(): CollabDebugReportHost {
    const self = this;
    return {
      bugs: this.bugs,
      plans: this.plans,
      evaluations: this.evaluations,
      get cancelled() {
        return self.cancelled;
      },
      buildMarkdownSummary: (...args) => this.buildMarkdownSummary(...args),
      sessionId: this.sessionId,
      snapshot: this.snapshot,
      options: this.options,
      alerts: this.alerts,
      get snapshotWarnings() {
        return self.snapshotWarnings;
      },
    };
  }

  private collabAgentTasksHost(): CollabAgentTasksHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.options satisfies CollabAgentTasksHost['options']);
    void (this.director satisfies CollabAgentTasksHost['director']);
    void (this.snapshot satisfies CollabAgentTasksHost['snapshot']);
    void (this.sessionId satisfies CollabAgentTasksHost['sessionId']);
    return this as unknown as CollabAgentTasksHost;
  }
}
