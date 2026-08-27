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
    const board = await createBoard(projectRoot, { title: 'Live work' });
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
});
