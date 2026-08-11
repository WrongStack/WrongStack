import { type FSWatcher, watch } from 'node:fs';
import { basename, dirname } from 'node:path';
import type { Context, TodoItem } from '@wrongstack/core/agent';
import { getSharedProjectMailbox } from '@wrongstack/core/coordination';
import {
  loadPlan,
  loadTasks,
  mutatePlan,
  mutateTasks,
  type PlanFile,
  type PlanItem,
  type TaskFile,
} from '@wrongstack/core/storage';
import { deserializeTaskGraph } from '@wrongstack/core/tasking';
import type { SerializedTaskGraph, TaskStatus } from '@wrongstack/core/types';
import { formatTodosForModel, resolveWstackPaths, type TaskItem } from '@wrongstack/core/utils';
import {
  bridgeKanbanSupervisor,
  compactSessionMirrorBoard,
  createBoard,
  DEFAULT_COLUMNS,
  getBoard,
  getDependencyReadinessIssues,
  getKanbanOrchestrationSnapshot,
  type KanbanBoard,
  type KanbanColumn,
  type KanbanTask,
  listBoards,
  pruneSessionBoards,
  removeBoard,
  syncBoardFromTaskGraph,
  touchKanbanPresence,
  updateBoard,
} from '@wrongstack/kanban';

const SESSION_BOARD_TAG = 'session-work';
const MIRROR_DISABLED_ENV = 'WRONGSTACK_KANBAN_TASK_MIRROR';

/**
 * The canonical workflow shared by WebUI and TUI session boards.
 *
 * Session boards now use the same 5 standard columns as every other board
 * (backlog, todo, in-progress, review, done). Formerly this shipped a 4-column
 * variant without a backlog; the column lock unified the layout. Existing
 * 4-column session_mirror boards are migrated automatically on the next session
 * touch: `ensureSessionKanbanBoard`'s `sameColumns` check detects the drift
 * and `updateBoard` reconciles to DEFAULT_COLUMNS.
 */
export const SESSION_KANBAN_COLUMNS: KanbanColumn[] = DEFAULT_COLUMNS.map((column) => ({
  ...column,
}));

const boardQueue = new Map<string, Promise<void>>();
const boardEnsures = new Map<string, Promise<KanbanBoard>>();
type PendingMirror = {
  projectRoot: string;
  sessionId: string;
  graph: SerializedTaskGraph;
  reconciliationGraph?: SerializedTaskGraph | undefined;
  sourceSystem: 'session-todo' | 'session-task' | 'session-plan';
};
const pendingMirrors = new Map<string, PendingMirror>();
const activeMirrors = new Set<string>();
const mirrorFailures = new Map<
  string,
  { message: string; sourceSystem: PendingMirror['sourceSystem'] }
>();
const bindings = new WeakMap<Context, () => void>();
const suppressedTodoMirrors = new WeakSet<Context>();
const activeSessionBoards = new Map<string, number>();

function boardKey(projectRoot: string, sessionId: string): string {
  return `${projectRoot}\0${sessionId}`;
}

function mirrorKey(
  projectRoot: string,
  sessionId: string,
  sourceSystem: PendingMirror['sourceSystem'],
): string {
  return `${boardKey(projectRoot, sessionId)}\0${sourceSystem}`;
}

function completedReconciliationGraph(
  latest: SerializedTaskGraph,
  candidates: readonly SerializedTaskGraph[],
): SerializedTaskGraph | undefined {
  const latestNodeIds = new Set(latest.nodes.map((node) => node.id));
  const carriedNodeIds = new Set<string>();
  const completedNodes = candidates.flatMap((candidate) =>
    candidate.nodes.filter((node) => {
      if (
        node.status !== 'completed' ||
        latestNodeIds.has(node.id) ||
        carriedNodeIds.has(node.id)
      ) {
        return false;
      }
      carriedNodeIds.add(node.id);
      return true;
    }),
  );
  if (completedNodes.length === 0) return undefined;

  const carriedRequirements = completedNodes.flatMap((node) =>
    node.specRequirementId ? [node.specRequirementId] : [],
  );
  return {
    ...latest,
    nodes: [...latest.nodes, ...completedNodes],
    rootNodes: [...new Set([...latest.rootNodes, ...completedNodes.map((node) => node.id)])],
    ...(latest.requiredRequirementIds
      ? {
          requiredRequirementIds: [
            ...new Set([...latest.requiredRequirementIds, ...carriedRequirements]),
          ],
        }
      : {}),
  };
}

function sessionTag(sessionId: string): string {
  return `session:${sessionId}`;
}

function sessionBoardTitle(sessionId: string): string {
  const leaf = sessionId.split(/[\\/]/).filter(Boolean).pop() ?? sessionId;
  return `Session ${leaf.slice(0, 12)}`;
}

function sessionBoardTags(sessionId: string): string[] {
  return ['session', SESSION_BOARD_TAG, sessionTag(sessionId)];
}

function sessionIdFromTags(tags: readonly string[] | undefined): string | null {
  const tag = tags?.find((candidate) => candidate.startsWith('session:'));
  return tag?.slice('session:'.length) || null;
}

function isOwnedSessionBoard(tags: readonly string[] | undefined): boolean {
  return Boolean(tags?.includes(SESSION_BOARD_TAG) && sessionIdFromTags(tags));
}

function retainActiveSessionBoard(projectRoot: string, sessionId: string): void {
  const key = boardKey(projectRoot, sessionId);
  activeSessionBoards.set(key, (activeSessionBoards.get(key) ?? 0) + 1);
}

function releaseActiveSessionBoard(projectRoot: string, sessionId: string): void {
  const key = boardKey(projectRoot, sessionId);
  const remaining = (activeSessionBoards.get(key) ?? 0) - 1;
  if (remaining > 0) activeSessionBoards.set(key, remaining);
  else activeSessionBoards.delete(key);
}

function isSessionBoardActive(projectRoot: string, sessionId: string): boolean {
  return (activeSessionBoards.get(boardKey(projectRoot, sessionId)) ?? 0) > 0;
}

function sameColumns(columns: readonly KanbanColumn[]): boolean {
  return (
    columns.length === SESSION_KANBAN_COLUMNS.length &&
    columns.every((column, index) => column.id === SESSION_KANBAN_COLUMNS[index]?.id)
  );
}

