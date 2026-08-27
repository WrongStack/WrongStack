/**
 * Every other Kanban test runs the domain in-process. `client-domain.ts` and
 * `storage.ts` both take an explicit escape hatch under Vitest
 * (`isInProcessTestMode`), so ~50 test files and roughly 1000 assertions never
 * touch the code that actually ships: the wire codec, the daemon's
 * `expectedRevision` check, and the re-wrapping of `StaleWriteError` across the
 * socket. Green there proves the algorithms, not the transport.
 *
 * This file is the transport's coverage. It is deliberately one representative
 * slice rather than a second copy of the suite — one call per family, run
 * against a real daemon with `WRONGSTACK_KANBAN_FORCE_IPC=1`, so a change that
 * breaks encoding, revision fencing or error mapping fails somewhere.
 */
import { type ChildProcess, spawn } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { getProductionKanbanStorage } from '../src/server/remote-storage.js';
import {
  addTask,
  claimReadyTask,
  createBoard,
  createManagedLifecyclePolicy,
  getBoard,
  getKanbanQueueHealth,
  heartbeatTaskAssignment,
  listBoards,
  recoverStaleTaskAssignments,
  removeBoard,
  StaleWriteError,
  transitionTask,
  updateTaskAssignment,
} from './helpers/session-manager.js';

const distServer = fileURLToPath(new URL('../dist/project-server.js', import.meta.url));
const roots: string[] = [];
const children: ChildProcess[] = [];

