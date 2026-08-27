/**
 * ServerKanbanStore — facade for tool code that routes through the
 * project-scoped IPC daemon.
 *
 * Per the project memory:
 *   - The kanban domain is intentionally provider- and LLM-free
 *   - Production is fail-closed and never opens board files directly.
 *   - A disabled or unreachable daemon is an error for every client.
 */
import type * as DomainApi from '../client-domain.js';
import type { KanbanDomainOperation } from '../domain-operations.js';
import { getKanbanServerConnection } from './client.js';
import {
  decodeKanbanDomainValue,
  encodeKanbanDomainValue,
  type KanbanServerMethod,
  type KanbanServerOperations,
} from './protocol.js';

type DomainModule = typeof DomainApi;
type DomainArgs<K extends KanbanDomainOperation> = DomainModule[K] extends (
  projectRoot: string,
  ...args: infer Args
) => unknown
  ? Args
  : never;
type DomainResult<K extends KanbanDomainOperation> = DomainModule[K] extends (
  ...args: infer _Args
) => infer Result
  ? Awaited<Result>
  : never;

export class ServerKanbanStore {
  constructor(public readonly projectRoot: string) {}

  // ─── Board operations ────────────────────────────────────────────────────

  listBoards() {
    return this.callDomain('listBoards');
  }
  getBoard(boardId: string) {
    return this.callDomain('getBoard', boardId);
  }
  createBoard(input: DomainArgs<'createBoard'>[0]) {
    return this.callDomain('createBoard', input);
  }
  updateBoard(boardId: string, patch: DomainArgs<'updateBoard'>[1]) {
    return this.callDomain('updateBoard', boardId, patch);
  }
  duplicateBoard(boardId: string, options: NonNullable<DomainArgs<'duplicateBoard'>[1]> = {}) {
    return this.callDomain('duplicateBoard', boardId, options);
  }
  removeBoard(boardId: string) {
    return this.callDomain('removeBoard', boardId);
  }

  // ─── Task operations ────────────────────────────────────────────────────

  addTask(
    boardId: string,
    input: DomainArgs<'addTask'>[1],
    eventContext: NonNullable<DomainArgs<'addTask'>[2]>,
  ) {
    return this.callDomain('addTask', boardId, input, eventContext);
  }
  updateTask(
    boardId: string,
    taskId: string,
    patch: DomainArgs<'updateTask'>[2],
    eventContext: NonNullable<DomainArgs<'updateTask'>[3]>,
  ) {
    return this.callDomain('updateTask', boardId, taskId, patch, eventContext);
  }
  moveTask(
    boardId: string,
    taskId: string,
    targetColumnId: string,
    order: number | undefined,
    eventContext: NonNullable<DomainArgs<'moveTask'>[4]>,
  ) {
    return this.callDomain('moveTask', boardId, taskId, targetColumnId, order, eventContext);
  }
  deleteTask(
    boardId: string,
    taskId: string,
    eventContext: NonNullable<DomainArgs<'removeTask'>[2]>,
  ) {
    return this.callDomain('removeTask', boardId, taskId, eventContext);
  }
  getTask(boardId: string, taskId: string) {
    return this.callDomain('getTask', boardId, taskId);
  }
  copyTask(
    boardId: string,
    taskId: string,
    targetBoardId: string,
    options: NonNullable<DomainArgs<'copyTaskToBoard'>[3]>,
  ) {
    return this.callDomain('copyTaskToBoard', boardId, taskId, targetBoardId, options);
  }
  transferTask(
    boardId: string,
    taskId: string,
    targetBoardId: string,
    eventContext: NonNullable<DomainArgs<'transferTaskToBoard'>[3]>['eventContext'],
    targetColumnId?: string,
  ) {
    return this.callDomain('transferTaskToBoard', boardId, taskId, targetBoardId, {
      ...(targetColumnId !== undefined ? { targetColumnId } : {}),
      eventContext,
    });
  }

  // ─── Lifecycle / orchestration ──────────────────────────────────────────