/** Create (or migrate) the single Kanban board owned by a session. */
export async function ensureSessionKanbanBoard(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<KanbanBoard | null> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return null;
  const key = boardKey(projectRoot, sessionId);
  const inFlight = boardEnsures.get(key);
  if (inFlight) return inFlight;

  const promise = (async () => {
    const summary = (await listBoards(projectRoot)).find((board) =>
      board.tags?.includes(sessionTag(sessionId)),
    );
    let board = summary ? await getBoard(projectRoot, summary.id) : null;
    if (!board) {
      return createBoard(projectRoot, {
        title: sessionBoardTitle(sessionId),
        description: 'Live session work: todos, tasks, and plan items.',
        tags: sessionBoardTags(sessionId),
        columns: SESSION_KANBAN_COLUMNS,
        generatedBy: `session-kanban:${sessionId}`,
        kind: 'session_mirror' as const,
        retention: { mode: 'archive_after_ttl' as const, ttlMs: 7 * 24 * 60 * 60 * 1000 },
      });
    }

    // Boards produced by the older task/plan mirrors used the generic five
    // columns. Migrate only session-owned boards; updateBoard reconciles cards
    // from Backlog into Todo while preserving Running/Preview/Done cards.
    if (!sameColumns(board.columns) || !board.tags?.includes(SESSION_BOARD_TAG)) {
      board =
        (await updateBoard(projectRoot, board.id, {
          title: sessionBoardTitle(sessionId),
          description: 'Live session work: todos, tasks, and plan items.',
          tags: [...new Set([...(board.tags ?? []), ...sessionBoardTags(sessionId)])],
          columns: SESSION_KANBAN_COLUMNS,
        })) ?? board;
    }
    return board;
  })();

  boardEnsures.set(key, promise);
  try {
    return await promise;
  } finally {
    boardEnsures.delete(key);
  }
}

function enqueueBoardWork<T>(
  projectRoot: string,
  sessionId: string,
  work: () => Promise<T>,
): Promise<T> {
  const key = boardKey(projectRoot, sessionId);
  const previous = boardQueue.get(key) ?? Promise.resolve();
  const result = previous.catch(() => undefined).then(work);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  boardQueue.set(key, tail);
  void tail.then(() => {
    if (boardQueue.get(key) === tail) boardQueue.delete(key);
  });
  return result;
}

async function removeEmptySessionBoard(
  projectRoot: string,
  boardId: string,
  sessionId: string,
): Promise<string | null> {
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    if (isSessionBoardActive(projectRoot, sessionId)) return null;
    const board = await getBoard(projectRoot, boardId);
    if (!board || board.tasks.length > 0 || !isOwnedSessionBoard(board.tags)) return null;
    if (sessionIdFromTags(board.tags) !== sessionId) return null;
    return (await removeBoard(projectRoot, board.id)) ? board.id : null;
  });
}

async function removeOwnedSessionBoard(
  projectRoot: string,
  boardId: string,
  sessionId: string,
): Promise<string | null> {
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    if (isSessionBoardActive(projectRoot, sessionId)) return null;
    const board = await getBoard(projectRoot, boardId);
    if (!board || !isOwnedSessionBoard(board.tags)) return null;
    if (sessionIdFromTags(board.tags) !== sessionId) return null;
    return (await removeBoard(projectRoot, board.id)) ? board.id : null;
  });
}

/**
 * Remove an inactive session's observational mirror, including its cards.
 * The durable source remains the session todo/task/plan files; retaining the
 * mirror after detach only creates historical duplicate work in project views.
 */
export async function cleanupSessionKanbanBoard(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<string[]> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  if (isSessionBoardActive(projectRoot, sessionId)) return [];
  const candidates = (await listBoards(projectRoot)).filter(
    (board) => isOwnedSessionBoard(board.tags) && sessionIdFromTags(board.tags) === sessionId,
  );
  const removed = await Promise.all(
    candidates.map((board) => removeOwnedSessionBoard(projectRoot, board.id, sessionId)),
  );
  return removed.filter((boardId): boardId is string => Boolean(boardId));
}

/** Remove a particular inactive session's system-owned board when it has no cards. */
export async function cleanupSessionKanbanBoardIfEmpty(
  projectRoot: string | undefined,
  sessionId: string,
): Promise<string[]> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  if (isSessionBoardActive(projectRoot, sessionId)) return [];
  const candidates = (await listBoards(projectRoot)).filter(
    (board) =>
      board.taskCount === 0 &&
      isOwnedSessionBoard(board.tags) &&
      sessionIdFromTags(board.tags) === sessionId,
  );
  const removed = await Promise.all(
    candidates.map((board) => removeEmptySessionBoard(projectRoot, board.id, sessionId)),
  );
  return removed.filter((boardId): boardId is string => Boolean(boardId));
}

/** Prune stale empty session boards while preserving manual and live boards. */
export async function cleanupEmptySessionKanbanBoards(
  projectRoot: string | undefined,
  activeSessionId = '',
): Promise<string[]> {
  if (!projectRoot || process.env[MIRROR_DISABLED_ENV] === '0') return [];
  const candidates = (await listBoards(projectRoot)).flatMap((board) => {
    const ownerSessionId = sessionIdFromTags(board.tags);
    return board.taskCount === 0 &&
      isOwnedSessionBoard(board.tags) &&
      ownerSessionId &&
      ownerSessionId !== activeSessionId &&
      !isSessionBoardActive(projectRoot, ownerSessionId)
      ? [{ boardId: board.id, sessionId: ownerSessionId }]
      : [];
  });
  const removed = await Promise.all(
    candidates.map(({ boardId, sessionId }) =>
      removeEmptySessionBoard(projectRoot, boardId, sessionId),
    ),
  );
  return removed.filter((boardId): boardId is string => Boolean(boardId));
}

async function projectGraph(
  projectRoot: string | undefined,
  sessionId: string,
  graph: SerializedTaskGraph,
  sourceSystem: 'session-todo' | 'session-task' | 'session-plan',
): Promise<KanbanBoard | null> {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return null;
  return enqueueBoardWork(projectRoot, sessionId, async () => {
    const board = await ensureSessionKanbanBoard(projectRoot, sessionId);
    if (!board) return null;
    const result = await syncBoardFromTaskGraph(
      projectRoot,
      board.id,
      deserializeTaskGraph(graph),
      {
        sourceSystem,
        tags: [...new Set([...(board.tags ?? []), ...sessionBoardTags(sessionId)])],
        archiveMissingTasks: true,
        includeCompletedTasks: true,
        // The scope ledger stays declared and accurate, but it may not veto a
        // projection. A session mirror reflects a tactical list that shrinks by
        // design, and refusing the sync never protected the removed row — it
        // froze the entire board, permanently, because the stored scope then
        // outlived every later snapshot (`session-kanban.mirror-failed`).
        // Nothing is lost by shrinking here: `archiveMissingTasks` keeps the
        // removed card on the board as `archived`, the reconciliation pass
        // first walks vanished completed rows to Done, and the session journal
        // remains the durable record.
        allowRequirementScopeShrink: true,
      },
    );
    if (!result) return null;
    // The whole board is rewritten on every mutation, so its card count is a
    // direct per-update cost. A long session cycles through many todo lists
    // and archives each one, so without a ceiling every later update pays for
    // work that finished hours ago. Bound the terminal cards; open work and
    // anything a retained card depends on is never dropped.
    const compacted = await compactSessionMirrorBoard(projectRoot, board.id);
    if (compacted?.removedTaskIds.length) {
      return (await getBoard(projectRoot, board.id)) ?? result.board;
    }
    return result.board;
  });
}

