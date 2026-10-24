import { EventBus } from '@wrongstack/contracts/kernel';
import { expect, it, vi } from 'vitest';

vi.mock('@wrongstack/goal', async (original) => {
  const actual = await original<typeof import('@wrongstack/goal')>();
  class Store {
    save = vi.fn(async () => {});
    acquireRunLease = vi.fn(async () => async () => {});
    acquireGoalRunLease = vi.fn(async () => async () => {});
  }
  return {
    ...actual,
    PhaseStore: Store,
    prepareGoalWorkspace: async (_root: string, graph: { workspace: { dir: string } }) =>
      graph.workspace.dir,
  };
});
const { PhaseGraphBuilder } = await import('@wrongstack/goal');
const { createGoalHost } = await import('../src/goal-host.js');

it('resumes a goal without phase worktrees in the owned goal checkout', async () => {
  const graph = await new PhaseGraphBuilder({
    title: 'Resume context',
    phases: [
      {
        name: 'Build',
        description: '',
        priority: 'high',
        estimateHours: 1,
        parallelizable: false,
        taskTemplates: [
          { title: 'Build', description: '', type: 'chore', priority: 'high', estimateHours: 1 },
        ],
      },
    ],
  }).build();
  graph.workspace = { dir: '/owned-goal', branch: 'wstack/ap/goal', baseBranch: 'main' };
  graph.worktrees = false;
  graph.verifyTasks = false;
  const workingDirectories: string[] = [];
  const host = createGoalHost({
    storeDir: '/virtual-store',
    projectRoot: '/main-project',
    events: new EventBus(),
    getConfig: () => ({}) as never,
    multiAgentHost: {
      makeSubagentFactory: () => async (options: { cwd?: string }) => ({
        agent: {
          run: async () => {
            workingDirectories.push(options.cwd ?? '/main-project');
            return { status: 'done', finalText: 'done' };
          },
        },
      }),
    } as never,
  });
  expect((await host.onGoalResumeFromGraph(graph)).ok).toBe(true);
  await vi.waitFor(() => expect(host.getGoalRunner()).toBeNull());
  console.log('EXPECTED: owned goal checkout; ACTUAL:', workingDirectories);
  expect(workingDirectories).toEqual(['/owned-goal']);
});
