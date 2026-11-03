import { randomUUID } from 'node:crypto';
import { toErrorMessage } from '@wrongstack/core/utils';
import {
  claimBoardManagement,
  finalizeTaskCompletion,
  finishBoardManagement,
  getBoard,
  getKanbanQueueHealth,
  type KanbanBoard,
  type KanbanExecutionRouting,
  type KanbanQueueHealth,
  type KanbanSupervisorConfig,
  type KanbanSupervisorSnapshot,
  kanbanQueueAnomalyCount,
  listBoards,
  reconcileKanbanBoard,
  recoverStaleTaskAssignments,
  renewBoardManagement,
  resolveGateEnforcement,
} from '@wrongstack/kanban';
import { systemSessionId } from '@wrongstack/primitives';
import { publishKanbanBoard } from './kanban-broadcast.js';
import {
  buildManagementPrompt,
  hasManageableWork,
  managementFingerprint,
} from './kanban-management.js';
import { errMessage } from './ws-utils.js';

/**
 * The supervisor repairs boards on a timer, not on a tab's request, so its
 * events are attributed to the daemon rather than to whichever session
 * happens to be open.
 */
const SUPERVISOR_EVENT_CONTEXT = {
  sessionId: systemSessionId('kanban-supervisor'),
  actor: 'kanban-supervisor',
} as const;

