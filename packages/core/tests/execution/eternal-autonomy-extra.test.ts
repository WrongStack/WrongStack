import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/core/agent.js';
import { EternalAutonomyEngine } from '../../src/execution/eternal-autonomy.js';
import { EventBus } from '../../src/kernel/events.js';
import { emptyGoal, goalFilePath, loadGoal, saveGoal } from '../../src/storage/goal-store.js';

type RunResult = { status: string; iterations: number; finalText?: string; error?: unknown };

function makeAgent(runImpl: (input: unknown) => Promise<RunResult>, todos: unknown[] = []): Agent {
  return {
    run: vi.fn(runImpl),
    register: vi.fn(),
    use: vi.fn(),
    container: null as never,
    tools: null as never,
    providers: null as never,
    events: new EventBus(),
    pipelines: null as never,
    ctx: { todos } as never,
  } as never as Agent;
}

let tmp: string;
let projectRoot: string;
let goalPath: string;

beforeEach(async () => {
  tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'wstack-eternal-extra-'));
  projectRoot = tmp;
  goalPath = goalFilePath(projectRoot);
  await fs.mkdir(path.dirname(goalPath), { recursive: true });
  await saveGoal(goalPath, emptyGoal('Make the project better'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.rm(tmp, { recursive: true, force: true });
});

const todo = (content: string) => ({ id: 't1', content, status: 'pending' as const });

describe('EternalAutonomyEngine.run() loop', () => {
  it('survives an iteration error, resets on a good iteration, then stops', async () => {
    const agent = makeAgent(async () => ({ status: 'done', iterations: 1, finalText: 'ok' }), [todo('x')]);
    const onError = vi.fn();
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0, onError });
    const spy = vi.spyOn(engine, 'runOneIteration');
    spy.mockRejectedValueOnce(new Error('iteration boom')); // → catch: onError + appendFailure
    spy.mockResolvedValueOnce(true); // → iterationOk resets consecutiveFailures
    spy.mockImplementationOnce(async () => {
      (engine as never as { stopRequested: boolean }).stopRequested = true;
      return false;
    });
    await engine.run();
    expect(onError).toHaveBeenCalledWith(expect.any(Error), 1);
    expect((engine as never as { consecutiveFailures: number }).consecutiveFailures).toBe(0);
    expect(engine.currentState).toBe('stopped');
    const goal = await loadGoal(goalPath);
    expect(goal?.journal.some((e) => e.status === 'failure')).toBe(true);
  });
});

