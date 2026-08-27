import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

/** Session that owns the board events these tests write. */
const TEST_CONTEXT_SESSION_ID = '2026-08-26/sess_01TESTTOOLSCONTEXT0000000';

describe('kanban tool — managed lifecycle adoption', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-adopt-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  const ctx = () =>
    ({ eventSessionId: () => TEST_CONTEXT_SESSION_ID, projectRoot: dir }) as unknown as Context;

  it('adopts five existing columns without moving cards', async () => {
    const board = await createBoard(dir, {
      title: 'Legacy board',
      // Columns are locked to DEFAULT_COLUMNS (backlog, todo, in-progress,
      // review, done). The lifecycle mapping below uses 'in-progress'.
      tasks: [{ title: 'Active', columnId: 'in-progress', status: 'in_progress' }],
    });

    const result = await kanbanTool.execute(
      {
        action: 'adopt_managed_lifecycle',
        boardId: board.id,
        columns: ['backlog', 'todo', 'in-progress', 'review', 'done'],
        author: 'migration-agent',
        transitionComment: 'Adopt legacy stages without moving cards.',
      },
      ctx(),
      { signal: newSignal() },
    );

    expect(result.ok).toBe(true);
    expect(result.board?.lifecycle?.mode).toBe('managed');
    expect(result.board?.tasks[0]).toMatchObject({
      columnId: 'in-progress',
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