  transitionTask(boardId: string, taskId: string, input: DomainArgs<'transitionTask'>[2]) {
    return this.callDomain('transitionTask', boardId, taskId, input);
  }
  adoptManagedLifecycle(boardId: string, input: DomainArgs<'adoptManagedLifecycle'>[1]) {
    return this.callDomain('adoptManagedLifecycle', boardId, input);
  }
  repairManagedProjection(
    boardId: string,
    taskId: string,
    input: DomainArgs<'repairManagedTaskProjection'>[2],
  ) {
    return this.callDomain('repairManagedTaskProjection', boardId, taskId, input);
  }
  claimReadyTask(
    input: NonNullable<DomainArgs<'claimReadyTask'>[0]>,
    eventContext: NonNullable<DomainArgs<'claimReadyTask'>[1]>,
  ) {
    return this.callDomain('claimReadyTask', input, eventContext);
  }
  releaseTaskClaim(
    boardId: string,
    taskId: string,
    input: NonNullable<DomainArgs<'releaseTaskClaim'>[2]>,
    eventContext: NonNullable<DomainArgs<'releaseTaskClaim'>[3]>,
  ) {
    return this.callDomain('releaseTaskClaim', boardId, taskId, input, eventContext);
  }
  assignTask(
    boardId: string,
    taskId: string,
    input: DomainArgs<'assignTask'>[2],
    eventContext: NonNullable<DomainArgs<'assignTask'>[3]>,
  ) {
    return this.callDomain('assignTask', boardId, taskId, input, eventContext);
  }
  updateTaskAssignment(
    boardId: string,
    taskId: string,
    patch: DomainArgs<'updateTaskAssignment'>[2],
    eventContext: NonNullable<DomainArgs<'updateTaskAssignment'>[3]>,
  ) {
    return this.callDomain('updateTaskAssignment', boardId, taskId, patch, eventContext);
  }
  finalizeTaskCompletion(
    boardId: string,
    taskId: string,
    options: NonNullable<DomainArgs<'finalizeTaskCompletion'>[2]>,
  ) {
    return this.callDomain('finalizeTaskCompletion', boardId, taskId, options);
  }
  reserveKanbanDispatch(input: NonNullable<DomainArgs<'reserveKanbanDispatch'>[0]>) {
    return this.callDomain('reserveKanbanDispatch', input);
  }
  startKanbanDispatch(input: NonNullable<DomainArgs<'startKanbanDispatch'>[0]>) {
    return this.callDomain('startKanbanDispatch', input);
  }
  completeKanbanDispatch(input: NonNullable<DomainArgs<'completeKanbanDispatch'>[0]>) {
    return this.callDomain('completeKanbanDispatch', input);
  }
  failKanbanDispatch(input: NonNullable<DomainArgs<'failKanbanDispatch'>[0]>) {
    return this.callDomain('failKanbanDispatch', input);
  }
  cancelKanbanDispatch(input: NonNullable<DomainArgs<'cancelKanbanDispatch'>[0]>) {
    return this.callDomain('cancelKanbanDispatch', input);
  }
  heartbeatKanbanDispatch(input: NonNullable<DomainArgs<'heartbeatKanbanDispatch'>[0]>) {
    return this.callDomain('heartbeatKanbanDispatch', input);
  }
  pruneSessionBoards(options: NonNullable<DomainArgs<'pruneSessionBoards'>[0]> = {}) {
    return this.callDomain('pruneSessionBoards', options);
  }
  heartbeatTaskAssignment(
    boardId: string,
    taskId: string,
    input: NonNullable<DomainArgs<'heartbeatTaskAssignment'>[2]>,
    eventContext: NonNullable<DomainArgs<'heartbeatTaskAssignment'>[3]>,
  ) {
    return this.callDomain('heartbeatTaskAssignment', boardId, taskId, input, eventContext);
  }
  recoverStaleTaskAssignments(
    input: NonNullable<DomainArgs<'recoverStaleTaskAssignments'>[1]> & {
      boardId: string;
      eventContext: NonNullable<DomainArgs<'recoverStaleTaskAssignments'>[2]>;
    },
  ) {
    const { boardId, eventContext, ...options } = input;
    return this.callDomain('recoverStaleTaskAssignments', boardId, options, eventContext);
  }
  getKanbanOrchestrationSnapshot(
    input: NonNullable<DomainArgs<'getKanbanOrchestrationSnapshot'>[0]> = {},
  ) {
    return this.callDomain('getKanbanOrchestrationSnapshot', input);
  }
  reconcileBoard(
    boardId: string,
    eventContext: NonNullable<DomainArgs<'reconcileKanbanBoard'>[1]>,
  ) {
    return this.callDomain('reconcileKanbanBoard', boardId, eventContext);
  }

