/**
 * ServerKanbanStore — facade for tool code that prefers the IPC daemon
 * and falls back to direct file-backed storage when the server is
 * unavailable or disabled.
 *
 * Per the project memory:
 *   - The kanban domain is intentionally provider- and LLM-free
 *   - Server-backed stores should wrap `FileKanbanStore` rather than fork
 *     validation/persistence logic
 *   - A `kanban.mode` of `auto|server|file` lets direct-file clients and
 *     the server coexist safely without per-project daemons
 */
import * as storage from '../storage.js';
import * as kanban from '../manager.js';
import {
  getKanbanServerConnection,
  type KanbanServerMethod,
} from './client.js';

type Mode = 'auto' | 'server' | 'file';

function resolveMode(): Mode {
  const env = process.env['WRONGSTACK_KANBAN_MODE'];
  if (env === 'server' || env === 'file') return env;
  return 'auto';
}

export class ServerKanbanStore {
  constructor(public readonly projectRoot: string) {
    // The kanban.mode env var (auto|server|file) is resolved lazily in the
    // per-call `useServer` branch when per-action routing through the
    // daemon is wired up. Today the facade calls direct file-backed
    // functions; the infrastructure (client.ts, project-server.ts) is in
    // place to support routing without changing every call site.
    void resolveMode();
  }

  // ─── Board operations ────────────────────────────────────────────────────

  listBoards() {
    return this.call('listBoards', {}, () => kanban.listBoards(this.projectRoot));
  }
  getBoard(boardId: string) {
    return this.call('getBoard', { boardId }, () => kanban.getBoard(this.projectRoot, boardId));
  }
  createBoard(input: any) {
    return this.call('createBoard', input, () => kanban.createBoard(this.projectRoot, input));
  }
  updateBoard(boardId: string, patch: any) {
    return this.call('updateBoard', { boardId, ...patch }, () => kanban.updateBoard(this.projectRoot, boardId, patch));
  }
  duplicateBoard(boardId: string, options: any) {
    return this.call('duplicateBoard', { boardId, options }, () => kanban.duplicateBoard(projectRoot_safe(this), boardId, options));
  }
  removeBoard(boardId: string) {
    return this.call('deleteBoard', { boardId }, () => kanban.removeBoard(this.projectRoot, boardId));
  }
  addColumn(boardId: string, input: any) {
    return this.call('addColumn', { boardId, ...input }, () => kanban.addColumn(this.projectRoot, boardId, input));
  }
  updateColumn(boardId: string, columnId: string, patch: any) {
    return this.call('updateColumn', { boardId, columnId, ...patch }, () => (kanban as any).updateColumn(this.projectRoot, boardId, columnId, patch));
  }
  removeColumn(boardId: string, columnId: string) {
    return this.call('deleteColumn', { boardId, columnId }, () => (kanban as any).removeColumn(this.projectRoot, boardId, columnId));
  }

  // ─── Task operations ────────────────────────────────────────────────────

  addTask(boardId: string, input: any) {
    return this.call('addTask', { boardId, ...input }, () => kanban.addTask(this.projectRoot, boardId, input));
  }
  updateTask(boardId: string, taskId: string, patch: any) {
    return this.call('updateTask', { boardId, taskId, ...patch }, () => kanban.updateTask(this.projectRoot, boardId, taskId, patch));
  }
  moveTask(boardId: string, taskId: string, targetColumnId: string, order?: number) {
    return this.call('moveTask', { boardId, taskId, targetColumnId, order }, () => kanban.moveTask(this.projectRoot, boardId, taskId, targetColumnId, order));
  }
  deleteTask(boardId: string, taskId: string) {
    const fn = (kanban as any).deleteTask ?? (kanban as any).removeTask;
    return this.call('deleteTask', { boardId, taskId }, () => fn(this.projectRoot, boardId, taskId));
  }
  getTask(boardId: string, taskId: string) {
    return this.call('getTask', { boardId, taskId }, () => kanban.getTask(this.projectRoot, boardId, taskId));
  }
  copyTask(boardId: string, taskId: string, targetBoardId: string, options?: any) {
    return this.call('copyTask', { boardId, taskId, targetBoardId, options }, () => kanban.copyTaskToBoard(this.projectRoot, boardId, taskId, targetBoardId, (options ?? {}) as any));
  }
  transferTask(boardId: string, taskId: string, targetBoardId: string, targetColumnId?: string) {
    return this.call(
      'transferTask',
      { boardId, taskId, targetBoardId, targetColumnId },
      () => kanban.transferTaskToBoard(this.projectRoot, boardId, taskId, targetBoardId, { targetColumnId } as any),
    );
  }

