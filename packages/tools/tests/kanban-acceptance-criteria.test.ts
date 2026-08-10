import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { addTask, createBoard, getBoard } from '@wrongstack/kanban';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

/**
 * The Done gate (`validateDefinitionOfDone`) refuses to advance a card while
 * any acceptance criterion is not `passed`. These tests pin the agent-facing
 * escape route, because a card whose criteria cannot be passed from the tool
 * surface is a card parked in Review forever.
 */
describe('kanban tool — acceptance criteria are agent-writable', () => {
  let dir: string;
  const ctx = () => ({ projectRoot: dir }) as unknown as Context;

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-criteria-'));
  });

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true });
  });

  async function seed() {
    const board = await createBoard(dir, {
      title: 'Criteria board',
      columns: [{ id: 'todo', title: 'Todo', order: 0 }],
    });
    const created = await addTask(dir, board.id, { title: 'Parent card' });
    return { boardId: board.id, taskId: created!.task.id };
  }

  it('add_check writes onto successCriteria, the array the Done gate reads', async () => {
    const { boardId, taskId } = await seed();

    const result = await kanbanTool.execute(
      { action: 'add_check', boardId, taskId, checkDescription: 'Typecheck passes' },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(true);

    // There is no second `task.checks[]` store: the gate and the tool operate
    // on the same array, so an added criterion is immediately gate-relevant.
    const task = (await getBoard(dir, boardId))?.tasks.find((t) => t.id === taskId);
    expect(task?.successCriteria).toHaveLength(1);
    expect(task?.successCriteria?.[0]?.description).toBe('Typecheck passes');
    expect(task?.successCriteria?.[0]?.status).toBe('pending');
  });

  it('update_check moves a criterion to passed and clears the gate', async () => {
    const { boardId, taskId } = await seed();
    await kanbanTool.execute(
      { action: 'add_check', boardId, taskId, checkDescription: 'Typecheck passes' },
      ctx(),
      { signal: newSignal() },
    );
    const checkId = (await getBoard(dir, boardId))?.tasks.find((t) => t.id === taskId)
      ?.successCriteria?.[0]?.id;
    expect(checkId).toBeTruthy();

    const result = await kanbanTool.execute(
      { action: 'update_check', boardId, taskId, checkId, checkStatus: 'passed' },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(true);

    const task = (await getBoard(dir, boardId))?.tasks.find((t) => t.id === taskId);
    expect(task?.successCriteria?.[0]?.status).toBe('passed');
    // A passed criterion is stamped, so review has an audit trail rather than
    // a bare boolean flip.
    expect(task?.successCriteria?.[0]?.checkedAt).toBeTruthy();
  });

  it('add_check may seed a criterion already passed', async () => {
    const { boardId, taskId } = await seed();
    await kanbanTool.execute(
      {
        action: 'add_check',
        boardId,
        taskId,
        checkDescription: 'Reviewed by hand',
        checkStatus: 'passed',
      },
      ctx(),
      { signal: newSignal() },
    );
    const task = (await getBoard(dir, boardId))?.tasks.find((t) => t.id === taskId);
    expect(task?.successCriteria?.[0]?.status).toBe('passed');
  });

  it('reports a missing criterion instead of silently succeeding', async () => {
    const { boardId, taskId } = await seed();
    const result = await kanbanTool.execute(
      { action: 'update_check', boardId, taskId, checkId: 'no-such-check', checkStatus: 'passed' },
      ctx(),
      { signal: newSignal() },
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('Check not found');
  });
});
