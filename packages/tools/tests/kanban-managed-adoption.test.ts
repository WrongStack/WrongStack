import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

describe('kanban tool — managed lifecycle adoption', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-adopt-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ctx = () => ({ projectRoot: dir }) as unknown as Context;

  it('adopts five existing columns without moving cards', async () => {
    const board = await createBoard(dir, {
      title: 'Legacy board',
      columns: [
        { id: 'backlog', title: 'Backlog', order: 0, wipLimit: 0 },
        { id: 'todo', title: 'Todo', order: 1, wipLimit: 0 },
        { id: 'running', title: 'Running', order: 2, wipLimit: 0 },
        { id: 'review', title: 'Review', order: 3, wipLimit: 0 },
        { id: 'done', title: 'Done', order: 4, wipLimit: 0 },
      ],
      tasks: [{ title: 'Active', columnId: 'running', status: 'in_progress' }],
    });

    const result = await kanbanTool.execute(
      {
        action: 'adopt_managed_lifecycle',
        boardId: board.id,
        columns: ['backlog', 'todo', 'running', 'review', 'done'],
        author: 'migration-agent',
        transitionComment: 'Adopt legacy stages without moving cards.',
      },
      ctx(),
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.board?.lifecycle?.mode).toBe('managed');
    expect(result.board?.tasks[0]).toMatchObject({
      columnId: 'running',
      status: 'in_progress',
      lifecycle: { currentStage: 'running' },
    });
  });

  it('rejects a malformed ordered column list before mutation', async () => {
    const board = await createBoard(dir, { title: 'Legacy board' });
    const result = await kanbanTool.execute(
      {
        action: 'adopt_managed_lifecycle',
        boardId: board.id,
        columns: ['backlog', 'todo'],
        author: 'migration-agent',
        transitionComment: 'Invalid adoption.',
      },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('ordered as backlog, todo, running, review, done');
  });
});
