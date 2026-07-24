/**
 * SDD live board model.
 *
 * A board snapshot is the canonical, surface-agnostic projection of a running
 * (or persisted) SDD TaskGraph: tasks laid into topological dependency columns,
 * each carrying its short id, status, blockers and the agent currently on it.
 * The projector (sdd-board-projector.ts) emits these over the EventBus and
 * persists them (sdd-board-store.ts); every surface (WebUI/TUI) renders the
 * same shape.
 */

import { computeTaskProgress } from '@wrongstack/core/tasking';
import type { TaskGraph, TaskNode, TaskProgress } from '@wrongstack/core/types';

export type SddBoardStatus =
  | 'idle'
  | 'running'
  | 'paused'
  | 'stopped'
  | 'completed'
  | 'failed'
  | 'deadlocked';

/**
 * FORGE-style display status: `queued` = pending with all blockers done;
 * `cancelled` = a task the user stopped (stored as a terminal `failed` node
 * carrying `metadata.cancelled`, surfaced distinctly so it doesn't read as an
 * error). Display-only — not a core `TaskStatus`.
 */
export type SddTaskDisplayStatus = TaskNode['status'] | 'queued' | 'cancelled';

export interface SddBoardTask {
  id: string;
  /** Stable short id (t01, t02, …) in creation order. */
  shortId: string;
  title: string;
  description: string;
  status: TaskNode['status'];
  displayStatus: SddTaskDisplayStatus;
  priority: TaskNode['priority'];
  type: TaskNode['type'];
  /** Short ids of the tasks that block this one (depends_on edges). */
  deps: string[];
  /** Worker on the task right now (scientist nickname), if any. */
  agentName?: string | undefined;
  /** Git worktree branch this task runs in, when isolated. */
  worktreeBranch?: string | undefined;
  startedAt?: number | undefined;
  completedAt?: number | undefined;
  retries: number;
  /** Per-task model assignment (overrides the run default), if set. */
  model?: string | undefined;
  /** Per-task provider assignment (overrides the run default), if set. */
  provider?: string | undefined;
  /** Per-task fallback model chain (overrides the run default), if set. */
  fallbackModels?: string[] | undefined;
  /** Per-task completion-gate verification command, if set. */
  verificationCommand?: string | undefined;
  /** Completion-gate outcome for the last worker attempt, if verification ran. */
  verificationState?: 'passed' | 'failed' | undefined;
  /** Failure reason when verificationState is 'failed'. */
  verificationDetail?: string | undefined;
}

/** A topological column: tasks whose deepest dependency chain is `depth`. */
export interface SddBoardColumn {
  label: string;
  /** Short ids of the tasks in this column (join against `tasks`). */
  taskIds: string[];
}

export interface SddDeadlockChain {
  /** Short id of the blocked task. */
  blocked: string;
  /** Short ids of the failed/incomplete blockers holding it. */
  blockedBy: string[];
}

/** One entry in the live activity feed (the board's "what just happened" ticker). */
export interface SddBoardFeedEntry {
  ts: number;
  kind:
    | 'started'
    | 'completed'
    | 'failed'
    | 'retrying'
    | 'wave'
    | 'deadlock'
    | 'verification_failed'
    | 'conflict'
    | 'split'
    | 'supervisor'
    | 'tool'
    | 'file';
  /** Full task id for durable per-task history; older snapshots may only carry shortId. */
  taskId?: string | undefined;
  /** Short id of the task this entry concerns, when applicable. */
  taskShortId?: string | undefined;
  /** Worker involved, when applicable. */
  agentName?: string | undefined;
  /** Human-readable one-line summary. */
  text: string;
  /** Structured event-log fields used by richer board surfaces. */
  action?: string | undefined;
  detail?: string | undefined;
  filePath?: string | undefined;
  durationMs?: number | undefined;
  ok?: boolean | undefined;
}

export interface SddBoardSnapshot {
  runId: string;
  specId?: string | undefined;
  graphId: string;
  title: string;
  status: SddBoardStatus;
  startedAt: number;
  updatedAt: number;
  progress: TaskProgress;
  /** Current wave index (0-based) of the parallel run. */
  wave: number;
  tasks: SddBoardTask[];
  columns: SddBoardColumn[];
  diagnostics?: { deadlockChains?: SddDeadlockChain[] } | undefined;
  /** Live activity feed — most recent first (capped). */
  feed?: SddBoardFeedEntry[] | undefined;
  /** Per-task event history — most recent first and capped independently per task. */
  taskEvents?: Record<string, SddBoardFeedEntry[]> | undefined;
  /** Run-level default worker model (task overrides take precedence). */
  defaultModel?: string | undefined;
  /** Run-level default worker provider. */
  defaultProvider?: string | undefined;
  /** Run-level default fallback model chain. */
  fallbackModels?: string[] | undefined;
  /** Base branch the run's squash commits land on (worktree runs only). */
  baseBranch?: string | undefined;
  /**
   * Squash commits the run landed on the base branch, in landing order. Lets a
   * post-run `/sdd rollback` revert them from disk after the live run is gone.
   */
  mergedCommits?: Array<{ taskId: string; sha: string; title: string }> | undefined;
}

/**
 * Lay a TaskGraph's nodes into topological dependency columns with stable short
 * ids and per-task blocker refs. Shared by the projector (live) and any static
 * board browser. Pure; no run state — `agentName`/`worktreeBranch`/`retries`
 * are read from the node's `assignee`/`metadata` so a reload reflects the last
 * persisted run.
 */
