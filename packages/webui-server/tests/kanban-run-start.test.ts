/**
 * `kanban.run.start` against real boards on disk. The standalone engine answered "unavailable";
 * the CLI-hosted WebUI and the engine now share one implementation. The Goal handler, the run
 * mirror and the socket are recorders.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createBoard } from '@wrongstack/kanban';
import { addTask } from '@wrongstack/kanban/test-support';
import { afterEach, describe, expect, it } from 'vitest';
import { createKanbanRunStart } from '../src/server/kanban-run-start.js';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function setup(options: { tasks?: string[] } = {}) {
  const root = await mkdtemp(join(tmpdir(), 'kanban-run-start-'));
  roots.push(root);
  const board = await createBoard(root, { title: 'Desktop launch' });
  for (const title of options.tasks ?? ['Write the parser', 'Test the parser']) {
    await addTask(root, board.id, { title });
  }
  const sent: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const goalMessages: Array<{ type: string; payload: Record<string, unknown> }> = [];
  const bound: string[] = [];
  const start = createKanbanRunStart({
    agent: {} as never,
    events: {} as never,
    getProjectRoot: () => root,
    goalHandler: {
      handleMessage: async (_ws, message) => {
        goalMessages.push(message as never);
      },
    },
    kanbanRunMirror: {
      bind: () => {},
      bindGoalNext: (boardId) => bound.push(boardId),
    },
    send: (_ws, message) => sent.push(message as never),
  });
  const run = (payload: Record<string, unknown>) =>
    start({} as never, { type: 'kanban.run.start', payload } as never);
  return { boardId: board.id, sent, goalMessages, bound, run };
}

describe('kanban.run.start', () => {
  it("starts a Goal run from the board's tasks and binds it back to that board", async () => {
    const h = await setup();
    await h.run({ boardId: h.boardId, engine: 'goal' });
    expect(h.bound).toEqual([h.boardId]);
    expect(h.goalMessages).toHaveLength(1);
    const goal = h.goalMessages[0]!;
    expect(goal.type).toBe('goal.start');
    expect(goal.payload).toMatchObject({ title: 'Desktop launch', autonomous: false });
    const titles = (goal.payload['phases'] as Array<{ taskTemplates: { title: string }[] }>)
      .flatMap((phase) => phase.taskTemplates.map((task) => task.title))
      .sort();
    expect(titles).toEqual(['Test the parser', 'Write the parser']);
    expect(h.sent.at(-1)).toEqual({
      type: 'kanban.run.start',
      payload: { success: true, data: { engine: 'goal', boardId: h.boardId } },
    });
  });

  it('refuses a missing board, an empty board and an SDD run without worker agents', async () => {
    const h = await setup();
    await h.run({ boardId: 'no-such-board', engine: 'goal' });
    await h.run({ boardId: h.boardId, engine: 'sdd' });
    await h.run({ boardId: h.boardId });
    const empty = await setup({ tasks: [] });
    await empty.run({ boardId: empty.boardId, engine: 'goal' });
    expect(h.sent.map((message) => message.payload['error'])).toEqual([
      'Board not found: no-such-board',
      'SDD runs need the multi-agent host, which is not available here.',
      'boardId and engine required',
    ]);
    expect(empty.sent[0]?.payload).toEqual({
      success: false,
      error: 'Board has no tasks to run',
    });
    expect(h.goalMessages).toEqual([]);
  });
});
