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
import { pathToFileURL } from 'node:url';

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

/**
 * Canonicalize before hashing, matching `core/src/utils/project-watch.ts`.
 * Without it `D:\x` and `d:\x` hash differently and each spawns its own daemon
 * for the same project — two processes, two owners, split state.
 */
function canonicalRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * 64-bit djb2 (two independent 32-bit lanes). A single 32-bit lane collides at
 * roughly 77k distinct roots by the birthday bound, and a collision here is not
 * cosmetic: two unrelated projects would share one pipe, so one daemon would
 * serve boards for the wrong root.
 */
function projectKey(projectRoot: string): string {
  const canonical = canonicalRoot(projectRoot);
  let hashA = 5381;
  let hashB = 52711;
  for (let i = 0; i < canonical.length; i++) {
    const code = canonical.charCodeAt(i);
    hashA = ((hashA << 5) + hashA + code) | 0;
    hashB = ((hashB << 5) + hashB + (code ^ 0x5f)) | 0;
  }
  return (
    (hashA >>> 0).toString(16).padStart(8, '0') + (hashB >>> 0).toString(16).padStart(8, '0')
  );
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
/** How often to confirm the project root still exists (orphan guard). */
const ROOT_LIVENESS_CHECK_MS = 60_000;
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

/**
 * Module-scope so `stop()` can actually close it. While this lived as a `const`
 * inside `main()` it was unreachable from `stop()`, so the listening pipe handle
 * — a ref'd libuv handle — kept the process alive forever after the idle timer
 * fired: the daemon set `stopping = true` and then lingered as a ~45MB zombie
 * that accepted connections only to destroy them. Four such orphans were found
 * running against deleted temp directories.
 */
let server: net.Server | null = null;

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
  // Close the listener, or the ref'd handle keeps the event loop — and the
  // process — alive indefinitely. Every sibling daemon (tools, sage, chronicle,
  // mailbox) does this; kanban was the one that did not.
  if (server) {
    const listener = server;
    server = null;
    await new Promise<void>((resolve) => listener.close(() => resolve()));
  }
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
  const board = await kanban.removeTask(projectRoot, boardId, taskId);
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
  if (!params.boardId || !params.taskId || (!params.to && !params.status)) {
    invalid('transitionTask requires boardId, taskId, and to/status');
  }
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
  if (!params.boardId || !params.taskId || !params.input) {
    invalid('assignTask requires boardId, taskId, and input');
  }
  return await kanban.assignTask(
    projectRoot,
    params.boardId,
    params.taskId,
    params.input,
    params.eventContext,
  );
});
defineMethod('updateTaskAssignment', async (params: any) => {
  if (!params.boardId || !params.taskId || !params.patch) {
    invalid('updateTaskAssignment requires boardId, taskId, and patch');
  }
  return await kanban.updateTaskAssignment(
    projectRoot,
    params.boardId,
    params.taskId,
    params.patch,
    params.eventContext,
  );
});
defineMethod('finalizeTaskCompletion', async (params: any) => {
  if (!params.boardId || !params.taskId) {
    invalid('finalizeTaskCompletion requires boardId and taskId');
  }
  return await kanban.finalizeTaskCompletion(
    projectRoot,
    params.boardId,
    params.taskId,
    params.options,
  );
});
defineMethod('heartbeatAssignment', async (params: any) => {
  if (!params.boardId || !params.taskId) invalid('heartbeatAssignment requires boardId and taskId');
  return await kanban.heartbeatTaskAssignment(projectRoot, params.boardId, params.taskId, params);
});
const verifyCompletion = async (params: any) => {
  if (!params.boardId || !params.taskId) {
    invalid('verifyTaskCompletion requires boardId and taskId');
  }
  return await kanban.verifyTaskCompletion(projectRoot, params.boardId, params.taskId, {
    ...(params.persist !== undefined ? { persist: params.persist } : {}),
  });
};
defineMethod('verifyTaskCompletion', verifyCompletion);
defineMethod('verifyCompletion', verifyCompletion);
defineMethod('recoverStaleTaskAssignments', async (params: any) => {
  const boardId = params?.boardId ?? '';
  return await kanban.recoverStaleTaskAssignments(projectRoot, boardId, {});
});
defineMethod('reconcileBoard', async ({ boardId }: { boardId: string }) => {
  if (!boardId) invalid('reconcileBoard requires boardId');
  return await kanban.reconcileKanbanBoard(projectRoot, boardId);
});

