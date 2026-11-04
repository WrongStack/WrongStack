import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { createBoard, deleteBoard, getBoard } from '@wrongstack/kanban';
import { addTask } from '@wrongstack/kanban/test-support';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createKanbanSupervisor } from '../src/webui-server/kanban-supervisor.js';

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    tempRoots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })),
  );
});

describe('kanban supervisor', () => {
  it('repairs status/column drift without dispatching an LLM', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-supervisor-'));
    tempRoots.push(projectRoot);
    const board = await createBoard(projectRoot, {
      title: 'Live work',
      supervisor: { enabled: true, mode: 'deterministic' },
    });
    const created = await addTask(projectRoot, board.id, {
      title: 'Already running',
      status: 'in_progress',
      columnId: 'backlog',
    });
    const dispatchTask = vi.fn();
    const broadcasts: Array<{ type: string; payload: unknown }> = [];
    const supervisor = createKanbanSupervisor({
      projectRoot,
      dispatchTask,
      broadcast: (message) => broadcasts.push(message),
    });

    try {
      const snapshots = await supervisor.auditNow(board.id);
      const updated = await getBoard(projectRoot, board.id);
      const task = updated?.tasks.find((candidate) => candidate.id === created?.task.id);

      expect(task?.status).toBe('in_progress');
      expect(task?.columnId).toBe('in-progress');
      expect(snapshots.at(-1)?.mode).toBe('deterministic');
      expect(dispatchTask).not.toHaveBeenCalled();
      expect(broadcasts.some((message) => message.type === 'kanban.supervisor.status')).toBe(true);
    } finally {
      supervisor.dispose();
    }
  });

  it('drops snapshots and schedules for boards deleted during a long-lived session', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-supervisor-prune-'));
    tempRoots.push(projectRoot);
    const board = await createBoard(projectRoot, { title: 'Temporary board' });
    const supervisor = createKanbanSupervisor({
      projectRoot,
      broadcast: () => {},
    });

    try {
      await supervisor.auditNow();
      expect(supervisor.getStats()).toMatchObject({
        snapshots: 1,
        scheduledBoards: 1,
      });

      await deleteBoard(projectRoot, board.id);
      await supervisor.auditNow();

      expect(supervisor.getSnapshot(board.id)).toBeUndefined();
      expect(supervisor.getStats()).toEqual({
        snapshots: 0,
        scheduledBoards: 0,
        agentCooldowns: 0,
        runningAgents: 0,
      });
    } finally {
      supervisor.dispose();
    }
  });

  it('broadcasts a board only when its audit finds something new, plus a slow heartbeat', async () => {
    const projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'kanban-supervisor-quiet-'));
    tempRoots.push(projectRoot);
    const board = await createBoard(projectRoot, {
      title: 'Quiet board',
      supervisor: { enabled: true, mode: 'deterministic' },
    });
    const statuses: Array<{ lastAuditAt?: string; summary?: string }> = [];
    const supervisor = createKanbanSupervisor({
      projectRoot,
      broadcast: (message) => {
        if (message.type !== 'kanban.supervisor.status') return;
        statuses.push(
          (message.payload as { data: { lastAuditAt?: string; summary?: string } }).data,
        );
      },
    });
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-11-03T10:00:00.000Z'));

    try {
      await supervisor.auditNow(board.id);
      vi.setSystemTime(new Date('2026-11-03T10:00:10.000Z'));
      await supervisor.auditNow(board.id);
      vi.setSystemTime(new Date('2026-11-03T10:00:20.000Z'));
      await supervisor.auditNow(board.id);

      expect(statuses).toHaveLength(1);
      expect(supervisor.getSnapshot(board.id)?.lastAuditAt).toBe('2026-11-03T10:00:20.000Z');

      await addTask(projectRoot, board.id, { title: 'New work', status: 'in_progress' });
      vi.setSystemTime(new Date('2026-11-03T10:00:30.000Z'));
      await supervisor.auditNow(board.id);

      expect(statuses).toHaveLength(2);
      expect(statuses[1]?.summary).not.toBe(statuses[0]?.summary);

      vi.setSystemTime(new Date('2026-11-03T10:05:31.000Z'));
      await supervisor.auditNow(board.id);

      expect(statuses).toHaveLength(3);
      expect(statuses[2]?.lastAuditAt).toBe('2026-11-03T10:05:31.000Z');
    } finally {
      vi.useRealTimers();
      supervisor.dispose();
    }
  });
});