describe('EternalAutonomyEngine — agent.run throwing', () => {
  it('classifies a thrown plain error as a failure', async () => {
    const agent = makeAgent(async () => { throw new Error('provider exploded'); }, [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);
    expect((engine as never as { consecutiveFailures: number }).consecutiveFailures).toBe(1);
  });

  it('classifies a thrown AbortError as an abort', async () => {
    const agent = makeAgent(async () => {
      const e = new Error('aborted by signal');
      e.name = 'AbortError';
      throw e;
    }, [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);
  });

  it('honours a recoverable flag on a thrown error (transient backoff)', async () => {
    const agent = makeAgent(async () => {
      const e = Object.assign(new Error('429 rate limited'), { recoverable: true });
      throw e;
    }, [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0, transientBackoffBaseMs: 0 });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);
    // base=0 → computeTransientBackoffMs returns 0 → no backoff sleep, just retry counter
    expect((engine as never as { consecutiveTransientRetries: number }).consecutiveTransientRetries).toBe(1);
  });

  it('returns false without counting a failure when aborted after stop()', async () => {
    let engineRef: EternalAutonomyEngine;
    const agent = makeAgent(async () => {
      (engineRef as never as { stopRequested: boolean }).stopRequested = true;
      return { status: 'aborted', iterations: 1 };
    }, [todo('x')]);
    engineRef = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const ok = await engineRef.runOneIteration();
    expect(ok).toBe(false);
    expect((engineRef as never as { consecutiveFailures: number }).consecutiveFailures).toBe(0);
  });
});

describe('EternalAutonomyEngine — brainstorm task variations', () => {
  // For the no-task paths, the engine would sleep 5s; flip stopRequested in the
  // brainstorm agent so the post-decide `if (!stopRequested)` skips that sleep.
  function noTaskEngine(brainstormImpl: () => Promise<RunResult>): EternalAutonomyEngine {
    let engineRef: EternalAutonomyEngine;
    const agent = makeAgent(async () => {
      const r = await brainstormImpl();
      (engineRef as never as { stopRequested: boolean }).stopRequested = true;
      return r;
    }, []);
    engineRef = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0, gitStatusReader: async () => '' });
    return engineRef;
  }

  it('returns a real brainstormed task (first non-empty line)', async () => {
    const directives: string[] = [];
    const agent = makeAgent(async (input) => {
      directives.push(JSON.stringify(input));
      // first call = brainstorm (returns a task line), second = execution
      return { status: 'done', iterations: 1, finalText: directives.length === 1 ? 'Add a CHANGELOG entry\nextra' : 'executed' };
    }, []);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0, gitStatusReader: async () => '' });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    expect(directives[1]).toContain('Add a CHANGELOG entry');
  });

  it('treats a non-done brainstorm result as no task', async () => {
    const ok = await noTaskEngine(async () => ({ status: 'failed', iterations: 1, finalText: 'whatever' })).runOneIteration();
    expect(ok).toBe(false);
  });

  it('treats empty brainstorm text as no task', async () => {
    const ok = await noTaskEngine(async () => ({ status: 'done', iterations: 1, finalText: '   ' })).runOneIteration();
    expect(ok).toBe(false);
  });

  it('returns null from the brainstorm path when agent.run throws', async () => {
    // throw happens before the stopRequested flip → decide returns null → engine
    // would sleep; stop it pre-emptively so the test stays fast.
    let engineRef: EternalAutonomyEngine;
    const agent = makeAgent(async () => {
      (engineRef as never as { stopRequested: boolean }).stopRequested = true;
      throw new Error('brainstorm down');
    }, []);
    engineRef = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0, gitStatusReader: async () => '' });
    const ok = await engineRef.runOneIteration();
    expect(ok).toBe(false);
  });
});

describe('EternalAutonomyEngine — git reader failure', () => {
  it('falls through to brainstorm when the git reader throws', async () => {
    let calls = 0;
    const agent = makeAgent(async () => {
      calls++;
      // first call is the brainstorm probe (git failed → brainstorm)
      return { status: 'done', iterations: 1, finalText: calls === 1 ? 'Write docs' : 'done' };
    }, []);
    const engine = new EternalAutonomyEngine({
      agent, projectRoot, goalPath, cycleGapMs: 0,
      gitStatusReader: async () => { throw new Error('not a git repo'); },
    });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    expect(calls).toBeGreaterThanOrEqual(1);
  });
});

