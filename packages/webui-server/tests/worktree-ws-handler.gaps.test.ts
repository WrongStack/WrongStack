import { resolve } from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

vi.mock('@wrongstack/core/worktree', () => ({
  WorktreeManager: vi.fn(),
}));
vi.mock('@wrongstack/sdd', () => ({
  cleanupStaleSddWorktrees: vi.fn(),
}));

import { WorktreeManager } from '@wrongstack/core/worktree';
import { cleanupStaleSddWorktrees } from '@wrongstack/sdd';
import { WorktreeWebSocketHandler } from '../src/server/worktree-ws-handler.js';

const managerMock = WorktreeManager as unknown as { mockImplementation: (impl: unknown) => void };
const cleanupMock = cleanupStaleSddWorktrees as unknown as ReturnType<typeof vi.fn>;

interface Sent {
  type: string;
  payload: Record<string, unknown>;
}

class FakeWs {
  readyState = 1;
  bufferedAmount = 0;
  sent: Sent[] = [];
  handlers = new Map<string, Array<() => void>>();
  terminate = vi.fn();
  send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data) as Sent);
  });
  on(event: string, cb: () => void): void {
    this.handlers.set(event, [...(this.handlers.get(event) ?? []), cb]);
  }
  emit(event: string): void {
    for (const cb of this.handlers.get(event) ?? []) cb();
  }
}

/** Last worktree.state payload as a non-optional record. */
function lastState(ws: {
  sent: Array<{ type: string; payload: Record<string, unknown> }>;
}): Record<string, unknown> {
  const message = ws.sent.filter((m) => m.type === 'worktree.state').at(-1);
  return (message as { payload: Record<string, unknown> }).payload;
}

function logger() {
  const log = {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    level: 'info',
    trace: vi.fn(),
    child: vi.fn(() => log),
  };
  return log as never;
}

function managerWith(methods: Record<string, unknown>) {
  managerMock.mockImplementation(
    class {
      constructor() {
        Object.assign(this, methods);
      }
    } as never,
  );
}

let events: EventBus;

beforeEach(() => {
  vi.clearAllMocks();
  cleanupMock.mockResolvedValue({ removed: 0 });
  events = new EventBus();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe('WorktreeWebSocketHandler — client lifecycle and dispatch', () => {
  it('sends the current state and orphan inventory to new clients', async () => {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    const log = logger();
    const handler = new WorktreeWebSocketHandler(events, log, {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    // State snapshot goes to the client; the orphan scan broadcasts to everyone.
    expect(ws.sent[0]?.type).toBe('worktree.state');
    await vi.waitFor(() => expect(ws.sent.some((m) => m.type === 'worktree.orphans')).toBe(true));
    const orphans = ws.sent.find((m) => m.type === 'worktree.orphans')?.payload;
    expect(orphans).toMatchObject({ orphans: [], canClean: true });
    handler.dispose();
  });

  it('forwards control messages and rejects unknown ones', async () => {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    expect(await handler.handleMessage({ type: 'worktree.scan' })).toBe(true);
    expect(await handler.handleMessage({ type: 'worktree.cleanup' })).toBe(true);
    expect(await handler.handleMessage({ type: 'other.thing' })).toBe(false);
    handler.dispose();
  });

  it('drops clients that close or error', async () => {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    ws.emit('close');
    // After the client is gone, broadcasts reach nobody without throwing.
    await handler.handleMessage({ type: 'worktree.scan' });
    expect(ws.sent.length).toBeGreaterThan(0);
    handler.dispose();
  });
});

describe('WorktreeWebSocketHandler — lifecycle events', () => {
  function emit(event: string, payload: unknown): void {
    (events as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);
  }

  it('tracks allocation, commit, merge, conflict, and release', async () => {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);

    emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'run-1',
      ownerLabel: 'phase 1',
      dir: '/proj/.wrongstack/worktrees/h1',
      branch: 'wstack/ap/h1',
      baseBranch: 'main',
    });
    let state = lastState(ws);
    expect(state['worktrees']).toHaveLength(1);
    expect(state['baseBranch']).toBe('main');

    emit('worktree.committed', {
      handleId: 'h1',
      insertions: 3,
      deletions: 1,
      files: 2,
      committed: true,
    });
    state = lastState(ws);
    expect((state['worktrees'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: 'committing',
      insertions: 3,
      deletions: 1,
      files: 2,
    });

    emit('worktree.conflict', { handleId: 'h1', conflictFiles: ['a.ts'] });
    state = lastState(ws);
    expect((state['worktrees'] as Array<Record<string, unknown>>)[0]).toMatchObject({
      status: 'needs-review',
      conflictFiles: ['a.ts'],
    });

    emit('worktree.failed', { handleId: 'h1', error: 'boom' });
    state = lastState(ws);
    expect((state['worktrees'] as Array<Record<string, unknown>>)[0]?.['status']).toBe('failed');

    // Kept-for-review release retains the handle; a full release drops it.
    emit('worktree.released', { handleId: 'h1', kept: true });
    state = lastState(ws);
    expect(state['worktrees']).toHaveLength(1);

    emit('worktree.released', { handleId: 'h1', kept: false });
    state = lastState(ws);
    expect(state['worktrees']).toHaveLength(0);

    expect(ws.sent.some((m) => m.type === 'worktree.event')).toBe(true);
    handler.dispose();
  });

  it('caps the recent activity strip at six entries', async () => {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'o',
      ownerLabel: 'l',
      branch: 'wstack/ap/h1',
      baseBranch: 'main',
    });
    for (let i = 0; i < 10; i++) {
      emit('worktree.failed', { handleId: 'h1', error: `fail ${i}` });
    }
    const state = lastState(ws);
    const handle = (state['worktrees'] as Array<Record<string, unknown>>)[0];
    expect(handle).toBeDefined();
    expect((handle as Record<string, unknown>)['recentActivity'] as unknown[]).toHaveLength(6);
    handler.dispose();
  });
});

