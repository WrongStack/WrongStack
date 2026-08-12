import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import type { KanbanToolOutput } from '../src/kanban-tool-types.js';

// serialize() shapes the TRANSCRIPT payload only — execute()'s return value is
// untouched, so programmatic consumers (todo mirror, gates) keep the full board.

const now = '2026-06-15T00:00:00.000Z';

function mkBoard(taskCount: number, padBytes = 0): KanbanBoard {
  const pad = 'x'.repeat(padBytes);
  const tasks: KanbanTask[] = Array.from({ length: taskCount }, (_, i) => ({
    id: `t${i}`,
    title: `Task ${i} ${pad}`,
    columnId: i % 2 === 0 ? 'todo' : 'done',
    order: i,
    priority: 'medium',
    status: 'pending',
    createdAt: now,
    updatedAt: now,
  })) as KanbanTask[];
  return {
    id: 'b1',
    title: 'Board',
    version: 1,
    revision: 0,
    createdAt: now,
    updatedAt: now,
    columns: [
      { id: 'todo', title: 'Todo', order: 0 },
      { id: 'done', title: 'Done', order: 1 },
    ],
    tasks,
  } as unknown as KanbanBoard;
}

function out(board: KanbanBoard, task?: KanbanTask): KanbanToolOutput {
  return { ok: true, message: 'Task added.', board, task: task ?? board.tasks[0] };
}

describe('kanbanTool.serialize (transcript board trimming)', () => {
  it('keeps a small board payload intact for mutations', () => {
    const board = mkBoard(3);
    const text = kanbanTool.serialize!(out(board), { action: 'add_task' });
    const parsed = JSON.parse(text) as KanbanToolOutput;
    expect((parsed.board as KanbanBoard).tasks).toHaveLength(3);
    expect(parsed.message).toBe('Task added.');
  });

  it('replaces a >16KB board with a compact summary on mutations', () => {
    const board = mkBoard(40, 600); // well over the 16KB cap once serialized
    const text = kanbanTool.serialize!(out(board), { action: 'add_task' });
    const parsed = JSON.parse(text) as {
      message: string;
      task?: KanbanTask;
      board: { columns: Record<string, number>; totalTasks: number; note: string };
    };
    expect(parsed.board.totalTasks).toBe(40);
    expect(parsed.board.columns).toEqual({ Todo: 20, Done: 20 });
    expect(parsed.board.note).toMatch(/omitted from the transcript/);
    // The affected task and the message survive the trim.
    expect(parsed.task?.id).toBe('t0');
    expect(parsed.message).toBe('Task added.');
    expect(text.length).toBeLessThan(JSON.stringify(out(board)).length / 4);
  });

  it('keeps the full board for get_board — that is its purpose', () => {
    const board = mkBoard(40, 600);
    const text = kanbanTool.serialize!(out(board), { action: 'get_board' });
    const parsed = JSON.parse(text) as KanbanToolOutput;
    expect((parsed.board as KanbanBoard).tasks).toHaveLength(40);
  });
});