/**
 * Queue an observational mirror without retaining every intermediate state.
 * Todo/task/plan streams are independent, but within each stream only the
 * newest pending graph matters. This bounds a stalled file lock to one active
 * and one pending projection instead of an arbitrarily long Promise chain.
 */
function queueLatestMirror(
  projectRoot: string | undefined,
  sessionId: string,
  graph: SerializedTaskGraph,
  sourceSystem: PendingMirror['sourceSystem'],
): void {
  if (!projectRoot || !sessionId || process.env[MIRROR_DISABLED_ENV] === '0') return;
  const key = mirrorKey(projectRoot, sessionId, sourceSystem);
  const previous = pendingMirrors.get(key);
  const reconciliationGraph = previous
    ? completedReconciliationGraph(
        graph,
        [previous.reconciliationGraph, previous.graph].filter(
          (candidate): candidate is SerializedTaskGraph => candidate !== undefined,
        ),
      )
    : undefined;
  pendingMirrors.set(key, {
    projectRoot,
    sessionId,
    graph,
    ...(reconciliationGraph ? { reconciliationGraph } : {}),
    sourceSystem,
  });
  if (activeMirrors.has(key)) return;
  activeMirrors.add(key);
  void (async () => {
    try {
      for (;;) {
        const pending = pendingMirrors.get(key);
        if (!pending) break;
        pendingMirrors.delete(key);
        try {
          if (pending.reconciliationGraph) {
            await projectGraph(
              pending.projectRoot,
              pending.sessionId,
              pending.reconciliationGraph,
              pending.sourceSystem,
            );
          }
          await projectGraph(
            pending.projectRoot,
            pending.sessionId,
            pending.graph,
            pending.sourceSystem,
          );
          mirrorFailures.delete(boardKey(pending.projectRoot, pending.sessionId));
        } catch (error) {
          // A mirror must never fail silently: scope-shrink rejection and IPC
          // failures otherwise look like successful plan/task/todo updates
          // while the authoritative board intentionally retains older work.
          // A console warning alone is not enough — nothing reads stdout mid
          // session, so the divergence stayed invisible until someone opened
          // the board. Retain it for the next `todo` call to report.
          const message = error instanceof Error ? error.message : String(error);
          mirrorFailures.set(boardKey(pending.projectRoot, pending.sessionId), {
            message,
            sourceSystem: pending.sourceSystem,
          });
          console.warn(
            JSON.stringify({
              level: 'warn',
              event: 'session-kanban.mirror-failed',
              sessionId: pending.sessionId,
              sourceSystem: pending.sourceSystem,
              message,
              timestamp: new Date().toISOString(),
            }),
          );
          // A newer pending snapshot, if present, still gets a chance after a
          // transient lock or filesystem failure.
        }
      }
    } finally {
      activeMirrors.delete(key);
      // A mirror can arrive between the last Map read and deleting the active
      // marker. Re-arm once so that snapshot cannot be stranded.
      const pending = pendingMirrors.get(key);
      if (pending) {
        pendingMirrors.delete(key);
        queueLatestMirror(
          pending.projectRoot,
          pending.sessionId,
          pending.graph,
          pending.sourceSystem,
        );
      }
    }
  })();
}

/**
 * Consume the last unreported mirror failure for a session, if any.
 *
 * The mirror is asynchronous and fire-and-forget, so a rejected projection
 * used to be observable only in stdout. The `todo` tool drains this on its
 * next call and reports it as a warning, so a board that stopped tracking the
 * session is surfaced where the divergence actually matters.
 */
export function takeSessionMirrorFailure(
  projectRoot: string | undefined,
  sessionId: string,
): string | undefined {
  if (!projectRoot || !sessionId) return undefined;
  const key = boardKey(projectRoot, sessionId);
  const failure = mirrorFailures.get(key);
  if (!failure) return undefined;
  mirrorFailures.delete(key);
  return `Kanban mirror (${failure.sourceSystem}) failed and the board may be stale: ${failure.message}`;
}

/**
 * True while a todo projection for this session is queued or in flight.
 *
 * Board-to-todo application must stand down in that window: the board on disk
 * is provably older than the local list that produced the pending mirror, so
 * applying it would silently roll back the newer todo state.
 */
function hasInFlightTodoMirror(projectRoot: string | undefined, sessionId: string): boolean {
  if (!projectRoot || !sessionId) return false;
  const key = mirrorKey(projectRoot, sessionId, 'session-todo');
  return pendingMirrors.has(key) || activeMirrors.has(key);
}

export function todoListToSerializedGraph(
  todos: readonly TodoItem[],
  sessionId: string,
): SerializedTaskGraph {
  const graphId = `todo:${sessionId}`;
  const nodes = todos.map((todo, index) => ({
    id: todo.id,
    title: todo.content,
    description: todo.activeForm ?? '',
    type: 'chore' as const,
    priority: 'medium' as const,
    status: todo.status,
    specRequirementId: `${graphId}:${todo.id}`,
    createdAt: index,
    updatedAt: index,
  }));
  return {
    id: graphId,
    specId: graphId,
    requiredRequirementIds: nodes.map((node) => node.specRequirementId),
    title: 'Session todos',
    nodes,
    edges: [],
    rootNodes: nodes.map((node) => node.id),
    createdAt: 0,
    updatedAt: 0,
  };
}

