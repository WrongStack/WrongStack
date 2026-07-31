import {
  finalizeTaskCompletion,
  getBoard,
  getKanbanQueueHealth,
  type KanbanBoard,
  type KanbanExecutionRouting,
  type KanbanQueueHealth,
  type KanbanSupervisorConfig,
  type KanbanSupervisorSnapshot,
  listBoards,
  reconcileKanbanBoard,
  recoverStaleTaskAssignments,
  resolveGateEnforcement,
} from '@wrongstack/kanban';

export interface KanbanSupervisorDispatchOptions {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  skills?: string[] | undefined;
  name?: string | undefined;
  /**
   * Free-form task context propagated into the spawned `TaskSpec.context`.
   * The supervisor forwards kanban identity from the board/task snapshot so
   * the tool-runtime boundary gate can resolve the live policy.
   */
  context?:
    | {
        kanban?: { boardId?: string; taskId?: string; projectRoot?: string };
      }
    | undefined;
  onDone?:
    | ((result: {
        status: 'completed' | 'failed';
        result?: string | undefined;
        error?: string | undefined;
      }) => void | Promise<void>)
    | undefined;
}

export interface KanbanSupervisorDeps {
  projectRoot: string;
  broadcast: (message: { type: string; payload: unknown }) => void;
  dispatchTask?:
    | ((description: string, opts?: KanbanSupervisorDispatchOptions) => Promise<string>)
    | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface KanbanSupervisor {
  getSnapshot(boardId: string): KanbanSupervisorSnapshot | undefined;
  auditNow(boardId?: string): Promise<KanbanSupervisorSnapshot[]>;
  getStats(): {
    snapshots: number;
    scheduledBoards: number;
    agentCooldowns: number;
    runningAgents: number;
  };
  dispose(): void;
}

const DEFAULT_INTERVAL_MS = 10_000;
const MIN_INTERVAL_MS = 2_000;
const DEFAULT_AGENT_COOLDOWN_MS = 5 * 60_000;

const DEFAULT_CONFIG: KanbanSupervisorConfig = {
  enabled: true,
  mode: 'deterministic',
  intervalMs: DEFAULT_INTERVAL_MS,
  recoveryMode: 'auto',
};

/**
 * Quiet, project-local board custodian. The frequent pass is deterministic and
 * free; an LLM is spawned only when the board explicitly opts into agentic mode
 * and the health snapshot contains an anomaly.
 */
export function createKanbanSupervisor(deps: KanbanSupervisorDeps): KanbanSupervisor {
  const snapshots = new Map<string, KanbanSupervisorSnapshot>();
  const nextDue = new Map<string, number>();
  const agentLastRun = new Map<string, number>();
  const agentRunning = new Set<string>();
  let disposed = false;
  let nextTimer: ReturnType<typeof setTimeout> | undefined;

  const forgetBoard = (boardId: string): void => {
    snapshots.delete(boardId);
    nextDue.delete(boardId);
    agentLastRun.delete(boardId);
    agentRunning.delete(boardId);
  };

  const pruneAbsentBoards = (presentBoardIds: ReadonlySet<string>): void => {
    for (const boardId of snapshots.keys()) {
      if (!presentBoardIds.has(boardId)) forgetBoard(boardId);
    }
    for (const boardId of nextDue.keys()) {
      if (!presentBoardIds.has(boardId)) forgetBoard(boardId);
    }
    for (const boardId of agentLastRun.keys()) {
      if (!presentBoardIds.has(boardId)) forgetBoard(boardId);
    }
    for (const boardId of agentRunning) {
      if (!presentBoardIds.has(boardId)) forgetBoard(boardId);
    }
  };

  const publish = (snapshot: KanbanSupervisorSnapshot) => {
    snapshots.set(snapshot.boardId, snapshot);
    deps.broadcast({
      type: 'kanban.supervisor.status',
      payload: { success: true, data: snapshot },
    });
  };

  const auditBoard = async (board: KanbanBoard): Promise<KanbanSupervisorSnapshot> => {
    const config = effectiveConfig(board);
    const auditedAt = new Date().toISOString();
    const intervalMs = Math.max(MIN_INTERVAL_MS, config.intervalMs ?? DEFAULT_INTERVAL_MS);
    const nextAuditAt = new Date(Date.now() + intervalMs).toISOString();
    nextDue.set(board.id, Date.now() + intervalMs);

    if (!config.enabled) {
      const snapshot: KanbanSupervisorSnapshot = {
        boardId: board.id,
        status: 'disabled',
        mode: config.mode,
        lastAuditAt: auditedAt,
        nextAuditAt,
        reconciledTaskIds: [],
        staleRecoveredTaskIds: [],
        anomalyCount: 0,
        summary: 'Supervision is disabled for this board.',
      };
      publish(snapshot);
      return snapshot;
    }

    const reconciled = await reconcileKanbanBoard(deps.projectRoot, board.id);
    // Completion-gate sweep: catch tasks whose worker marked its assignment
    // completed through a path that never called finalizeTaskCompletion
    // (third-party board writers). They are parked in review by
    // updateTaskAssignment; run the gate so they reach a final state.
    const gateSwept = await sweepGateParkedTasks(deps, reconciled?.board ?? board);
    let health = await getKanbanQueueHealth(deps.projectRoot, { boardId: board.id });
    const recovered = health.staleAssignments.count
      ? await recoverStaleTaskAssignments(deps.projectRoot, board.id, {
          mode: config.recoveryMode ?? 'auto',
          reason: 'Kanban supervisor found an expired worker lease.',
        })
      : null;
    if (recovered) health = await getKanbanQueueHealth(deps.projectRoot, { boardId: board.id });

    const anomalyCount = countAnomalies(health);
    const snapshot: KanbanSupervisorSnapshot = {
      boardId: board.id,
      status: anomalyCount > 0 ? 'attention' : 'healthy',
      mode: config.mode,
      lastAuditAt: auditedAt,
      nextAuditAt,
      reconciledTaskIds: reconciled?.tasks.map((task) => task.id) ?? [],
      staleRecoveredTaskIds: recovered?.tasks.map((task) => task.id) ?? [],
      anomalyCount,
      summary: healthSummary(health),
    };
    publish(snapshot);

    const changedBoard = recovered?.board ?? gateSwept ?? reconciled?.board;
    if (changedBoard) {
      deps.broadcast({
        type: 'kanban.get',
        payload: { success: true, data: { board: changedBoard } },
      });
      deps.broadcast({
        type: 'kanban.list',
        payload: { success: true, data: await listBoards(deps.projectRoot) },
      });
    }

    if (config.mode === 'agentic' && anomalyCount > 0) {
      await maybeRunAgent(board, config, health, snapshot);
    }
    return snapshots.get(board.id) ?? snapshot;
  };

  const maybeRunAgent = async (
    board: KanbanBoard,
    config: KanbanSupervisorConfig,
    health: KanbanQueueHealth,
    snapshot: KanbanSupervisorSnapshot,
  ): Promise<void> => {
    if (!deps.dispatchTask || agentRunning.has(board.id)) return;
    const cooldownMs = Math.max(
      MIN_INTERVAL_MS,
      config.agentCooldownMs ?? DEFAULT_AGENT_COOLDOWN_MS,
    );
    if (Date.now() - (agentLastRun.get(board.id) ?? 0) < cooldownMs) return;
    agentRunning.add(board.id);
    agentLastRun.set(board.id, Date.now());
    // Watchdog: if the spawned task crashes or is killed without invoking
    // onDone, clear the lock after a bounded duration so the board isn't
    // permanently blocked from future agentic runs.
    const watchdog = setTimeout(
      () => agentRunning.delete(board.id),
      Math.max(cooldownMs * 2, DEFAULT_AGENT_COOLDOWN_MS * 2),
    );
    watchdog.unref?.();
    publish({
      ...snapshot,
      status: 'running',
      lastAgentRunAt: new Date().toISOString(),
      summary: `Agentic anomaly review started. ${snapshot.summary ?? ''}`.trim(),
    });
    const routing = config.routing ?? { mode: 'session' as const };
    try {
      const spawnSummary = await deps.dispatchTask(buildAuditPrompt(board, health), {
        ...dispatchRoute(routing),
        ...(config.skills?.length ? { skills: config.skills } : {}),
        name: `kanban-supervisor-${board.id.slice(0, 6)}`,
        // Carry the board identity into the spawned TaskSpec.context so the
        // tool-runtime boundary gate (`evaluateToolKanbanBoundary`) can resolve
        // the live board policy instead of failing open. Whole-board agentic
        // runs have no taskId, so only boardId is propagated.
        context: { kanban: { boardId: board.id, projectRoot: deps.projectRoot } },
        onDone: async (result) => {
          clearTimeout(watchdog);
          agentRunning.delete(board.id);
          // A long-running supervisor agent can finish after its board was
          // deleted. Do not resurrect the removed board's snapshot entry.
          if ((await getBoard(deps.projectRoot, board.id)) === null) return;
          const current = snapshots.get(board.id) ?? snapshot;
          publish({
            ...current,
            status:
              result.status === 'failed' ? 'error' : current.anomalyCount ? 'attention' : 'healthy',
            lastAgentRunAt: new Date().toISOString(),
            summary: result.result ?? current.summary,
            ...(result.error ? { error: result.error } : {}),
          });
        },
      });
      const current = snapshots.get(board.id) ?? snapshot;
      publish({ ...current, status: 'running', summary: spawnSummary });
    } catch (error) {
      clearTimeout(watchdog);
      agentRunning.delete(board.id);
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`[KanbanSupervisor] ${board.id}: ${message}`);
      publish({ ...snapshot, status: 'error', error: message });
    }
  };

