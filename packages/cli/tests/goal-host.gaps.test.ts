import { execFile } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { EventBus } from '@wrongstack/core/kernel';
import { PhaseGraphBuilder, type PhaseGraph } from '@wrongstack/core/goal';
import { promisify } from 'node:util';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  configureGoalPolicy,
  createGoalHost,
  isGoalCommandAllowed,
  resetGoalPolicy,
  type GoalHostDeps,
} from '../src/goal-host.js';

const execFileAsync = promisify(execFile);

interface RouteOpts {
  plan: unknown;
  onTaskRun?: () => Promise<void> | void;
  taskStatus?: string;
  onPlannerRun?: () => Promise<void> | void;
  plannerThrows?: boolean;
}

/**
 * Fake MultiAgentHost routing agent.run() by prompt shape: the planner call
 * (no task/repair marker) returns the plan JSON, task calls return "done",
 * and repair/conflict calls return plain text.
 */
function fakeHost(opts: RouteOpts): GoalHostDeps['multiAgentHost'] {
  const factory = async (_built: { name: string; cwd?: string | undefined }) => ({
    agent: {
      run: async (prompt: string) => {
        if (opts.plannerThrows) throw new Error('planner exploded');
        if (prompt.includes('You are executing one task')) {
          await opts.onTaskRun?.();
          return { status: opts.taskStatus ?? 'done', finalText: 'did the task' };
        }
        if (prompt.includes('repairing a FAILED verification')) {
          return { status: 'done', finalText: 'fixed it' };
        }
        await opts.onPlannerRun?.();
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

const TWO_PHASE_PLAN = [
  ONE_PHASE_PLAN[0],
  {
    name: 'Phase B',
    description: 'do B',
    priority: 'medium',
    estimateHours: 1,
    parallelizable: false,
    tasks: [
      { title: 'task two', description: '', type: 'feature', priority: 'medium', estimateHours: 1 },
    ],
  },
];

describe('goal command policy', () => {
  afterEach(() => resetGoalPolicy());

  it('allows the built-in package managers by default', () => {
    resetGoalPolicy();
    expect(isGoalCommandAllowed('pnpm')).toBe(true);
    expect(isGoalCommandAllowed(' npm ')).toBe(true); // trimmed before lookup
    expect(isGoalCommandAllowed('curl')).toBe(false);
  });

  it('extends and trims the allowlist from exec policy, rebuilt from base each call', () => {
    configureGoalPolicy({ allow: ['go', '  cargo  ', ''] });
    expect(isGoalCommandAllowed('go')).toBe(true);
    expect(isGoalCommandAllowed('cargo')).toBe(true);
    expect(isGoalCommandAllowed('pnpm')).toBe(true); // base retained

    configureGoalPolicy({ allow: ['go'], deny: ['pnpm', 'go'] });
    expect(isGoalCommandAllowed('go')).toBe(false);
    expect(isGoalCommandAllowed('pnpm')).toBe(false);
    expect(isGoalCommandAllowed('npm')).toBe(true); // untouched base entry

    resetGoalPolicy();
    expect(isGoalCommandAllowed('pnpm')).toBe(true);
    expect(isGoalCommandAllowed('go')).toBe(false);
  });
});

describe('createGoalHost — start failures and task errors', () => {
  let storeDir: string;
  let projectRoot: string;
  const prevVerify = process.env['WRONGSTACK_GOAL_VERIFY'];

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-store-'));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-root-'));
    process.env['WRONGSTACK_GOAL_VERIFY'] = '0';
  });

  afterEach(async () => {
    if (prevVerify === undefined) delete process.env['WRONGSTACK_GOAL_VERIFY'];
    else process.env['WRONGSTACK_GOAL_VERIFY'] = prevVerify;
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

  it('surfaces planner exceptions as a friendly error', async () => {
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN, plannerThrows: true }), new EventBus());
    const result = await host.onGoalStart({ goal: 'anything' });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.error).toContain('Planning failed: planner exploded');
  });

  it('fails the graph when a task subagent ends in a non-done status', async () => {
    const events = new EventBus();
    const failed = new Promise<void>((resolve) => {
      (events as unknown as { on(e: string, h: () => void): void }).on('graph.failed', resolve);
    });
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN, taskStatus: 'error' }), events);
    const result = await host.onGoalStart({ goal: 'doomed' });
    expect(result.ok).toBe(true);
    await failed;
    await new Promise((r) => setTimeout(r, 30));
    const phase = Array.from(result.ok ? result.graph.phases.values() : [])[0];
    expect(phase?.status).toBe('failed');
  });

  it('exposes a live runner and services the interactive board during a run', async () => {
    const events = new EventBus();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const host = makeHost(fakeHost({ plan: TWO_PHASE_PLAN, onTaskRun: () => held }), events);

    const result = await host.onGoalStart({ goal: 'boardable' });
    expect(result.ok).toBe(true);
    await new Promise((r) => setTimeout(r, 30));

    const runner = host.getGoalRunner();
    expect(runner).not.toBeNull();
    expect(runner?.isRunning()).toBe(true);
    expect(runner?.getProgress()).not.toBeNull();

    const graph = result.ok ? result.graph : null;
    expect(graph).not.toBeNull();
    const phaseA = Array.from(graph!.phases.keys())[0] as string;
    const phaseB = Array.from(graph!.phases.keys())[1] as string;

    const addedId = host.onGoalAddTask(phaseB, {
      title: 'extra task',
      type: 'test',
      priority: 'low',
    });
    expect(typeof addedId).toBe('string');
    expect(addedId!.length).toBeGreaterThan(0);
    // The freshly added task is pending, so moving and requeueing it succeed.
    expect(host.onGoalMoveTask(addedId!, phaseA)).toBe(true);
    expect(host.onGoalRetryTask(addedId!)).toBe(true);
    expect(host.onGoalAssignTask('task-999', 'agent-1', 'Rookie')).toBe(false); // unknown task
    expect(host.onGoalRetryTask('task-999')).toBe(false);

    host.onGoalPause();
    expect(runner?.isRunning()).toBe(true);
    host.onGoalResume();

    host.onGoalStop();
    expect(host.getGoalRunner()).toBeNull();

    release();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('resumes a persisted graph and runs its pending tasks', async () => {
    const events = new EventBus();
    let release!: () => void;
    const held = new Promise<void>((r) => {
      release = r;
    });
    const host = makeHost(fakeHost({ plan: TWO_PHASE_PLAN, onTaskRun: () => held }), events);

    // The builder materializes tasks from taskTemplates — the same shape the
    // GoalPlanner emits (the `tasks` key is the wire format it parses).
    const graph: PhaseGraph = await new PhaseGraphBuilder({
      title: 'resumable goal',
      phases: [
        {
          name: 'Phase A',
          description: 'do A',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'task one',
              description: '',
              type: 'feature',
              priority: 'high',
              estimateHours: 1,
            },
          ],
        },
      ],
      autonomous: true,
    }).build();
    const result = await host.onGoalResumeFromGraph(graph);
    expect(result.ok).toBe(true);
    for (let i = 0; i < 100 && host.getGoalRunner()?.isRunning() !== true; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(host.getGoalRunner()?.isRunning()).toBe(true);

    // A second resume is refused while the first is still running.
    const second = await host.onGoalResumeFromGraph(graph);
    expect(second.ok).toBe(false);

    release();
    for (let i = 0; i < 150 && host.getGoalRunner() !== null; i++) {
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(host.getGoalRunner()).toBeNull();
  });
});

