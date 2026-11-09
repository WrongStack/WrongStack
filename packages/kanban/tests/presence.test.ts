import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeBoard } from '../src/storage.js';
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

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

describe('Kanban board presence', () => {
  it.each([
    [
      { sessionId: 'a:b', agentId: 'c' },
      { sessionId: 'a', agentId: 'b:c' },
    ],
    [
      { sessionId: 'a:b', agentId: 'c' },
      { sessionId: 'a%3Ab', agentId: 'c' },
    ],
  ])('keeps distinct identity pairs %j and %j separate', async (first, second) => {
    const board = await createBoard(tmpDir, { title: 'Distinct presence' });
    const seenAt = '2026-07-16T10:00:00.000Z';
    await touchKanbanPresence(tmpDir, board.id, { ...first, agentName: 'First', seenAt });
    await touchKanbanPresence(tmpDir, board.id, { ...second, agentName: 'Second', seenAt });
    await touchKanbanPresence(tmpDir, board.id, {
      ...first,
      taskId: 'new-task',
      seenAt: '2026-07-16T10:00:30.000Z',
    });
    const rows = (await getBoard(tmpDir, board.id))?.presence ?? [];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(
      rows.find((row) => row.sessionId === first.sessionId && row.agentId === first.agentId),
    ).toMatchObject({ ...first, agentName: 'First', firstSeenAt: seenAt, taskId: 'new-task' });
    expect(
      rows.find((row) => row.sessionId === second.sessionId && row.agentId === second.agentId),
    ).toMatchObject({ ...second, agentName: 'Second', firstSeenAt: seenAt });
  });

  it('refreshes legacy identity rows without duplicates or lost first-seen metadata', async () => {
    const board = await createBoard(tmpDir, { title: 'Legacy presence' });
    const times = {
      firstSeenAt: '2026-07-16T10:00:00.000Z',
      lastSeenAt: '2026-07-16T10:00:00.000Z',
      activeUntil: '2026-07-16T10:01:00.000Z',
      active: true,
    };
    await writeBoard(tmpDir, {
      ...board,
      presence: [
        { ...times, id: 'a:b:c', sessionId: 'a:b', agentId: 'c', agentName: 'First' },
        { ...times, id: 'a%3Ab:c', sessionId: 'a%3Ab', agentId: 'c', agentName: 'Second' },
      ],
    });
    await touchKanbanPresence(tmpDir, board.id, {
      sessionId: 'a:b',
      agentId: 'c',
      seenAt: '2026-07-16T10:00:30.000Z',
    });
    const rows = (await getBoard(tmpDir, board.id))?.presence ?? [];
    expect(rows).toHaveLength(2);
    expect(new Set(rows.map((row) => row.id)).size).toBe(2);
    expect(rows.find((row) => row.sessionId === 'a:b')).toMatchObject({
      id: 'a%3Ab:c',
      agentName: 'First',
      firstSeenAt: times.firstSeenAt,
    });
    expect(rows.find((row) => row.sessionId === 'a%3Ab')).toMatchObject({
      id: 'a%253Ab:c',
      agentName: 'Second',
    });
  });

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
