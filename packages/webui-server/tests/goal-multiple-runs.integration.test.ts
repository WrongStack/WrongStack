import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/contracts/kernel';
import { PhaseGraphBuilder, PhaseStore } from '@wrongstack/goal';
import { expect, it, vi } from 'vitest';
import { deferred, goalGitFixture } from '../../goal/tests/helpers/goal-git-fixture.js';
import { GoalWebSocketHandler } from '../src/server/goal-ws-handler.js';

const phase = (title: string) => [
  {
    name: 'Build',
    description: '',
    priority: 'high',
    estimateHours: 1,
    parallelizable: false,
    taskTemplates: [{ title, description: '', type: 'chore', priority: 'high', estimateHours: 1 }],
  },
];

it('runs two WebUI goals independently, routes status by id and preserves another terminal owner', async () => {
  const fixture = await goalGitFixture();
  const gates = [deferred(), deferred()];
  const entered = [deferred(), deferred()];
  const factory = async (opts: { cwd?: string }) => {
    return {
      agent: {
        run: async (prompt: string) => {
          const index = Number(/Execute task: Task (\d)/.exec(prompt)?.[1]);
          expect(Number.isInteger(index)).toBe(true);
          await fs.writeFile(path.join(opts.cwd!, `goal-${index}.txt`), 'owned goal');
          entered[index]!.resolve();
          await gates[index]!.promise;
          return { status: 'done', finalText: 'done' };
        },
      },
    };
  };
  const ws = { readyState: 1, on: vi.fn(), send: vi.fn() } as never;
  const handler = new GoalWebSocketHandler(
    {} as never,
    { cwd: fixture.projectRoot, session: { id: 'web-session' } } as never,
    { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    fixture.storeDir,
    new EventBus(),
    fixture.projectRoot,
    undefined,
    factory as never,
  );
  handler.addClient(ws);
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const store = new PhaseStore({ baseDir: fixture.storeDir });
  try {
    await Promise.all(
      ids.map((goalId, index) =>
        handler.handleMessage(ws, {
          type: 'goal.start',
          payload: {
            goalId,
            sessionId: `web-${index}`,
            title: `Goal ${index}`,
            phases: phase(`Task ${index}`),
            verifyTasks: false,
          },
        }),
      ),
    );
    await Promise.all(entered.map((gate) => gate.promise));
    expect((await store.listGoals()).map((goal) => goal.status)).toEqual(['running', 'running']);
    await handler.handleMessage(ws, { type: 'goal.status', payload: { goalId: ids[0] } });
    const messages = () =>
      (ws as unknown as { send: ReturnType<typeof vi.fn> }).send.mock.calls.map(([raw]) =>
        JSON.parse(String(raw)),
      );
    expect(
      messages()
        .filter((message) => message.type === 'goal.state')
        .at(-1)?.payload.goalId,
    ).toBe(ids[0]);
    gates[0]!.resolve();
    await vi.waitFor(
      async () =>
        expect((await store.listGoals()).find((goal) => goal.id === ids[0])?.status).toBe(
          'completed',
        ),
      // Real Git checkpoints/worktree operations can exceed 10s under coverage.
      { timeout: 60_000 },
    );
    expect((await store.listGoals()).find((goal) => goal.id === ids[1])?.status).toBe('running');
    gates[1]!.resolve();
    await vi.waitFor(
      async () =>
        expect((await store.listGoals()).every((goal) => goal.status === 'completed')).toBe(true),
      { timeout: 60_000 },
    );
    await handler.handleMessage(ws, { type: 'goal.list' });
    expect(
      messages()
        .filter((message) => message.type === 'goal.list')
        .at(-1)?.payload.goals,
    ).toHaveLength(2);
    expect(await fixture.git('rev-parse', 'HEAD')).toBe(fixture.baseline);
    const external = await new PhaseGraphBuilder({
      title: 'External terminal',
      phases: phase('External') as never,
    }).build();
    external.workspace = {
      dir: path.join(fixture.projectRoot, '.wrongstack/worktrees/external'),
      branch: 'wstack/ap/external',
      baseBranch: 'main',
    };
    external.runState = 'running';
    await store.save(external);
    const release = await store.acquireGoalRunLease(
      external.id,
      `cli:${process.pid}:${external.id}`,
    );
    try {
      await handler.handleMessage(ws, { type: 'goal.status', payload: { goalId: external.id } });
      expect(
        messages()
          .filter((message) => message.type === 'goal.state')
          .at(-1)?.payload,
      ).toMatchObject({ readOnly: true, status: 'running' });
      await handler.handleMessage(ws, { type: 'goal.stop', payload: { goalId: external.id } });
      expect(
        messages()
          .filter((message) => message.type === 'goal.error')
          .at(-1)?.payload.controlOnly,
      ).toBe(true);
      expect((await store.load(external.id))?.runState).toBe('running');
    } finally {
      await release();
    }
  } finally {
    for (const gate of gates) gate.resolve();
    for (const goalId of ids)
      await handler.handleMessage(ws, { type: 'goal.stop', payload: { goalId } });
    handler.dispose();
    await fixture.dispose();
  }
}, 180_000);