describe('createGoalHost — verify gate', () => {
  let storeDir: string;
  let projectRoot: string;
  const prevVerify = process.env['WRONGSTACK_GOAL_VERIFY'];
  const prevVerifyCmd = process.env['WRONGSTACK_GOAL_VERIFY_CMD'];

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-store-'));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-root-'));
    await fs.mkdir(path.join(projectRoot, 'node_modules'), { recursive: true });
    delete process.env['WRONGSTACK_GOAL_VERIFY_CMD'];
    delete process.env['WRONGSTACK_GOAL_VERIFY'];
  });

  afterEach(async () => {
    if (prevVerify === undefined) delete process.env['WRONGSTACK_GOAL_VERIFY'];
    else process.env['WRONGSTACK_GOAL_VERIFY'] = prevVerify;
    if (prevVerifyCmd === undefined) delete process.env['WRONGSTACK_GOAL_VERIFY_CMD'];
    else process.env['WRONGSTACK_GOAL_VERIFY_CMD'] = prevVerifyCmd;
    resetGoalPolicy();
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

  const writePackageJson = async (scripts: Record<string, string>) => {
    await fs.writeFile(
      path.join(projectRoot, 'package.json'),
      JSON.stringify({ name: 'verify-fixture', scripts }),
      'utf8',
    );
  };

  it('skips verification when no typecheck/lint scripts exist', async () => {
    await writePackageJson({});
    const events = new EventBus();
    const completed = new Promise<void>((resolve) => {
      (events as unknown as { on(e: string, h: () => void): void }).on('graph.completed', resolve);
    });
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN }), events);
    const result = await host.onGoalStart({ goal: 'scriptless' });
    expect(result.ok).toBe(true);
    await completed;
    await new Promise((r) => setTimeout(r, 30));
    const phase = Array.from(result.ok ? result.graph.phases.values() : [])[0];
    expect(phase?.status).toBe('completed');
  });

  // npm/pnpm are .cmd shims on Windows and cannot be spawned without a shell,
  // so the script-runner path is exercised through custom allowed commands
  // (the same runCmd pipeline with shell=true).
  const PASS_CMD = 'node -e "process.exit(0)"';
  const FAIL_CMD = 'node -e "process.exit(3)"';

  it('completes phases whose verification passes', async () => {
    await writePackageJson({});
    process.env['WRONGSTACK_GOAL_VERIFY_CMD'] = PASS_CMD;
    configureGoalPolicy({ allow: [PASS_CMD] });
    const events = new EventBus();
    const completed = new Promise<void>((resolve) => {
      (events as unknown as { on(e: string, h: () => void): void }).on('graph.completed', resolve);
    });
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN }), events);
    const result = await host.onGoalStart({ goal: 'typed' });
    expect(result.ok).toBe(true);
    await completed;
    await new Promise((r) => setTimeout(r, 30));
    const phase = Array.from(result.ok ? result.graph.phases.values() : [])[0];
    expect(phase?.status).toBe('completed');
  }, 90_000);

  it('fails the phase after repair when verification keeps failing', async () => {
    await writePackageJson({});
    process.env['WRONGSTACK_GOAL_VERIFY_CMD'] = FAIL_CMD;
    configureGoalPolicy({ allow: [FAIL_CMD] });
    const events = new EventBus();
    const failed = new Promise<void>((resolve) => {
      (events as unknown as { on(e: string, h: () => void): void }).on('graph.failed', resolve);
    });
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN }), events);
    const result = await host.onGoalStart({ goal: 'unfixable' });
    expect(result.ok).toBe(true);
    await failed;
    await new Promise((r) => setTimeout(r, 30));
    const phase = Array.from(result.ok ? result.graph.phases.values() : [])[0];
    expect(phase?.status).toBe('failed');
  }, 90_000);

  it('runs a custom allowed verify command', async () => {
    await writePackageJson({});
    process.env['WRONGSTACK_GOAL_VERIFY_CMD'] = PASS_CMD;
    configureGoalPolicy({ allow: [PASS_CMD] });
    const events = new EventBus();
    const completed = new Promise<void>((resolve) => {
      (events as unknown as { on(e: string, h: () => void): void }).on('graph.completed', resolve);
    });
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN }), events);
    const result = await host.onGoalStart({ goal: 'custom verify' });
    expect(result.ok).toBe(true);
    await completed;
    await new Promise((r) => setTimeout(r, 30));
    const phase = Array.from(result.ok ? result.graph.phases.values() : [])[0];
    expect(phase?.status).toBe('completed');
  });

  it('refuses custom verify commands outside the allowlist', async () => {
    await writePackageJson({});
    process.env['WRONGSTACK_GOAL_VERIFY_CMD'] = 'curl';
    const events = new EventBus();
    const failed = new Promise<void>((resolve) => {
      (events as unknown as { on(e: string, h: () => void): void }).on('graph.failed', resolve);
    });
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN }), events);
    const result = await host.onGoalStart({ goal: 'disallowed' });
    expect(result.ok).toBe(true);
    await failed;
    await new Promise((r) => setTimeout(r, 30));
    const phase = Array.from(result.ok ? result.graph.phases.values() : [])[0];
    expect(phase?.status).toBe('failed');
  });

  it('refuses chained custom verify commands', async () => {
    await writePackageJson({});
    process.env['WRONGSTACK_GOAL_VERIFY_CMD'] = 'node -e "0" && echo chained';
    const events = new EventBus();
    const failed = new Promise<void>((resolve) => {
      (events as unknown as { on(e: string, h: () => void): void }).on('graph.failed', resolve);
    });
    const host = makeHost(fakeHost({ plan: ONE_PHASE_PLAN }), events);
    const result = await host.onGoalStart({ goal: 'chained' });
    expect(result.ok).toBe(true);
    await failed;
    await new Promise((r) => setTimeout(r, 30));
    const phase = Array.from(result.ok ? result.graph.phases.values() : [])[0];
    expect(phase?.status).toBe('failed');
  });
});

