import {
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
} from '@wrongstack/kanban';

interface DispatchOptions {
  provider?: string | undefined;
  model?: string | undefined;
  fallbackProfile?: string | undefined;
  fallbackModels?: string[] | undefined;
  skills?: string[] | undefined;
  name?: string | undefined;
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
  dispatchTask?: ((description: string, opts?: DispatchOptions) => Promise<string>) | undefined;
  log?: ((message: string) => void) | undefined;
}

export interface KanbanSupervisor {
  getSnapshot(boardId: string): KanbanSupervisorSnapshot | undefined;
  auditNow(boardId?: string): Promise<KanbanSupervisorSnapshot[]>;
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
  let ticking = false;

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

    const changedBoard = recovered?.board ?? reconciled?.board;
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
        onDone: async (result) => {
          agentRunning.delete(board.id);
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
      agentRunning.delete(board.id);
      const message = error instanceof Error ? error.message : String(error);
      deps.log?.(`[KanbanSupervisor] ${board.id}: ${message}`);
      publish({ ...snapshot, status: 'error', error: message });
    }
  };

  const auditNow = async (boardId?: string): Promise<KanbanSupervisorSnapshot[]> => {
    const boards = boardId
      ? [await getBoard(deps.projectRoot, boardId)].filter((board): board is KanbanBoard =>
          Boolean(board),
        )
      : await Promise.all(
          (await listBoards(deps.projectRoot)).map((summary) =>
            getBoard(deps.projectRoot, summary.id),
          ),
        ).then((items) => items.filter((board): board is KanbanBoard => Boolean(board)));
    const results: KanbanSupervisorSnapshot[] = [];
    for (const board of boards) results.push(await auditBoard(board));
    return results;
  };

  const tick = async () => {
    if (disposed || ticking) return;
    ticking = true;
    try {
      const now = Date.now();
      const boards = await listBoards(deps.projectRoot);
      for (const summary of boards) {
        if ((nextDue.get(summary.id) ?? 0) > now) continue;
        const board = await getBoard(deps.projectRoot, summary.id);
        if (board) await auditBoard(board);
      }
    } catch (error) {
      deps.log?.(`[KanbanSupervisor] ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      ticking = false;
    }
  };

  const timer = setInterval(() => void tick(), MIN_INTERVAL_MS);
  timer.unref?.();
  void tick();

  return {
    getSnapshot: (boardId) => snapshots.get(boardId),
    auditNow,
    dispose() {
      disposed = true;
      clearInterval(timer);
    },
  };
}

function effectiveConfig(board: KanbanBoard): KanbanSupervisorConfig {
  return { ...DEFAULT_CONFIG, ...(board.supervisor ?? {}) };
}

function dispatchRoute(routing: KanbanExecutionRouting): DispatchOptions {
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
