import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createGoalHost, type GoalHostDeps } from '../src/goal-host.js';

// A minimal fake MultiAgentHost: makeSubagentFactory() returns a factory whose
// agent.run() routes by prompt — the planner call (no task marker) returns a
// plan JSON, task calls return a "done" result. `onRun` lets a test intercept.
function fakeHost(opts: {
  plan: unknown;
  onTaskRun?: () => Promise<void> | void;
  taskStatus?: string;
}): GoalHostDeps['multiAgentHost'] {
  const factory = async (_built: { name: string; cwd?: string | undefined }) => ({
    agent: {
      run: async (prompt: string) => {
        if (prompt.includes('You are executing one task')) {
          await opts.onTaskRun?.();
          return { status: opts.taskStatus ?? 'done', finalText: 'did the task' };
        }
        // planner (or repair/conflict, which these tests disable)
        return { status: 'done', finalText: JSON.stringify(opts.plan) };
      },
    },
    dispose: async () => {},
  });
  return {
    makeSubagentFactory: (_cfg: unknown) => factory,
  } as never as GoalHostDeps['multiAgentHost'];
}

const ONE_PHASE_PLAN = [
  {
    name: 'Phase A',
    description: 'do A',
    priority: 'high',
    estimateHours: 1,
    parallelizable: false,
    tasks: [
      { title: 'task one', description: '', type: 'feature', priority: 'high', estimateHours: 1 },
    ],
  },
];

describe('createGoalHost', () => {
  let storeDir: string;
  let projectRoot: string;
  const prevVerify = process.env['WRONGSTACK_GOAL_VERIFY'];

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-store-'));
    // Non-git temp dir → worktree isolation never activates.
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-root-'));
    // The verify gate would shell out to typecheck/lint — off for unit tests.
    process.env['WRONGSTACK_GOAL_VERIFY'] = '0';
  });

  afterEach(async () => {
    if (prevVerify === undefined) delete process.env['WRONGSTACK_GOAL_VERIFY'];
    else process.env['WRONGSTACK_GOAL_VERIFY'] = prevVerify;
    // Fire-and-forget `void persist(graph)` calls can still be in flight after a
    // run finalizes; retry the removal so a trailing write doesn't ENOTEMPTY on
    // Windows.
    const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
    await fs.rm(storeDir, rmOpts);
    await fs.rm(projectRoot, rmOpts);
  });

  const makeHost = (host: GoalHostDeps['multiAgentHost'], events: EventBus) =>
    createGoalHost({
      multiAgentHost: host,
      getConfig: () => ({}) as never,
      events,
      storeDir,
      projectRoot,
      worktrees: false,
    });

  it('plans, builds, runs to completion and persists the graph', async () => {
    const events = new EventBus();
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN }), events);

    const completed = new Promise<void>((resolve) => {
      (events as unknown as { on(e: string, h: () => void): void }).on('graph.completed', resolve);
    });

    const result = await host.onGoalStart({ goal: 'build the thing' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.graph.title).toBe('build the thing');
    expect(result.graph.phases.size).toBe(1);

    await completed;
    // Let trailing fire-and-forget persists settle before asserting/cleanup.
    await new Promise((r) => setTimeout(r, 30));

    const phase = Array.from(result.graph.phases.values())[0]!;
    expect(phase.status).toBe('completed');
    expect(result.graph.completedPhaseIds).toContain(phase.id);

    // The graph JSON was persisted to disk under storeDir.
    const files = await fs.readdir(storeDir);
    expect(files.some((f) => f.endsWith('.json'))).toBe(true);

    // The run finalized — no active runner remains.
    expect(host.getGoalRunner()).toBeNull();
  });

  it('rejects a second start while one is already running', async () => {
    const events = new EventBus();
    // Hold the single task until we release it, keeping the first run "running".
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN, onTaskRun: () => held }), events);

    const first = await host.onGoalStart({ goal: 'first' });
    expect(first.ok).toBe(true);
    // Give the orchestrator a tick to enter the running task.
    await new Promise((r) => setTimeout(r, 20));

    const second = await host.onGoalStart({ goal: 'second' });
    expect(second.ok).toBe(false);
    if (!second.ok) expect(second.error).toMatch(/already in progress/i);

    release(); // let the first run finish so the test exits cleanly
    await new Promise((r) => setTimeout(r, 20));
  });

  it('returns a friendly error when the planner produces no usable plan', async () => {
    const events = new EventBus();
    const host = makeHost(fakeHost({ plan: 'not an array, no JSON here' }), events);
    const result = await host.onGoalStart({ goal: 'vague' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toMatch(/did not produce a usable phase plan/i);
  });

  it('interactive board mutators are safe no-ops with no active run', () => {
    const events = new EventBus();
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN }), events);
    expect(host.getGoalRunner()).toBeNull();
    expect(host.onGoalMoveTask('t', 'p')).toBe(false);
    expect(host.onGoalAssignTask('t', 'a', 'Agent')).toBe(false);
    expect(host.onGoalAddTask('p', { title: 'x' })).toBeNull();
    expect(host.onGoalRetryTask('t')).toBe(false);
    // pause/resume/stop must not throw when nothing is running.
    expect(() => {
      host.onGoalPause();
      host.onGoalResume();
      host.onGoalStop();
    }).not.toThrow();
  });
});