describe('createGoalHost — worktree actions', () => {
  let storeDir: string;
  let projectRoot: string;

  beforeEach(async () => {
    storeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-store-'));
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'ap-git-'));
    await execFileAsync('git', ['init', '-q'], { cwd: projectRoot });
    await execFileAsync('git', ['config', 'user.email', 't@t'], { cwd: projectRoot });
    await execFileAsync('git', ['config', 'user.name', 't'], { cwd: projectRoot });
    await fs.writeFile(path.join(projectRoot, 'a.txt'), 'a\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: projectRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'init'], { cwd: projectRoot });
  });

  afterEach(async () => {
    const rmOpts = { recursive: true, force: true, maxRetries: 5, retryDelay: 50 } as const;
    await fs.rm(storeDir, rmOpts);
    await fs.rm(projectRoot, rmOpts);
  });

  const makeHost = () =>
    createGoalHost({
      multiAgentHost: fakeHost({ plan: ONE_PHASE_PLAN }),
      getConfig: () => ({}) as never,
      events: new EventBus(),
      storeDir,
      projectRoot,
      worktrees: false,
    });

  it('refuses worktree actions outside a git repository', async () => {
    const host = createGoalHost({
      multiAgentHost: fakeHost({ plan: ONE_PHASE_PLAN }),
      getConfig: () => ({}) as never,
      events: new EventBus(),
      storeDir,
      projectRoot: await fs.mkdtemp(path.join(os.tmpdir(), 'ap-nogit-')),
      worktrees: false,
    });
    expect(await host.onWorktree('list')).toContain('Not a git repository');
  });

  it('lists worktrees and prunes stale entries', async () => {
    const host = makeHost();
    const list = await host.onWorktree('list');
    expect(list).toContain(projectRoot.split(path.sep).pop() ?? 'ap-git');

    const pruned = await host.onWorktree('prune');
    expect(pruned).toContain('Pruned stale worktree entries');
  });

  it('guards merge usage and unsafe branch names', async () => {
    const host = makeHost();
    expect(await host.onWorktree('merge')).toContain('Usage: /worktree merge <branch>');
    expect(await host.onWorktree('merge', '--force')).toContain('Refusing unsafe branch name');
  });

  it('squash-merges a branch and reports rollback on conflicts', async () => {
    await execFileAsync('git', ['checkout', '-q', '-b', 'feature'], { cwd: projectRoot });
    await fs.writeFile(path.join(projectRoot, 'b.txt'), 'b\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: projectRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'feature'], { cwd: projectRoot });
    await execFileAsync('git', ['checkout', '-q', 'master'], { cwd: projectRoot }).catch(
      async () => {
        await execFileAsync('git', ['checkout', '-q', 'main'], { cwd: projectRoot });
      },
    );

    const host = makeHost();
    const merged = await host.onWorktree('merge', 'feature');
    expect(merged).toContain('Merged "feature"');

    // A conflicting second merge is rolled back with a warning.
    await execFileAsync('git', ['checkout', '-q', '-b', 'conflicter'], { cwd: projectRoot });
    await fs.writeFile(path.join(projectRoot, 'a.txt'), 'conflicting\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: projectRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'conflict'], { cwd: projectRoot });
    await execFileAsync('git', ['checkout', '-q', '-'], { cwd: projectRoot });
    await fs.writeFile(path.join(projectRoot, 'a.txt'), 'base-change\n', 'utf8');
    await execFileAsync('git', ['add', '.'], { cwd: projectRoot });
    await execFileAsync('git', ['commit', '-q', '-m', 'base'], { cwd: projectRoot });

    const conflict = await host.onWorktree('merge', 'conflicter');
    expect(conflict).toContain('rolled back');
  });

  it('cleans managed worktrees and branches', async () => {
    const host = makeHost();
    const cleaned = await host.onWorktree('clean');
    expect(cleaned).toMatch(/Removed \d+ worktree\(s\) and \d+ branch\(es\)/);
  });

  it('rejects unknown worktree actions', async () => {
    const host = makeHost();
    expect(await host.onWorktree('dance' as never)).toContain('Unknown worktree action');
  });
});
