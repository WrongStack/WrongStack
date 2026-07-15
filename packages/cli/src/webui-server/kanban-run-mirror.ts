/**
 * KanbanRunMirror — projects live AutoPhase / SDD runs into `@wrongstack/kanban`
 * boards so the kanban view becomes the unified LIVE surface for both engines.
 *
 * It is fed two ways (both in the CLI-hosted webui-server process, the only
 * place with the shared EventBus + both live handlers):
 *   - SDD: subscribe to `sdd.board.snapshot` on the shared bus.
 *   - AutoPhase: a callback tap on `AutoPhaseWebSocketHandler` (that orchestrator
 *     does NOT emit PhaseEventMap on the bus), delivering its `buildState()`.
 *
 * Each run maps to ONE kanban board. Linkage lives in board TAGS (not
 * generatedBy, which `syncBoardFromTaskGraph` overwrites):
 *   ['sdd', 'run:<runId>', 'graph:<graphId>']  or  ['autophase', 'graph:<graphId>']
 *
 * Reconcile per tick is a two-pass, both idempotent:
 *   1. `syncBoardFromTaskGraph` — structure + status→column + deps + origin-keyed
 *      create/update/archive.
 *   2. targeted, diff-guarded `updateTaskAssignment` overlay for the LIVE subset
 *      only (running/completed/failed/cancelled/assigned tasks) so the inspector's
 *      AgentRunPanel lights up with the real worker + model — without fabricating
 *      phantom assignments or a per-tick event storm.
 */

import type { EventBus } from '@wrongstack/core';
import {
  deserializeTaskGraph,
  type SerializedTaskGraph,
  type TaskEdge,
  type TaskNode,
} from '@wrongstack/core';
import {
  createBoard,
  getBoard,
  type KanbanAgentRunStatus,
  type KanbanBoard,
  type KanbanTask,
  listBoards,
  syncBoardFromTaskGraph,
  updateTaskAssignment,
} from '@wrongstack/kanban';
import type { SddBoardSnapshot, SddBoardTask } from '@wrongstack/sdd';

type Engine = 'sdd' | 'autophase';

interface WSServerMessage {
  type: string;
  payload: unknown;
}

export interface KanbanRunMirrorDeps {
  projectRoot: string;
  events?: EventBus | undefined;
  broadcast: (msg: WSServerMessage) => void;
  log?: ((msg: string) => void) | undefined;
}

/** Loose shape of the AutoPhase `buildState()` projection we consume. */
interface AutophaseState {
  title?: string;
  goal?: string;
  phases?: Array<{
    id: string;
    name?: string;
    tasks?: Array<{
      id: string;
      title: string;
      description?: string;
      status: TaskNode['status'];
      priority: TaskNode['priority'];
      type: TaskNode['type'];
      assignee?: string;
      startedAt?: number;
      completedAt?: number;
    }>;
  }>;
}

export interface KanbanRunMirror {
  /** AutoPhase tap — the handler's `onBoardState(graphId, state)` callback. */
  onAutophaseState(graphId: string, state: Record<string, unknown>): void;
  /** Bind a runId to a specific board (used by launch-from-board, phase 4). */
  bind(engine: Engine, key: string, boardId: string): void;
  /**
   * One-shot: the NEXT AutoPhase run whose graphId we haven't seen binds to this
   * board instead of creating a new one. Used by launch-from-board — the graphId
   * is only known after the async build, so we can't `bind()` up front.
   */
  bindAutophaseNext(boardId: string): void;
  dispose(): void;
}

const DEBOUNCE_MS = 300;