describe('WorktreeWebSocketHandler — orphan scan', () => {
  it('reports an empty inventory when management deps are missing', async () => {
    const handler = new WorktreeWebSocketHandler(events, logger());
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    await vi.waitFor(() => expect(ws.sent.some((m) => m.type === 'worktree.orphans')).toBe(true));
    expect(ws.sent.find((m) => m.type === 'worktree.orphans')?.payload).toMatchObject({
      orphans: [],
      canClean: false,
    });
    handler.dispose();
  });

  it('separates worktree orphans from branch-only orphans', async () => {
    managerWith({
      listManaged: async () => ({
        worktrees: [{ dir: '/proj/.wrongstack/worktrees/a', branch: 'wstack/ap/a' }],
        branches: ['wstack/ap/a', 'wstack/ap/b'],
      }),
    });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    await vi.waitFor(() => expect(ws.sent.some((m) => m.type === 'worktree.orphans')).toBe(true));
    expect(ws.sent.find((m) => m.type === 'worktree.orphans')?.payload).toMatchObject({
      canClean: true,
      orphans: [
        { kind: 'worktree', dir: '/proj/.wrongstack/worktrees/a', branch: 'wstack/ap/a' },
        { kind: 'branch', branch: 'wstack/ap/b' },
      ],
    });
    handler.dispose();
  });

  it('excludes live-owned branches and reports canClean false', async () => {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    (events as unknown as { emit: (e: string, p: unknown) => void }).emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'o',
      ownerLabel: 'l',
      branch: 'wstack/ap/live',
      baseBranch: 'main',
    });
    managerWith({
      listManaged: async () => ({
        worktrees: [{ dir: '/proj/.wrongstack/worktrees/live', branch: 'wstack/ap/live' }],
        branches: [],
      }),
    });
    await handler.handleMessage({ type: 'worktree.scan' });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    await vi.waitFor(() => expect(ws.sent.some((m) => m.type === 'worktree.orphans')).toBe(true));
    const payload = ws.sent.find((m) => m.type === 'worktree.orphans')?.payload;
    expect(payload?.['orphans']).toEqual([]);
    expect(payload?.['canClean']).toBe(false);
    expect(payload?.['reason']).toBe('a run is live in this session');
    handler.dispose();
  });

  it('broadcasts an empty inventory when the scan throws', async () => {
    managerWith({
      listManaged: async () => {
        throw new Error('git broken');
      },
    });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    await vi.waitFor(() => expect(ws.sent.some((m) => m.type === 'worktree.orphans')).toBe(true));
    expect(ws.sent.find((m) => m.type === 'worktree.orphans')?.payload).toMatchObject({
      orphans: [],
      canClean: false,
    });
    handler.dispose();
  });
});