export function taskFileToSerializedGraph(
  tasks: readonly TaskItem[],
  sessionId: string,
): SerializedTaskGraph {
  const graphId = `session:${sessionId}`;
  const ids = new Set(tasks.map((task) => task.id));
  const nodes = tasks.map((task, index) => ({
    id: task.id,
    title: task.title,
    description: task.description ?? '',
    type: task.type,
    priority: task.priority,
    status: task.status,
    specRequirementId: `${graphId}:${task.id}`,
    ...(task.assignee ? { assignee: task.assignee } : {}),
    ...(task.estimateHours !== undefined ? { estimateHours: task.estimateHours } : {}),
    createdAt: index,
    updatedAt: index,
  }));
  const edges = tasks.flatMap((task) =>
    (task.dependsOn ?? [])
      .filter((dependency) => ids.has(dependency))
      .map((dependency) => ({
        id: `${dependency}->${task.id}`,
        from: dependency,
        to: task.id,
        type: 'depends_on' as const,
      })),
  );
  const hasIncoming = new Set(edges.map((edge) => edge.to));
  const rootNodes = nodes.filter((node) => !hasIncoming.has(node.id)).map((node) => node.id);
  return {
    // Keep the historical graph id so existing mirrored task cards are reused.
    id: graphId,
    specId: graphId,
    requiredRequirementIds: nodes.map((node) => node.specRequirementId),
    title: 'Session tasks',
    nodes,
    edges,
    rootNodes: rootNodes.length ? rootNodes : nodes[0] ? [nodes[0].id] : [],
    createdAt: 0,
    updatedAt: 0,
  };
}

const PLAN_STATUS_TO_TASK: Record<PlanItem['status'], TaskStatus> = {
  open: 'pending',
  in_progress: 'in_progress',
  done: 'completed',
};

export function planFileToSerializedGraph(
  items: readonly PlanItem[],
  sessionId: string,
): SerializedTaskGraph {
  const graphId = `plan:${sessionId}`;
  const nodes = items.map((item, index) => ({
    id: item.id,
    title: item.title,
    description: item.details ?? '',
    type: 'chore' as const,
    priority: 'medium' as const,
    status: PLAN_STATUS_TO_TASK[item.status],
    specRequirementId: `${graphId}:${item.id}`,
    createdAt: index,
    updatedAt: index,
  }));
  return {
    id: graphId,
    specId: graphId,
    requiredRequirementIds: nodes.map((node) => node.specRequirementId),
    title: 'Session plan',
    nodes,
    edges: [],
    rootNodes: nodes.map((node) => node.id),
    createdAt: 0,
    updatedAt: 0,
  };
}

export function projectSessionTodosToKanban(
  projectRoot: string | undefined,
  todos: readonly TodoItem[],
  sessionId: string,
): Promise<KanbanBoard | null> {
  return projectGraph(
    projectRoot,
    sessionId,
    todoListToSerializedGraph(todos, sessionId),
    'session-todo',
  );
}

export function projectSessionTasksToKanban(
  projectRoot: string | undefined,
  tasks: readonly TaskItem[],
  sessionId: string,
): Promise<KanbanBoard | null> {
  return projectGraph(
    projectRoot,
    sessionId,
    taskFileToSerializedGraph(tasks, sessionId),
    'session-task',
  );
}

export function projectSessionPlanToKanban(
  projectRoot: string | undefined,
  items: readonly PlanItem[],
  sessionId: string,
): Promise<KanbanBoard | null> {
  return projectGraph(
    projectRoot,
    sessionId,
    planFileToSerializedGraph(items, sessionId),
    'session-plan',
  );
}

function fireAndForget(context: string, work: Promise<unknown>): void {
  void work.catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'session-kanban',
        context,
        message,
        timestamp: new Date().toISOString(),
      }),
    );
  });
}

function broadcastTodoUpdate(context: Context, todos: readonly TodoItem[]): void {
  const sessionId = context.session?.id ?? '';
  if (!context.agentId || !sessionId) return;
  const statusCounts = { pending: 0, inProgress: 0, completed: 0 };
  for (const todo of todos) {
    if (todo.status === 'completed') statusCounts.completed++;
    else if (todo.status === 'in_progress') statusCounts.inProgress++;
    else statusCounts.pending++;
  }
  const projectDir = resolveWstackPaths({ projectRoot: context.projectRoot }).projectDir;
  const mailbox = getSharedProjectMailbox(projectDir);
  void mailbox
    .send({
      from: context.agentId,
      to: '*',
      type: 'status',
      subject: `Kanban todo list updated (${todos.length} item${todos.length === 1 ? '' : 's'})`,
      body: JSON.stringify({
        kind: 'kanban.todos.updated',
        sessionId,
        revision: context.state.revision,
        todoCount: todos.length,
        statusCounts,
      }),
      priority: 'normal',
      senderSessionId: sessionId,
    })
    .catch(() => {
      // Mailbox awareness is best-effort; canonical state is already updated.
    });
}

function notifyTodoUpdate(context: Context, todos: readonly TodoItem[]): void {
  const summary = formatTodosForModel(todos);
  const text =
    `[KANBAN TODO UPDATE]\nAnother Kanban agent reassessed the shared board. The canonical todo list is now:\n${summary}\n` +
    'Reassess your current plan before continuing; do not rely on the initial todo snapshot. ' +
    "Preserve each row's <kanban board/task> binding verbatim on your next `todo` call — a row that loses it stops advancing its card.";
  const state = context.state as Partial<Context['state']>;
  if (typeof state.appendBlockToLastUserMessage === 'function') {
    if (state.appendBlockToLastUserMessage({ type: 'text', text })) return;
  }
  if (typeof state.appendMessage === 'function') {
    state.appendMessage({ role: 'user', content: [{ type: 'text', text }] });
  }
}

/**
 * The todo rows that still need the session mirror: those not already cards on
 * the board this session is working on.
 *
 * The rule used to be all-or-nothing — the mirror was skipped only when EVERY
 * row was bound. A single unbound row (a todo the model added to the chat list
 * without also filing a card) sent the whole list to a separate session board,
 * so work already tracked on the real board showed up a second time there, and
 * one stray row was enough to leave a session board holding a single card.
 *
 * With no active board every row still needs mirroring, since there is no other
 * place the work is being recorded.
 */
export function todosNeedingSessionMirror(
  todos: readonly TodoItem[],
  activeBoardId: string | undefined,
): readonly TodoItem[] {
  if (!activeBoardId) return todos;
  return todos.filter((todo) => todo.kanbanBoardId !== activeBoardId || !todo.kanbanTaskId);
}

export function mirrorSessionTodosToKanban(
  projectRoot: string | undefined,
  todos: readonly TodoItem[],
  sessionId: string,
): void {
  queueLatestMirror(
    projectRoot,
    sessionId,
    todoListToSerializedGraph(todos, sessionId),
    'session-todo',
  );
}