  // ─── Lifecycle / orchestration ──────────────────────────────────────────

  transitionTask(boardId: string, taskId: string, input: any) {
    return this.call('transitionTask', { boardId, taskId, ...input }, () => kanban.transitionTask(this.projectRoot, boardId, taskId, input));
  }
  adoptManagedLifecycle(boardId: string, taskId: string, input: any) {
    return this.call('adoptManagedLifecycle', { boardId, taskId, ...input }, () => kanban.adoptManagedLifecycle(this.projectRoot, boardId, input));
  }
  repairManagedProjection(boardId: string, taskId: string, input: any) {
    return this.call('repairManagedProjection', { boardId, taskId, ...input }, () => kanban.repairManagedTaskProjection(this.projectRoot, boardId, taskId, input));
  }
  claimReadyTask(input: any) {
    return this.call('claimTask', input, () => kanban.claimReadyTask(this.projectRoot, input));
  }
  releaseTaskClaim(boardId: string, taskId: string) {
    return this.call('releaseTask', { boardId, taskId }, () => kanban.releaseTaskClaim(this.projectRoot, boardId, taskId));
  }
  assignTask(boardId: string, taskId: string, input: any, eventContext: any = {}) {
    return this.call('assignTask', { boardId, taskId, input, eventContext }, () =>
      kanban.assignTask(this.projectRoot, boardId, taskId, input, eventContext),
    );
  }
  updateTaskAssignment(boardId: string, taskId: string, patch: any, eventContext: any = {}) {
    return this.call(
      'updateTaskAssignment',
      { boardId, taskId, patch, eventContext },
      () => kanban.updateTaskAssignment(this.projectRoot, boardId, taskId, patch, eventContext),
    );
  }
  finalizeTaskCompletion(boardId: string, taskId: string, options: any = {}) {
    return this.call(
      'finalizeTaskCompletion',
      { boardId, taskId, options },
      () => kanban.finalizeTaskCompletion(this.projectRoot, boardId, taskId, options),
    );
  }
  heartbeatTaskAssignment(boardId: string, taskId: string, input: any) {
    return this.call('heartbeatAssignment', { boardId, taskId, ...input }, () => kanban.heartbeatTaskAssignment(this.projectRoot, boardId, taskId, input));
  }
  recoverStaleTaskAssignments(input: any) {
    return this.call('recoverStaleTaskAssignments', { boardId: input?.boardId }, () => kanban.recoverStaleTaskAssignments(this.projectRoot, input));
  }
  getKanbanOrchestrationSnapshot(input: any) {
    return this.call('getKanbanOrchestrationSnapshot', input, () => kanban.getKanbanOrchestrationSnapshot(this.projectRoot, input));
  }
  reconcileBoard(boardId: string) {
    return this.call('reconcileBoard', { boardId }, () => kanban.reconcileKanbanBoard(this.projectRoot, boardId));
  }

  // ─── Chains ─────────────────────────────────────────────────────────────

  setChain(
    boardId: string,
    taskIds: string[],
    options: { chainId?: string; enforceDependencies?: boolean } = {},
  ) {
    return this.call('setChain', { boardId, taskIds, ...options }, () =>
      kanban.setTaskChain(this.projectRoot, boardId, { taskIds, ...options }),
    );
  }
  getChain(boardId: string, opts: { taskId?: string; chainId?: string }) {
    return this.call('getChain', { boardId, ...opts }, () =>
      kanban.getTaskChain(this.projectRoot, boardId, opts.chainId ?? opts.taskId ?? ''),
    );
  }

  verifyTaskCompletion(
    boardId: string,
    taskId: string,
    options: { persist?: boolean } = {},
  ) {
    return this.call('verifyTaskCompletion', { boardId, taskId, ...options }, () =>
      kanban.verifyTaskCompletion(this.projectRoot, boardId, taskId, options),
    );
  }