export function createKanbanRunMirror(deps: KanbanRunMirrorDeps): KanbanRunMirror {
  const { projectRoot, events, broadcast } = deps;
  const log = deps.log ?? (() => {});

  // engine:key → boardId (key = runId for sdd, graphId for autophase).
  const boards = new Map<string, string>();
  // One-shot board id for the next launched AutoPhase run (graphId unknown yet).
  let pendingAutophaseBoardId: string | undefined;
  // engine:key → content stamp of the last projected state (skip-if-unchanged).
  const stamps = new Map<string, string>();
  const pending = new Map<string, () => Promise<void>>();
  const timers = new Map<string, ReturnType<typeof setTimeout>>();

  const mapKey = (engine: Engine, key: string) => `${engine}:${key}`;

  // Trailing debounce keyed by engine:key — latest projection wins.
  function schedule(engine: Engine, key: string, run: () => Promise<void>): void {
    const k = mapKey(engine, key);
    pending.set(k, run);
    if (timers.has(k)) return;
    timers.set(
      k,
      setTimeout(() => {
        timers.delete(k);
        const fn = pending.get(k);
        pending.delete(k);
        if (fn) void fn().catch((err) => log(`[KanbanRunMirror] ${k}: ${errMsg(err)}`));
      }, DEBOUNCE_MS),
    );
  }

  async function resolveBoardId(
    engine: Engine,
    key: string,
    title: string,
    tags: string[],
    matchTags?: string[],
  ): Promise<string> {
    const k = mapKey(engine, key);
    const existing = boards.get(k);
    if (existing) return existing;
    // Reclaim a board written on a previous mirror lifetime (restart-during-run):
    // scan disk for one carrying every distinguishing tag before minting a new
    // one. Matters more now that AutoPhase fans out to one board PER PHASE — a
    // restart would otherwise duplicate every phase board.
    if (matchTags?.length) {
      const found = (await listBoards(projectRoot)).find((b) =>
        matchTags.every((t) => b.tags?.includes(t)),
      );
      if (found) {
        boards.set(k, found.id);
        return found.id;
      }
    }
    const board = await createBoard(projectRoot, { title, tags });
    boards.set(k, board.id);
    return board.id;
  }

  // Reconcile one graph (a whole SDD run, or one AutoPhase phase) into the board.
  async function syncGraph(
    boardId: string,
    graph: SerializedTaskGraph,
    engine: Engine,
    tags: string[],
    phaseId?: string,
  ): Promise<KanbanBoard | null> {
    const result = await syncBoardFromTaskGraph(projectRoot, boardId, deserializeTaskGraph(graph), {
      sourceSystem: engine,
      archiveMissingTasks: true,
      includeCompletedTasks: true,
      tags,
      ...(phaseId ? { phaseId } : {}),
    });
    return result?.board ?? null;
  }

  // Diff-guarded assignment overlay for the live subset. Returns the final board.
  async function overlayAssignments(
    boardId: string,
    live: Array<{ taskId: string; phaseId?: string; assignment: DesiredAssignment }>,
    fallbackBoard: KanbanBoard | null,
  ): Promise<KanbanBoard | null> {
    if (live.length === 0) return fallbackBoard;
    let board = fallbackBoard ?? (await getBoard(projectRoot, boardId));
    if (!board) return null;
    const byOrigin = new Map<string, KanbanTask>();
    for (const t of board.tasks) {
      if (t.origin?.taskId) byOrigin.set(originKey(t.origin.taskId, t.origin.phaseId), t);
    }
    for (const item of live) {
      const task = byOrigin.get(originKey(item.taskId, item.phaseId));
      if (!task) continue;
      if (assignmentUnchanged(task.assignment, item.assignment)) continue;
      const updated = await updateTaskAssignment(projectRoot, boardId, task.id, item.assignment);
      if (updated) board = updated;
    }
    return board;
  }

  async function publish(board: KanbanBoard | null): Promise<void> {
    if (board) {
      broadcast({ type: 'kanban.get', payload: { success: true, data: { board } } });
    }
    broadcast({
      type: 'kanban.list',
      payload: { success: true, data: await listBoards(projectRoot) },
    });
  }

  // ── SDD ────────────────────────────────────────────────────────────────
  async function projectSdd(runId: string, snapshot: SddBoardSnapshot): Promise<void> {
    const k = mapKey('sdd', runId);
    const stamp = sddStamp(snapshot);
    if (stamps.get(k) === stamp) return;
    stamps.set(k, stamp);

    const tags = ['sdd', `run:${runId}`, `graph:${snapshot.graphId}`];
    const boardId = await resolveBoardId('sdd', runId, snapshot.title || `SDD ${runId}`, tags, [
      `run:${runId}`,
    ]);
    const graph = buildTaskGraphFromSddSnapshot(snapshot);
    const board = await syncGraph(boardId, graph, 'sdd', tags);

    const live: Array<{ taskId: string; assignment: DesiredAssignment }> = [];
    for (const t of snapshot.tasks) {
      const a = desiredAssignmentFromSdd(t);
      if (a) live.push({ taskId: t.id, assignment: a });
    }
    const final = await overlayAssignments(boardId, live, board);
    await publish(final);
  }

  // ── AutoPhase ──────────────────────────────────────────────────────────
  // Phased work spreads across ONE board PER PHASE — never a single crowded
  // board. All phase boards share a `run:<graphId>` tag (so the frontend groups
  // them under one run) and each carries its own `phase:<phaseId>` tag + a
  // "<run> — <phase>" title. Control (pause/resume/stop, per-task retry/reassign)
  // is run-level, so it works identically from any phase board.
  async function projectAutophase(graphId: string, state: AutophaseState): Promise<void> {
    const k = mapKey('autophase', graphId);
    const stamp = autophaseStamp(state);
    if (stamps.get(k) === stamp) return;
    stamps.set(k, stamp);

    const runTitle = state.title || `AutoPhase ${graphId}`;
    const phases = state.phases ?? [];

    for (let i = 0; i < phases.length; i++) {
      const phase = phases[i];
      if (!phase) continue;
      const phaseKey = `${graphId}:${phase.id}`;
      const phaseName = phase.name || `Phase ${i + 1}`;
      const tags = ['autophase', `run:${graphId}`, `graph:${graphId}`, `phase:${phase.id}`];
      const title = `${runTitle} — ${phaseName}`;
      // A board-launched run's one-shot binding attaches to the FIRST phase.
      if (i === 0 && !boards.has(mapKey('autophase', phaseKey)) && pendingAutophaseBoardId) {
        boards.set(mapKey('autophase', phaseKey), pendingAutophaseBoardId);
        pendingAutophaseBoardId = undefined;
      }
      const boardId = await resolveBoardId('autophase', phaseKey, title, tags, [
        `graph:${graphId}`,
        `phase:${phase.id}`,
      ]);
      const graph = buildTaskGraphFromAutophasePhase(graphId, title, phase);
      const board = await syncGraph(boardId, graph, 'autophase', tags, phase.id);

      const live: Array<{ taskId: string; phaseId: string; assignment: DesiredAssignment }> = [];
      for (const t of phase.tasks ?? []) {
        const a = desiredAssignmentFromAutophase(t);
        if (a) live.push({ taskId: t.id, phaseId: phase.id, assignment: a });
      }
      const final = await overlayAssignments(boardId, live, board);
      await publish(final);
    }
  }

  // ── Wiring ───────────────────────────────────────────────────────────────
  let unsub: (() => void) | undefined;
  if (events) {
    const handler = (e: { runId: string; snapshot: SddBoardSnapshot }) => {
      if (!e?.runId || !e.snapshot) return;
      schedule('sdd', e.runId, () => projectSdd(e.runId, e.snapshot));
    };
    unsub = events.on('sdd.board.snapshot', handler as (p: unknown) => void);
  }

  return {
    onAutophaseState(graphId, state) {
      if (!graphId) return;
      schedule('autophase', graphId, () => projectAutophase(graphId, state as AutophaseState));
    },
    bind(engine, key, boardId) {
      boards.set(mapKey(engine, key), boardId);
    },
    bindAutophaseNext(boardId) {
      pendingAutophaseBoardId = boardId;
    },
    dispose() {
      unsub?.();
      for (const t of timers.values()) clearTimeout(t);
      timers.clear();
      pending.clear();
    },
  };
}

