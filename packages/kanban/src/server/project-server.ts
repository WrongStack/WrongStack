/**
 * Kanban Project Server — IPC daemon
 *
 * Single shared process per project. Owns the kanban state for `projectRoot`.
 * Tools and other agents connect over a net.Socket (named pipe on Windows,
 * Unix domain socket elsewhere) and call typed methods from `protocol.ts`.
 *
 * Lifecycle:
 *   - Spawned detached via `client.ts` when first needed
 *   - Idle for `WRONGSTACK_KANBAN_SERVER_IDLE_MS` (default 5 minutes)
 *     with zero connected clients → exits cleanly
 *   - Hard stop on `shutdown` request or SIGTERM
 */
import * as fsPromises from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';

import * as kanban from '../manager.js';
import {
  KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
  type KanbanHelloFrame,
  type KanbanRequest,
  type KanbanErrorResponse,
  type KanbanServerEvent,
  type KanbanProjectServerInfo,
  type KanbanErrorCode,
} from './protocol.js';
import { emitBoardEvent, subscribeToBoardEvents } from './event-emitter.js';

// ─── Endpoint resolution ────────────────────────────────────────────────────

function projectKey(projectRoot: string): string {
  let hash = 5381;
  for (let i = 0; i < projectRoot.length; i++) {
    hash = ((hash << 5) + hash + projectRoot.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(16).padStart(8, '0');
}

export function kanbanProjectServerEndpoint(projectRoot: string): string {
  const key = projectKey(projectRoot);
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\wrongstack-kanban-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}-${key}`;
  }
  const dir = process.env['TMPDIR'] ?? '/tmp';
  return path.join(dir, `wrongstack-kanban-v${KANBAN_PROJECT_SERVER_PROTOCOL_VERSION}-${key}.sock`);
}

// ─── Constants ───────────────────────────────────────────────────────────────

const DEFAULT_IDLE_MS = 5 * 60_000;
const MAX_FRAME_CHARS = 8 * 1024 * 1024;
const MAX_PARALLEL_REQUESTS_PER_CLIENT = 32;

interface ClientState {
  socket: net.Socket;
  buffer: string;
  activeControllers: Set<AbortController>;
}

let projectRoot = '';
let endpoint = '';
let serverInfo: KanbanProjectServerInfo | null = null;
let stopping = false;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
const clients = new Set<ClientState>();

// ─── Frame I/O ───────────────────────────────────────────────────────────────

function sendFrame(socket: net.Socket, frame: unknown): void {
  socket.write(JSON.stringify(frame) + '\n');
}

function broadcastEvent(ev: KanbanServerEvent): void {
  for (const state of clients) {
    try {
      sendFrame(state.socket, ev);
    } catch {
      state.socket.destroy();
    }
  }
}

// ─── Server lifecycle ────────────────────────────────────────────────────────

function scheduleIdleStop(): void {
  if (stopping || clients.size > 0) return;
  if (idleTimer) clearTimeout(idleTimer);
  const idleInput = Number(process.env['WRONGSTACK_KANBAN_SERVER_IDLE_MS']);
  const idleMs = Number.isFinite(idleInput) && idleInput >= 100 ? idleInput : DEFAULT_IDLE_MS;
  idleTimer = setTimeout(() => void stop('idle-timeout'), idleMs);
  idleTimer.unref?.();
}

async function stop(reason: string): Promise<void> {
  if (stopping) return;
  stopping = true;
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = undefined;
  for (const state of clients) {
    for (const c of state.activeControllers) c.abort(new Error(`Kanban server stopping: ${reason}`));
    state.socket.destroy();
  }
  clients.clear();
  if (process.platform !== 'win32' && endpoint) {
    await fsPromises.rm(endpoint, { force: true }).catch(() => {});
  }
}

async function ensureParentDir(): Promise<void> {
  if (process.platform === 'win32') return;
  const dir = path.dirname(endpoint);
  await fsPromises.mkdir(dir, { recursive: true }).catch(() => undefined);
}

// ─── Method registrations ────────────────────────────────────────────────────
//
// All handlers are async to give the call site a uniform shape. The `direct`
// wrapper strips the `Promise` so we can access `.id` and other properties
// on the resolved value.

type Handler = (params: any) => Promise<unknown>;
const methods = new Map<string, Handler>();

function defineMethod(name: string, handler: Handler): void {
  methods.set(name, handler);
}

function notFound(message: string): never {
  throw { code: 'NOT_FOUND', message };
}
function invalid(message: string): never {
  throw { code: 'INVALID_INPUT', message };
}

defineMethod('ping', async () => ({
  ...serverInfo!,
  clients: clients.size,
  pendingRequests: sumActive(),
}));

defineMethod('shutdown', async () => {
  setImmediate(() => void stop('client-request'));
  return { stopping: true };
});

// Board reads
defineMethod('listBoards', async () => await kanban.listBoards(projectRoot));
defineMethod('listBoardSummaries', async () => await kanban.listBoards(projectRoot));
defineMethod('getBoard', async ({ boardId }: { boardId: string }) => {
  if (!boardId) invalid('getBoard requires boardId');
  const board = await kanban.getBoard(projectRoot, boardId);
  if (!board) notFound(`Board ${boardId} not found`);
  return board;
});
defineMethod('getTask', async ({ boardId, taskId }: { boardId: string; taskId: string }) => {
  if (!boardId || !taskId) invalid('getTask requires boardId and taskId');
  const task = await kanban.getTask(projectRoot, boardId, taskId);
  if (!task) notFound(`Task ${taskId} not found`);
  return task;
});
defineMethod('getKanbanOrchestrationSnapshot', async (params: any) =>
  await kanban.getKanbanOrchestrationSnapshot(projectRoot, params),
);
defineMethod('searchTasks', async (params: any) => await kanban.searchKanban(projectRoot, params));
defineMethod('readyTasks', async (params: any) => await kanban.listReadyTasks(projectRoot, params));

// Board mutations
defineMethod('createBoard', async (params: any) => {
  const board = await kanban.createBoard(projectRoot, params);
  emitBoardEvent('board.created', board.id, board);
  return board;
});
defineMethod('updateBoard', async ({ boardId, ...patch }: any) => {
  if (!boardId) invalid('updateBoard requires boardId');
  const board = await kanban.updateBoard(projectRoot, boardId, patch);
  if (!board) notFound(`Board ${boardId} not found`);
  emitBoardEvent('board.updated', boardId, patch);
  return board;
});
defineMethod('duplicateBoard', async ({ boardId, options }: any) => {
  if (!boardId) invalid('duplicateBoard requires boardId');
  const board = await kanban.duplicateBoard(projectRoot, boardId, options);
  if (!board) notFound(`Board ${boardId} not found`);
  emitBoardEvent('board.created', board.id, board);
  return board;
});
defineMethod('deleteBoard', async ({ boardId }: { boardId: string }) => {
  if (!boardId) invalid('deleteBoard requires boardId');
  const removed = await kanban.removeBoard(projectRoot, boardId);
  if (removed) emitBoardEvent('board.deleted', boardId);
  return removed;
});
defineMethod('generateBoard', async ({ description }: { description: string }) => {
  if (!description) invalid('generateBoard requires description');
  // Fallback: createBoard with a description-derived title
  const board = await kanban.createBoard(projectRoot, {
    title: (description.split('\n')[0] ?? description).slice(0, 80),
    description,
  });
  emitBoardEvent('board.created', board.id, board);
  return board;
});

// Column mutations
defineMethod('addColumn', async (params: any) => {
  const result = await kanban.addColumn(projectRoot, params.boardId, params);
  if (!result) notFound(`Board ${params.boardId} not found`);
  emitBoardEvent('column.added', params.boardId, params, undefined, (result as any).column?.id ?? '');
  return result;
});
defineMethod('updateColumn', async (params: any) => {
  if (!params.boardId || !params.columnId) invalid('updateColumn requires boardId and columnId');
  const board = await (kanban as any).updateColumn(projectRoot, params.boardId, params.columnId, params);
  if (!board) notFound('Column not found');
  emitBoardEvent('column.updated', params.boardId, params, undefined, params.columnId);
  return board;
});
defineMethod('deleteColumn', async ({ boardId, columnId }: any) => {
  if (!boardId || !columnId) invalid('deleteColumn requires boardId and columnId');
  const board = await (kanban as any).removeColumn(projectRoot, boardId, columnId);
  if (!board) notFound('Column not found');
  emitBoardEvent('column.deleted', boardId, { columnId }, undefined, columnId);
  return board;
});

// Task mutations
defineMethod('addTask', async (params: any) => {
  if (!params.boardId || !params.title) invalid('addTask requires boardId and title');
  const result = await kanban.addTask(projectRoot, params.boardId, params);
  if (!result) notFound(`Board ${params.boardId} not found`);
  const taskId = (result as any).task?.id;
  emitBoardEvent('task.added', params.boardId, params, taskId);
  return result;
});
defineMethod('updateTask', async (params: any) => {
  if (!params.boardId || !params.taskId) invalid('updateTask requires boardId and taskId');
  const board = await kanban.updateTask(projectRoot, params.boardId, params.taskId, params);
  if (!board) notFound(`Task ${params.taskId} not found`);
  emitBoardEvent('task.updated', params.boardId, params, params.taskId);
  return board;
});
defineMethod('deleteTask', async ({ boardId, taskId }: any) => {
  if (!boardId || !taskId) invalid('deleteTask requires boardId and taskId');
  const fn = (kanban as any).deleteTask ?? (kanban as any).removeTask;
  if (!fn) throw { code: 'INTERNAL_ERROR', message: 'deleteTask not available in this build' };
  const board = await fn(projectRoot, boardId, taskId);
  if (!board) notFound('Task not found');
  emitBoardEvent('task.deleted', boardId, { taskId }, taskId);
  return board;
});
defineMethod('moveTask', async (params: any) => {
  if (!params.boardId || !params.taskId || !params.targetColumnId) invalid('moveTask requires boardId, taskId, and targetColumnId');
  const board = await kanban.moveTask(projectRoot, params.boardId, params.taskId, params.targetColumnId, params.order);
  if (!board) notFound('Move failed');
  emitBoardEvent('task.moved', params.boardId, params, params.taskId);
  return board;
});
defineMethod('copyTask', async (params: any) => {
  if (!params.boardId || !params.taskId || !params.targetBoardId) invalid('copyTask requires boardId, taskId, and targetBoardId');
  const result = await kanban.copyTaskToBoard(projectRoot, params.boardId, params.taskId, params.targetBoardId, params.options ?? {});
  emitBoardEvent('task.added', params.targetBoardId, result, (result as any)?.task?.id);
  return result;
});
defineMethod('transferTask', async (params: any) => {
  if (!params.boardId || !params.taskId || !params.targetBoardId) invalid('transferTask requires boardId, taskId, and targetBoardId');
  const result = await kanban.transferTaskToBoard(projectRoot, params.boardId, params.taskId, params.targetBoardId, params.targetColumnId);
  emitBoardEvent('task.moved', params.targetBoardId, result, params.taskId);
  return result;
});

// Lifecycle / orchestration
defineMethod('transitionTask', async (params: any) => {
  if (!params.boardId || !params.taskId || !params.status) invalid('transitionTask requires boardId, taskId, and status');
  const board = await kanban.transitionTask(projectRoot, params.boardId, params.taskId, params);
  if (!board) notFound('Board or task not found');
  emitBoardEvent('task.transitioned', params.boardId, params, params.taskId);
  return board;
});
defineMethod('adoptManagedLifecycle', async (params: any) => {
  if (!params.boardId || !params.author || !params.transitionComment) invalid('adoptManagedLifecycle requires boardId, author, transitionComment');
  return await kanban.adoptManagedLifecycle(projectRoot, params.boardId, params);
});
defineMethod('repairManagedProjection', async (params: any) => {
  if (!params.boardId || !params.taskId || !params.author || !params.transitionComment) invalid('repairManagedProjection requires boardId, taskId, author, transitionComment');
  return await kanban.repairManagedTaskProjection(projectRoot, params.boardId, params.taskId, params);
});
defineMethod('claimTask', async (params: any) => await kanban.claimReadyTask(projectRoot, params));
defineMethod('releaseTask', async ({ boardId, taskId }: any) => {
  if (!boardId || !taskId) invalid('releaseTask requires boardId and taskId');
  return await kanban.releaseTaskClaim(projectRoot, boardId, taskId);
});
defineMethod('assignTask', async (params: any) => {
  if (!params.boardId || !params.taskId || !params.assignee) invalid('assignTask requires boardId, taskId, and assignee');
  return await kanban.assignTask(projectRoot, params.boardId, params.taskId, { assignee: params.assignee });
});
defineMethod('heartbeatAssignment', async (params: any) => {
  if (!params.boardId || !params.taskId) invalid('heartbeatAssignment requires boardId and taskId');
  return await kanban.heartbeatTaskAssignment(projectRoot, params.boardId, params.taskId, params);
});
defineMethod('recoverStaleTaskAssignments', async (params: any) => {
  const boardId = params?.boardId ?? '';
  return await kanban.recoverStaleTaskAssignments(projectRoot, boardId, {});
});
defineMethod('reconcileBoard', async ({ boardId }: { boardId: string }) => {
  if (!boardId) invalid('reconcileBoard requires boardId');
  return await kanban.reconcileKanbanBoard(projectRoot, boardId);
});

// Chains — currently not publicly exposed; server stores the data on the
// board directly via a thin board-write path. The kanban tool still calls
// setChain/getChain directly through its own internal helper.
defineMethod('setChain', async ({ boardId, taskIds }: any) => {
  if (!boardId || !Array.isArray(taskIds)) invalid('setChain requires boardId and taskIds[]');
  // The public API doesn't expose setChain; we forward to the manager's
  // internals via a dynamic import. Tools that need setChain semantics
  // should still call the internal helper directly.
  const internal = await import('../manager/_internal.js');
  const board = await (internal as any).setChainMetadata(
    await import('../storage.js').then((m) => m.readBoard(projectRoot, boardId)),
    [],
    taskIds[0],
    true,
  );
  return board ?? notFound('Chain failed');
});
defineMethod('getChain', async (params: any) => {
  if (!params.boardId || (!params.taskId && !params.chainId)) invalid('getChain requires boardId and taskId or chainId');
  const storage = await import('../storage.js');
  const board = await storage.readBoard(projectRoot, params.boardId);
  if (!board) notFound(`Board ${params.boardId} not found`);
  const chain = (board as any).chains?.[params.chainId ?? ''] ?? null;
  if (!chain) notFound('Chain not found');
  return chain;
});

// Task graph — forward to the task-graph-bridge module directly.
defineMethod('syncTaskGraph', async ({ boardId, taskGraph }: any) => {
  if (!boardId || !taskGraph) invalid('syncTaskGraph requires boardId and taskGraph');
  const bridge = await import('../manager/task-graph-bridge.js');
  return await (bridge as any).syncTaskGraphToBoard(projectRoot, boardId, typeof taskGraph === 'string' ? JSON.parse(taskGraph) : taskGraph);
});
defineMethod('createFromGraph', async ({ taskGraph, options }: any) => {
  if (!taskGraph) invalid('createFromGraph requires taskGraph');
  const bridge = await import('../manager/task-graph-bridge.js');
  const board = await (bridge as any).createBoardFromTaskGraph(
    projectRoot,
    typeof taskGraph === 'string' ? JSON.parse(taskGraph) : taskGraph,
    options,
  );
  emitBoardEvent('board.created', board.id, board);
  return board;
});
defineMethod('importSessionTasks', async (params: any) => {
  const bridge = await import('../manager/task-graph-bridge.js');
  return await (bridge as any).mirrorSessionTasksToBoard(projectRoot, params);
});

// Atomicity
defineMethod('assessAtomicity', async (params: any) => {
  if (!params.boardId || !params.taskId) invalid('assessAtomicity requires boardId and taskId');
  return await kanban.assessTaskAtomicity(projectRoot, params.boardId, params.taskId);
});

// Export
defineMethod('exportMarkdown', async ({ boardId }: { boardId: string }) => {
  if (!boardId) invalid('exportMarkdown requires boardId');
  const serialization = await import('../manager/serialization.js');
  const md = await (serialization as any).exportBoardToMarkdown(projectRoot, boardId);
  if (!md) notFound(`Board ${boardId} not found`);
  return md;
});
defineMethod('exportTaskGraph', async ({ boardId }: { boardId: string }) => {
  if (!boardId) invalid('exportTaskGraph requires boardId');
  const bridge = await import('../manager/task-graph-bridge.js');
  const graph = await (bridge as any).exportBoardToTaskGraph(projectRoot, boardId);
  if (!graph) notFound(`Board ${boardId} not found`);
  return graph;
});

function sumActive(): number {
  let total = 0;
  for (const state of clients) total += state.activeControllers.size;
  return total;
}

function errorFromThrown(value: unknown): KanbanErrorResponse['error'] {
  if (value && typeof value === 'object' && 'code' in value && 'message' in value) {
    const v = value as { code: KanbanErrorCode; message: string };
    return { code: v.code, message: v.message };
  }
  if (value instanceof Error) {
    return { code: 'INTERNAL_ERROR', message: value.message, cause: value.stack ?? null };
  }
  return { code: 'INTERNAL_ERROR', message: String(value) };
}

// ─── Per-client request loop ─────────────────────────────────────────────────

function processRequest(state: ClientState, req: KanbanRequest): void {
  const def = methods.get(req.method);
  if (!def) {
    sendFrame(state.socket, {
      id: req.id,
      error: { code: 'INVALID_INPUT', message: `Unknown method: ${req.method}` },
    });
    return;
  }

  if (state.activeControllers.size >= MAX_PARALLEL_REQUESTS_PER_CLIENT) {
    sendFrame(state.socket, {
      id: req.id,
      error: { code: 'INTERNAL_ERROR', message: 'Too many parallel requests on this connection' },
    });
    return;
  }

  const controller = new AbortController();
  state.activeControllers.add(controller);

  Promise.resolve()
    .then(() => def(req.params))
    .then((result) => {
      sendFrame(state.socket, { id: req.id, ok: true, result: result ?? null });
    })
    .catch((err) => {
      sendFrame(state.socket, { id: req.id, error: errorFromThrown(err) });
    })
    .finally(() => {
      state.activeControllers.delete(controller);
    });
}

function onData(state: ClientState, chunk: string): void {
  state.buffer += chunk;
  let nl: number;
  while ((nl = state.buffer.indexOf('\n')) !== -1) {
    const line = state.buffer.slice(0, nl);
    state.buffer = state.buffer.slice(nl + 1);
    if (state.buffer.length > MAX_FRAME_CHARS) {
      state.socket.destroy(new Error('Frame buffer exceeded maximum size'));
      return;
    }
    if (!line.trim()) continue;
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === 'object' && typeof parsed.method === 'string' && typeof parsed.id === 'number') {
        processRequest(state, parsed as KanbanRequest);
      }
    } catch {
      sendFrame(state.socket, {
        id: -1,
        error: { code: 'INVALID_INPUT', message: 'Malformed JSON frame' },
      });
    }
  }
}

// ─── Bootstrap ───────────────────────────────────────────────────────────────

function parseArgs(argv: string[]): { projectRoot: string } {
  let root = '';
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--project-root' && i + 1 < argv.length) {
      root = argv[i + 1] ?? '';
      i++;
    }
  }
  if (!root) throw new Error('kanban project server requires --project-root');
  return { projectRoot: root };
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  projectRoot = args.projectRoot;
  endpoint = kanbanProjectServerEndpoint(projectRoot);

  await ensureParentDir();

  serverInfo = {
    protocolVersion: KANBAN_PROJECT_SERVER_PROTOCOL_VERSION,
    pid: process.pid,
    projectRoot,
    endpoint,
    startedAt: new Date().toISOString(),
  };

  subscribeToBoardEvents((ev) => {
    broadcastEvent({ type: 'event', event: ev.event, data: ev.data });
  });

  const server = net.createServer((socket) => {
    if (stopping) {
      socket.destroy();
      return;
    }
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = undefined;
    socket.setEncoding('utf8');
    const state: ClientState = {
      socket,
      buffer: '',
      activeControllers: new Set(),
    };
    clients.add(state);
    const hello: KanbanHelloFrame = { type: 'hello', ...serverInfo! };
    sendFrame(socket, hello);
    socket.on('data', (chunk: string) => onData(state, chunk));
    socket.on('close', () => {
      for (const c of state.activeControllers) c.abort(new Error('Client disconnected'));
      clients.delete(state);
      scheduleIdleStop();
    });
    socket.on('error', () => {
      clients.delete(state);
    });
  });

  server.on('error', (err) => {
    process.stderr.write(`kanban project server error: ${err.message}\n`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(endpoint!, () => {
      server.off('error', reject);
      resolve();
    });
  });

  process.stdout.write(`kanban project server listening on ${endpoint}\n`);

  process.on('SIGTERM', () => void stop('SIGTERM').then(() => process.exit(0)));
  process.on('SIGINT', () => void stop('SIGINT').then(() => process.exit(0)));
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`kanban project server fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}