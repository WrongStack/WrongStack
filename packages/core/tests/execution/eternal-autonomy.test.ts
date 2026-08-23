import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { addTask, createBoard, getBoard, listBoards, removeBoard, updateTask } from '@wrongstack/kanban';
import type { Agent } from '../../src/core/agent.js';
import { EternalAutonomyEngine } from '../../src/execution/eternal-autonomy.js';
import { EventBus } from '../../src/kernel/events.js';
import { createGoalKanbanBoard, findGoalKanbanBoard } from '../../src/storage/goal-kanban.js';
import { emptyGoal, goalFilePath, loadGoal, saveGoal } from '../../src/storage/goal-store.js';
import { setBoardStorePort } from '../../src/storage/board-store-port.js';

setBoardStorePort({ addTask, createBoard, getBoard, listBoards, removeBoard, updateTask });

interface MockAgentSetup {
  todos?: Array<{ id: string; content: string; status: 'pending' | 'in_progress' | 'completed' }>;
  runImpl?: (input: unknown) => Promise<{ status: string; iterations: number; finalText?: string }>;
  tokenCounter?: {
    total: () => { input: number; output: number };
    estimateCost: () => { total: number };
    currentRequestTokens?: () => { input: number; cacheRead: number; cacheWrite: number };
  };
}

function makeMockAgent(setup: MockAgentSetup = {}): Agent {
  const events = new EventBus();
  const ctx = {
    todos: setup.todos ?? [],
    tokenCounter: setup.tokenCounter,
  } as any;
  const runMock = vi.fn(async (input: unknown) => {
    if (setup.runImpl) return setup.runImpl(input);
    return { status: 'done', iterations: 1, finalText: 'ok' };
  });
  return {
    run: runMock,
    register: vi.fn(),
    use: vi.fn(),
    container: null as any,
    tools: null as any,
    providers: null as any,
    events,
    pipelines: null as any,
    ctx,
  } as never as Agent;
}

function makeMockTokenCounter(
  seq: Array<{ input: number; output: number; cost: number; requestInput?: number }>,
): MockAgentSetup['tokenCounter'] {
  let i = 0;
  return {
    total: () => {
      const s = seq[Math.min(i, seq.length - 1)]!;
      return { input: s.input, output: s.output };
    },
    estimateCost: () => {
      const s = seq[Math.min(i, seq.length - 1)]!;
      // Advance the cursor only on the cost read, which is the last call
      // per iteration in the engine (snapshot order: total → cost).
      i++;
      return { total: s.cost };
    },
    currentRequestTokens: () => {
      const s = seq[Math.min(i, seq.length - 1)]!;
      return { input: s.requestInput ?? s.input, cacheRead: 0, cacheWrite: 0 };
    },
  };
}