// ── Pure normalizers (exported for unit tests) ───────────────────────────────

/** Build a serialized TaskGraph from an SDD board snapshot (faithful; runtime in metadata). */
export function buildTaskGraphFromSddSnapshot(snapshot: SddBoardSnapshot): SerializedTaskGraph {
  const shortToId = new Map(snapshot.tasks.map((t) => [t.shortId, t.id]));
  const nodes: TaskNode[] = snapshot.tasks.map((t, i) => ({
    id: t.id,
    title: t.title,
    description: t.description ?? '',
    type: t.type,
    priority: t.priority,
    status: t.status,
    ...(t.agentName ? { assignee: t.agentName } : {}),
    createdAt: i,
    updatedAt: i,
    ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
    ...(t.completedAt !== undefined ? { completedAt: t.completedAt } : {}),
    metadata: {
      model: t.model,
      provider: t.provider,
      fallbackModels: t.fallbackModels,
      worktreeBranch: t.worktreeBranch,
      retries: t.retries,
      cancelled: t.displayStatus === 'cancelled',
      verificationCommand: t.verificationCommand,
    },
  }));
  const edges: TaskEdge[] = [];
  for (const t of snapshot.tasks) {
    for (const dep of t.deps) {
      const from = shortToId.get(dep);
      if (from) edges.push({ id: `${from}->${t.id}`, from, to: t.id, type: 'depends_on' });
    }
  }
  return wrapGraph(
    snapshot.graphId,
    snapshot.specId ?? snapshot.graphId,
    snapshot.title,
    nodes,
    edges,
  );
}

type AutophasePhase = NonNullable<AutophaseState['phases']>[number];

/** Build a serialized TaskGraph for one AutoPhase phase (graph.id = RUN graphId; phase scoped via sync phaseId). */
export function buildTaskGraphFromAutophasePhase(
  graphId: string,
  title: string,
  phase: AutophasePhase,
): SerializedTaskGraph {
  const tasks = phase.tasks ?? [];
  const nodes: TaskNode[] = tasks.map((t, i) => ({
    id: t.id,
    title: t.title,
    description: t.description ?? '',
    type: t.type,
    priority: t.priority,
    status: t.status,
    ...(t.assignee ? { assignee: t.assignee } : {}),
    createdAt: i,
    updatedAt: i,
    ...(t.startedAt !== undefined ? { startedAt: t.startedAt } : {}),
    ...(t.completedAt !== undefined ? { completedAt: t.completedAt } : {}),
    tags: phase.name ? [phase.name] : [],
  }));
  return wrapGraph(graphId, graphId, title, nodes, []);
}