export interface KanbanSupervisorDispatchOptions {
  role?: string | undefined;
  allowedCapabilities?: readonly string[] | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  /** Named cost level; resolved against `modelTiers` at dispatch time. */
  tier?: string | undefined;
  skills?: string[] | undefined;
  tools?: string[] | undefined;
  signal?: AbortSignal | undefined;
  name?: string | undefined;
  /**
   * Free-form task context propagated into the spawned `TaskSpec.context`.
   * The supervisor forwards kanban identity from the board/task snapshot so
   * the tool-runtime boundary gate can resolve the live policy.
   */
  context?:
    | {
        sessionId?: string;
        kanban?: {
          boardId?: string;
          taskId?: string;
          projectRoot?: string;
          managementToken?: string;
          leaseId?: string;
        };
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
  projectRoot: string | (() => string);
  broadcast: (message: { type: string; payload: unknown }) => void;
  dispatchTask?:
    | ((description: string, opts?: KanbanSupervisorDispatchOptions) => Promise<string>)
    | undefined;
  log?: ((message: string) => void) | undefined;
}

/**
 * Resolve the supervisor's project root on demand. Accepting a getter
 * (`() => string`) instead of a captured `string` keeps the supervisor tied
 * to the live workspace — without it, the snapshot field stays pinned to the
 * project that was active at construction, so a project swap leaves
 * previously audited boards in the wrong workspace until the process is
 * recreated.
 */
function resolveProjectRoot(deps: KanbanSupervisorDeps): string {
  const root = deps.projectRoot;
  return typeof root === 'function' ? root() : root;
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

/**
 * Every audit refreshes a board's snapshot, but an audit that found nothing new
 * is not news. Broadcasting each one sent every connected client a status per
 * board every ten seconds, and the desktop host journals every broadcast: on a
 * project with 164 boards they were 92% of a 371 MB journal. An unchanged
 * snapshot is re-sent at this pace so clients still see the supervisor alive;
 * a client asking for a board's status always gets the latest audit.
 */
const UNCHANGED_REBROADCAST_MS = 5 * 60_000;

/** A snapshot's content without the audit times every pass changes. */
function broadcastKey(snapshot: KanbanSupervisorSnapshot): string {
  const { lastAuditAt: _last, nextAuditAt: _next, ...content } = snapshot;
  return JSON.stringify(content);
}

const DEFAULT_CONFIG: KanbanSupervisorConfig = {
  enabled: true,
  mode: 'agentic',
  intervalMs: DEFAULT_INTERVAL_MS,
  recoveryMode: 'auto',
};

/**
 * Quiet, project-local board custodian. The frequent pass is deterministic and
 * free; a manager assesses new/changed work once. Explicit deterministic mode
 * disables LLM management. Unchanged successful reviews never poll the model.
 */
export function createKanbanSupervisor(deps: KanbanSupervisorDeps): KanbanSupervisor {
  const snapshots = new Map<string, KanbanSupervisorSnapshot>();
  /** What each board's last broadcast said (audit times aside) and when it went out. */
  const broadcasted = new Map<string, { key: string; at: number }>();
  const nextDue = new Map<string, number>();
  const agentLastRun = new Map<string, number>();
  const agentRunning = new Set<string>();
  const reviewed = new Map<string, string>();
  const watchdogs = new Map<string, ReturnType<typeof setTimeout>>();
  const controllers = new Map<string, AbortController>();
  let disposed = false;
  let activeProjectRoot = resolveProjectRoot(deps);
  let nextTimer: ReturnType<typeof setTimeout> | undefined;

  const forgetBoard = (boardId: string): void => {
    snapshots.delete(boardId);
    broadcasted.delete(boardId);
    nextDue.delete(boardId);
    agentLastRun.delete(boardId);
    agentRunning.delete(boardId);
    reviewed.delete(boardId);
    clearTimeout(watchdogs.get(boardId));
    watchdogs.delete(boardId);
    controllers.get(boardId)?.abort();
    controllers.delete(boardId);
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

  const currentProject = (): string => {
    const root = resolveProjectRoot(deps);
    if (root !== activeProjectRoot) {
      pruneAbsentBoards(new Set());
      activeProjectRoot = root;
    }
    return root;
  };

  const publish = (snapshot: KanbanSupervisorSnapshot) => {
    if (disposed) return;
    snapshots.set(snapshot.boardId, snapshot);
    const key = broadcastKey(snapshot);
    const last = broadcasted.get(snapshot.boardId);
    const now = Date.now();
    if (last?.key === key && now - last.at < UNCHANGED_REBROADCAST_MS) return;
    broadcasted.set(snapshot.boardId, { key, at: now });
    deps.broadcast({
      type: 'kanban.supervisor.status',
      payload: { success: true, data: snapshot },
    });
  };

  const auditBoard = async (board: KanbanBoard): Promise<KanbanSupervisorSnapshot> => {
    const projectRoot = resolveProjectRoot(deps);
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

    const reconciled = await reconcileKanbanBoard(projectRoot, board.id, SUPERVISOR_EVENT_CONTEXT);
    // Completion-gate sweep: catch tasks whose worker marked its assignment
    // completed through a path that never called finalizeTaskCompletion
    // (third-party board writers). They are parked in review by
    // updateTaskAssignment; run the gate so they reach a final state.
    const gateSwept = await sweepGateParkedTasks(
      { ...deps, projectRoot },
      reconciled?.board ?? board,
    );
    let health = await getKanbanQueueHealth(projectRoot, { boardId: board.id });
    const recovered = health.staleAssignments.count
      ? await recoverStaleTaskAssignments(
          projectRoot,
          board.id,
          {
            mode: config.recoveryMode ?? 'auto',
            reason: 'Kanban supervisor found an expired worker lease.',
          },
          SUPERVISOR_EVENT_CONTEXT,
        )
      : null;
    if (recovered) health = await getKanbanQueueHealth(projectRoot, { boardId: board.id });

    const anomalyCount = kanbanQueueAnomalyCount(health);
    const currentBoard = recovered?.board ?? gateSwept ?? reconciled?.board ?? board;
    const running =
      agentRunning.has(board.id) || (currentBoard.management?.lease?.expiresAt ?? 0) > Date.now();
    const pendingManagement =
      config.mode === 'agentic' &&
      hasManageableWork(currentBoard) &&
      (currentBoard.management?.reviewCoverageVersion !== 1 ||
        currentBoard.management.reviewedFingerprint !== managementFingerprint(currentBoard)) &&
      reviewed.get(board.id) !== managementFingerprint(currentBoard);
    const managementFailure = pendingManagement && currentBoard.management?.status === 'failed';
    const snapshot: KanbanSupervisorSnapshot = {
      boardId: board.id,
      status: running
        ? 'running'
        : managementFailure
          ? 'error'
          : anomalyCount > 0 || pendingManagement
            ? 'attention'
            : 'healthy',
      mode: config.mode,
      lastAuditAt: auditedAt,
      nextAuditAt,
      reconciledTaskIds: reconciled?.tasks.map((task) => task.id) ?? [],
      staleRecoveredTaskIds: recovered?.tasks.map((task) => task.id) ?? [],
      anomalyCount,
      error: managementFailure ? currentBoard.management?.error : undefined,
      summary: [
        `${healthSummary(health)}${
          pendingManagement
            ? deps.dispatchTask
              ? ' · task management pending'
              : ' · task management unavailable: host has no agent dispatcher'
            : ''
        }`,
        !running ? currentBoard.management?.summary : undefined,
      ]
        .filter(Boolean)
        .join('\n'),
    };
    if (disposed || projectRoot !== resolveProjectRoot(deps)) return snapshot;
    publish(snapshot);

    const changedBoard = recovered?.board ?? gateSwept ?? reconciled?.board;
    if (changedBoard) {
      // The sweep can retire a board, so the list is genuinely stale here.
      await publishKanbanBoard(deps.broadcast, changedBoard, () => listBoards(projectRoot));
    }

    if (config.mode === 'agentic' && (hasManageableWork(currentBoard) || anomalyCount > 0)) {
      await maybeRunAgent(currentBoard, config, health, snapshot);
    }
    return snapshots.get(board.id) ?? snapshot;
  };

  const maybeRunAgent = async (
    board: KanbanBoard,
    config: KanbanSupervisorConfig,
    health: KanbanQueueHealth,
    snapshot: KanbanSupervisorSnapshot,
  ): Promise<void> => {
    if (disposed || !deps.dispatchTask || agentRunning.has(board.id)) return;
    const fingerprint = managementFingerprint(board);
    if (reviewed.get(board.id) === fingerprint && snapshot.anomalyCount === 0) return;
    if (
      board.management?.reviewCoverageVersion === 1 &&
      board.management.reviewedFingerprint === fingerprint
    )
      return;
    if ((board.management?.lease?.expiresAt ?? 0) > Date.now()) return;
    const projectRoot = resolveProjectRoot(deps);
    const cooldownMs = Math.max(
      MIN_INTERVAL_MS,
      config.agentCooldownMs ?? DEFAULT_AGENT_COOLDOWN_MS,
    );
    if (Date.now() - (agentLastRun.get(board.id) ?? 0) < cooldownMs) return;
    agentRunning.add(board.id);
    const token = randomUUID();
    try {
      if (
        !(await claimBoardManagement(projectRoot, board.id, { token, fingerprint, cooldownMs }))
      ) {
        agentRunning.delete(board.id);
        return;
      }
    } catch (error) {
      agentRunning.delete(board.id);
      throw error;
    }
    if (disposed || resolveProjectRoot(deps) !== projectRoot) {
      agentRunning.delete(board.id);
      await finishBoardManagement(projectRoot, board.id, token, {
        status: 'failed',
        error: 'Host closed or switched project.',
      });
      return;
    }
    agentLastRun.set(board.id, Date.now());
    const controller = new AbortController();
    controllers.set(board.id, controller);
    const abandon = async (reason: string) => {
      if (controllers.get(board.id) === controller) {
        clearTimeout(watchdogs.get(board.id));
        watchdogs.delete(board.id);
        controllers.delete(board.id);
        agentRunning.delete(board.id);
        if (resolveProjectRoot(deps) === projectRoot)
          publish({ ...snapshot, status: 'error', error: reason });
      }
      controller.abort();
      try {
        await finishBoardManagement(projectRoot, board.id, token, {
          status: 'failed',
          error: reason,
        });
      } catch (error) {
        // A disconnected owner cannot acknowledge release. Its expiring
        // durable lease still fences a replacement, and local retry stays live.
        deps.log?.(`[KanbanSupervisor] release ${board.id}: ${toErrorMessage(error)}`);
      }
    };
    // Owner death stops renewal; another host can recover the expired lease.
    // On lease loss stop this worker before allowing any further edits.
    const renew = async () => {
      if (controller.signal.aborted) return;
      try {
        if (
          disposed ||
          resolveProjectRoot(deps) !== projectRoot ||
          !(await renewBoardManagement(projectRoot, board.id, token))
        ) {
          await abandon('Kanban management lease was lost or its host changed.');
          return;
        }
      } catch (error) {
        await abandon(`Kanban management lease renewal failed: ${toErrorMessage(error)}`);
        return;
      }
      if (controller.signal.aborted) return;
      const timer = setTimeout(() => void renew(), 30_000);
      timer.unref?.();
      watchdogs.set(board.id, timer);
    };
    const watchdog = setTimeout(() => void renew(), 30_000);
    watchdog.unref?.();
    watchdogs.set(board.id, watchdog);
    publish({
      ...snapshot,
      status: 'running',
      lastAgentRunAt: new Date().toISOString(),
      summary: `Task management review started. ${snapshot.summary ?? ''}`.trim(),
      error: undefined,
    });
    const routing = config.routing ?? { mode: 'session' as const };
    try {
      const spawnSummary = await deps.dispatchTask(
        buildManagementPrompt(board, healthSummary(health)),
        {
          ...dispatchRoute(routing),
          ...(config.skills?.length ? { skills: config.skills } : {}),
          name: `kanban-supervisor-${board.id.slice(0, 6)}`,
          tools: ['kanban', 'read', 'grep', 'glob', 'tree'],
          signal: controller.signal,
          // Carry the board identity into the spawned TaskSpec.context so the
          // tool-runtime boundary gate (`evaluateToolKanbanBoundary`) can resolve
          // the live board policy instead of failing open. Whole-board agentic
          // runs have no taskId, so only boardId is propagated.
          context: {
            ...(board.tags?.find((tag) => tag.startsWith('session:'))
              ? { sessionId: board.tags.find((tag) => tag.startsWith('session:'))!.slice(8) }
              : {}),
            kanban: { boardId: board.id, projectRoot, managementToken: token },
          },
          onDone: async (result) => {
            const cancelled = controller.signal.aborted;
            if (controllers.get(board.id) === controller) {
              clearTimeout(watchdogs.get(board.id));
              watchdogs.delete(board.id);
              agentRunning.delete(board.id);
              controllers.delete(board.id);
            }
            controller.abort(result.status === 'failed' ? result.error : undefined);
            const accepted = await finishBoardManagement(
              projectRoot,
              board.id,
              token,
              cancelled ? { status: 'failed', error: 'Management run cancelled.' } : result,
            );
            if (!accepted) return;
            if (disposed || resolveProjectRoot(deps) !== projectRoot) return;
            // A long-running supervisor agent can finish after its board was
            // deleted. Do not resurrect the removed board's snapshot entry.
            const persisted = await getBoard(projectRoot, board.id);
            if (persisted === null || disposed) return;
            // Remember the input, not an unreviewed post-run snapshot: concurrent
            // leader changes must receive their own pass.
            const completed = !cancelled && persisted.management?.status === 'completed';
            if (completed) reviewed.set(board.id, fingerprint);
            const current = snapshots.get(board.id) ?? snapshot;
            publish({
              ...current,
              status: !completed ? 'error' : current.anomalyCount ? 'attention' : 'healthy',
              lastAgentRunAt: new Date().toISOString(),
              summary: persisted.management?.summary ?? result.result ?? current.summary,
              error: persisted.management?.error ?? result.error,
            });
          },
        },
      );
      const current = snapshots.get(board.id) ?? snapshot;
      if (agentRunning.has(board.id))
        publish({ ...current, status: 'running', summary: spawnSummary });
    } catch (error) {
      clearTimeout(watchdogs.get(board.id));
      watchdogs.delete(board.id);
      controller.abort();
      controllers.delete(board.id);
      agentRunning.delete(board.id);
      const message = toErrorMessage(error);
      await finishBoardManagement(projectRoot, board.id, token, {
        status: 'failed',
        error: message,
      });
      deps.log?.(`[KanbanSupervisor] ${board.id}: ${message}`);
      publish({ ...snapshot, status: 'error', error: message });
    }
  };

  const auditNow = async (boardId?: string): Promise<KanbanSupervisorSnapshot[]> => {
    if (disposed) return [];
    const projectRoot = currentProject();
    let boards: KanbanBoard[];
    if (boardId) {
      const board = await getBoard(projectRoot, boardId);
      if (board === null) {
        forgetBoard(boardId);
        boards = [];
      } else {
        boards = [board];
      }
    } else {
      const summaries = await listBoards(projectRoot);
      pruneAbsentBoards(new Set(summaries.map((summary) => summary.id)));
      boards = (
        await Promise.all(summaries.map((summary) => getBoard(projectRoot, summary.id)))
      ).filter((board): board is KanbanBoard => Boolean(board));
    }
    const results: KanbanSupervisorSnapshot[] = [];
    for (const board of boards) {
      if (disposed || projectRoot !== resolveProjectRoot(deps)) break;
      results.push(await auditBoard(board));
    }
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
    const projectRoot = currentProject();
    try {
      const now = Date.now();
      const summaries = await listBoards(projectRoot);
      pruneAbsentBoards(new Set(summaries.map((summary) => summary.id)));
      for (const summary of summaries) {
        if (disposed || projectRoot !== resolveProjectRoot(deps)) break;
        if ((nextDue.get(summary.id) ?? 0) > now) continue;
        const board = await getBoard(projectRoot, summary.id);
        if (board && projectRoot === resolveProjectRoot(deps)) await auditBoard(board);
      }
    } catch (error) {
      deps.log?.(`[KanbanSupervisor] ${errMessage(error)}`);
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
      reviewed.clear();
      for (const timer of watchdogs.values()) clearTimeout(timer);
      watchdogs.clear();
      for (const controller of controllers.values()) controller.abort();
      controllers.clear();
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
      // `parked` comes from an earlier read; the card may have been reopened
      // for another worker since, so the gate re-checks it under the lock.
      const finalized = await finalizeTaskCompletion(resolveProjectRoot(deps), board.id, task.id, {
        eventContext: SUPERVISOR_EVENT_CONTEXT,
        requireCompletedAssignment: true,
      });
      if (finalized) lastBoard = finalized.board;
    } catch (error) {
      deps.log?.(
        `[KanbanSupervisor] completion gate sweep failed for ${task.id}: ${errMessage(error)}`,
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
    ...(routing.tier ? { tier: routing.tier } : {}),
  };
}

// `countAnomalies` used to live here with its own arithmetic, which disagreed
// with the route's and the WebUI health bar's. `kanbanQueueAnomalyCount` is the
// single definition — see its JSDoc in @wrongstack/kanban.

function healthSummary(health: KanbanQueueHealth): string {
  return [
    `${health.counts.running} running`,
    `${health.counts.startable} ready`,
    `${health.counts.review} review`,
    `${health.counts.blocked} blocked`,
    `${health.counts.failed} failed`,
    `${health.staleAssignments.count} stale`,
    `${health.dependencyBlocked.count} dependency-blocked`,
    `${health.parked?.count ?? 0} parked`,
  ].join(' · ');
}
