import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { SddBoardSnapshot } from '@wrongstack/sdd';
import { afterEach, describe, expect, it } from 'vitest';
import { SddBoardWebSocketHandler } from '../src/index.js';

/** Minimal ws stub capturing sent JSON messages. */
function fakeWs() {
  const sent: Array<{ type: string; payload: unknown }> = [];
  return {
    readyState: 1,
    send: (data: string) => sent.push(JSON.parse(data)),
    on: () => {},
    sent,
  } as never;
}

const dirs: string[] = [];
async function tmpDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(os.tmpdir(), 'sdd-board-ws-'));
  dirs.push(d);
  return d;
}

afterEach(async () => {
  for (const d of dirs.splice(0))
    await fs.rm(d, { recursive: true, force: true }).catch(() => undefined);
});

function snapshot(over: Partial<SddBoardSnapshot> = {}): SddBoardSnapshot {
  return {
    runId: 'r1',
    graphId: 'g1',
    title: 'T',
    status: 'completed',
    startedAt: 0,
    updatedAt: 0,
    progress: {
      total: 1,
      completed: 1,
      failed: 0,
      inProgress: 0,
      pending: 0,
      blocked: 0,
      review: 0,
      percentComplete: 100,
    },
    wave: 0,
    tasks: [],
    columns: [],
    ...over,
  };
}

function lifecyclePaths(root: string, boardsDir: string) {
  return {
    projectRoot: root,
    controlTransport: 'legacy-file' as const,
    stateTransport: 'legacy-file' as const,
    paths: {
      projectSpecs: path.join(root, 'specs'),
      projectTaskGraphs: path.join(root, 'task-graphs'),
      projectSddSession: path.join(root, 'sdd-session.json'),
      projectSddBoards: boardsDir,
    },
  };
}

function trustBoundary(kind: 'allow' | 'deny'): TrustBoundary {
  return {
    evaluate: async () => ({ kind, reason: kind === 'allow' ? 'test allow' : 'test deny' }),
  };
}

async function readControl(boardsDir: string, runId: string): Promise<string> {
  return fs.readFile(path.join(boardsDir, `${runId}.control.jsonl`), 'utf8').catch(() => '');
}