  const auditNow = async (boardId?: string): Promise<KanbanSupervisorSnapshot[]> => {
    let boards: KanbanBoard[];
    if (boardId) {
      const board = await getBoard(deps.projectRoot, boardId);
      if (board === null) {
        forgetBoard(boardId);
        boards = [];
      } else {
        boards = [board];
      }
    } else {
      const summaries = await listBoards(deps.projectRoot);
      pruneAbsentBoards(new Set(summaries.map((summary) => summary.id)));
      boards = (
        await Promise.all(summaries.map((summary) => getBoard(deps.projectRoot, summary.id)))
      ).filter((board): board is KanbanBoard => Boolean(board));
    }
    const results: KanbanSupervisorSnapshot[] = [];
    for (const board of boards) results.push(await auditBoard(board));
    scheduleNext();
    return results;
  };

  /** Compute the soonest `nextDue` across all boards and schedule the next tick. */
  const scheduleNext = () => {
    if (disposed) return;
    // Clear any timer already armed before overwriting `nextTimer`. Without
    // this, an `auditNow()` call (or a status request that reschedules) that
    // races the background tick chain would orphan the previously-armed timer,
    // which keeps firing as an independent, self-perpetuating chain that
    // `dispose` can no longer see — one duplicate chain per such call.
    if (nextTimer !== undefined) {
      clearTimeout(nextTimer);
      nextTimer = undefined;
    }
    const now = Date.now();
    let minDue = Infinity;
    for (const due of nextDue.values()) {
      if (due < minDue) minDue = due;
    }
    if (!Number.isFinite(minDue) || minDue <= now) {
      // Either no boards have been seen yet, or a board is already due.
      // Fall back to MIN_INTERVAL_MS to avoid busy-waiting.
      nextTimer = setTimeout(() => void tick(), MIN_INTERVAL_MS);
      nextTimer.unref?.();
      return;
    }
    const delay = Math.min(minDue - now, DEFAULT_INTERVAL_MS);
    if (delay <= 0) {
      nextTimer = setTimeout(() => void tick(), MIN_INTERVAL_MS);
    } else {
      nextTimer = setTimeout(() => void tick(), delay);
    }
    nextTimer.unref?.();
  };