describe('WorktreeWebSocketHandler — cleanup', () => {
  it('refuses cleanup without management deps or with a live run', async () => {
    const noDeps = new WorktreeWebSocketHandler(events, logger());
    const ws1 = new FakeWs();
    noDeps.addClient(ws1 as unknown as WebSocket);
    await noDeps.handleMessage({ type: 'worktree.cleanup' });
    expect(ws1.sent.find((m) => m.type === 'worktree.cleanup_result')?.payload).toMatchObject({
      ok: false,
      reason: 'cleanup is not available in this session',
    });
    noDeps.dispose();

    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    const live = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    (events as unknown as { emit: (e: string, p: unknown) => void }).emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'o',
      ownerLabel: 'l',
      branch: 'wstack/ap/live',
      baseBranch: 'main',
    });
    const ws2 = new FakeWs();
    live.addClient(ws2 as unknown as WebSocket);
    await live.handleMessage({ type: 'worktree.cleanup' });
    expect(ws2.sent.find((m) => m.type === 'worktree.cleanup_result')?.payload).toMatchObject({
      ok: false,
      reason: 'a run is live in this session — stop it first',
    });
    live.dispose();
  });

  it('relays skip reasons from the stale-worktree cleanup', async () => {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    cleanupMock.mockResolvedValue({ skippedReason: 'another process owns the board' });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage({ type: 'worktree.cleanup' });
    expect(ws.sent.find((m) => m.type === 'worktree.cleanup_result')?.payload).toMatchObject({
      ok: false,
      reason: 'another process owns the board',
    });
    handler.dispose();
  });

  it('reports removed worktrees and drops stale handles', async () => {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
    cleanupMock.mockResolvedValue({ removed: 3 });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    (events as unknown as { emit: (e: string, p: unknown) => void }).emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'o',
      ownerLabel: 'l',
      branch: 'wstack/ap/gone',
      baseBranch: 'main',
    });
    (events as unknown as { emit: (e: string, p: unknown) => void }).emit('worktree.failed', {
      handleId: 'h1',
      error: 'done for',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    await handler.handleMessage({ type: 'worktree.cleanup' });
    expect(ws.sent.find((m) => m.type === 'worktree.cleanup_result')?.payload).toMatchObject({
      ok: true,
      removed: 3,
    });
    const state = lastState(ws);
    expect(state['worktrees']).toHaveLength(0);
    handler.dispose();
  });
});

