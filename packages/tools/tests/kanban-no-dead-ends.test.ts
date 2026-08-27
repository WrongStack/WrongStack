import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Context } from '@wrongstack/core/agent';
import { createBoard, getBoard } from '@wrongstack/kanban';
import { addTask } from '@wrongstack/kanban/test-support';
import { beforeEach, describe, expect, it } from 'vitest';
import { kanbanTool } from '../src/kanban.js';
import { newSignal } from './fixtures.js';

/**
 * The managed lifecycle may refuse a transition. It may never leave a caller
 * with no way forward.
 *
 * Every gate below is legitimate — a card should not reach Done with unmet
 * criteria, unfinished children, or unsatisfied dependencies. What made them
 * dead ends was that the state they demand could be entered but never left:
 * a dependency could be added and not removed, `split_atomic` set `atomic`
 * with nothing to unset it, and a criterion could be added but not dropped.
 * Each refusal then pointed at work the caller did not want to do, and the
 * only real escape was `release_managed_lifecycle` — dropping the ceremony
 * for the whole board because of one card.
 *
 * These tests assert the escape exists for each gate, and that the refusal
 * message names it. They are deliberately written as the recovery path a
 * caller would actually take.
 */
let dir: string;

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-kanban-deadends-'));
});

const eventContext = { sessionId: '2026-08-26/sess_TESTDEADENDS' };
const ctx = () =>
  ({
    projectRoot: dir,
    eventSessionId: () => eventContext.sessionId,
    setCurrentKanbanTask() {},
  }) as unknown as Context;
const run = (input: Record<string, unknown>) =>
  kanbanTool.execute(input as never, ctx(), { signal: newSignal() });

async function managedBoard(): Promise<string> {
  const board = await createBoard(dir, {
    title: 'Managed board',
    columns: [
      { id: 'backlog', title: 'Backlog', order: 0 },
      { id: 'todo', title: 'Todo', order: 1 },
      { id: 'in-progress', title: 'Running', order: 2 },
      { id: 'review', title: 'Review', order: 3 },
      { id: 'done', title: 'Done', order: 4 },
    ],
    lifecycle: {
      mode: 'managed',
      columns: {
        backlog: 'backlog',
        todo: 'todo',
        running: 'in-progress',
        review: 'review',
        done: 'done',
      },
    },
  });
  return board.id;
}

const card = (boardId: string, title: string) =>
  addTask(
    dir,
    boardId,
    { title, description: `${title} description`, assignee: 'agent-1' },
    eventContext,
  );

const taskOf = async (boardId: string, taskId: string) =>
  (await getBoard(dir, boardId))!.tasks.find((t) => t.id === taskId);

