import { describe, expect, it, vi } from 'vitest';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import { BudgetExceededError } from '../../src/coordination/subagent-budget.js';
import { EventBus } from '../../src/kernel/events.js';
import type { SubagentRunner, TaskResult } from '../../src/types/multi-agent.js';

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'coord1',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 4,
  ...overrides,
});

function waitForDone(coord: DefaultMultiAgentCoordinator, timeoutMs = 2000): Promise<TaskResult[]> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`done not fired within ${timeoutMs}ms`)),
      timeoutMs,
    );
    coord.on('done', (e: { results: TaskResult[] }) => {
      clearTimeout(t);
      resolve(e.results);
    });
  });
}

function waitForCompletions(
  coord: DefaultMultiAgentCoordinator,
  count: number,
  timeoutMs = 2000,
): Promise<TaskResult[]> {
  return new Promise((resolve, reject) => {
    const results: TaskResult[] = [];
    const t = setTimeout(
      () => reject(new Error(`only ${results.length}/${count} completed`)),
      timeoutMs,
    );
    coord.on('task.completed', (e: { result: TaskResult }) => {
      results.push(e.result);
      if (results.length >= count) {
        clearTimeout(t);
        resolve(results);
      }
    });
  });
}

describe('DefaultMultiAgentCoordinator with runner', () => {
  it('runner executes a task and reports success', async () => {
    const runner: SubagentRunner = vi.fn(async () => ({
      result: 'ok',
      iterations: 3,
      toolCalls: 5,
    }));
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 'task1', description: 'do work' });
    const [result] = await donePromise;

    expect(runner).toHaveBeenCalledOnce();
    expect(result.status).toBe('success');
    expect(result.result).toBe('ok');
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(5);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('dispatches targeted tasks to the requested subagent', async () => {
    const seen: string[] = [];
    const runner: SubagentRunner = vi.fn(async (_task, ctx) => {
      seen.push(ctx.subagentId);
      return { result: ctx.subagentId, iterations: 1, toolCalls: 0 };
    });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    await coord.spawn({ id: 'a2', name: 'A2' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 'task1', description: 'do work', subagentId: 'a2' });
    const [result] = await donePromise;

    expect(seen).toEqual(['a2']);
    expect(result.subagentId).toBe('a2');
    expect(result.result).toBe('a2');
  });

  it('budget overflow surfaces as failed status', async () => {
    const runner: SubagentRunner = async (_task, ctx) => {
      ctx.budget.recordToolCall();
      ctx.budget.recordToolCall(); // 2nd call exceeds maxToolCalls=1
      return { result: undefined, iterations: 1, toolCalls: 2 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1', maxToolCalls: 1 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'overrun' });
    const [result] = await donePromise;

    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('budget_tool_calls');
    expect(result.error?.message).toMatch(/tool_calls/);
    expect(result.toolCalls).toBe(2);
  });

  it('per-task budget overrides per-subagent budget', async () => {
    const runner: SubagentRunner = async (_task, ctx) => {
      expect(ctx.budget.limits.maxToolCalls).toBe(2);
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });
    await coord.spawn({ id: 'a1', name: 'A1', maxToolCalls: 10 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'tight task', maxToolCalls: 2 });
    await donePromise;
  });

  it('timeout aborts the runner and reports status=timeout', async () => {
    const runner: SubagentRunner = async (_task, ctx) => {
      ctx.reportProgress?.({
        text: 'incomplete but useful root-cause evidence',
        source: 'runner',
        capturedAt: Date.now(),
      });
      // Cooperative runner that respects the signal
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), 500);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { result: 'too late', iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1', timeoutMs: 30 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'slow' });
    const [result] = await donePromise;

    expect(result.status).toBe('timeout');
    expect(result.partial).toMatchObject({
      text: 'incomplete but useful root-cause evidence',
      source: 'runner',
    });
  });

  it('never-die: a wired onThreshold negotiates a timeout extension and the task finishes (status=success)', async () => {
    // The production runner (makeAgentSubagentRunner) wires budget._events to
    // the subagent's EventBus and onThreshold to requestDecision(). The
    // FleetBus wildcard then forwards budget.threshold_reached to the director,
    // which grants an extension. Here we stand in for that chain with a
    // wildcard listener that always extends — proving the coordinator's
    // executeWithTimeout watchdog re-arms instead of hard-killing on timeout.
    const extends_: number[] = [];
    const runner: SubagentRunner = async (_task, ctx) => {
      const bus = new EventBus();
      bus.onPattern('*', (type, payload) => {
        if (type === 'budget.threshold_reached') {
          const p = payload as {
            limit: number;
            extend: (e: { timeoutMs: number }) => void;
          };
          extends_.push(p.limit);
          p.extend({ timeoutMs: 999_999 });
        }
      });
      ctx.budget._events = bus;
      ctx.budget.onThreshold = ({ requestDecision }) => requestDecision();

      // Cooperative work that outlives the initial 20ms timeout window but
      // finishes on its own once the extension keeps it alive.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), 80);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { result: 'finished', iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1', timeoutMs: 20 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'long but progressing' });
    const [result] = await donePromise;

    // The watchdog fired (the listener saw at least one threshold) but the
    // task was NOT killed — it negotiated headroom and completed.
    expect(extends_.length).toBeGreaterThan(0);
    expect(result.status).toBe('success');
    expect(result.result).toBe('finished');
  });

  it('idle-timeout reaps a genuinely stalled subagent (no activity)', async () => {
    // A runner that does nothing but sleep past the idle window, never
    // emitting activity — the watchdog should reap it as a stall.
    const runner: SubagentRunner = async (_task, ctx) => {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => resolve(), 500);
        ctx.signal.addEventListener('abort', () => {
          clearTimeout(t);
          reject(new Error('aborted'));
        });
      });
      return { result: 'too late', iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });
    // idleTimeoutMs only (no wall-clock cap).
    await coord.spawn({ id: 'a1', name: 'A1', idleTimeoutMs: 40 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'stalled' });
    const [result] = await donePromise;
    expect(result.status).toBe('timeout');
  });

  it('idle-timeout does NOT reap an actively-working subagent', async () => {
    // The runner keeps marking activity faster than the idle window, so the
    // watchdog must re-arm forever and let it finish on its own.
    // Activity interval (50ms) is 5× smaller than the idle window (250ms), so a
    // single CPU-starved sleep would have to stretch 5× before the watchdog
    // could spuriously reap. Total work (8 × 50ms = 400ms) still exceeds the
    // idle window, so the markActivity re-arming is genuinely necessary to
    // survive — without it the agent would time out. The old 20ms-vs-40ms (2×)
    // margin flaked under full-suite load.
    const runner: SubagentRunner = async (_task, ctx) => {
      for (let i = 0; i < 8; i++) {
        await new Promise((r) => setTimeout(r, 50));
        ctx.budget.markActivity(); // simulate a tool call / streamed progress
      }
      return { result: 'finished', iterations: 1, toolCalls: 8 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });
    await coord.spawn({ id: 'a1', name: 'A1', idleTimeoutMs: 250 });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'busy but slow' });
    const [result] = await donePromise;
    expect(result.status).toBe('success');
    expect(result.result).toBe('finished');
  });

  it('respects maxConcurrent — extra tasks queue until a slot frees', async () => {
    let active = 0;
    let maxActive = 0;
    const runner: SubagentRunner = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 30));
      active--;
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ maxConcurrent: 2 }), { runner });

    for (let i = 0; i < 4; i++) await coord.spawn({ id: `a${i}`, name: `A${i}` });
    const completions = waitForCompletions(coord, 5);
    for (let i = 0; i < 5; i++) await coord.assign({ id: `t${i}`, description: `task ${i}` });

    const results = await completions;
    expect(results).toHaveLength(5);
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(results.every((r) => r.status === 'success')).toBe(true);
  });

  it('context isolation — each subagent gets its own AbortSignal', async () => {
    // Run both tasks concurrently so they land on different subagents.
    // With maxConcurrent=2 both slots are claimed before either completes,
    // forcing the coordinator to pick distinct subagents.
    const signals: AbortSignal[] = [];
    let resolveAll!: () => void;
    const allStarted = new Promise<void>((r) => {
      resolveAll = r;
    });
    let started = 0;
    const runner: SubagentRunner = async (_task, ctx) => {
      signals.push(ctx.signal);
      if (++started === 2) resolveAll();
      await allStarted;
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ maxConcurrent: 2 }), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    await coord.spawn({ id: 'a2', name: 'A2' });
    const completions = waitForCompletions(coord, 2);
    await coord.assign({ id: 't1', description: 'one' });
    await coord.assign({ id: 't2', description: 'two' });
    await completions;

    expect(signals.length).toBe(2);
    expect(signals[0]).not.toBe(signals[1]);
  });

  it('stop() aborts an in-flight task', async () => {
    let aborted = false;
    const runner: SubagentRunner = async (_task, ctx) => {
      await new Promise<void>((resolve, reject) => {
        ctx.signal.addEventListener('abort', () => {
          aborted = true;
          reject(new Error('aborted'));
        });
        setTimeout(resolve, 1000);
      });
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'long' });

    // Yield once so the runner is dispatched before we stop.
    await new Promise((r) => setTimeout(r, 10));
    await coord.stop('a1');

    const [result] = await donePromise;
    expect(aborted).toBe(true);
    expect(result.status).toBe('stopped');
  });

  it('runner exception surfaces as failed status', async () => {
    const runner: SubagentRunner = async () => {
      throw new Error('runner kaboom');
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'fail' });
    const [result] = await donePromise;

    expect(result.status).toBe('failed');
    expect(result.error?.message).toMatch(/kaboom/);
    expect(result.error?.kind).toBe('unknown');
  });

  it('coordinator defaultBudget applies when subagent omits limits', async () => {
    let observed: { maxIterations?: number } = {};
    const runner: SubagentRunner = async (_task, ctx) => {
      observed = { maxIterations: ctx.budget.limits.maxIterations };
      return { result: undefined, iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(
      makeConfig({ defaultBudget: { maxIterations: 7 } }),
      { runner },
    );

    await coord.spawn({ id: 'a1', name: 'A1' });
    const donePromise = waitForDone(coord);
    await coord.assign({ id: 't1', description: 'x' });
    await donePromise;

    expect(observed.maxIterations).toBe(7);
  });

  it('subagent budget falls back to default if subagent error sidelines it briefly', async () => {
    // After a failed task the subagent should self-recover to 'idle' and accept new work
    const calls: number[] = [];
    let n = 0;
    const runner: SubagentRunner = async () => {
      n++;
      calls.push(n);
      if (n === 1) throw new Error('first crash');
      return { result: 'second-ok', iterations: 1, toolCalls: 0 };
    };
    const coord = new DefaultMultiAgentCoordinator(makeConfig({ maxConcurrent: 1 }), { runner });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completions = waitForCompletions(coord, 2);
    await coord.assign({ id: 't1', description: 'first' });
    await coord.assign({ id: 't2', description: 'second' });
    const results = await completions;

    expect(results[0]!.status).toBe('failed');
    expect(results[1]!.status).toBe('success');
    expect(results[1]!.result).toBe('second-ok');
  });

  it('BudgetExceededError is exported and constructible', () => {
    const err = new BudgetExceededError('tokens', 100, 150);
    expect(err.name).toBe('BudgetExceededError');
    expect(err.kind).toBe('tokens');
    expect(err.limit).toBe(100);
    expect(err.observed).toBe(150);
    expect(err.message).toMatch(/Budget exceeded/);
  });

  it('remove() with a running task + queued pending task completes both without inFlight underflow', async () => {
    // Regression: remove() used to route orphaned PENDING tasks through
    // recordCompletion, whose inFlight-- stole a decrement from the still-
    // running task — tripping the underflow guard, suppressing the running
    // task's task.completed, and hanging its awaiter. Both tasks must complete
    // and no inFlight_underflow warning may fire.
    let abortRunner: (() => void) | undefined;
    const runner: SubagentRunner = (_task, ctx) =>
      new Promise((_resolve, reject) => {
        // Cooperative runner: reject when the coordinator aborts our signal.
        const onAbort = () => reject(new Error('agent aborted'));
        if (ctx.signal.aborted) onAbort();
        else ctx.signal.addEventListener('abort', onAbort, { once: true });
        abortRunner = onAbort;
      });

    const coord = new DefaultMultiAgentCoordinator(makeConfig(), { runner });
    const warnings: Array<{ type: string }> = [];
    coord.on('warning', (w: { type: string }) => warnings.push(w));
    const completed = new Set<string>();
    coord.on('task.completed', (e: { result: TaskResult }) =>
      completed.add(e.result.taskId),
    );

    await coord.spawn({ id: 'a1', name: 'A1' });
    // taskA dispatches and blocks the single worker (inFlight=1).
    await coord.assign({ id: 'taskA', subagentId: 'a1', description: 'long task' });
    // taskB targets the now-busy worker, so it stays pending.
    await coord.assign({ id: 'taskB', subagentId: 'a1', description: 'queued task' });

    expect(coord.getStats().inFlight).toBe(1);
    expect(coord.getStats().pending).toBe(1);

    // Remove the worker while taskA runs and taskB is queued.
    await coord.remove('a1');
    // Let the cooperative runner observe the abort and reject taskA.
    abortRunner?.();
    // Flush microtasks so taskA's rejection → recordCompletion settles.
    await new Promise((r) => setTimeout(r, 10));

    // Both tasks must have produced a terminal completion event.
    expect(completed.has('taskA')).toBe(true);
    expect(completed.has('taskB')).toBe(true);
    // The decrement accounting must be clean — no underflow warning.
    expect(warnings.find((w) => w.type === 'inFlight_underflow')).toBeUndefined();
    expect(coord.getStats().inFlight).toBe(0);
  });
});