export function mirrorSessionTasksToKanban(
  projectRoot: string | undefined,
  tasks: readonly TaskItem[],
  sessionId: string,
): void {
  queueLatestMirror(
    projectRoot,
    sessionId,
    taskFileToSerializedGraph(tasks, sessionId),
    'session-task',
  );
}

export function mirrorSessionPlanToKanban(
  projectRoot: string | undefined,
  items: readonly PlanItem[],
  sessionId: string,
): void {
  queueLatestMirror(
    projectRoot,
    sessionId,
    planFileToSerializedGraph(items, sessionId),
    'session-plan',
  );
}

/**
 * Bind all live session work paths to Kanban. Todo changes are observed from
 * ConversationState; plan/task sidecars are watched so slash commands, WebUI,
 * plugins, and tools all pass through the same board.
 */
export function attachSessionKanbanMirror(context: Context): () => void {
  const existing = bindings.get(context);
  if (existing) return existing;

  const attachedProjectRoot = context.projectRoot ?? '';
  let registeredSessionId = '';
  const syncActiveSessionRegistration = () => {
    if (!attachedProjectRoot) return;
    const currentSessionId = context.session?.id ?? '';
    if (currentSessionId === registeredSessionId) return;
    if (registeredSessionId) {
      releaseActiveSessionBoard(attachedProjectRoot, registeredSessionId);
      fireAndForget(
        'cleanup-board',
        cleanupSessionKanbanBoard(attachedProjectRoot, registeredSessionId),
      );
    }
    registeredSessionId = currentSessionId;
    if (registeredSessionId) {
      retainActiveSessionBoard(attachedProjectRoot, registeredSessionId);
    }
  };
  syncActiveSessionRegistration();

  let watcher: FSWatcher | null = null;
  let watchedDir = '';
  let timer: NodeJS.Timeout | null = null;
  let unsubscribeBoardEvents: (() => void) | null = null;
  let watchedBoardId = '';
  let boardTimer: NodeJS.Timeout | null = null;
  let presenceTimer: NodeJS.Timeout | null = null;

  const sessionId = () => context.session?.id ?? '';
  const activeManagedBoardId = () => {
    const metaKanban = context.meta['kanban'];
    const metaBoardId =
      metaKanban && typeof metaKanban === 'object'
        ? (metaKanban as Record<string, unknown>)['boardId']
        : undefined;
    return (
      context.currentKanbanBoardId ??
      (typeof metaBoardId === 'string' && metaBoardId ? metaBoardId : '')
    );
  };
  const refreshFiles = async () => {
    const id = sessionId();
    if (!id) return;
    const planPath = context.meta['plan.path'];
    if (typeof planPath === 'string' && planPath) {
      const plan = await loadPlan(planPath);
      if (plan) await projectSessionPlanToKanban(context.projectRoot, plan.items, id);
    }
    const taskPath = context.meta['task.path'];
    if (typeof taskPath === 'string' && taskPath) {
      const tasks = await loadTasks(taskPath);
      if (tasks) await projectSessionTasksToKanban(context.projectRoot, tasks.tasks, id);
    }
  };

  const refreshBoard = async () => {
    if (!watchedBoardId) return;
    const board = await getBoard(context.projectRoot, watchedBoardId);
    if (!board) return;
    if (board.lifecycle?.mode === 'managed') applyManagedKanbanBoardToTodos(context, board);
    else applySessionKanbanBoardToTodos(context, board);
  };

  const configureBoardWatcher = async () => {
    const id = sessionId();
    const managedBoardId = activeManagedBoardId();
    const board = managedBoardId
      ? await getBoard(context.projectRoot, managedBoardId)
      : id
        ? await ensureSessionKanbanBoard(context.projectRoot, id)
        : null;
    if (!board) return;
    if (board.id === watchedBoardId) {
      await refreshBoard();
      return;
    }
    unsubscribeBoardEvents?.();
    unsubscribeBoardEvents = null;
    watchedBoardId = board.id;
    try {
      unsubscribeBoardEvents = bridgeKanbanSupervisor(
        context.projectRoot,
        (event) => {
          const data = event.data as { boardId?: string } | undefined;
          if (data?.boardId !== board.id) return;
          if (boardTimer) clearTimeout(boardTimer);
          boardTimer = setTimeout(() => fireAndForget('refresh-board', refreshBoard()), 60);
        },
        { autoReconnect: true, reconnectDelayMs: 1_000 },
      );
      const touchPresence = () =>
        touchKanbanPresence(context.projectRoot, board.id, {
          sessionId: id,
          agentId: context.agentId,
          agentName: context.agentName,
        });
      fireAndForget('touch-presence', touchPresence());
      if (presenceTimer) clearInterval(presenceTimer);
      presenceTimer = setInterval(() => fireAndForget('touch-presence', touchPresence()), 60_000);
      presenceTimer.unref?.();
      // Managed boards are authoritative immediately. Session boards were
      // already hydrated from the local checkpoint above; applying their
      // initially empty board here can erase a newer local todo update before
      // its queued mirror reaches disk.
      if (board.lifecycle?.mode === 'managed') applyManagedKanbanBoardToTodos(context, board);
    } catch {
      unsubscribeBoardEvents = null;
      watchedBoardId = '';
    }
  };

  const configureWatcher = () => {
    const planPath = context.meta['plan.path'];
    const taskPath = context.meta['task.path'];
    const candidate =
      typeof planPath === 'string' && planPath
        ? dirname(planPath)
        : typeof taskPath === 'string' && taskPath
          ? dirname(taskPath)
          : '';
    if (!candidate || candidate === watchedDir) return;
    watcher?.close();
    watcher = null;
    watchedDir = candidate;
    try {
      watcher = watch(candidate, { persistent: false }, (_event, filename) => {
        const name = filename?.toString();
        const currentPlanPath = context.meta['plan.path'];
        const currentTaskPath = context.meta['task.path'];
        const planName = typeof currentPlanPath === 'string' ? basename(currentPlanPath) : '';
        const taskName = typeof currentTaskPath === 'string' ? basename(currentTaskPath) : '';
        if (name && name !== planName && name !== taskName) return;
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fireAndForget('refresh-files', refreshFiles()), 60);
      });
      watcher.on('error', () => watcher?.close());
    } catch {
      // The session directory can briefly disappear during project/session
      // switches; the next meta update re-attempts the binding.
      watcher = null;
      watchedDir = '';
    }
  };

  const unsubscribe = context.state.onChange((change) => {
    if (change.kind === 'todos_replaced' && !suppressedTodoMirrors.has(context)) {
      const snapshot = change.completedSnapshot ?? change.todos;
      // Mirror only the rows that are NOT already cards on the board this
      // session is working on.
      //
      // This used to be all-or-nothing: the mirror was skipped only when EVERY
      // row was already bound. One unbound row — a todo the model added to the
      // chat list without also filing a card — sent the whole list to a
      // separate session board, so work already tracked on the real board
      // appeared a second time there. That is the "some of these tasks are
      // also on another board" symptom, and a single stray row is likewise how
      // a session board ends up holding exactly one card.
      const unbound = todosNeedingSessionMirror(snapshot, activeManagedBoardId());
      if (snapshot.length > 0 && unbound.length === 0) return;
      // ConversationState auto-clears an all-done tactical list. Project the
      // pre-clear completion snapshot so every card reaches Done atomically.
      mirrorSessionTodosToKanban(context.projectRoot, unbound, sessionId());
      return;
    }
    if (
      change.kind === 'meta_set' &&
      (change.key === 'plan.path' || change.key === 'task.path' || change.key === 'kanban')
    ) {
      syncActiveSessionRegistration();
      configureWatcher();
      if (!activeManagedBoardId()) {
        fireAndForget('ensure-board', ensureSessionKanbanBoard(context.projectRoot, sessionId()));
      }
      fireAndForget('configure-watcher', configureBoardWatcher());
      fireAndForget('refresh-board', refreshBoard());
      fireAndForget('refresh-files', refreshFiles());
    }
  });

  configureWatcher();
  fireAndForget('configure-watcher', configureBoardWatcher());

  const detach = () => {
    unsubscribe();
    if (timer) clearTimeout(timer);
    if (boardTimer) clearTimeout(boardTimer);
    if (presenceTimer) clearInterval(presenceTimer);
    watcher?.close();
    unsubscribeBoardEvents?.();
    bindings.delete(context);
    if (attachedProjectRoot && registeredSessionId) {
      releaseActiveSessionBoard(attachedProjectRoot, registeredSessionId);
      fireAndForget(
        'cleanup-board',
        cleanupSessionKanbanBoard(attachedProjectRoot, registeredSessionId),
      );
      registeredSessionId = '';
    }
  };
  bindings.set(context, detach);
  return detach;
}