  // ─── Chains ─────────────────────────────────────────────────────────────

  setChain(
    boardId: string,
    taskIds: string[],
    options: { chainId?: string; enforceDependencies?: boolean } = {},
    eventContext: NonNullable<DomainArgs<'setTaskChain'>[2]>,
  ) {
    return this.callDomain('setTaskChain', boardId, { taskIds, ...options }, eventContext);
  }
  getChain(boardId: string, opts: { taskId?: string; chainId?: string }) {
    const taskOrChainId = opts.chainId ?? opts.taskId;
    if (!taskOrChainId) {
      throw new Error('getChain requires taskId or chainId');
    }
    return this.callDomain('getTaskChain', boardId, taskOrChainId);
  }

  verifyTaskCompletion(
    boardId: string,
    taskId: string,
    options: NonNullable<DomainArgs<'verifyTaskCompletion'>[2]> = {},
  ) {
    return this.callDomain('verifyTaskCompletion', boardId, taskId, options);
  }

  // ─── Search / export / import ───────────────────────────────────────────

  searchTasks(input: NonNullable<DomainArgs<'searchKanban'>[0]> = {}) {
    return this.callDomain('searchKanban', input);
  }
  listReadyTasks(input: NonNullable<DomainArgs<'listReadyTasks'>[0]> = {}) {
    return this.callDomain('listReadyTasks', input);
  }
  exportMarkdown(boardId: string) {
    return this.callDomain('exportBoardMarkdown', boardId);
  }
  exportTaskGraph(
    boardId: string,
    options: NonNullable<DomainArgs<'exportBoardToTaskGraph'>[1]> = {},
  ) {
    return this.callDomain('exportBoardToTaskGraph', boardId, options);
  }
  syncTaskGraph(
    boardId: string,
    taskGraph: DomainArgs<'syncBoardFromTaskGraph'>[1],
    options: NonNullable<DomainArgs<'syncBoardFromTaskGraph'>[2]> = {},
  ) {
    return this.callDomain('syncBoardFromTaskGraph', boardId, taskGraph, options);
  }
  createFromGraph(
    taskGraph: DomainArgs<'createBoardFromTaskGraph'>[0],
    options: NonNullable<DomainArgs<'createBoardFromTaskGraph'>[1]> = {},
  ) {
    return this.callDomain('createBoardFromTaskGraph', taskGraph, options);
  }

  // ─── Atomicity ──────────────────────────────────────────────────────────

  assessTaskAtomicity(
    boardId: string,
    taskId: string,
    options: NonNullable<DomainArgs<'assessTaskAtomicity'>[2]>,
  ) {
    return this.callDomain('assessTaskAtomicity', boardId, taskId, options);
  }

  // ─── Storage direct (rarely needed by tools) ───────────────────────────

  readBoard(boardId: string) {
    return this.call('storageReadBoard', { boardRef: boardId });
  }
  listBoardIds() {
    return this.call('storageListBoardIds', {});
  }

  // ─── Internal: IPC is the only client transport ────────────────────────

  private async callDomain<K extends KanbanDomainOperation>(
    operation: K,
    ...args: DomainArgs<K>
  ): Promise<DomainResult<K>> {
    const wireArgs = [...args] as unknown[];
    while (wireArgs.length > 0 && wireArgs.at(-1) === undefined) wireArgs.pop();
    const result = await this.call('domainCall', {
      operation,
      wireArgs: encodeKanbanDomainValue(wireArgs),
    });
    return decodeKanbanDomainValue(result) as DomainResult<K>;
  }

  private async call<M extends KanbanServerMethod>(
    method: M,
    params: KanbanServerOperations[M]['args'],
  ): Promise<KanbanServerOperations[M]['result']> {
    const connection = await getKanbanServerConnection(this.projectRoot);
    if (!connection) {
      throw new Error('Kanban server unavailable; clients require the project IPC owner');
    }

    // Once a request reaches a daemon, never replay it against the file store:
    // a lost response may still mean the mutation committed server-side.
    return connection.request(method, params);
  }
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
