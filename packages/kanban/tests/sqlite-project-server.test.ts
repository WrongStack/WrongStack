import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { SqliteKanbanStorage } from '../src/server/sqlite-storage.js';
import { appendKanbanEvent, createBoardObject, getKanbanDir, writeBoard } from '../src/storage.js';
import {
  bridgeKanbanSupervisor,
  createBoard,
  deleteKanbanWorkflowState,
  drainKanbanWorkflowCommands,
  enqueueKanbanWorkflowCommand,
  exportBoardToTaskGraph,
  getBoard,
  getKanbanServerConnection,
  getServerKanbanStore,
  kanbanProjectServerEndpoint,
  kanbanWorkflowId,
  listKanbanEvents,
  listKanbanWorkflowStates,
  readKanbanWorkflowState,
  writeKanbanWorkflowState,
} from './helpers/session-manager.js';

const distServer = fileURLToPath(new URL('../dist/project-server.js', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  delete process.env['WRONGSTACK_KANBAN_FORCE_IPC'];
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  }
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('SQLite Kanban storage', () => {
  it('migrates legacy board, event, and HQ sync state exactly once', async () => {
    const root = await tempRoot('migration');
    const board = createBoardObject({ title: 'Legacy board' });
    const boardPath = path.join(getKanbanDir(root), `${board.id}.json`);
    const eventsPath = path.join(getKanbanDir(root), `${board.id}.events.jsonl`);
    const hqSyncPath = path.join(getKanbanDir(root), '.hq-sync.json');
    await writeBoard(root, board);
    await appendKanbanEvent(root, board.id, {
      id: 'legacy-event',
      boardId: board.id,
      type: 'task.activity',
      sessionId: '2026-08-26/sess_01TESTKANBAN0000000000000',
      ts: new Date().toISOString(),
      actor: 'test',
      after: { source: 'legacy' },
    });
    await fs.writeFile(
      hqSyncPath,
      JSON.stringify({ boards: { [board.id]: { revision: 0 } }, tombstones: {} }),
      'utf8',
    );

    const storage = await SqliteKanbanStorage.open(root);
    try {
      expect(await storage.listBoardIds()).toEqual([board.id]);
      expect((await storage.readBoard(board.id))?.title).toBe('Legacy board');
      expect(await storage.readEvents(board.id)).toHaveLength(1);
      expect(await storage.readMetadata('hq-sync-state-v1')).toContain(board.id);
      expect(await fs.stat(storage.databasePath)).toBeTruthy();
      await expect(fs.stat(boardPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(eventsPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(hqSyncPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      storage.close();
    }

    const reopened = await SqliteKanbanStorage.open(root);
    try {
      expect(await reopened.readEvents(board.id)).toHaveLength(1);
    } finally {
      reopened.close();
    }
  });

  it('preserves every legacy source when import fails, then removes them after a clean retry', async () => {
    const root = await tempRoot('migration-retry');
    const board = createBoardObject({ title: 'Retry board' });
    const boardPath = path.join(getKanbanDir(root), `${board.id}.json`);
    const eventsPath = path.join(getKanbanDir(root), `${board.id}.events.jsonl`);
    const hqSyncPath = path.join(getKanbanDir(root), '.hq-sync.json');
    await writeBoard(root, board);
    await fs.writeFile(eventsPath, '{malformed-event}\n', 'utf8');
    await fs.writeFile(hqSyncPath, JSON.stringify({ boards: {}, tombstones: {} }), 'utf8');

    await expect(SqliteKanbanStorage.open(root)).rejects.toThrow();
    await expect(fs.stat(boardPath)).resolves.toBeTruthy();
    await expect(fs.stat(eventsPath)).resolves.toBeTruthy();
    await expect(fs.stat(hqSyncPath)).resolves.toBeTruthy();

    await fs.writeFile(
      eventsPath,
      `${JSON.stringify({
        id: 'retry-event',
        boardId: board.id,
        type: 'task.activity',
        ts: new Date().toISOString(),
        actor: 'test',
      })}\n`,
      'utf8',
    );
    const storage = await SqliteKanbanStorage.open(root);
    try {
      expect((await storage.readBoard(board.id))?.title).toBe('Retry board');
      expect(await storage.readEvents(board.id)).toHaveLength(1);
      await expect(fs.stat(boardPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(eventsPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(hqSyncPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      storage.close();
    }
  });

  it('reconciles legacy files written after the migration marker without regressing or duplicating SQLite data', async () => {
    const root = await tempRoot('migration-reconcile');
    const board = {
      ...createBoardObject({ title: 'Initial board' }),
      updatedAt: '2026-07-29T00:00:00.000Z',
    };
    const firstEvent = {
      id: 'event-1',
      boardId: board.id,
      type: 'task.activity',
      sessionId: '2026-08-26/sess_01TESTKANBAN0000000000000',
      ts: '2026-07-29T00:00:00.000Z',
      actor: 'test',
    };
    await writeBoard(root, board);
    await appendKanbanEvent(root, board.id, firstEvent);

    const initial = await SqliteKanbanStorage.open(root);
    const aheadBoard = {
      ...createBoardObject({ title: 'SQLite placeholder' }),
      updatedAt: '2026-07-29T00:00:00.000Z',
    };
    try {
      await initial.writeBoard(
        {
          ...board,
          title: 'Newer SQLite board',
          revision: 2,
          updatedAt: '2026-07-29T00:02:00.000Z',
        },
        0,
      );
      await initial.writeBoard(aheadBoard);
    } finally {
      initial.close();
    }

    const staleBoardPath = path.join(getKanbanDir(root), `${board.id}.json`);
    const aheadBoardPath = path.join(getKanbanDir(root), `${aheadBoard.id}.json`);
    const eventsPath = path.join(getKanbanDir(root), `${board.id}.events.jsonl`);
    await writeBoard(root, {
      ...board,
      title: 'Stale legacy board',
      revision: 1,
      updatedAt: '2026-07-29T00:01:00.000Z',
    });
    await writeBoard(root, {
      ...aheadBoard,
      title: 'Newer legacy board',
      revision: 3,
      updatedAt: '2026-07-29T00:03:00.000Z',
    });
    await fs.writeFile(
      eventsPath,
      `${JSON.stringify(firstEvent)}\n${JSON.stringify({
        ...firstEvent,
        id: 'event-2',
        ts: '2026-07-29T00:04:00.000Z',
      })}\n`,
      'utf8',
    );

    const reconciled = await SqliteKanbanStorage.open(root);
    try {
      expect(await reconciled.readBoard(board.id)).toMatchObject({
        title: 'Newer SQLite board',
        revision: 2,
      });
      expect(await reconciled.readBoard(aheadBoard.id)).toMatchObject({
        title: 'Newer legacy board',
        revision: 3,
      });
      expect((await reconciled.readEvents(board.id)).map((event) => event.id)).toEqual([
        'event-1',
        'event-2',
      ]);
      await expect(fs.stat(staleBoardPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(aheadBoardPath)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(eventsPath)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      reconciled.close();
    }
  });

  it('routes the public API through one live IPC owner without new JSON files', async () => {
    const root = await tempRoot('ipc');
    process.env['WRONGSTACK_KANBAN_FORCE_IPC'] = '1';
    const child = startDaemon(root);
    const daemonEndpoint = kanbanProjectServerEndpoint(root);
    await waitForEndpoint(daemonEndpoint);

    const [connection, equivalentRootConnection] = await Promise.all([
      getKanbanServerConnection(root),
      getKanbanServerConnection(`${root}${path.sep}.`),
    ]);
    expect(equivalentRootConnection).toBe(connection);

    const pushedEvents: Array<{ event: string; data: unknown }> = [];
    const unsubscribe = connection!.subscribe((event) => pushedEvents.push(event));
    const board = await createBoard(root, { title: 'IPC board' });
    const workflowId = kanbanWorkflowId('sdd', 'run-1');
    await enqueueKanbanWorkflowCommand(root, workflowId, {
      id: 'command-1',
      type: 'pause',
      payload: { reason: 'test' },
    });
    // Retrying the same command id is idempotent within one workflow.
    await enqueueKanbanWorkflowCommand(root, workflowId, {
      id: 'command-1',
      type: 'pause',
      payload: { reason: 'test' },
    });
    const store = getServerKanbanStore(root);
    await store.addTask(
      board.id,
      { title: 'SQLite task' },
      { sessionId: '2026-08-26/sess_01TESTKANBAN0000000000000', actor: 'kanban-test' },
    );
    const loaded = await store.getBoard(board.id);
    const events = await listKanbanEvents(root, board.id);
    const exported = await store.exportTaskGraph(board.id);
    expect(connection).not.toBeNull();
    const status = await connection!.request('ping', {});
    await waitForCondition(
      () =>
        pushedEvents.some(
          (event) =>
            event.event === 'board.created' &&
            (event.data as { boardId?: string }).boardId === board.id,
        ) &&
        pushedEvents.some(
          (event) =>
            event.event === 'workflow.command' &&
            (event.data as { boardId?: string }).boardId === workflowId,
        ) &&
        pushedEvents.some(
          (event) =>
            event.event === 'board.updated' &&
            (event.data as { boardId?: string }).boardId === board.id,
        ),
      'daemon mutation events',
    );
    unsubscribe();

    expect(loaded?.tasks).toHaveLength(1);
    expect(events.length).toBeGreaterThan(0);
    expect(exported?.graph.nodes).toBeInstanceOf(Map);
    expect(exported?.graph.nodes.size).toBe(1);
    expect(exported?.taskIdMap).toBeInstanceOf(Map);
    expect(exported?.taskIdMap.size).toBe(1);
    expect(status.storage).toBe('sqlite');
    expect(status.pid).toBe(child.pid);
    expect(path.basename(status.databasePath)).toBe('_kanban.sqlite');
    expect(
      pushedEvents
        .filter((event) => (event.data as { boardId?: string }).boardId === board.id)
        .map((event) => event.event),
    ).toEqual(['board.created', 'board.updated']);
    expect(await getBoard(root, board.id)).toEqual(loaded);
    expect((await exportBoardToTaskGraph(root, board.id))?.graph.nodes).toBeInstanceOf(Map);
    expect(await drainKanbanWorkflowCommands(root, workflowId)).toMatchObject([
      { id: 'command-1', workflowId, type: 'pause', payload: { reason: 'test' } },
    ]);
    expect(await drainKanbanWorkflowCommands(root, workflowId)).toEqual([]);

    const firstState = await writeKanbanWorkflowState(root, workflowId, { status: 'running' }, 0);
    const secondState = await writeKanbanWorkflowState(
      root,
      workflowId,
      { status: 'completed' },
      firstState.revision,
    );
    await expect(
      writeKanbanWorkflowState(root, workflowId, { status: 'stale' }, firstState.revision),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
    expect(await readKanbanWorkflowState(root, workflowId)).toEqual(secondState);
    expect(await listKanbanWorkflowStates(root, 'sdd:')).toEqual([secondState]);
    expect(await deleteKanbanWorkflowState(root, workflowId)).toBe(true);
    expect(await readKanbanWorkflowState(root, workflowId)).toBeNull();

    const entries = await fs.readdir(getKanbanDir(root));
    expect(entries).toContain('_kanban.sqlite');
    expect(entries.some((entry) => entry.endsWith('.json'))).toBe(false);
    expect(entries.some((entry) => entry.endsWith('.events.jsonl'))).toBe(false);

    // WS-027: a raw socket with no credential is now refused at the gate,
    // before method dispatch. This peer is exactly the threat the daemon had
    // no answer for: it could previously drive every board operation.
    const unauthenticated = await rawRequest(daemonEndpoint, {
      id: 76,
      method: 'listBoards',
      params: {},
    });
    expect(unauthenticated).toMatchObject({ id: 76, error: { code: 'UNAUTHORIZED' } });

    // With the token from the daemon's owner-only metadata file, the original
    // point of this assertion still holds: the legacy method is gone.
    const metadata = JSON.parse(
      await fs.readFile(path.join(root, '.wrongstack', 'kanban-server.json'), 'utf8'),
    ) as { authToken: string };
    const legacyResponse = await rawRequest(daemonEndpoint, {
      id: 77,
      method: 'listBoards',
      params: {},
      authToken: metadata.authToken,
    });
    expect(legacyResponse).toMatchObject({
      id: 77,
      error: { code: 'INVALID_INPUT', message: 'Unknown method: listBoards' },
    });

    await connection!.request('shutdown', { reason: 'test-complete' });
    await waitForExit(child);
  });

  it('reconnects daemon event subscribers after the IPC owner restarts', async () => {
    const root = await tempRoot('reconnect');
    process.env['WRONGSTACK_KANBAN_FORCE_IPC'] = '1';
    const firstChild = startDaemon(root);
    const daemonEndpoint = kanbanProjectServerEndpoint(root);
    await waitForEndpoint(daemonEndpoint);

    let connected = 0;
    const pushedEvents: Array<{ event: string; data: unknown }> = [];
    const unsubscribe = bridgeKanbanSupervisor(
      root,
      (event) => {
        pushedEvents.push(event);
      },
      {
        reconnectDelayMs: 250,
        onConnected: () => {
          connected++;
        },
      },
    );
    await waitForCondition(() => connected === 1, 'initial event subscription');

    const workflowId = kanbanWorkflowId('sdd', 'restart-recovery');
    const persistedState = await writeKanbanWorkflowState(
      root,
      workflowId,
      { status: 'running', taskGraphId: 'graph-1' },
      0,
    );
    await enqueueKanbanWorkflowCommand(root, workflowId, {
      id: 'restart-command',
      createdAt: new Date().toISOString(),
      type: 'pause',
    });

    const firstConnection = await getKanbanServerConnection(root);
    await firstConnection!.request('shutdown', { reason: 'restart-test' });
    await waitForExit(firstChild);

    const secondChild = startDaemon(root);
    await waitForEndpoint(daemonEndpoint);
    await waitForCondition(() => connected === 2, 'replacement event subscription');
    expect(await readKanbanWorkflowState(root, workflowId)).toEqual(persistedState);
    expect(await drainKanbanWorkflowCommands(root, workflowId)).toMatchObject([
      { id: 'restart-command', workflowId, type: 'pause' },
    ]);

    const board = await createBoard(root, { title: 'After restart' });
    await waitForCondition(
      () =>
        pushedEvents.some(
          (event) =>
            event.event === 'board.created' &&
            (event.data as { boardId?: string }).boardId === board.id,
        ),
      'post-restart daemon event',
    );

    unsubscribe();
    const secondConnection = await getKanbanServerConnection(root);
    await secondConnection!.request('shutdown', { reason: 'test-complete' });
    await waitForExit(secondChild);
  });
});

async function tempRoot(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `wstack-kanban-${label}-`));
  roots.push(root);
  return root;
}

async function waitForCondition(predicate: () => boolean, label: string): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function rawRequest(
  endpoint: string,
  request: {
    id: number;
    method: string;
    params: Record<string, unknown>;
    authToken?: string;
  },
): Promise<Record<string, unknown>> {
  const socket = net.createConnection(endpoint);
  socket.setEncoding('utf8');
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Timed out waiting for raw Kanban response: ${request.method}`));
    }, 5_000);
    timer.unref?.();
    let buffer = '';
    socket.on('data', (chunk: string) => {
      buffer += chunk;
      for (;;) {
        const newline = buffer.indexOf('\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 1);
        const frame = JSON.parse(line) as Record<string, unknown>;
        if (frame.id !== request.id) continue;
        clearTimeout(timer);
        socket.destroy();
        resolve(frame);
        return;
      }
    });
    socket.once('connect', () => {
      socket.write(`${JSON.stringify(request)}\n`);
    });
    socket.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
}

function startDaemon(projectRoot: string): ChildProcess {
  const child = spawn(process.execPath, [distServer, '--project-root', projectRoot], {
    env: {
      ...process.env,
      WRONGSTACK_KANBAN_FORCE_IPC: '1',
      WRONGSTACK_KANBAN_SERVER_IDLE_MS: '30000',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  return child;
}

async function waitForEndpoint(endpoint: string): Promise<void> {
  const deadline = Date.now() + 30_000;
  for (;;) {
    const connected = await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(endpoint);
      socket.once('connect', () => {
        socket.destroy();
        resolve(true);
      });
      socket.once('error', () => resolve(false));
    });
    if (connected) return;
    if (Date.now() >= deadline) throw new Error(`Kanban endpoint did not open: ${endpoint}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Kanban daemon did not exit')), 10_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
  });
}