/** Fully hydrate a session board before a host announces the session as ready. */
/**
 * Re-bind the card this session was working, after a restart or `--resume`.
 *
 * The binding produced by `start_task` lives in `ctx.meta.kanban`, which is
 * conversation state — nothing restores it. So a resumed session came back
 * with `currentKanbanTaskId` undefined while its card still sat in Running on
 * the board: file events lost their task attribution, and under
 * `tools.kanbanGovernance` the run was un-bound until the model happened to
 * call `start_task` again.
 *
 * Board presence is the durable anchor. It is keyed `<sessionId>:<agentId>`,
 * carries the `taskId`, and is stored on the board record itself, so it
 * survives the restart even though its derived `active` flag does not (the TTL
 * is two minutes). Matching it against the cards that are actually still
 * running gives an unambiguous answer without guessing from free-text agent
 * ids.
 *
 * Deliberately conservative — it prefers to do nothing over binding the wrong
 * card:
 * - never overrides a binding this process already has;
 * - only considers cards whose assignment is still `running`;
 * - skips an expired lease, because `recover_stale` may have reassigned that
 *   card to another worker;
 * - picks the most recently seen entry when a session touched several.
 *
 * Session mirrors and archived boards are excluded by the snapshot's default
 * board-kind filter, which is correct: `start_task` never targets them.
 */
export async function rebindSessionKanbanTask(
  context: Context,
): Promise<{ boardId: string; taskId: string } | null> {
  const sessionId = context.session?.id;
  if (!sessionId || !context.projectRoot) return null;
  // A live binding always wins: this runs at session start, but `start_task`
  // may already have bound a card in the same boot.
  if (context.currentKanbanTaskId) return null;

  let best: { boardId: string; taskId: string; lastSeenAt: string } | undefined;
  try {
    const snapshot = await getKanbanOrchestrationSnapshot(context.projectRoot);
    const nowMs = Date.now();
    for (const result of snapshot.running) {
      const assignment = result.task.assignment;
      if (assignment?.status !== 'running') continue;
      const expiresAt = assignment.leaseExpiresAt
        ? Date.parse(assignment.leaseExpiresAt)
        : Number.NaN;
      if (Number.isFinite(expiresAt) && expiresAt <= nowMs) continue;
      const entry = result.board.presence?.find(
        (candidate) => candidate.sessionId === sessionId && candidate.taskId === result.task.id,
      );
      if (!entry) continue;
      if (!best || entry.lastSeenAt > best.lastSeenAt) {
        best = { boardId: result.board.id, taskId: result.task.id, lastSeenAt: entry.lastSeenAt };
      }
    }
  } catch {
    // Best-effort: a Kanban daemon that is down must not stop a session from
    // becoming ready. The model can still call start_task itself.
    return null;
  }
  if (!best) return null;
  context.setCurrentKanbanTask(best.taskId, best.boardId);
  return { boardId: best.boardId, taskId: best.taskId };
}

export async function hydrateSessionKanban(context: Context): Promise<KanbanBoard | null> {
  const id = context.session?.id ?? '';
  if (!id) return null;
  // Before anything else: a resumed session should know which card it is on.
  // Independent of the session-mirror work below — the card is almost always
  // on a project board, not on the mirror.
  await rebindSessionKanbanTask(context);
  await cleanupEmptySessionKanbanBoards(context.projectRoot, id);
  // Board-level retention had no production caller at all: every session mirror
  // was created with a 7-day `archive_after_ttl` policy that nothing ever
  // enforced, so expired boards accumulated indefinitely. Session start is the
  // one moment every surface passes through. Detached on purpose — it sweeps
  // every board in the project and must not delay the session becoming ready.
  if (context.projectRoot) {
    fireAndForget('prune-session-boards', pruneSessionBoards(context.projectRoot));
  }
  let board = await ensureSessionKanbanBoard(context.projectRoot, id);
  if (context.todos.length) {
    board = await projectSessionTodosToKanban(context.projectRoot, context.todos, id);
  }
  const planPath = context.meta['plan.path'];
  if (typeof planPath === 'string' && planPath) {
    const plan = await loadPlan(planPath);
    if (plan) board = await projectSessionPlanToKanban(context.projectRoot, plan.items, id);
  }
  const taskPath = context.meta['task.path'];
  if (typeof taskPath === 'string' && taskPath) {
    const tasks = await loadTasks(taskPath);
    if (tasks) board = await projectSessionTasksToKanban(context.projectRoot, tasks.tasks, id);
  }
  return board;
}