describe('managed lifecycle has no dead ends', () => {
  it('a dependency recorded in error can be cleared', async () => {
    const boardId = await managedBoard();
    const blocker = await card(boardId, 'Blocker');
    const blocked = await card(boardId, 'Blocked');
    await run({
      action: 'add_dependency',
      boardId,
      taskId: blocked!.task.id,
      dependencyTaskId: blocker!.task.id,
    });
    expect((await taskOf(boardId, blocked!.task.id))?.dependsOn).toEqual([blocker!.task.id]);

    // An explicit empty array is a clear, not a no-op. This used to collapse
    // to `undefined` and silently leave the dependency in place.
    const cleared = await run({
      action: 'update_task',
      boardId,
      taskId: blocked!.task.id,
      dependsOn: [],
    });
    expect(cleared.ok).toBe(true);
    expect((await taskOf(boardId, blocked!.task.id))?.dependsOn ?? []).toEqual([]);
  });

  it('the dependency refusal names the way out', async () => {
    const boardId = await managedBoard();
    const blocker = await card(boardId, 'Blocker');
    const blocked = await card(boardId, 'Blocked');
    await run({
      action: 'add_dependency',
      boardId,
      taskId: blocked!.task.id,
      dependencyTaskId: blocker!.task.id,
    });
    await run({
      action: 'add_check',
      boardId,
      taskId: blocked!.task.id,
      checkDescription: 'It works',
    });

    const refused = await run({
      action: 'start_task',
      boardId,
      taskId: blocked!.task.id,
      author: 'agent-1',
      transitionComment: 'Trying to start behind a dependency.',
    });
    expect(refused.ok).toBe(false);
    expect(refused.message).toContain('dependsOn');
  });

  it('a composite parent stranded without children can become a leaf again', async () => {
    const boardId = await managedBoard();
    const parent = await card(boardId, 'Composite');
    await run({
      action: 'split_atomic',
      boardId,
      taskId: parent!.task.id,
      childTitles: ['Child A'],
    });
    const withChildren = await taskOf(boardId, parent!.task.id);
    expect(withChildren?.atomic).toBe(true);

    // The children turn out to be unnecessary and are dropped.
    for (const childId of withChildren?.childTaskIds ?? []) {
      await run({ action: 'delete_task', boardId, taskId: childId });
    }
    const stranded = await taskOf(boardId, parent!.task.id);
    expect(stranded?.atomic).toBe(true);
    expect(stranded?.childTaskIds ?? []).toEqual([]);

    // `split_atomic` used to be a one-way door: nothing on the tool surface
    // could unset `atomic`, so this card could never move forward again.
    const relaxed = await run({
      action: 'update_task',
      boardId,
      taskId: parent!.task.id,
      atomic: false,
      childTaskIds: [],
    });
    expect(relaxed.ok).toBe(true);
    expect((await taskOf(boardId, parent!.task.id))?.atomic).toBe(false);
  });

  it('an acceptance criterion that no longer applies can be removed', async () => {
    const boardId = await managedBoard();
    const t = await card(boardId, 'Card');
    await run({
      action: 'add_check',
      boardId,
      taskId: t!.task.id,
      checkDescription: 'Criterion that turned out to be irrelevant',
      checkStatus: 'skipped',
    });
    const checkId = (await taskOf(boardId, t!.task.id))!.successCriteria![0]!.id;

    // Done refuses while any criterion is not `passed`. Without removal the
    // only alternatives were marking it passed — a lie — or parking the card.
    const removed = await run({ action: 'remove_check', boardId, taskId: t!.task.id, checkId });
    expect(removed.ok).toBe(true);
    expect((await taskOf(boardId, t!.task.id))?.successCriteria ?? []).toEqual([]);
  });

  it('the unmet-criteria refusal names each criterion and the removal escape', async () => {
    const boardId = await managedBoard();
    const t = await card(boardId, 'Card');
    await run({
      action: 'add_check',
      boardId,
      taskId: t!.task.id,
      checkDescription: 'Not yet settled',
    });
    await run({
      action: 'start_task',
      boardId,
      taskId: t!.task.id,
      author: 'agent-1',
      transitionComment: 'Starting.',
    });
    await run({
      action: 'mark_assignment',
      boardId,
      taskId: t!.task.id,
      assignmentStatus: 'running',
      agentId: 'agent-1',
      lastResult: 'Implemented the change.',
    });
    await run({
      action: 'transition_task',
      boardId,
      taskId: t!.task.id,
      lifecycleStage: 'review',
      author: 'agent-1',
      transitionComment: 'Ready for review.',
    });

    const refused = await run({
      action: 'transition_task',
      boardId,
      taskId: t!.task.id,
      lifecycleStage: 'done',
      author: 'agent-1',
      transitionComment: 'Accepting.',
      transitionAction: 'Reviewed and accepted.',
    });
    expect(refused.ok).toBe(false);
    // Says which criterion, and that removal is the honest alternative to
    // passing one that did not hold.
    expect(refused.message).toContain('Not yet settled');
    expect(refused.message).toContain('remove_check');
  });

  it('a card with no criteria at all is told to add one, not to pass nothing', async () => {
    const boardId = await managedBoard();
    const t = await card(boardId, 'Card');
    // Forward movement demands criteria, so the empty case surfaces here.
    const refused = await run({
      action: 'start_task',
      boardId,
      taskId: t!.task.id,
      author: 'agent-1',
      transitionComment: 'Starting without criteria.',
    });
    expect(refused.ok).toBe(false);
    // The readiness gate catches this before the Done gate ever sees it, and
    // says what to add rather than telling the caller to pass criteria that
    // do not exist.
    expect(refused.message).toContain('acceptance criterion');
    expect(refused.message).not.toContain('update_check');
  });

  it('release_managed_lifecycle is always available as the last resort', async () => {
    const boardId = await managedBoard();
    const t = await card(boardId, 'Card');
    const released = await run({ action: 'release_managed_lifecycle', boardId });
    expect(released.ok).toBe(true);

    // Cards and history survive, and the board now moves without ceremony.
    const board = await getBoard(dir, boardId);
    expect(board?.lifecycle).toBeFalsy();
    expect(board?.tasks.some((task) => task.id === t!.task.id)).toBe(true);
  });
});
