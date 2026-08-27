import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  createBoard,
  getBoard,
  listBoards,
  touchKanbanPresence,
  withLiveKanbanPresence,
} from './helpers/session-manager.js';

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-presence-'));
});

describe('Kanban board presence', () => {
  it('records one live row per session and agent and refreshes last-seen metadata', async () => {
    const board = await createBoard(tmpDir, { title: 'Presence' });
    await touchKanbanPresence(tmpDir, board.id, {
      sessionId: 'session-a',
      agentId: 'agent-a',
      agentName: 'Ada',
      taskId: 'task-1',
      seenAt: '2026-07-16T10:00:00.000Z',
      ttlMs: 60_000,
    });
    await touchKanbanPresence(tmpDir, board.id, {
      sessionId: 'session-a',
      agentId: 'agent-a',
      agentName: 'Ada',
      taskId: 'task-2',
      runTaskId: 'run-2',
      seenAt: '2026-07-16T10:00:30.000Z',
      ttlMs: 60_000,
    });

    const loaded = await getBoard(tmpDir, board.id);
    expect(loaded?.presence).toHaveLength(1);
    expect(loaded?.presence?.[0]).toMatchObject({
      id: 'session-a:agent-a',
      sessionId: 'session-a',
      agentId: 'agent-a',
      agentName: 'Ada',
      taskId: 'task-2',
      runTaskId: 'run-2',
      firstSeenAt: '2026-07-16T10:00:00.000Z',
      lastSeenAt: '2026-07-16T10:00:30.000Z',
    });
    expect((await listBoards(tmpDir))[0]?.presence).toHaveLength(1);
  });

  it('derives inactive state after the active-until deadline', async () => {
    const board = await createBoard(tmpDir, { title: 'Expiry' });
    const touched = await touchKanbanPresence(tmpDir, board.id, {
      sessionId: 'session-a',
      agentId: 'agent-a',
      seenAt: '2026-07-16T10:00:00.000Z',
      ttlMs: 1_000,
    });

    expect(
      withLiveKanbanPresence(touched!, new Date('2026-07-16T10:00:00.500Z')).presence?.[0]?.active,
    ).toBe(true);
    expect(
      withLiveKanbanPresence(touched!, new Date('2026-07-16T10:00:02.000Z')).presence?.[0]?.active,
    ).toBe(false);
  });
});