  // ─── Search / export / import ───────────────────────────────────────────

  searchTasks(input: any) {
    return this.call('searchTasks', input, () => kanban.searchKanban(this.projectRoot, input));
  }
  listReadyTasks(input: any) {
    return this.call('readyTasks', input, () => kanban.listReadyTasks(this.projectRoot, input));
  }
  exportMarkdown(boardId: string) {
    return this.call('exportMarkdown', { boardId }, () => (kanban as any).exportBoardToMarkdown(this.projectRoot, boardId));
  }
  exportTaskGraph(boardId: string) {
    return this.call('exportTaskGraph', { boardId }, () => (kanban as any).exportBoardToTaskGraph(this.projectRoot, boardId));
  }
  syncTaskGraph(boardId: string, taskGraph: any) {
    return this.call('syncTaskGraph', { boardId, taskGraph: JSON.stringify(taskGraph) }, () => (kanban as any).syncTaskGraphToBoard(this.projectRoot, boardId, taskGraph));
  }
  createFromGraph(taskGraph: any, options: any) {
    return this.call('createFromGraph', { taskGraph: JSON.stringify(taskGraph), boardTitle: options?.boardTitle }, () => (kanban as any).createBoardFromTaskGraph(this.projectRoot, taskGraph, options));
  }
  mirrorSessionTasks(options: any) {
    return this.call('importSessionTasks', options, () => (kanban as any).mirrorSessionTasksToBoard(this.projectRoot, options));
  }

  // ─── Atomicity ──────────────────────────────────────────────────────────

  assessTaskAtomicity(boardId: string, taskId: string) {
    return this.call('assessAtomicity', { boardId, taskId }, () => kanban.assessTaskAtomicity(this.projectRoot, boardId, taskId));
  }

  // ─── Storage direct (rarely needed by tools) ───────────────────────────

  readBoard(boardId: string) {
    return storage.readBoard(this.projectRoot, boardId);
  }
  listBoardIds() {
    return storage.listBoardIds(this.projectRoot);
  }

  // ─── Internal: prefer server, fallback to direct call ──────────────────

  private async call<T>(
    method: KanbanServerMethod,
    params: any,
    direct: () => Promise<T> | T,
  ): Promise<any> {
    const mode = resolveMode();
    if (mode === 'file') return direct();

    let connection;
    try {
      connection = await getKanbanServerConnection(this.projectRoot);
    } catch (error) {
      if (mode === 'server') throw error;
      return direct();
    }

    if (!connection) {
      if (mode === 'server') {
        throw new Error('Kanban server unavailable (mode=server)');
      }
      return direct();
    }

    // Once a request reaches a daemon, never replay it against the file store:
    // a lost response may still mean the mutation committed server-side.
    return connection.request(method, params);
  }
}

function projectRoot_safe(store: ServerKanbanStore): string {
  return store.projectRoot;
}

/**
 * Bounded LRU of per-project stores.
 *
 * This was a plain module-scope `Map` that was never evicted, so a long-lived
 * host (webui-server, HQ) accumulated one store per project root it ever
 * touched — including every temp directory created by a test run. Mirrors the
 * 8-project caps in webui-server's `chronicle-routes.ts` and `mailbox-handlers.ts`.
 */
const MAX_CACHED_STORES = 8;
const stores = new Map<string, ServerKanbanStore>();

export function getServerKanbanStore(projectRoot: string): ServerKanbanStore {
  let s = stores.get(projectRoot);
  if (s) {
    // Refresh recency: Map preserves insertion order, so re-inserting moves
    // this key to the most-recent end.
    stores.delete(projectRoot);
    stores.set(projectRoot, s);
    return s;
  }
  s = new ServerKanbanStore(projectRoot);
  stores.set(projectRoot, s);
  while (stores.size > MAX_CACHED_STORES) {
    const oldest = stores.keys().next().value;
    if (oldest === undefined) break;
    stores.delete(oldest);
  }
  return s;
}

export { getKanbanServerConnection, isKanbanServerAvailable } from './client.js';
export { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from './protocol.js';