export interface SessionKanbanSourceUpdate {
  source: 'todo' | 'task' | 'plan' | null;
  todos?: TodoItem[] | undefined;
  tasks?: TaskFile | undefined;
  plan?: PlanFile | undefined;
}

function sourceStatus(task: KanbanTask): TaskStatus {
  if (task.status === 'completed') return 'completed';
  if (task.status === 'in_progress') return 'in_progress';
  if (task.status === 'review') return 'review';
  if (task.status === 'blocked') return 'blocked';
  if (task.status === 'failed') return 'failed';
  return 'pending';
}

/**
 * Collapse the card statuses onto the three-state todo surface.
 *
 * `review` maps to `in_progress`: a card in Preview is work underway awaiting
 * acceptance, not unstarted work. The managed projection used to call it
 * `pending`, which both misreported the card and left the run with no
 * in-progress row — and with no in-progress row the governed task binding is
 * cleared, which blocks every subsequent product mutation.
 */
function todoStatus(task: KanbanTask): TodoItem['status'] {
  const status = sourceStatus(task);
  if (status === 'completed') return 'completed';
  if (status === 'in_progress' || status === 'review') return 'in_progress';
  return 'pending';
}

/**
 * Shape a card as a todo row without claiming a managed binding.
 *
 * `kanbanBoardId`/`kanbanTaskId` are the contract for "this row IS a real
 * managed card": every surface treats a row carrying them as read-only and
 * refuses local edits. An observational session mirror offers no such
 * authority — stamping its ids made `/todos add|clear|remove` and the WebUI
 * worklist reject edits against a board that only reflects them back.
 */
function sessionTodoFromTask(task: KanbanTask, board?: KanbanBoard): TodoItem {
  const blockedBy = board ? blockingTitles(board, task) : [];
  return {
    id: task.origin?.taskId ?? task.id,
    content: task.title,
    status: todoStatus(task),
    ...(task.description ? { activeForm: task.description } : {}),
    ...(blockedBy.length ? { blockedBy } : {}),
  };
}

function managedTodoFromTask(task: KanbanTask, board: KanbanBoard): TodoItem {
  return {
    ...sessionTodoFromTask(task, board),
    kanbanBoardId: board.id,
    kanbanTaskId: task.id,
  };
}

/**
 * Human-readable titles of the unfinished dependencies blocking a card.
 *
 * The board recomputes readiness on every mutation; this only carries the
 * result to the todo surface. Titles rather than ids, because the row is read
 * by a model and a human, neither of whom can resolve a raw card id.
 */
export function blockingTitles(board: KanbanBoard, task: KanbanTask): string[] {
  return getDependencyReadinessIssues(board, task).map((issue) => {
    const dependency = board.tasks.find((candidate) => candidate.id === issue.dependencyId);
    if (!dependency) return `${issue.dependencyId} (missing)`;
    return dependency.title;
  });
}

const PRIORITY_ORDER: Readonly<Record<string, number>> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/**
 * Order cards the way they must actually be worked: dependencies first, then
 * priority, then the board's own column/manual order.
 *
 * The managed projection previously sorted by `createdAt` — the moment a card
 * happened to be created — which is unrelated to execution order, so the list
 * the model reads top-to-bottom was not a plan. A dependency-respecting
 * (Kahn) order makes the visible sequence the executable sequence; ties fall
 * back to the deterministic board order so the list never reshuffles on its
 * own. Any card left over by a dependency cycle is appended rather than
 * dropped — the board rejects cycles, but a projection must never lose work.
 */
export function orderTasksForTodos(board: KanbanBoard, tasks: readonly KanbanTask[]): KanbanTask[] {
  const columnOrder = new Map(board.columns.map((column) => [column.id, column.order]));
  const baseline = [...tasks].sort(
    (left, right) =>
      (columnOrder.get(left.columnId) ?? 0) - (columnOrder.get(right.columnId) ?? 0) ||
      (PRIORITY_ORDER[left.priority] ?? 2) - (PRIORITY_ORDER[right.priority] ?? 2) ||
      left.order - right.order ||
      left.createdAt.localeCompare(right.createdAt) ||
      left.id.localeCompare(right.id),
  );

  const included = new Set(baseline.map((task) => task.id));
  const remaining = new Map(baseline.map((task) => [task.id, task]));
  const emitted: KanbanTask[] = [];
  const done = new Set<string>();

  while (remaining.size > 0) {
    // `baseline` order is preserved inside each ready wave, so equal-depth
    // work keeps the board's own priority/column sequence.
    const ready = baseline.filter(
      (task) =>
        remaining.has(task.id) &&
        (task.dependsOn ?? []).every(
          (dependencyId) => !included.has(dependencyId) || done.has(dependencyId),
        ),
    );
    if (ready.length === 0) break;
    for (const task of ready) {
      remaining.delete(task.id);
      done.add(task.id);
      emitted.push(task);
    }
  }
  for (const task of baseline) if (remaining.has(task.id)) emitted.push(task);
  return emitted;
}

function sameTodos(left: readonly TodoItem[], right: readonly TodoItem[]): boolean {
  return (
    left.length === right.length &&
    left.every((todo, index) => {
      const candidate = right[index];
      return (
        candidate?.id === todo.id &&
        candidate.content === todo.content &&
        candidate.status === todo.status &&
        candidate.activeForm === todo.activeForm &&
        candidate.promotedFromPlan === todo.promotedFromPlan &&
        candidate.promotedFromTask === todo.promotedFromTask &&
        candidate.kanbanBoardId === todo.kanbanBoardId &&
        candidate.kanbanTaskId === todo.kanbanTaskId &&
        // Readiness is part of the projection: when a dependency completes,
        // the rows are otherwise identical and the unblocking would never
        // reach the model.
        (candidate.blockedBy ?? []).join('\u0000') === (todo.blockedBy ?? []).join('\u0000')
      );
    })
  );
}

/**
 * Replace the tactical todo list from the current cards on a session-owned board.
 *
 * Existing mirrored todo cards retain their stable source ids. New cards created
 * by a Kanban worker become todos under their card ids, so reassessment can add,
 * split, merge, reprioritize, or remove work without being overwritten by the
 * todo list that happened to exist when the run started.
 */