describe('SddBoardWebSocketHandler — lifecycle', () => {
  it('drops retained clients and the latest snapshot on dispose', async () => {
    const root = await tmpDir();
    const handler = new SddBoardWebSocketHandler(path.join(root, 'sdd-boards'));
    handler.addClient(fakeWs());
    const internal = handler as unknown as {
      clients: Set<unknown>;
      latest: SddBoardSnapshot | null;
    };
    internal.latest = snapshot();

    handler.dispose();
    expect(internal.clients.size).toBe(0);
    expect(internal.latest).toBeNull();
  });

  it('polls standalone board storage only while clients are connected', async () => {
    const root = await tmpDir();
    const listeners = new Map<string, () => void>();
    const ws = {
      readyState: 1,
      send: () => undefined,
      on: (event: string, listener: () => void) => listeners.set(event, listener),
    } as never;
    const handler = new SddBoardWebSocketHandler(path.join(root, 'sdd-boards'));
    const internal = handler as unknown as { poll: ReturnType<typeof setInterval> | null };

    expect(internal.poll).toBeNull();
    handler.addClient(ws);
    expect(internal.poll).not.toBeNull();
    listeners.get('close')?.();
    expect(internal.poll).toBeNull();
    handler.dispose();
  });

  it('applies cleanup_worktrees from disk and broadcasts a lifecycle_result', async () => {
    const root = await tmpDir();
    const boardsDir = path.join(root, 'sdd-boards');
    const handler = new SddBoardWebSocketHandler(
      boardsDir,
      undefined,
      lifecyclePaths(root, boardsDir),
    );
    const ws = fakeWs();
    handler.addClient(ws);

    await handler.handleMessage({ type: 'sdd.board.cleanup_worktrees' });

    const res = (
      ws as unknown as { sent: Array<{ type: string; payload: { op: string; ok: boolean } }> }
    ).sent.find((m) => m.type === 'sdd.board.lifecycle_result');
    expect(res?.payload).toMatchObject({ op: 'cleanup_worktrees', ok: true });
    handler.dispose();
  });

  it('destroy clears the board and pushes an empty snapshot', async () => {
    const root = await tmpDir();
    const boardsDir = path.join(root, 'sdd-boards');
    await fs.mkdir(lifecyclePaths(root, boardsDir).paths.projectSpecs, { recursive: true });
    const handler = new SddBoardWebSocketHandler(
      boardsDir,
      undefined,
      lifecyclePaths(root, boardsDir),
    );
    const ws = fakeWs();
    handler.addClient(ws);

    await handler.handleMessage({ type: 'sdd.board.destroy', payload: {} });

    const sent = (ws as unknown as { sent: Array<{ type: string; payload: unknown }> }).sent;
    expect(sent.find((m) => m.type === 'sdd.board.lifecycle_result')?.payload).toMatchObject({
      op: 'destroy',
      ok: true,
    });
    // A cleared board is broadcast as a null snapshot.
    expect(sent.some((m) => m.type === 'sdd.board.snapshot' && m.payload === null)).toBe(true);
    handler.dispose();
  });

  it('refuses a lifecycle op while the run is still active', async () => {
    const root = await tmpDir();
    const boardsDir = path.join(root, 'sdd-boards');
    const events = new EventBus();
    const handler = new SddBoardWebSocketHandler(
      boardsDir,
      events,
      lifecyclePaths(root, boardsDir),
    );
    const ws = fakeWs();
    handler.addClient(ws);
    // Make the handler believe a run is live.
    events.emit('sdd.board.snapshot', {
      runId: 'r1',
      snapshot: snapshot({ status: 'running' }),
    } as never);

    await handler.handleMessage({ type: 'sdd.board.rollback' });

    const res = (
      ws as unknown as {
        sent: Array<{ type: string; payload: { op: string; ok: boolean; reason?: string } }>;
      }
    ).sent.find((m) => m.type === 'sdd.board.lifecycle_result');
    expect(res?.payload.ok).toBe(false);
    expect(res?.payload.reason).toMatch(/stop the run first/i);
    handler.dispose();
  });

  it('authorizes non-empty verification commands before appending control', async () => {
    const root = await tmpDir();
    const boardsDir = path.join(root, 'sdd-boards');
    const handler = new SddBoardWebSocketHandler(
      boardsDir,
      undefined,
      lifecyclePaths(root, boardsDir),
      { trustBoundary: trustBoundary('allow') },
    );

    await handler.handleMessage({
      type: 'sdd.board.set_task_verification',
      payload: { runId: 'r1', taskId: 't1', verificationCommand: 'pnpm test' },
    });

    expect(await readControl(boardsDir, 'r1')).toContain('pnpm test');
  });

  it.each([
    ['denied by the trust boundary', trustBoundary('deny'), 'pnpm test'],
    ['missing security dependencies', undefined, 'pnpm test'],
    ['a non-string command', trustBoundary('allow'), 42],
    ['an oversized command', trustBoundary('allow'), 'x'.repeat(8_193)],
  ])('does not append verification control when %s', async (_label, boundary, command) => {
    const root = await tmpDir();
    const boardsDir = path.join(root, 'sdd-boards');
    const handler = new SddBoardWebSocketHandler(
      boardsDir,
      undefined,
      lifecyclePaths(root, boardsDir),
      boundary ? { trustBoundary: boundary } : undefined,
    );

    await handler.handleMessage({
      type: 'sdd.board.set_task_verification',
      payload: { runId: 'r1', taskId: 't1', verificationCommand: command },
    });

    expect(await readControl(boardsDir, 'r1')).toBe('');
  });

  it.each([undefined, '', 'x'.repeat(8_192)])(
    'preserves valid verification-control values %#',
    async (verificationCommand) => {
      const root = await tmpDir();
      const boardsDir = path.join(root, 'sdd-boards');
      const handler = new SddBoardWebSocketHandler(
        boardsDir,
        undefined,
        lifecyclePaths(root, boardsDir),
        { trustBoundary: trustBoundary('allow') },
      );

      await handler.handleMessage({
        type: 'sdd.board.set_task_verification',
        payload: { runId: 'r1', taskId: 't1', verificationCommand },
      });

      expect(await readControl(boardsDir, 'r1')).not.toBe('');
    },
  );

  it('authorizes command-bearing split criteria before appending control', async () => {
    const root = await tmpDir();
    const boardsDir = path.join(root, 'sdd-boards');
    const handler = new SddBoardWebSocketHandler(
      boardsDir,
      undefined,
      lifecyclePaths(root, boardsDir),
      { trustBoundary: trustBoundary('allow') },
    );

    await handler.handleMessage({
      type: 'sdd.board.split_task',
      payload: {
        runId: 'r1',
        taskId: 't1',
        subtasks: [{ title: 'child', description: 'work', successCriterion: 'run: pnpm test' }],
      },
    });

    expect(await readControl(boardsDir, 'r1')).toContain('run: pnpm test');
  });

  it.each([
    ['denied by the trust boundary', trustBoundary('deny'), 'run: pnpm test'],
    ['missing security dependencies', undefined, '$ pnpm test'],
    ['a non-string criterion', trustBoundary('allow'), 42],
    ['an oversized command', trustBoundary('allow'), `run: ${'x'.repeat(8_193)}`],
  ])(
    'does not append split control when a verification command is %s',
    async (_label, boundary, criterion) => {
      const root = await tmpDir();
      const boardsDir = path.join(root, 'sdd-boards');
      const handler = new SddBoardWebSocketHandler(
        boardsDir,
        undefined,
        lifecyclePaths(root, boardsDir),
        boundary ? { trustBoundary: boundary } : undefined,
      );

      await handler.handleMessage({
        type: 'sdd.board.split_task',
        payload: {
          runId: 'r1',
          taskId: 't1',
          subtasks: [{ title: 'child', description: 'work', successCriterion: criterion }],
        },
      });

      expect(await readControl(boardsDir, 'r1')).toBe('');
    },
  );
});