defineMethod('setChain', async ({ boardId, taskIds, chainId, enforceDependencies }: any) => {
  if (!boardId || !Array.isArray(taskIds)) invalid('setChain requires boardId and taskIds[]');
  const result = await kanban.setTaskChain(projectRoot, boardId, {
    taskIds,
    ...(chainId !== undefined ? { chainId } : {}),
    ...(enforceDependencies !== undefined ? { enforceDependencies } : {}),
  });
  return result ?? notFound('Chain failed');
});
defineMethod('getChain', async (params: any) => {
  if (!params.boardId || (!params.taskId && !params.chainId)) invalid('getChain requires boardId and taskId or chainId');
  const chain = await kanban.getTaskChain(
    projectRoot,
    params.boardId,
    params.chainId ?? params.taskId,
  );
  if (!chain) notFound('Chain not found');
  return chain;
});

// Task graph — forward to the task-graph-bridge module directly.
defineMethod('syncTaskGraph', async ({ boardId, taskGraph }: any) => {
  if (!boardId || !taskGraph) invalid('syncTaskGraph requires boardId and taskGraph');
  const bridge = await import('../manager/task-graph-bridge.js');
  return await bridge.syncBoardFromTaskGraph(projectRoot, boardId, typeof taskGraph === 'string' ? JSON.parse(taskGraph) : taskGraph);
});
defineMethod('createFromGraph', async ({ taskGraph, options }: any) => {
  if (!taskGraph) invalid('createFromGraph requires taskGraph');
  const bridge = await import('../manager/task-graph-bridge.js');
  const result = await bridge.createBoardFromTaskGraph(
    projectRoot,
    typeof taskGraph === 'string' ? JSON.parse(taskGraph) : taskGraph,
    options,
  );
  emitBoardEvent('board.created', result.board.id, result.board);
  return result;
});

// Atomicity
defineMethod('assessAtomicity', async (params: any) => {
  if (!params.boardId || !params.taskId) invalid('assessAtomicity requires boardId and taskId');
  return await kanban.assessTaskAtomicity(projectRoot, params.boardId, params.taskId);
});

// Export
defineMethod('exportMarkdown', async ({ boardId }: { boardId: string }) => {
  if (!boardId) invalid('exportMarkdown requires boardId');
  const [serialization, storage] = await Promise.all([
    import('../manager/serialization.js'),
    import('../storage.js'),
  ]);
  const board = await storage.readBoard(projectRoot, boardId);
  if (!board) notFound(`Board ${boardId} not found`);
  return serialization.exportBoardAsMarkdown(board);
});
defineMethod('exportTaskGraph', async ({ boardId }: { boardId: string }) => {
  if (!boardId) invalid('exportTaskGraph requires boardId');
  const bridge = await import('../manager/task-graph-bridge.js');
  const graph = await bridge.exportBoardToTaskGraph(projectRoot, boardId);
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

  server = net.createServer((socket) => {
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

  const listener = server;
  listener.on('error', (err: NodeJS.ErrnoException) => {
    // EADDRINUSE means another daemon won the bind election for this root —
    // that is the ownership protocol working, not a failure. Exiting non-zero
    // there made a normal race look like a crash.
    if (err.code === 'EADDRINUSE') {
      process.exit(0);
    }
    process.stderr.write(`kanban project server error: ${err.message}\n`);
    process.exit(1);
  });

  await new Promise<void>((resolve, reject) => {
    listener.once('error', reject);
    listener.listen(endpoint!, () => {
      listener.off('error', reject);
      resolve();
    });
  });

  process.stdout.write(`kanban project server listening on ${endpoint}\n`);

  // Arm the idle timer at startup. Previously the only caller was the socket
  // 'close' handler, so a daemon that was spawned but never connected to had
  // `idleTimer === undefined` and lived forever. Every sibling daemon arms it
  // right after listen().
  scheduleIdleStop();

  // Orphan guard: kanban has no client heartbeat and no lease sweep, so a
  // half-open socket would pin `clients.size > 0` and defeat the idle timer.
  // A vanished project root is unambiguous — nothing can ever be served again.
  const livenessTimer = setInterval(() => {
    void fsPromises.stat(projectRoot).catch(() => {
      void stop('project-root-removed').then(() => process.exit(0));
    });
  }, ROOT_LIVENESS_CHECK_MS);
  livenessTimer.unref?.();

  process.on('SIGTERM', () => void stop('SIGTERM').then(() => process.exit(0)));
  process.on('SIGINT', () => void stop('SIGINT').then(() => process.exit(0)));
}

/**
 * `file://${process.argv[1]}` never matches `import.meta.url` on Windows —
 * argv[1] is a backslash path (`D:\...\project-server.js`) while import.meta.url
 * is a percent-encoded forward-slash URL (`file:///D:/.../project-server.js`).
 * The daemon therefore silently did nothing and exited 0 when spawned there.
 * `pathToFileURL` is the portable comparison.
 */
const isMain = process.argv[1] ? import.meta.url === pathToFileURL(process.argv[1]).href : false;
if (isMain) {
  main().catch((err) => {
    process.stderr.write(`kanban project server fatal: ${err?.message ?? err}\n`);
    process.exit(1);
  });
}
