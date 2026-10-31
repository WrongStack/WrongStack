/**
 * A Goal budget stops the run before the next task starts: the run ends `stopped` with the
 * reason, the unstarted task stays pending, and the usage is saved for a later resume.
 */
import type { PhaseGraph } from '@wrongstack/goal';
import { expect, it } from 'vitest';
import { type GoalRunHost, startGoalRun } from '../src/server/goal-run.js';

function host() {
  const broadcasts: { type: string; payload: unknown }[] = [];
  const executed: string[] = [];
  const saved: PhaseGraph[] = [];
  let settle!: () => void;
  const finished = new Promise<void>((resolve) => {
    settle = resolve;
  });
  const value = {
    goalId: undefined,
    abort: null,
    planPhases: async () => [],
    stopping: false,
    broadcast: (message: { type: string; payload: unknown }) => broadcasts.push(message),
    runStatus: 'idle',
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
    graph: null,
    worktrees: null,
    runBase: null,
    events: undefined,
    projectRoot: undefined,
    context: { session: { id: 'session-1' } },
    persistence: { save: async (graph: PhaseGraph) => void saved.push(graph) },
    runRepairPhase: async () => {},
    executeTaskWithAgent: async (task: { title: string }) => {
      executed.push(task.title);
      return { ok: true };
    },
    runChimeraReview: async () => {},
    persistDetached: () => {},
    broadcastState: () => {},
    orchestrator: null,
    startBroadcast: () => {},
    runPromise: null,
    stopBroadcast: () => {},
    releaseActiveRunLease: async () => settle(),
  } as unknown as GoalRunHost;
  return { value, broadcasts, executed, saved, finished };
}

const task = (title: string) => ({
  title,
  description: title,
  type: 'feature' as const,
  priority: 'medium' as const,
  estimateHours: 1,
});

it('stops before the task that would exceed the task budget', async () => {
  const h = host();
  await startGoalRun(h.value, {
    goal: 'Budgeted goal',
    verifyTasks: false,
    worktrees: false,
    budget: { maxTasks: 1 },
    phases: [
      {
        name: 'Only phase',
        description: 'd',
        priority: 'medium',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [task('First task'), { ...task('Second task'), dependsOn: [0] }],
      },
    ],
  });
  await h.finished;
  expect(h.executed).toEqual(['First task']);
  const graph = h.value.graph!;
  expect(graph.runState).toBe('stopped');
  expect(graph.runError).toMatch(/Budget reached: 1 of 1 tasks/);
  expect(graph.budgetUsage?.tasks).toBe(1);
  const second = [...[...graph.phases.values()][0]!.taskGraph.nodes.values()].find(
    (node) => node.title === 'Second task',
  );
  expect(second?.status).toBe('pending');
  expect(h.broadcasts).toContainEqual({
    type: 'goal.stopped',
    payload: expect.objectContaining({ reason: expect.stringMatching(/Budget reached/) }),
  });
  expect(h.saved.at(-1)?.runState).toBe('stopped');

  // Resuming with the saved budget stops again before any task; a raised budget continues.
  const again = host();
  await startGoalRun(again.value, undefined, graph);
  await again.finished;
  expect(again.executed).toEqual([]);
  const raised = host();
  await startGoalRun(raised.value, { budget: { maxTasks: 2 } }, graph);
  await raised.finished;
  expect(raised.executed).toEqual(['Second task']);
  expect(graph.budget).toEqual({ maxTasks: 2 });
  expect(graph.budgetUsage?.tasks).toBe(2);
  expect(graph.runState).toBe('completed');
  expect(graph.runError).toBeUndefined();
});

it('stops before the next task once the provider tokens reported by tasks reach the budget', async () => {
  const h = host();
  // Each task reports the provider usage of its agent run.
  (h.value as unknown as { executeTaskWithAgent: unknown }).executeTaskWithAgent = async (
    item: { title: string },
    _phase: string,
    _env: unknown,
    _signal: unknown,
    onUsage?: (usage: { input: number; output: number; cacheRead?: number }) => void,
  ) => {
    h.executed.push(item.title);
    onUsage?.({ input: 400, output: 500, cacheRead: 200 });
    return { ok: true };
  };
  await startGoalRun(h.value, {
    goal: 'Token budget',
    verifyTasks: false,
    worktrees: false,
    budget: { maxTokens: 1000 },
    phases: [
      {
        name: 'Only phase',
        description: 'd',
        priority: 'medium',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [task('First task'), { ...task('Second task'), dependsOn: [0] }],
      },
    ],
  });
  await h.finished;
  expect(h.executed).toEqual(['First task']);
  const graph = h.value.graph!;
  expect(graph.budget).toEqual({ maxTokens: 1000 });
  expect(graph.budgetUsage?.tokens).toBe(1100);
  expect(graph.runState).toBe('stopped');
  expect(graph.runError).toMatch(/Budget reached: 1,100 of 1,000 provider tokens/);
});

async function costRun(price: (model: string) => number | null) {
  const h = host();
  Object.assign(h.value, {
    priceUsage: async (_usage: unknown, source: { model: string }) => price(source.model),
    executeTaskWithAgent: async (
      item: { title: string },
      _phase: string,
      _env: unknown,
      _signal: unknown,
      onUsage?: (usage: { input: number; output: number }, source: object) => void,
    ) => {
      h.executed.push(item.title);
      onUsage?.({ input: 1000, output: 100 }, { providerId: 'fixture', model: item.title });
      return { ok: true };
    },
  });
  await startGoalRun(h.value, {
    goal: 'Cost budget',
    verifyTasks: false,
    worktrees: false,
    budget: { maxCostUsd: 0.5 },
    phases: [
      {
        name: 'Only phase',
        description: 'd',
        priority: 'medium',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          task('First task'),
          { ...task('Second task'), dependsOn: [0] },
          { ...task('Third task'), dependsOn: [1] },
        ],
      },
    ],
  });
  await h.finished;
  return h;
}

it('stops before the next task once the estimated cost reaches the cost budget', async () => {
  const h = await costRun(() => 0.3);
  expect(h.executed).toEqual(['First task', 'Second task']);
  const graph = h.value.graph!;
  expect(graph.budgetUsage?.costUsd).toBeCloseTo(0.6);
  expect(graph.runState).toBe('stopped');
  expect(graph.runError).toMatch(/Budget reached: an estimated \$0\.6000 of \$0\.5 spent/);
});

it('stops a cost-budgeted run at a response whose price is unknown', async () => {
  const h = await costRun((model) => (model === 'First task' ? null : 0.01));
  expect(h.executed).toEqual(['First task']);
  const graph = h.value.graph!;
  expect(graph.budgetUsage?.unpricedResponses).toBe(1);
  expect(graph.runError).toMatch(/cost of 1 provider responses is unknown/);
});