/**
 * Stable short-id map (t01, t02, …) for a graph's nodes in creation order.
 * Shared by the board renderer and the projector (deadlock-chain labelling).
 */
export function shortIdMap(graph: TaskGraph): Map<string, string> {
  const nodes = Array.from(graph.nodes.values()).sort((a, b) => a.createdAt - b.createdAt);
  const m = new Map<string, string>();
  nodes.forEach((n, i) => {
    m.set(n.id, `t${String(i + 1).padStart(2, '0')}`);
  });
  return m;
}

export function buildBoardTasks(graph: TaskGraph): {
  tasks: SddBoardTask[];
  columns: SddBoardColumn[];
} {
  const nodes = Array.from(graph.nodes.values()).sort((a, b) => a.createdAt - b.createdAt);
  const shortId = shortIdMap(graph);

  // Blockers per node (depends_on edges pointing at the node).
  const blockers = new Map<string, string[]>();
  for (const n of nodes) blockers.set(n.id, []);
  for (const e of graph.edges) {
    if (e.type === 'depends_on') blockers.get(e.to)?.push(e.from);
  }

  const statusOf = (id: string) => graph.nodes.get(id)?.status;

  // Memoized topological depth (longest blocker chain), cycle-guarded.
  const depthCache = new Map<string, number>();
  const depthOf = (id: string, seen = new Set<string>()): number => {
    const cached = depthCache.get(id);
    if (cached !== undefined) return cached;
    if (seen.has(id)) return 0;
    seen.add(id);
    const deps = blockers.get(id) ?? [];
    const d = deps.length === 0 ? 0 : 1 + Math.max(...deps.map((b) => depthOf(b, seen)));
    depthCache.set(id, d);
    return d;
  };

  const toTask = (n: TaskNode): SddBoardTask => {
    const deps = blockers.get(n.id)!;
    const allDepsDone = deps.every((b) => statusOf(b) === 'completed');
    const meta = (n.metadata ?? {}) as Record<string, unknown>;
    const cancelled = Boolean(meta['cancelled']);
    const displayStatus: SddTaskDisplayStatus = cancelled
      ? 'cancelled'
      : n.status === 'pending' && deps.length > 0 && allDepsDone
        ? 'queued'
        : n.status;
    return {
      id: n.id,
      shortId: shortId.get(n.id)!,
      title: n.title,
      description: n.description,
      status: n.status,
      displayStatus,
      priority: n.priority,
      type: n.type,
      deps: deps.map((b) => shortId.get(b) ?? b.slice(0, 6)),
      agentName: n.assignee,
      worktreeBranch:
        typeof meta['worktreeBranch'] === 'string' ? (meta['worktreeBranch'] as string) : undefined,
      startedAt: n.startedAt,
      completedAt: n.completedAt,
      retries: typeof meta['retries'] === 'number' ? (meta['retries'] as number) : 0,
      model: typeof meta['model'] === 'string' ? (meta['model'] as string) : undefined,
      provider: typeof meta['provider'] === 'string' ? (meta['provider'] as string) : undefined,
      fallbackModels: Array.isArray(meta['fallbackModels'])
        ? (meta['fallbackModels'] as string[])
        : undefined,
      verificationCommand:
        typeof meta['verificationCommand'] === 'string'
          ? (meta['verificationCommand'] as string)
          : undefined,
      verificationState:
        meta['verificationState'] === 'passed' || meta['verificationState'] === 'failed'
          ? (meta['verificationState'] as 'passed' | 'failed')
          : undefined,
      verificationDetail:
        typeof meta['verificationDetail'] === 'string'
          ? (meta['verificationDetail'] as string)
          : undefined,
    };
  };

  const tasks = nodes.map(toTask);

  const byDepth = new Map<number, string[]>();
  for (const n of nodes) {
    const d = depthOf(n.id);
    if (!byDepth.has(d)) byDepth.set(d, []);
    byDepth.get(d)!.push(shortId.get(n.id)!);
  }
  const columns: SddBoardColumn[] = [...byDepth.keys()]
    .sort((a, b) => a - b)
    .map((d) => ({ label: d === 0 ? 'Start' : `Phase ${d}`, taskIds: byDepth.get(d)! }));

  return { tasks, columns };
}

/**
 * Build a full board snapshot from a graph + run state. The projector calls
 * this on every (throttled) change.
 */
export function buildBoardSnapshot(
  graph: TaskGraph,
  run: {
    runId: string;
    specId?: string | undefined;
    status: SddBoardStatus;
    startedAt: number;
    wave: number;
    deadlockChains?: SddDeadlockChain[] | undefined;
    defaultModel?: string | undefined;
    defaultProvider?: string | undefined;
    fallbackModels?: string[] | undefined;
    baseBranch?: string | undefined;
    mergedCommits?: Array<{ taskId: string; sha: string; title: string }> | undefined;
  },
  now: number,
): SddBoardSnapshot {
  const { tasks, columns } = buildBoardTasks(graph);
  return {
    runId: run.runId,
    specId: run.specId,
    graphId: graph.id,
    title: graph.title,
    status: run.status,
    startedAt: run.startedAt,
    updatedAt: now,
    progress: computeTaskProgress(graph),
    wave: run.wave,
    tasks,
    columns,
    diagnostics: run.deadlockChains?.length ? { deadlockChains: run.deadlockChains } : undefined,
    defaultModel: run.defaultModel,
    defaultProvider: run.defaultProvider,
    fallbackModels: run.fallbackModels,
    baseBranch: run.baseBranch,
    mergedCommits: run.mergedCommits?.length ? run.mergedCommits : undefined,
  };
}