describe('WorktreeWebSocketHandler — per-row operations', () => {
  function handlerWith(methods: Record<string, unknown>) {
    managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }), ...methods });
    const h = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: '/proj',
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    h.addClient(ws as unknown as WebSocket);
    return { h, ws };
  }

  it('refuses removals without targets or with unsafe targets', async () => {
    const { h, ws } = handlerWith({});
    await h.handleMessage({ type: 'worktree.remove', payload: {} });
    expect(ws.sent.find((m) => m.type === 'worktree.cleanup_result')?.payload).toMatchObject({
      ok: false,
      reason: 'nothing to remove',
    });

    await h.handleMessage({ type: 'worktree.remove', payload: { branch: 'main' } });
    expect(
      ws.sent.filter((m) => m.type === 'worktree.cleanup_result').at(-1)?.payload,
    ).toMatchObject({ ok: false, reason: 'not a managed worktree branch' });

    await h.handleMessage({
      type: 'worktree.remove',
      payload: { dir: 'C:/evil/checkout' },
    });
    expect(
      ws.sent.filter((m) => m.type === 'worktree.cleanup_result').at(-1)?.payload,
    ).toMatchObject({ ok: false, reason: 'path is outside the managed worktrees root' });
    h.dispose();
  });

  it('refuses removal of a live branch and relays removeOne results', async () => {
    const removeOne = vi.fn(async () => ({ removed: true }));
    const { h, ws } = handlerWith({ removeOne });
    (events as unknown as { emit: (e: string, p: unknown) => void }).emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'o',
      ownerLabel: 'l',
      branch: 'wstack/ap/live',
      baseBranch: 'main',
    });
    await h.handleMessage({
      type: 'worktree.remove',
      payload: { branch: 'wstack/ap/live' },
    });
    expect(
      ws.sent.filter((m) => m.type === 'worktree.cleanup_result').at(-1)?.payload,
    ).toMatchObject({ ok: false, reason: 'a run is live on this worktree — stop it first' });

    await h.handleMessage({
      type: 'worktree.remove',
      payload: { dir: '/proj/.wrongstack/worktrees/old', branch: 'wstack/ap/old' },
    });
    expect(removeOne).toHaveBeenCalledWith('/proj/.wrongstack/worktrees/old', 'wstack/ap/old');
    expect(
      ws.sent.filter((m) => m.type === 'worktree.cleanup_result').at(-1)?.payload,
    ).toMatchObject({ ok: true, removed: 1 });
    h.dispose();
  });

  it('refuses merges without a branch, on unsafe branches, or on live runs', async () => {
    const mergeBranch = vi.fn(async () => ({ ok: true }));
    const { h, ws } = handlerWith({ mergeBranch });
    await h.handleMessage({ type: 'worktree.merge', payload: {} });
    expect(ws.sent.find((m) => m.type === 'worktree.merge_result')?.payload).toMatchObject({
      ok: false,
      reason: 'no branch',
    });

    await h.handleMessage({ type: 'worktree.merge', payload: { branch: '--force' } });
    expect(ws.sent.filter((m) => m.type === 'worktree.merge_result').at(-1)?.payload).toMatchObject(
      { ok: false, reason: 'not a managed worktree branch' },
    );

    (events as unknown as { emit: (e: string, p: unknown) => void }).emit('worktree.allocated', {
      handleId: 'h1',
      ownerId: 'o',
      ownerLabel: 'l',
      branch: 'wstack/ap/live',
      baseBranch: 'main',
    });
    await h.handleMessage({ type: 'worktree.merge', payload: { branch: 'wstack/ap/live' } });
    expect(ws.sent.filter((m) => m.type === 'worktree.merge_result').at(-1)?.payload).toMatchObject(
      { ok: false, reason: 'a run is live on this worktree — stop it first' },
    );
    h.dispose();
  });

  it('relays merge results with conflict details', async () => {
    const mergeBranch = vi.fn(async () => ({
      ok: false,
      conflict: true,
      conflictFiles: ['a.ts', 'b.ts'],
      reason: 'conflict',
    }));
    const { h, ws } = handlerWith({ mergeBranch });
    await h.handleMessage({ type: 'worktree.merge', payload: { branch: 'wstack/ap/m' } });
    expect(ws.sent.find((m) => m.type === 'worktree.merge_result')?.payload).toMatchObject({
      ok: false,
      branch: 'wstack/ap/m',
      conflict: true,
      conflictFiles: ['a.ts', 'b.ts'],
    });
    h.dispose();
  });

  it('guards diff targets and relays summaries', async () => {
    const diffSummary = vi.fn(async () => ({ files: 2, insertions: 5, deletions: 1 }));
    const { h, ws } = handlerWith({ diffSummary });
    await h.handleMessage({ type: 'worktree.diff', payload: { dir: '/outside' } });
    expect(ws.sent.find((m) => m.type === 'worktree.diff_result')?.payload).toMatchObject({
      dir: '/outside',
      summary: null,
    });

    await h.handleMessage({
      type: 'worktree.diff',
      payload: { dir: '/proj/.wrongstack/worktrees/a', baseBranch: 'main' },
    });
    // An unmanaged baseBranch is ignored (treated as detected base).
    expect(diffSummary).toHaveBeenCalledWith(resolve('/proj/.wrongstack/worktrees/a'), undefined);
    expect(ws.sent.filter((m) => m.type === 'worktree.diff_result').at(-1)?.payload).toMatchObject({
      summary: { files: 2, insertions: 5, deletions: 1 },
    });
    h.dispose();
  });

  it('passes a managed baseBranch through to the diff', async () => {
    const diffSummary = vi.fn(async () => null);
    const { h } = handlerWith({ diffSummary });
    await h.handleMessage({
      type: 'worktree.diff',
      payload: { dir: '/proj/.wrongstack/worktrees/a', baseBranch: 'wstack/ap/base' },
    });
    expect(diffSummary).toHaveBeenCalledWith(
      resolve('/proj/.wrongstack/worktrees/a'),
      'wstack/ap/base',
    );
    h.dispose();
  });
});