describe('EternalAutonomyEngine — terminal markers + progress', () => {
  it('clears the goal on [GOAL_COMPLETE] and fires onEternalStop', async () => {
    const onEternalStop = vi.fn();
    const agent = makeAgent(async () => ({ status: 'done', iterations: 1, finalText: 'all set\n[GOAL_COMPLETE]' }), [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0, onEternalStop });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    expect(onEternalStop).toHaveBeenCalled();
    await expect(fs.stat(goalPath)).rejects.toBeDefined(); // goal file removed
  });

  it('clears the goal on a [goal clear] marker', async () => {
    const onEternalStop = vi.fn();
    const agent = makeAgent(async () => ({ status: 'done', iterations: 1, finalText: 'done here\n[goal clear]' }), [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0, onEternalStop });
    await engine.runOneIteration();
    expect(onEternalStop).toHaveBeenCalled();
  });

  it('persists partial progress from [PROGRESS: N%]', async () => {
    const agent = makeAgent(async () => ({ status: 'done', iterations: 1, finalText: 'halfway [PROGRESS: 50%] keep going' }), [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    const goal = await loadGoal(goalPath);
    expect(goal?.progress).toBe(50);
  });

  it('completes the goal when the agent reports [PROGRESS: 100%]', async () => {
    const agent = makeAgent(async () => ({ status: 'done', iterations: 1, finalText: 'finished [PROGRESS: 100%]' }), [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    expect((engine as never as { stopRequested: boolean }).stopRequested).toBe(true);
  });
});

describe('EternalAutonomyEngine — failure classification', () => {
  it('applies interruptible transient backoff on a recoverable failure', async () => {
    const agent = makeAgent(
      async () => ({ status: 'failed', iterations: 1, error: { recoverable: true, describe: () => 'rate limited' } }),
      [todo('x')],
    );
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const backoff = vi.spyOn(engine as never as { sleepInterruptible: (ms: number) => Promise<void> }, 'sleepInterruptible').mockResolvedValue();
    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);
    expect(backoff).toHaveBeenCalled();
    expect((engine as never as { consecutiveTransientRetries: number }).consecutiveTransientRetries).toBe(1);
  });

  it('treats max_iterations as a non-transient failure', async () => {
    const agent = makeAgent(async () => ({ status: 'max_iterations', iterations: 500 }), [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);
    expect((engine as never as { consecutiveFailures: number }).consecutiveFailures).toBe(1);
  });

  it('counts a non-user abort as a failure', async () => {
    const agent = makeAgent(async () => ({ status: 'aborted', iterations: 1 }), [todo('x')]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(false);
    expect((engine as never as { consecutiveFailures: number }).consecutiveFailures).toBe(1);
  });
});

describe('EternalAutonomyEngine — git source', () => {
  it('reads real `git status --porcelain` to source a task from a dirty tree', async () => {
    // Init a real git repo with a dirty file; no gitStatusReader → readGitStatus runs.
    execFileSync('git', ['init'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.email', 't@e.st'], { cwd: projectRoot });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: projectRoot });
    await fs.writeFile(path.join(projectRoot, 'dirty.txt'), 'uncommitted');
    const directives: string[] = [];
    const agent = makeAgent(async (input) => {
      directives.push(JSON.stringify(input));
      return { status: 'done', iterations: 1, finalText: 'inspected' };
    }, []); // no todos → falls through to git
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    const ok = await engine.runOneIteration();
    expect(ok).toBe(true);
    expect(directives.join(' ')).toContain('dirty.txt');
  });
});

describe('EternalAutonomyEngine — brainstorm DONE + brain consultation', () => {
  async function runBrainstormDone(opts: { brain?: { decide: (r: unknown) => Promise<unknown> } } = {}) {
    // No todos, clean tree (gitStatusReader returns '') → brainstorm; agent answers DONE.
    const agent = makeAgent(async () => ({ status: 'done', iterations: 1, finalText: 'DONE' }), []);
    const engine = new EternalAutonomyEngine({
      agent,
      projectRoot,
      goalPath,
      cycleGapMs: 0,
      noTaskCoolDownMs: 0, // brain-denied iterations must not idle 5 s
      gitStatusReader: async () => '',
      brainstormDoneStopThreshold: 1, // stop after the first DONE
      ...opts,
    });
    const ok = await engine.runOneIteration();
    return { engine, ok };
  }

  it('stops after the DONE threshold when no brain is wired (heuristic)', async () => {
    const { engine } = await runBrainstormDone();
    expect((engine as never as { stopRequested: boolean }).stopRequested).toBe(true);
  });

  it('keeps going when the brain denies completion', async () => {
    const { engine } = await runBrainstormDone({ brain: { decide: async () => ({ type: 'deny', reason: 'not done' }) } });
    expect((engine as never as { consecutiveBrainstormDone: number }).consecutiveBrainstormDone).toBe(0);
    expect((engine as { consecutiveBrainstormDone: number }).consecutiveBrainstormDone).toBe(0);
  });

  it('stops when the brain picks the goal_complete option', async () => {
    const { engine } = await runBrainstormDone({
      brain: {
        decide: async () => ({
          type: 'answer',
          optionId: 'goal_complete',
          text: 'The goal is complete — stop the eternal run',
        }),
      },
    });
    expect((engine as never as { stopRequested: boolean }).stopRequested).toBe(true);
  });

  it('keeps going on a prose answer without the exact option id', async () => {
    // "Yes, the goal is complete." as free text is NOT control-plane input —
    // only optionId 'goal_complete' stops the run.
    const { engine } = await runBrainstormDone({
      brain: { decide: async () => ({ type: 'answer', text: 'Yes, the goal is complete.' }) },
    });
    expect((engine as never as { consecutiveBrainstormDone: number }).consecutiveBrainstormDone).toBe(0);
    expect((engine as never as { stopRequested: boolean }).stopRequested).toBe(false);
  });

  it('stops (trusts the heuristic) when the brain asks the human, and journals prior work', async () => {
    // Seed a journal entry so consultBrainForDone's recent-work map runs.
    const g = await loadGoal(goalPath);
    g!.journal.push({ iteration: 1, at: new Date().toISOString(), source: 'todo', task: 'earlier work', status: 'success' });
    await saveGoal(goalPath, g!);
    const { engine } = await runBrainstormDone({ brain: { decide: async () => ({ type: 'ask_human', prompt: 'unsure' }) } });
    // ask_human is neither deny nor a complete-answer → consultBrainForDone returns true → stop.
    expect((engine as never as { stopRequested: boolean }).stopRequested).toBe(true);
  });

  it('trusts the heuristic when the brain decide() throws', async () => {
    const { engine } = await runBrainstormDone({ brain: { decide: async () => { throw new Error('brain down'); } } });
    expect((engine as never as { stopRequested: boolean }).stopRequested).toBe(true);
  });
});

describe('EternalAutonomyEngine — todo selection edges', () => {
  it('skips a non-pending todo and selects the next pending one', async () => {
    const directives: string[] = [];
    const agent = makeAgent(async (input) => {
      directives.push(JSON.stringify(input));
      return { status: 'done', iterations: 1, finalText: 'ok' };
    }, [
      { id: 'done1', content: 'already done', status: 'completed' },
      { id: 'p1', content: 'the real task', status: 'pending' },
    ]);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    await engine.runOneIteration();
    expect(directives[0]).toContain('the real task');
  });

  it('falls through when ctx.todos is not an array', async () => {
    let engineRef: EternalAutonomyEngine;
    const agent = makeAgent(async () => {
      (engineRef as never as { stopRequested: boolean }).stopRequested = true;
      return { status: 'done', iterations: 1, finalText: 'noop' };
    }, undefined as never);
    (agent.ctx as { todos: unknown }).todos = null; // non-array → pickPendingTodo returns null
    engineRef = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0, gitStatusReader: async () => '' });
    const ok = await engineRef.runOneIteration();
    expect(typeof ok).toBe('boolean');
  });

  it('counts a trailing-text DONE brainstorm answer toward the DONE streak', async () => {
    let engineRef: EternalAutonomyEngine;
    const agent = makeAgent(async () => {
      (engineRef as never as { stopRequested: boolean }).stopRequested = true;
      return { status: 'done', iterations: 1, finalText: 'DONE\nnothing left to do' };
    }, []);
    engineRef = new EternalAutonomyEngine({
      agent, projectRoot, goalPath, cycleGapMs: 0, gitStatusReader: async () => '', brainstormDoneStopThreshold: 99,
    });
    await engineRef.runOneIteration();
    expect((engineRef as never as { consecutiveBrainstormDone: number }).consecutiveBrainstormDone).toBe(1);
  });
});

describe('EternalAutonomyEngine — prime idempotence', () => {
  it('prime() twice is a no-op the second time (engineState already running)', async () => {
    const agent = makeAgent(async () => ({ status: 'done', iterations: 1, finalText: 'ok' }), []);
    const engine = new EternalAutonomyEngine({ agent, projectRoot, goalPath, cycleGapMs: 0 });
    await engine.prime();
    await engine.prime(); // persistEngineState('running') → already running → early return
    const goal = await loadGoal(goalPath);
    expect(goal?.engineState).toBe('running');
  });
});
