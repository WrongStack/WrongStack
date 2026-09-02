import { afterEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import type { SddBoardSnapshot } from '@wrongstack/sdd';
import { SddBoardWebSocketHandler } from '@wrongstack/webui-server';

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
    paths: {
      projectSpecs: path.join(root, 'specs'),
      projectTaskGraphs: path.join(root, 'task-graphs'),
      projectSddSession: path.join(root, 'sdd-session.json'),
      projectSddBoards: boardsDir,
    },
  };
}

describe('SddBoardWebSocketHandler — lifecycle', () => {
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
});