function wrapGraph(
  id: string,
  specId: string,
  title: string,
  nodes: TaskNode[],
  edges: TaskEdge[],
): SerializedTaskGraph {
  const hasIncoming = new Set(edges.map((e) => e.to));
  const rootNodes = nodes.filter((n) => !hasIncoming.has(n.id)).map((n) => n.id);
  return {
    id,
    specId,
    title,
    nodes,
    edges,
    rootNodes: rootNodes.length ? rootNodes : nodes[0] ? [nodes[0].id] : [],
    createdAt: 0,
    updatedAt: 0,
  };
}

// ── Assignment overlay helpers ───────────────────────────────────────────────

type DesiredAssignment = Partial<KanbanTask['assignment']> & { status: KanbanAgentRunStatus };

function desiredAssignmentFromSdd(t: SddBoardTask): DesiredAssignment | null {
  const status = runStatusFromDisplay(t.displayStatus);
  const isLive = Boolean(t.agentName) || status !== null;
  if (!isLive) return null;
  return {
    ...(t.agentName ? { name: t.agentName } : {}),
    ...(t.provider ? { provider: t.provider } : {}),
    ...(t.model ? { model: t.model } : {}),
    ...(t.fallbackModels && t.fallbackModels.length ? { fallbackModels: t.fallbackModels } : {}),
    ...(t.retries ? { attempt: t.retries } : {}),
    ...(t.startedAt !== undefined ? { dispatchedAt: new Date(t.startedAt).toISOString() } : {}),
    ...(t.completedAt !== undefined ? { completedAt: new Date(t.completedAt).toISOString() } : {}),
    status: status ?? 'assigned',
  };
}

function desiredAssignmentFromAutophase(t: {
  status: TaskNode['status'];
  assignee?: string;
  startedAt?: number;
  completedAt?: number;
}): DesiredAssignment | null {
  const status = runStatusFromCore(t.status);
  const isLive = Boolean(t.assignee) || status !== null;
  if (!isLive) return null;
  return {
    ...(t.assignee ? { name: t.assignee } : {}),
    ...(t.startedAt !== undefined ? { dispatchedAt: new Date(t.startedAt).toISOString() } : {}),
    ...(t.completedAt !== undefined ? { completedAt: new Date(t.completedAt).toISOString() } : {}),
    status: status ?? 'assigned',
  };
}

function runStatusFromDisplay(d: SddBoardTask['displayStatus']): KanbanAgentRunStatus | null {
  if (d === 'in_progress') return 'running';
  if (d === 'completed') return 'completed';
  if (d === 'failed') return 'failed';
  if (d === 'cancelled') return 'cancelled';
  return null;
}

function runStatusFromCore(s: TaskNode['status']): KanbanAgentRunStatus | null {
  if (s === 'in_progress') return 'running';
  if (s === 'completed') return 'completed';
  if (s === 'failed') return 'failed';
  return null;
}

/** Compare only the scalar fields the mirror sets — skip a no-op updateTaskAssignment call. */
function assignmentUnchanged(
  current: KanbanTask['assignment'] | undefined,
  desired: DesiredAssignment,
): boolean {
  if (!current) return false;
  const cur = current as unknown as Record<string, unknown>;
  const des = desired as unknown as Record<string, unknown>;
  for (const k of [
    'name',
    'provider',
    'model',
    'status',
    'attempt',
    'dispatchedAt',
    'completedAt',
  ]) {
    if (cur[k] !== des[k]) return false;
  }
  const cf = current.fallbackModels ?? [];
  const df = desired.fallbackModels ?? [];
  return cf.length === df.length && cf.every((v, i) => v === df[i]);
}

// ── stamps / misc ────────────────────────────────────────────────────────────

function sddStamp(s: SddBoardSnapshot): string {
  return s.tasks
    .map((t) => `${t.id}:${t.displayStatus}:${t.agentName ?? ''}:${t.retries}:${t.model ?? ''}`)
    .join('|');
}

function autophaseStamp(state: AutophaseState): string {
  return (state.phases ?? [])
    .flatMap((p) => (p.tasks ?? []).map((t) => `${t.id}:${t.status}:${t.assignee ?? ''}`))
    .join('|');
}

function originKey(taskId: string, phaseId?: string): string {
  return phaseId ? `${phaseId}:${taskId}` : taskId;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