export function applySessionKanbanBoardToTodos(context: Context, board: KanbanBoard): TodoItem[] {
  const sessionId = context.session?.id ?? '';
  if (
    !sessionId ||
    sessionIdFromTags(board.tags) !== sessionId ||
    !isOwnedSessionBoard(board.tags)
  ) {
    return [...context.todos];
  }
  // A queued or in-flight projection means this board snapshot is provably
  // older than the local list that produced it. Board events are debounced,
  // so without this the mirror's own echo could land after a newer local
  // update and roll it back — a lost update the user sees as the todo list
  // reverting on its own.
  if (hasInFlightTodoMirror(context.projectRoot, sessionId)) return [...context.todos];

  const projectedTodos = orderTasksForTodos(
    board,
    board.tasks.filter(
      (task) =>
        task.status !== 'archived' &&
        (!task.origin ||
          task.origin.system === 'session-todo' ||
          (task.origin.graphId ?? '').startsWith('todo:')),
    ),
  ).map((task) => sessionTodoFromTask(task, board));

  const allCompleted =
    projectedTodos.length > 0 && projectedTodos.every((todo) => todo.status === 'completed');
  const effectiveTodos = allCompleted ? [] : projectedTodos;
  if (sameTodos(context.todos, effectiveTodos)) return [...context.todos];
  suppressedTodoMirrors.add(context);
  try {
    context.state.replaceTodos(projectedTodos);
  } finally {
    suppressedTodoMirrors.delete(context);
  }
  notifyTodoUpdate(context, context.todos);
  broadcastTodoUpdate(context, context.todos);
  return [...context.todos];
}

/** Project a durable managed board into the session's compact todo surface. */
export function applyManagedKanbanBoardToTodos(context: Context, board: KanbanBoard): TodoItem[] {
  const metaKanban = context.meta['kanban'];
  const metaBoardId =
    metaKanban && typeof metaKanban === 'object'
      ? (metaKanban as Record<string, unknown>)['boardId']
      : undefined;
  const activeBoardId =
    context.currentKanbanBoardId ?? (typeof metaBoardId === 'string' ? metaBoardId : undefined);
  if (!activeBoardId || board.id !== activeBoardId || board.lifecycle?.mode !== 'managed') {
    return [...context.todos];
  }

  const projectedTodos = orderTasksForTodos(
    board,
    board.tasks.filter(
      (task) =>
        task.status !== 'archived' &&
        task.mergedIntoTaskId === undefined &&
        (!task.childTaskIds || task.childTaskIds.length === 0),
    ),
  ).map((task) => managedTodoFromTask(task, board));

  if (sameTodos(context.todos, projectedTodos)) return [...context.todos];
  suppressedTodoMirrors.add(context);
  try {
    context.state.replaceTodos(projectedTodos);
  } finally {
    suppressedTodoMirrors.delete(context);
  }
  notifyTodoUpdate(context, context.todos);
  broadcastTodoUpdate(context, context.todos);
  return [...context.todos];
}

/** Reflect a TUI/WebUI Kanban card edit back to its originating work list. */
export async function applySessionKanbanTaskToSource(
  context: Context,
  task: KanbanTask,
  options: { remove?: boolean | undefined } = {},
): Promise<SessionKanbanSourceUpdate> {
  const originId = task.origin?.taskId;
  const graphId = task.origin?.graphId ?? '';
  if (!originId) return { source: null };

  if (task.origin?.system === 'session-todo' || graphId.startsWith('todo:')) {
    const next = options.remove
      ? context.todos.filter((todo) => todo.id !== originId)
      : context.todos.map((todo) =>
          todo.id === originId
            ? {
                ...todo,
                content: task.title,
                status:
                  sourceStatus(task) === 'completed'
                    ? ('completed' as const)
                    : sourceStatus(task) === 'in_progress' || sourceStatus(task) === 'review'
                      ? ('in_progress' as const)
                      : ('pending' as const),
              }
            : todo,
        );
    suppressedTodoMirrors.add(context);
    try {
      context.state.replaceTodos(next);
    } finally {
      suppressedTodoMirrors.delete(context);
    }
    return { source: 'todo', todos: [...context.todos] };
  }

  const id = context.session?.id ?? '';
  if (task.origin?.system === 'session-plan' || graphId.startsWith('plan:')) {
    const planPath = context.meta['plan.path'];
    if (typeof planPath !== 'string' || !planPath) {
      // A plan-origin card with no plan.path means the board and the plan
      // file would silently diverge: the board mutation already succeeded
      // above, but there is nowhere to write the reflection back to. Throw
      // so callers (TUI syncSource, WebUI syncSessionSource) can surface the
      // mismatch instead of reporting a silent success.
      throw new Error(
        'Cannot reflect this Kanban edit back to its plan source: the session has no plan.path configured. ' +
          'The board mutation already succeeded; the plan file is now out of sync.',
      );
    }
    const plan = await mutatePlan(planPath, id, (file) => ({
      ...file,
      updatedAt: new Date().toISOString(),
      items: options.remove
        ? file.items.filter((item) => item.id !== originId)
        : file.items.map((item) =>
            item.id === originId
              ? {
                  ...item,
                  title: task.title,
                  details: task.description,
                  status:
                    task.status === 'completed'
                      ? ('done' as const)
                      : task.status === 'in_progress' || task.status === 'review'
                        ? ('in_progress' as const)
                        : ('open' as const),
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
    }));
    return { source: 'plan', plan };
  }

  if (
    task.origin?.system === 'session-task' ||
    task.origin?.system === 'session' ||
    graphId.startsWith('session:')
  ) {
    const taskPath = context.meta['task.path'];
    if (typeof taskPath !== 'string' || !taskPath) {
      // Same rationale as the plan branch: a task-origin card with no
      // task.path would leave the board and the task file silently out of
      // sync. Throw so the caller can tell the user.
      throw new Error(
        'Cannot reflect this Kanban edit back to its task source: the session has no task.path configured. ' +
          'The board mutation already succeeded; the task file is now out of sync.',
      );
    }
    const tasks = await mutateTasks(taskPath, id, (file) => ({
      ...file,
      tasks: options.remove
        ? file.tasks.filter((item) => item.id !== originId)
        : file.tasks.map((item) =>
            item.id === originId
              ? {
                  ...item,
                  title: task.title,
                  description: task.description,
                  status: sourceStatus(task),
                  updatedAt: new Date().toISOString(),
                }
              : item,
          ),
    }));
    return { source: 'task', tasks };
  }

  return { source: null };
}