  const tick = async () => {
    if (disposed) return;
    try {
      const now = Date.now();
      const summaries = await listBoards(deps.projectRoot);
      pruneAbsentBoards(new Set(summaries.map((summary) => summary.id)));
      for (const summary of summaries) {
        if ((nextDue.get(summary.id) ?? 0) > now) continue;
        const board = await getBoard(deps.projectRoot, summary.id);
        if (board) await auditBoard(board);
      }
    } catch (error) {
      deps.log?.(`[KanbanSupervisor] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      scheduleNext();
    }
  };

  // Initial run — kick off the first audit cycle.
  void scheduleNext();

  return {
    getSnapshot: (boardId) => snapshots.get(boardId),
    auditNow,
    getStats: () => ({
      snapshots: snapshots.size,
      scheduledBoards: nextDue.size,
      agentCooldowns: agentLastRun.size,
      runningAgents: agentRunning.size,
    }),
    dispose() {
      disposed = true;
      if (nextTimer !== undefined) {
        clearTimeout(nextTimer);
        nextTimer = undefined;
      }
      snapshots.clear();
      nextDue.clear();
      agentLastRun.clear();
      agentRunning.clear();
    },
  };
}

function effectiveConfig(board: KanbanBoard): KanbanSupervisorConfig {
  return { ...DEFAULT_CONFIG, ...(board.supervisor ?? {}) };
}

/**
 * Finalize tasks that a third-party writer completed without calling the gate:
 * assignment says completed, the card is parked in review, and no verification
 * report has been produced yet. Returns the last mutated board, or undefined.
 */
async function sweepGateParkedTasks(
  deps: KanbanSupervisorDeps,
  board: KanbanBoard,
): Promise<KanbanBoard | undefined> {
  if (resolveGateEnforcement(board) === 'off') return undefined;
  const parked = board.tasks.filter(
    (task) =>
      task.status === 'review' &&
      task.assignment?.status === 'completed' &&
      !task.verificationReport,
  );
  let lastBoard: KanbanBoard | undefined;
  for (const task of parked) {
    try {
      const finalized = await finalizeTaskCompletion(deps.projectRoot, board.id, task.id, {
        eventContext: { actor: 'kanban-supervisor' },
      });
      if (finalized) lastBoard = finalized.board;
    } catch (error) {
      deps.log?.(
        `[KanbanSupervisor] completion gate sweep failed for ${task.id}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return lastBoard;
}

function dispatchRoute(routing: KanbanExecutionRouting): KanbanSupervisorDispatchOptions {
  if (routing.mode === 'session') return {};
  return {
    ...(routing.provider ? { provider: routing.provider } : {}),
    ...(routing.model ? { model: routing.model } : {}),
    ...(routing.fallbackProfile ? { fallbackProfile: routing.fallbackProfile } : {}),
    ...(routing.fallbackModels?.length ? { fallbackModels: routing.fallbackModels } : {}),
  };
}

function countAnomalies(health: KanbanQueueHealth): number {
  return (
    health.staleAssignments.count +
    health.heartbeatDue.count +
    health.counts.failed +
    health.counts.blocked
  );
}

function healthSummary(health: KanbanQueueHealth): string {
  return [
    `${health.counts.running} running`,
    `${health.counts.ready} ready`,
    `${health.counts.review} review`,
    `${health.counts.blocked} blocked`,
    `${health.counts.failed} failed`,
    `${health.staleAssignments.count} stale`,
    `${health.dependencyBlocked.count} dependency-blocked`,
  ].join(' · ');
}

function buildAuditPrompt(board: KanbanBoard, health: KanbanQueueHealth): string {
  const taskLines = board.tasks.map(
    (task) =>
      `- ${task.id}: ${task.title} [task=${task.status}; assignment=${task.assignment?.status ?? 'none'}; column=${task.columnId}]`,
  );
  return [
    'You are the explicitly configured WrongStack Kanban supervisor.',
    'Audit only this board. Do not implement product tasks.',
    `Board: ${board.title} (${board.id})`,
    `Health: ${healthSummary(health)}`,
    '',
    'Tasks:',
    ...taskLines,
    '',
    'Use the kanban tool for corrections. Preserve manual blockers and dependencies.',
    'Fix only demonstrable status/assignment/column drift, then report every action and remaining anomaly.',
  ].join('\n');
}