describe('EternalAutonomyEngine', () => {
  let tmp: string;
  let projectRoot: string;
  let goalPath: string;

  beforeEach(async () => {
    tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-eternal-'));
    projectRoot = tmp;
    goalPath = goalFilePath(projectRoot);
    // goalFilePath uses ~/.wrongstack so ensure that dir exists
    await fs.mkdir(path.dirname(goalPath), { recursive: true });
    await saveGoal(goalPath, emptyGoal('Make the project better'));
  });

  afterEach(async () => {
    await fs.rm(tmp, { recursive: true, force: true });
  });

  it('prefers pending todos as the iteration source', async () => {
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'refactor parser', status: 'pending' }],
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
    });

    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    // First and only agent.run call should have included the todo task text.
    const calls = (agent.run as any).mock.calls;
    expect(calls.length).toBe(1);
    const firstArg = calls[0][0];
    const directive = Array.isArray(firstArg) ? firstArg[0].text : String(firstArg);
    expect(directive).toContain('Source: todo');
    expect(directive).toContain('refactor parser');

    const after = await loadGoal(goalPath);
    expect(after?.iterations).toBe(1);
    expect(after?.journal[0]?.source).toBe('todo');
    expect(after?.journal[0]?.status).toBe('success');
  });

  it('falls back to git when no todos are pending', async () => {
    const agent = makeMockAgent({
      todos: [],
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => ' M packages/foo/bar.ts\n?? new-file.ts\n',
    });

    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    const calls = (agent.run as any).mock.calls;
    const directive = Array.isArray(calls[0][0]) ? calls[0][0][0].text : String(calls[0][0]);
    expect(directive).toContain('Source: git');
    expect(directive).toContain('packages/foo/bar.ts');

    const after = await loadGoal(goalPath);
    expect(after?.journal[0]?.source).toBe('git');
  });

  it('brainstorms when todos and git are both clean', async () => {
    let firstCall = true;
    const agent = makeMockAgent({
      todos: [],
      runImpl: async () => {
        if (firstCall) {
          firstCall = false;
          // First call is the brainstorm prompt — return a proposed task.
          return { status: 'done', iterations: 1, finalText: 'Add CI workflow for releases' };
        }
        return { status: 'done', iterations: 1, finalText: 'executed' };
      },
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
    });

    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);

    const calls = (agent.run as any).mock.calls;
    expect(calls.length).toBe(2); // brainstorm + execute
    const executeDirective = Array.isArray(calls[1][0]) ? calls[1][0][0].text : String(calls[1][0]);
    expect(executeDirective).toContain('Source: brainstorm');
    expect(executeDirective).toContain('Add CI workflow for releases');

    const after = await loadGoal(goalPath);
    expect(after?.journal[0]?.source).toBe('brainstorm');
  });

  it('emits live stage callbacks for a serial iteration', async () => {
    const phases: string[] = [];
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'do thing', status: 'pending' }],
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      onStage: (stage) => phases.push(stage.phase),
    });

    await engine.runOneIteration();

    expect(phases).toEqual(['decide', 'execute', 'reflect', 'sleep']);
  });

  it('records failures in the journal but keeps the engine alive', async () => {
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'do thing', status: 'pending' }],
      runImpl: async () =>
        ({
          status: 'failed',
          iterations: 1,
          error: { describe: () => 'provider unreachable' } as any,
        }) as any,
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
    });

    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);

    const after = await loadGoal(goalPath);
    expect(after?.journal[0]?.status).toBe('failure');
    expect(after?.journal[0]?.note).toContain('provider unreachable');
  });

  it('gracefully stops when the goal file disappears', async () => {
    const agent = makeMockAgent({});
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
    });
    // Simulate /goal clear by unlinking before the iteration starts.
    await fs.unlink(goalPath);

    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);
    expect((agent.run as any).mock.calls.length).toBe(0);
  });

  it('captures per-iteration token + cost delta in the journal', async () => {
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'do work', status: 'pending' }],
      // before-snapshot first, after-snapshot second.
      tokenCounter: makeMockTokenCounter([
        { input: 1000, output: 500, cost: 0.05 },
        { input: 1300, output: 650, cost: 0.07 },
      ]),
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
    });
    await engine.runOneIteration();
    const after = await loadGoal(goalPath);
    const entry = after?.journal[0];
    expect(entry?.tokens).toEqual({ input: 300, output: 150 });
    expect(entry?.costUsd).toBeCloseTo(0.02, 6);
  });

  it('runs cadence-based compaction after compactEveryNIterations succeeds', async () => {
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'step', status: 'pending' }],
    });
    const compactor = {
      compact: vi.fn().mockResolvedValue({ before: 1000, after: 600, reductions: [] }),
    };
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      compactor: compactor as any,
      compactEveryNIterations: 2,
    });

    await engine.runOneIteration(); // success #1
    await engine.runOneIteration(); // success #2 → cadence trip
    expect(compactor.compact).toHaveBeenCalledTimes(1);
    // Aggressive should be false on cadence trigger.
    expect(compactor.compact.mock.calls[0]![1]).toEqual({ aggressive: false });

    const after = await loadGoal(goalPath);
    const compactEntry = after?.journal.find((e) => e.task.startsWith('compaction'));
    expect(compactEntry?.note).toContain('saved');
  });

  it('runs aggressive compaction when token usage crosses ratio', async () => {
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'heavy work', status: 'pending' }],
      tokenCounter: makeMockTokenCounter([
        { input: 9000, output: 100, cost: 0.1, requestInput: 9000 },
        { input: 9100, output: 200, cost: 0.11, requestInput: 9100 },
      ]),
    });
    const compactor = {
      compact: vi.fn().mockResolvedValue({ before: 9100, after: 4000, reductions: [] }),
    };
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      compactor: compactor as any,
      compactEveryNIterations: 100, // cadence shouldn't trip
      aggressiveCompactRatio: 0.85,
      maxContextTokens: 10_000,
    });

    await engine.runOneIteration();
    expect(compactor.compact).toHaveBeenCalledTimes(1);
    expect(compactor.compact.mock.calls[0]![1]).toEqual({ aggressive: true });
  });

  it('does not compact when no compactor is wired', async () => {
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'plain', status: 'pending' }],
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      compactEveryNIterations: 1,
    });
    // No compactor — runOneIteration should succeed without throwing.
    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
  });

  it('prime() flips engineState on disk to running', async () => {
    const agent = makeMockAgent({});
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
    });
    await engine.prime();
    const after = await loadGoal(goalPath);
    expect(after?.engineState).toBe('running');
    expect(engine.currentState).toBe('running');
  });

  it('stop() flips engineState back to stopped on disk', async () => {
    const agent = makeMockAgent({});
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
    });
    await engine.prime();
    engine.stop();
    // Allow the fire-and-forget persistEngineState write to flush.
    await new Promise((r) => setTimeout(r, 50));
    const after = await loadGoal(goalPath);
    expect(after?.engineState).toBe('stopped');
    expect(engine.currentState).toBe('stopped');
  });

  it('resumes from a persisted goal across engine instances', async () => {
    // Iteration 1 with first engine instance — populates journal.
    const agentA = makeMockAgent({
      todos: [{ id: 't1', content: 'step A', status: 'pending' }],
    });
    const engineA = new EternalAutonomyEngine({
      agent: agentA,
      projectRoot,
      gitStatusReader: async () => '',
    });
    await engineA.runOneIteration();

    // Iteration 2 with a fresh engine instance — should see incremented counter.
    const agentB = makeMockAgent({
      todos: [{ id: 't2', content: 'step B', status: 'pending' }],
    });
    const engineB = new EternalAutonomyEngine({
      agent: agentB,
      projectRoot,
      gitStatusReader: async () => '',
    });
    await engineB.runOneIteration();

    const after = await loadGoal(goalPath);
    expect(after?.iterations).toBe(2);
    expect(after?.journal).toHaveLength(2);
    expect(after?.journal[0]?.task).toBe('step A');
    expect(after?.journal[1]?.task).toBe('step B');
  });

  it('forces brainstorm after consecutive failures', async () => {
    const todos = [{ id: 't1', content: 'broken thing', status: 'pending' as const }];
    let brainstormHit = false;
    const agent = makeMockAgent({
      todos,
      runImpl: async (input: unknown) => {
        const text =
          Array.isArray(input) && input[0] && 'text' in input[0] ? (input[0] as any).text : '';
        if (text.includes('You are deciding the next action')) {
          brainstormHit = true;
          return { status: 'done', iterations: 1, finalText: 'try a totally different path' };
        }
        // Always fail execute calls so the failure budget trips.
        return {
          status: 'failed',
          iterations: 1,
          error: { describe: () => 'boom' } as any,
        } as any;
      },
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      failureBudget: 2,
      gitStatusReader: async () => '',
    });

    await engine.runOneIteration(); // fail 1 (todo)
    await engine.runOneIteration(); // fail 2 (todo, budget hit on next decide)
    await engine.runOneIteration(); // should force brainstorm

    expect(brainstormHit).toBe(true);
    const after = await loadGoal(goalPath);
    const sources = after?.journal.map((e) => e.source) ?? [];
    expect(sources).toContain('brainstorm');
  });

  it('stops the engine and clears the goal when finalText contains [GOAL_COMPLETE]', async () => {
    let onEternalStopCalled = false;
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'last step', status: 'pending' }],
      runImpl: async () => ({
        status: 'done',
        iterations: 1,
        finalText: 'Wrapped everything up.\n[GOAL_COMPLETE]\nVerified via `pnpm test` (all green).',
      }),
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      onEternalStop: () => {
        onEternalStopCalled = true;
      },
    });

    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    // The goal file should be deleted and onEternalStop fired so REPL exits eternal mode.
    const after = await loadGoal(goalPath);
    expect(after).toBeNull(); // goal cleared / file removed
    expect(onEternalStopCalled).toBe(true);
    expect(engine.currentState).not.toBe('running');
  });

  it('coordinates [DONE:] markers through Kanban and Brain, then persists goal reached', async () => {
    const goal = {
      ...emptyGoal('Close the adaptive loop'),
      deliverables: ['Implement parser', 'Verify the loop'],
    };
    const boardId = await createGoalKanbanBoard(projectRoot, goal);
    goal.kanbanBoardId = boardId ?? undefined;
    await saveGoal(goalPath, goal);

    let onEternalStopCalled = false;
    const decide = vi.fn(async () => ({
      type: 'answer' as const,
      optionId: 'goal_reached',
      text: 'Verified.',
    }));
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'finish both deliverables', status: 'pending' }],
      runImpl: async () => ({
        status: 'done',
        iterations: 1,
        finalText: '[DONE: 1]\n[DONE: verify the]',
      }),
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      cycleGapMs: 0,
      gitStatusReader: async () => '',
      brain: { decide },
      onEternalStop: () => {
        onEternalStopCalled = true;
      },
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    });

    expect(await engine.runOneIteration()).toBe(true);
    expect(decide).toHaveBeenCalledTimes(1);
    expect(onEternalStopCalled).toBe(true);

    const persisted = await loadGoal(goalPath);
    expect(persisted?.goalState).toBe('completed');
    expect(persisted?.progress).toBe(100);
    expect(persisted?.progressNote).toBe('goal reached');
    expect(persisted?.reachedNote).toBe('goal reached');

    const board = await findGoalKanbanBoard(projectRoot, boardId ?? '');
    expect(board?.tasks.every((task) => task.status === 'completed')).toBe(true);
  });

  it('prefers the adaptive coordinator over legacy [PROGRESS: 100%] auto-complete', async () => {
    // Same iteration emits both markers. The coordinator must own the reach
    // decision; the legacy path (which calls `clearGoalManually` and removes
    // `goal.json`) must NOT run, otherwise the file disappears before the
    // coordinator can persist `goal reached`.
    const goal = {
      ...emptyGoal('Adaptive vs legacy'),
      deliverables: ['A', 'B'],
    };
    const boardId = await createGoalKanbanBoard(projectRoot, goal);
    goal.kanbanBoardId = boardId ?? undefined;
    await saveGoal(goalPath, goal);

    const decide = vi.fn(async () => ({
      type: 'answer' as const,
      optionId: 'keep_working',
      text: 'Not yet.',
    }));
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'finish both', status: 'pending' }],
      runImpl: async () => ({
        status: 'done',
        iterations: 1,
        finalText: '[DONE: 1]\n[DONE: 2]\n[PROGRESS: 100%] — all done',
      }),
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      cycleGapMs: 0,
      gitStatusReader: async () => '',
      brain: { decide },
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    });

    await engine.runOneIteration();
    // Brain kept working: goal stays active and the file is preserved.
    const persisted = await loadGoal(goalPath);
    expect(persisted).not.toBeNull();
    expect(persisted?.goalState).toBe('active');
    expect(persisted?.progress).toBe(100);
    expect(persisted?.reachedNote).toBeUndefined();
    // Brain was consulted exactly once, not twice.
    expect(decide).toHaveBeenCalledTimes(1);
    void boardId;
  });

  it('coordinates partial [DONE:] markers without consulting Brain', async () => {
    // Only one of two deliverables is marked done → progress is 50%, the
    // Brain verdict is intentionally skipped because allComplete is false.
    const goal = {
      ...emptyGoal('Partial completion'),
      deliverables: ['First half', 'Second half'],
    };
    const boardId = await createGoalKanbanBoard(projectRoot, goal);
    goal.kanbanBoardId = boardId ?? undefined;
    await saveGoal(goalPath, goal);

    const decide = vi.fn();
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'finish first', status: 'pending' }],
      runImpl: async () => ({
        status: 'done',
        iterations: 1,
        finalText: '[DONE: 1]',
      }),
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      cycleGapMs: 0,
      gitStatusReader: async () => '',
      brain: { decide },
      now: () => new Date('2026-07-17T12:00:00.000Z'),
    });

    expect(await engine.runOneIteration()).toBe(true);
    expect(decide).not.toHaveBeenCalled();
    const persisted = await loadGoal(goalPath);
    expect(persisted?.progress).toBe(50);
    expect(persisted?.goalState).toBe('active');
    void boardId;
  });

  it('refuses to run further iterations once goalState is completed', async () => {
    // Pre-load a completed goal.
    const goal = emptyGoal('done already');
    goal.goalState = 'completed';
    await saveGoal(goalPath, goal);

    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'should be ignored', status: 'pending' }],
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
    });

    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);
    // Critical: the agent must NOT have been invoked.
    expect((agent.run as any).mock.calls.length).toBe(0);
  });

  it('marks goal completed after threshold consecutive brainstorm DONE responses', async () => {
    let brainstormCount = 0;
    const agent = makeMockAgent({
      todos: [], // no todos
      runImpl: async () => {
        brainstormCount++;
        return { status: 'done', iterations: 1, finalText: 'DONE' };
      },
    });
    // Threshold 1 so the very first DONE flips state — keeps the test
    // off the engine's `await sleep(5_000)` null-action cool-down path.
    // The state-machine behaviour is the same at threshold N; threshold
    // 1 just lets us assert it in a single iteration.
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      brainstormDoneStopThreshold: 1,
    });

    await engine.runOneIteration();

    expect(brainstormCount).toBe(1);
    const after = await loadGoal(goalPath);
    // Goal file is deleted on completion — loadGoal returns null
    expect(after).toBeNull();
  });

  it('rotates past a stuck todo after todoMaxAttempts failures', async () => {
    const todos = [
      { id: 'stuck', content: 'cannot do', status: 'pending' as const },
      { id: 'ok', content: 'do this instead', status: 'pending' as const },
    ];
    const agent = makeMockAgent({
      todos,
      runImpl: async (input: unknown) => {
        const text =
          Array.isArray(input) && input[0] && 'text' in input[0] ? (input[0] as any).text : '';
        if (text.includes('cannot do')) {
          return {
            status: 'failed',
            iterations: 1,
            error: { describe: () => 'permanent failure' } as any,
          } as any;
        }
        return { status: 'done', iterations: 1, finalText: 'ok' };
      },
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      todoMaxAttempts: 2,
      // Disable force-brainstorm by setting the budget high — we want
      // the test to surface the per-todo rotation behaviour, not the
      // global consecutive-failure escape.
      failureBudget: 99,
    });

    // 2 failures on the stuck todo → attempts counter saturates at 2.
    await engine.runOneIteration();
    await engine.runOneIteration();
    // Next pick must skip 'stuck' and target 'ok'.
    await engine.runOneIteration();

    const after = await loadGoal(goalPath);
    expect(after?.todoAttempts?.['stuck']).toBe(2);
    const sources = after?.journal.map((e) => `${e.source}:${e.task}`) ?? [];
    expect(sources[2]).toBe('todo:do this instead');
  });

  it('applies exponential backoff on transient (recoverable) failures', async () => {
    // Stub provider error: agent.run returns failed + recoverable=true.
    // The engine should treat it as transient — sleep before returning,
    // NOT bump consecutiveFailures. Without this, a rate-limit storm
    // burns the failure budget in seconds.
    let runCount = 0;
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'do work', status: 'pending' }],
      runImpl: async () => {
        runCount++;
        return {
          status: 'failed',
          iterations: 1,
          error: {
            recoverable: true,
            describe: () => 'provider rate limited (429)',
          } as any,
        } as any;
      },
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      // Tiny backoff so the test finishes within the default budget.
      transientBackoffBaseMs: 50,
      transientBackoffMaxMs: 200,
      // High failure budget so brainstorm doesn't fire — we want to
      // verify consecutiveFailures is NOT bumped by transients.
      failureBudget: 99,
    });

    const t0 = Date.now();
    await engine.runOneIteration(); // transient #1 → ~50 ms
    await engine.runOneIteration(); // transient #2 → ~100 ms
    await engine.runOneIteration(); // transient #3 → ~200 ms (capped)
    const elapsed = Date.now() - t0;
    expect(elapsed).toBeGreaterThanOrEqual(300);
    expect(runCount).toBe(3);
    // Journal still records the failures — backoff doesn't hide them.
    const after = await loadGoal(goalPath);
    expect(after?.journal.filter((e) => e.status === 'failure').length).toBe(3);
  });

  it('does NOT back off on permanent (non-recoverable) failures', async () => {
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'work', status: 'pending' }],
      runImpl: async () =>
        ({
          status: 'failed',
          iterations: 1,
          error: {
            recoverable: false,
            describe: () => 'auth error (401)',
          } as any,
        }) as any,
    });
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      transientBackoffBaseMs: 5_000, // huge — would dominate if applied
      failureBudget: 99,
    });

    const t0 = Date.now();
    await engine.runOneIteration();
    const elapsed = Date.now() - t0;
    // No backoff for permanent → must stay clearly under the 5s
    // transientBackoffBaseMs; slack for event-loop stalls under suite load.
    expect(elapsed).toBeLessThan(4_000);
  });

  it('resets the transient backoff streak on a successful iteration', async () => {
    let runCount = 0;
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'work', status: 'pending' }],
      runImpl: async () => {
        runCount++;
        if (runCount <= 2) {
          return {
            status: 'failed',
            iterations: 1,
            error: { recoverable: true, describe: () => 'transient' } as any,
          } as any;
        }
        return { status: 'done', iterations: 1, finalText: 'ok' };
      },
    });
    // Capture the engine's COMPUTED backoff via onStage('sleep') rather than
    // measuring wall-clock. Wall-clock around an iteration that performs real
    // fs I/O + a real backoff sleep is flaky under the full parallel suite
    // (event-loop congestion can push a 50ms backoff past a 400ms wall budget);
    // the emitted `ms` is the exact value the backoff logic chose, so asserting
    // on it is deterministic. cycleGapMs:1 keeps the success-path sleep tiny.
    const sleeps: number[] = [];
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      transientBackoffBaseMs: 50,
      transientBackoffMaxMs: 1000,
      failureBudget: 99,
      cycleGapMs: 1,
      onStage: (s) => {
        if (s.phase === 'sleep') sleeps.push(s.ms);
      },
    });

    // Two transients (50ms, 100ms) then a success → resets streak.
    await engine.runOneIteration();
    await engine.runOneIteration();
    await engine.runOneIteration(); // success, streak resets

    // Now another transient: the backoff must restart at the base (50ms), NOT
    // the escalated 200ms it would be if the success hadn't reset the streak.
    // Swap in an always-failing agent without rebuilding the engine.
    (engine as any).opts.agent = makeMockAgent({
      todos: [{ id: 't2', content: 'work', status: 'pending' }],
      runImpl: async () =>
        ({
          status: 'failed',
          iterations: 1,
          error: { recoverable: true, describe: () => 'transient again' } as any,
        }) as any,
    });
    await engine.runOneIteration();

    // sleeps = [50 (transient #1), 100 (transient #2), 1 (success gap), 50 (reset backoff)]
    expect(sleeps[0]).toBe(50);
    expect(sleeps[1]).toBe(100);
    expect(sleeps.at(-1)).toBe(50);
  });

  it('passes autonomousContinue:true and a maxIterations cap to agent.run', async () => {
    const runCalls: Array<{ args: unknown; opts: any }> = [];
    const agent = makeMockAgent({
      todos: [{ id: 't1', content: 'work', status: 'pending' }],
      runImpl: async () => ({ status: 'done', iterations: 1, finalText: 'ok' }),
    });
    // Override run to capture opts (the helper's vi.fn already records but we want named access).
    (agent.run as any) = vi.fn(async (input: unknown, opts: any) => {
      runCalls.push({ args: input, opts });
      return { status: 'done', iterations: 1, finalText: 'ok' };
    });

    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      gitStatusReader: async () => '',
      iterationMaxAgentSteps: 25,
    });

    await engine.runOneIteration();
    expect(runCalls.length).toBe(1);
    expect(runCalls[0]!.opts.autonomousContinue).toBe(true);
    expect(runCalls[0]!.opts.maxIterations).toBe(25);
  });
});
