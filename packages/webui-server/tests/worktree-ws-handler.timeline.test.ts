import { join, resolve } from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import {
  projectWorktreeTimeline,
  type WorktreeTimelineEvent,
} from '@wrongstack/contracts/types/worktree-timeline';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

vi.mock('@wrongstack/core/worktree', () => ({ WorktreeManager: vi.fn() }));
vi.mock('@wrongstack/sdd', () => ({ cleanupStaleSddWorktrees: vi.fn() }));

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
  terminate = vi.fn();
  send = vi.fn((data: string) => {
    this.sent.push(JSON.parse(data) as Sent);
  });
  on(): void {}
}

const logger = () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn(), child: () => log };
  return log as never;
};

function managerWith(methods: Record<string, unknown>) {
  managerMock.mockImplementation(
    class {
      constructor() {
        Object.assign(this, methods);
      }
    } as never,
  );
}

const PROJ = resolve('/proj');
const timelineEvents = (ws: FakeWs): WorktreeTimelineEvent[] =>
  ws.sent
    .filter((m) => m.type === 'worktree.timeline_event')
    .map((m) => m.payload['event'] as WorktreeTimelineEvent);

let events: EventBus;
const emit = (event: string, payload: unknown) =>
  (events as unknown as { emit: (e: string, p: unknown) => void }).emit(event, payload);

beforeEach(() => {
  vi.clearAllMocks();
  events = new EventBus();
  managerWith({ listManaged: async () => ({ worktrees: [], branches: [] }) });
});

describe('WorktreeWebSocketHandler — timeline log', () => {
  it('keeps the lifecycle after release and replays it to a late client', async () => {
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: PROJ,
      boardsDir: '/boards',
    });
    const early = new FakeWs();
    handler.addClient(early as unknown as WebSocket);

    const base = { handleId: 'api-1', ownerId: 'p1', branch: 'wstack/ap/api-1', sessionId: 's1' };
    emit('worktree.allocated', { ...base, ownerLabel: 'API', baseBranch: 'main', at: 100 });
    emit('worktree.committed', {
      ...base,
      committed: true,
      insertions: 3,
      deletions: 1,
      files: 1,
      at: 200,
    });
    emit('worktree.merging', { ...base, baseBranch: 'main', at: 300 });
    emit('worktree.merged', { ...base, baseBranch: 'main', squash: true, at: 400 });
    emit('worktree.released', { ...base, kept: false, at: 500 });

    expect(timelineEvents(early).map((e) => e.kind)).toEqual([
      'allocated',
      'committed',
      'merging',
      'merged',
      'released',
    ]);
    // The live handle is gone after release…
    const state = early.sent.filter((m) => m.type === 'worktree.state').at(-1)?.payload;
    expect(state?.['worktrees']).toEqual([]);

    // …but a client connecting afterwards still receives the whole story.
    const late = new FakeWs();
    handler.addClient(late as unknown as WebSocket);
    const snapshot = late.sent.find((m) => m.type === 'worktree.timeline')?.payload['events'] as
      | WorktreeTimelineEvent[]
      | undefined;
    expect(snapshot?.map((e) => e.at)).toEqual([100, 200, 300, 400, 500]);
    const lane = projectWorktreeTimeline(snapshot ?? [], { now: 1000, sessionId: 's1' }).lanes[0];
    expect(lane?.outcome).toBe('merged');
    expect(lane?.segments.map((s) => s.phase)).toEqual(['working', 'queued', 'merging']);
    handler.dispose();
  });

  it('carries the failure reason into the live state and marks merging', async () => {
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: PROJ,
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    const base = { handleId: 'db-1', ownerId: 'p2', branch: 'wstack/ap/db-1' };
    emit('worktree.allocated', { ...base, ownerLabel: 'DB', baseBranch: 'main' });
    emit('worktree.merging', { ...base, baseBranch: 'main' });
    const merging = ws.sent.filter((m) => m.type === 'worktree.state').at(-1)?.payload;
    expect(merging?.['worktrees']).toEqual([expect.objectContaining({ status: 'merging' })]);

    emit('worktree.failed', { ...base, error: 'lint-staged failed', stage: 'commit' });
    const failed = ws.sent.filter((m) => m.type === 'worktree.state').at(-1)?.payload;
    expect(failed?.['worktrees']).toEqual([
      expect.objectContaining({ status: 'failed', lastError: 'lint-staged failed' }),
    ]);
    expect(timelineEvents(ws).at(-1)).toMatchObject({ kind: 'failed', stage: 'commit' });
    handler.dispose();
  });

  it('records panel merges, removals and the cleanup sweep, which emit no bus events', async () => {
    const dir = join(PROJ, '.wrongstack', 'worktrees', 'ui-2');
    managerWith({
      listManaged: async () => ({ worktrees: [], branches: [] }),
      mergeBranch: async () => ({ ok: true }),
      removeOne: async () => ({ removed: true }),
    });
    cleanupMock.mockResolvedValue({ swept: true, removed: 1, detected: 1 });
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: PROJ,
      boardsDir: '/boards',
    });
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);

    await handler.handleMessage({ type: 'worktree.merge', payload: { branch: 'wstack/ap/ui-1' } });
    await handler.handleMessage({
      type: 'worktree.remove',
      payload: { dir, branch: 'wstack/ap/ui-2' },
    });
    await handler.handleMessage({ type: 'worktree.cleanup' });

    expect(timelineEvents(ws)).toEqual([
      expect.objectContaining({ kind: 'merged', handleId: 'ui-1', branch: 'wstack/ap/ui-1' }),
      expect.objectContaining({ kind: 'released', handleId: 'ui-2', kept: false }),
      expect.objectContaining({ kind: 'released', handleId: 'cleanup-all', kept: false }),
    ]);
    handler.dispose();
  });

  it('bounds the log to the most recent events', async () => {
    const handler = new WorktreeWebSocketHandler(events, logger(), {
      projectRoot: PROJ,
      boardsDir: '/boards',
    });
    for (let i = 0; i < 1005; i++) {
      emit('worktree.released', { handleId: `h${i}`, ownerId: 'o', branch: 'b', kept: false });
    }
    const ws = new FakeWs();
    handler.addClient(ws as unknown as WebSocket);
    const snapshot = ws.sent.find((m) => m.type === 'worktree.timeline')?.payload['events'] as
      | WorktreeTimelineEvent[]
      | undefined;
    expect(snapshot).toHaveLength(1000);
    expect(snapshot?.[0]?.handleId).toBe('h5');
    handler.dispose();
  });
});