afterEach(async () => {
  delete process.env['WRONGSTACK_KANBAN_FORCE_IPC'];
  // Wait for the daemon to actually exit before removing the tree: on Windows
  // its open SQLite handle makes `rm` fail with EBUSY, which surfaces as a
  // second, misleading failure on top of whatever the test was reporting.
  await Promise.all(
    children.splice(0).map(async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      child.kill();
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 5_000);
        child.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }),
  );
  for (const root of roots.splice(0)) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('production storage path conformance', () => {
  it('carries a full task lifecycle over the wire', async () => {
    const root = await bootDaemon('lifecycle');

    const board = await createBoard(root, { title: 'Conformance board' });
    expect(board.id).toBeTruthy();

    const created = await addTask(root, board.id, {
      title: 'Ship the codec',
      description: 'Round-trips through the daemon, not the in-process manager.',
      assignee: 'conformance-agent',
      priority: 'high',
      labels: ['transport'],
      successCriteria: [
        { id: 'c1', description: 'Wire round-trip holds', type: 'manual', status: 'pending' },
      ],
    });
    const taskId = created?.task.id;
    if (!taskId) throw new Error('expected the daemon to return the created task');

    // Nested objects and arrays are where a codec regression shows first.
    const stored = await getBoard(root, board.id);
    const storedTask = stored?.tasks.find((task) => task.id === taskId);
    expect(storedTask?.labels).toEqual(['transport']);
    expect(storedTask?.successCriteria?.[0]?.description).toBe('Wire round-trip holds');
    expect(storedTask?.priority).toBe('high');

    const claimed = await claimReadyTask(root, {
      boardId: board.id,
      agentId: 'conformance-agent',
      leaseId: 'lease-conformance',
      leaseExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    expect(claimed?.task.id).toBe(taskId);
    expect(claimed?.task.assignment?.leaseId).toBe('lease-conformance');

    await updateTaskAssignment(root, board.id, taskId, { status: 'running' });
    const renewedAt = new Date(Date.now() + 120_000).toISOString();
    // Lease fencing over the wire: the token must match or the renewal is refused.
    await heartbeatTaskAssignment(root, board.id, taskId, {
      expectedLeaseId: 'lease-conformance',
      leaseExpiresAt: renewedAt,
    });
    const running = await getBoard(root, board.id);
    const runningTask = running?.tasks.find((task) => task.id === taskId);
    expect(runningTask?.assignment?.status).toBe('running');
    expect(runningTask?.assignment?.leaseExpiresAt).toBe(renewedAt);

    const health = await getKanbanQueueHealth(root, { boardId: board.id });
    expect(health.boardIds).toContain(board.id);
    expect(health.counts.running).toBe(1);
    // Optional payload branches are the ones a codec silently drops.
    expect(health.classifications).toBeDefined();
    const lean = await getKanbanQueueHealth(root, {
      boardId: board.id,
      includeClassifications: false,
    });
    expect(lean.classifications).toBeUndefined();

    await updateTaskAssignment(root, board.id, taskId, { status: 'completed' });
    const summaries = await listBoards(root);
    expect(summaries.map((summary) => summary.id)).toContain(board.id);

    expect(await removeBoard(root, board.id)).toBe(true);
    expect(await getBoard(root, board.id)).toBeNull();
  }, 60_000);

  it('re-raises a stale write as StaleWriteError on the client side', async () => {
    // `expectedRevision` is checked inside the daemon, so the failure has to
    // survive serialization and rehydrate as the class callers catch. It did
    // not: the client reconstructed only `KanbanLifecycleError` and handed back
    // a bare `Error` with a `code` property for everything else. Every
    // `instanceof StaleWriteError` retry was therefore dead code once the
    // mutation went through IPC — and no in-process test could see it.
    const root = await bootDaemon('stale');
    const board = await createBoard(root, { title: 'Revision fencing' });
    await addTask(root, board.id, { title: 'Contended card' });

    const before = await getBoard(root, board.id);
    if (!before) throw new Error('expected the board to exist');
    const staleRevision = (before.revision ?? 0) - 1;

    const storage = getProductionKanbanStorage(root);
    const rejection = await storage.writeBoard(before, staleRevision).then(
      () => null,
      (error: unknown) => error,
    );

    expect(rejection).toBeInstanceOf(StaleWriteError);
    // `code` is the older contract — anything already checking it must keep
    // working now that the class survives the wire too.
    expect((rejection as { code?: string }).code).toBe('STALE_WRITE');
  }, 60_000);

  it('walks a recovered managed card back to the queue over the wire', async () => {
    // Recovery is the one path that issues a second `mutateBoard` after its own
    // closure returns, so it exercises daemon call ordering rather than a
    // single request. It is also the newest behavior here.
    const root = await bootDaemon('recovery');
    const board = await createBoard(root, {
      title: 'Managed recovery',
      lifecycle: createManagedLifecyclePolicy(),
    });
    const created = await addTask(root, board.id, {
      title: 'Leased card',
      description: 'Has everything the managed gate asks for.',
      assignee: 'conformance-agent',
      successCriteria: [{ id: 'c1', description: 'Recovered', type: 'manual', status: 'pending' }],
    });
    const taskId = created?.task.id;
    if (!taskId) throw new Error('expected the daemon to return the created task');

    await transitionTask(root, board.id, taskId, {
      to: 'todo',
      actor: 'conformance-agent',
      comment: 'Card is fully specified.',
    });
    const claimed = await claimReadyTask(root, {
      boardId: board.id,
      agentId: 'conformance-agent',
      leaseId: 'lease-expired',
      claimedAt: '2020-01-01T00:00:00.000Z',
      heartbeatAt: '2020-01-01T00:00:00.000Z',
      leaseExpiresAt: '2020-01-02T00:00:00.000Z',
    });
    expect(claimed?.task.id).toBe(taskId);
    await updateTaskAssignment(root, board.id, taskId, { status: 'running' });
    await transitionTask(root, board.id, taskId, {
      to: 'running',
      actor: 'conformance-agent',
      comment: 'Started.',
    });

    const recovered = await recoverStaleTaskAssignments(root, board.id, {
      mode: 'release',
      reason: 'Conformance probe.',
    });
    expect(recovered?.tasks.map((task) => task.id)).toContain(taskId);

    const after = await getBoard(root, board.id);
    expect(after?.tasks.find((task) => task.id === taskId)?.lifecycle?.currentStage).toBe('todo');
  }, 60_000);
});

async function bootDaemon(label: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), `wstack-kanban-conformance-${label}-`));
  roots.push(root);
  process.env['WRONGSTACK_KANBAN_FORCE_IPC'] = '1';
  const child = spawn(process.execPath, [distServer, '--project-root', root], {
    env: {
      ...process.env,
      WRONGSTACK_KANBAN_FORCE_IPC: '1',
      WRONGSTACK_KANBAN_SERVER_IDLE_MS: '30000',
    },
    stdio: 'ignore',
    windowsHide: true,
  });
  children.push(child);
  await waitForEndpoint(root);
  return root;
}

async function waitForEndpoint(projectRoot: string): Promise<void> {
  const { kanbanProjectServerEndpoint } = await import('../src/index.js');
  const endpoint = kanbanProjectServerEndpoint(projectRoot);
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
