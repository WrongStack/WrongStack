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
  assignTask(boardId: string, taskId: string, input: any) {
    return this.call('assignTask', { boardId, taskId, ...input }, () => kanban.assignTask(this.projectRoot, boardId, taskId, input));
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

  // ─── Chains (currently accessed via kanban's internal API; server
  //          routing for these is a follow-up) ─────────────────────────────

  setChain(boardId: string, taskIds: string[]) {
    return this.call('setChain', { boardId, taskIds }, () => (kanban as any).setChainMetadata?.(this.projectRoot, boardId, taskIds));
  }
  getChain(boardId: string, opts: { taskId?: string; chainId?: string }) {
    return this.call('getChain', { boardId, ...opts }, async () => {
      const board = await storage.readBoard(this.projectRoot, boardId);
      if (!board) return null;
      const chain = (board as any).chains?.[opts.chainId ?? ''] ?? null;
      return chain;
    });
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

  private async call<T>(_method: string, _params: any, direct: () => Promise<T> | T): Promise<T> {
    // The server facade is currently opt-in. The kanban tool's existing
    // execute() function dispatches actions to direct storage functions;
    // routing every call through the daemon would require touching all
    // call sites. Tools that need cross-process coordination can call
    // `getKanbanServerConnection(projectRoot)` directly and use
    // `connection.request(method, params)`.
    //
    // The infrastructure is in place; per-action routing is a follow-up.
    // `_method` and `_params` are kept in the signature so the call sites
    // remain self-documenting and the per-action router can be slotted in
    // without changing every call shape.
    void _method;
    void _params;
    return direct();
  }
}

function projectRoot_safe(store: ServerKanbanStore): string {
  return store.projectRoot;
}

const stores = new Map<string, ServerKanbanStore>();
export function getServerKanbanStore(projectRoot: string): ServerKanbanStore {
  let s = stores.get(projectRoot);
  if (!s) {
    s = new ServerKanbanStore(projectRoot);
    stores.set(projectRoot, s);
  }
  return s;
}

export { getKanbanServerConnection, isKanbanServerAvailable } from './client.js';
export { KANBAN_PROJECT_SERVER_PROTOCOL_VERSION } from './protocol.js';