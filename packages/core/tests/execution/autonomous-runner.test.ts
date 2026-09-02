import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Agent } from '../../src/core/agent.js';
import type { RunResult } from '../../src/core/agent.js';
import type { Context } from '../../src/core/context.js';
import { AutonomousRunner, DoneConditionChecker } from '../../src/execution/autonomous-runner.js';
import { EventBus } from '../../src/kernel/events.js';
import type { DoneCondition } from '../../src/types/multi-agent.js';

function mockAgent(overrides: Partial<Agent> = {}): Agent {
  // Real EventBus so AutonomousRunner can subscribe to `tool.executed`
  // to count individual tool invocations (BUG-001 fix). Tests that want
  // to simulate tool calls emit on this bus from within their run mock.
  const events = new EventBus();
  return {
    run: vi.fn().mockResolvedValue({ status: 'done', iterations: 1, finalText: 'result' }),
    register: vi.fn(),
    use: vi.fn(),
    container: null as any,
    tools: null as any,
    providers: null as any,
    events,
    pipelines: null as any,
    ctx: null as any,
    ...overrides,
  } as never as Agent;
}

function mockContext(signal?: AbortSignal): Context {
  return {
    signal: signal ?? new AbortController().signal,
    messages: [],
    systemPrompt: [],
    model: 'test-model',
    provider: null as any,
    tools: [],
    session: { append: vi.fn(), flush: vi.fn(), getMessages: () => [], clear: vi.fn() } as any,
    tokenCounter: { account: vi.fn(), estimate: vi.fn(), reset: vi.fn() } as any,
    registerAbortHook: vi.fn(),
    drainAbortHooks: vi.fn(),
  } as never as Context;
}

function makeResult(status: RunResult['status'], finalText = 'output', iterations = 1): RunResult {
  return { status, iterations, finalText };
}

describe('DoneConditionChecker', () => {
  it('returns done=true for iterations condition when max reached', () => {
    const checker = new DoneConditionChecker({ type: 'iterations', maxIterations: 3 });
    const result = checker.check({ iterations: 3, toolCalls: 0 });
    expect(result.done).toBe(true);
    expect(result.reason).toMatch(/max iterations/);
    expect(result.iterations).toBe(3);
    expect(result.toolCalls).toBe(0);
  });

  it('returns done=false for iterations condition when below max', () => {
    const checker = new DoneConditionChecker({ type: 'iterations', maxIterations: 3 });
    const result = checker.check({ iterations: 2, toolCalls: 0 });
    expect(result.done).toBe(false);
    expect(result.iterations).toBe(2);
  });

  it('returns done=true for tool_calls condition when max reached', () => {
    const checker = new DoneConditionChecker({ type: 'tool_calls', maxToolCalls: 5 });
    const result = checker.check({ iterations: 0, toolCalls: 5 });
    expect(result.done).toBe(true);
    expect(result.reason).toMatch(/max tool calls/);
  });

  it('returns done=false for tool_calls condition when below max', () => {
    const checker = new DoneConditionChecker({ type: 'tool_calls', maxToolCalls: 5 });
    const result = checker.check({ iterations: 0, toolCalls: 4 });
    expect(result.done).toBe(false);
  });

  it('enforces an explicit maxIterations of 0 (zero-iteration budget)', () => {
    // Regression (round r15): the old truthiness guard treated 0 as "no cap"
    // and failed open, while the /tier CLI accepts+stores 0 ("✓ · 0 iters")
    // and SubagentBudget.checkLimits enforces it (`!== undefined`). An
    // explicit zero budget must stop the loop before any work.
    const checker = new DoneConditionChecker({ type: 'iterations', maxIterations: 0 });
    const result = checker.check({ iterations: 0, toolCalls: 0 });
    expect(result.done).toBe(true);
    expect(result.reason).toMatch(/max iterations \(0\) reached/);
  });

  it('enforces an explicit maxToolCalls of 0 (zero-tool budget)', () => {
    const checker = new DoneConditionChecker({ type: 'tool_calls', maxToolCalls: 0 });
    const result = checker.check({ iterations: 0, toolCalls: 0 });
    expect(result.done).toBe(true);
    expect(result.reason).toMatch(/max tool calls \(0\) reached/);
  });

  it('enforces explicit zero caps in directive mode', () => {
    const checker = new DoneConditionChecker({ type: 'directive', maxIterations: 0 });
    const result = checker.check({ iterations: 0, toolCalls: 0 });
    expect(result.done).toBe(true);
    expect(result.reason).toMatch(/max iterations \(0\) reached/);
  });

  it('treats an undefined budget as no cap (unchanged semantics)', () => {
    expect(
      new DoneConditionChecker({ type: 'iterations' }).check({ iterations: 99, toolCalls: 99 })
        .done,
    ).toBe(false);
    expect(
      new DoneConditionChecker({ type: 'tool_calls' }).check({ iterations: 99, toolCalls: 99 })
        .done,
    ).toBe(false);
  });

  it('returns done=true for output_match when pattern matches', () => {
    const checker = new DoneConditionChecker({ type: 'output_match', pattern: 'success' });
    const result = checker.check({
      iterations: 1,
      toolCalls: 1,
      lastOutput: 'task completed success',
    });
    expect(result.done).toBe(true);
    expect(result.reason).toMatch(/output matched pattern/);
  });

  it('returns done=false for output_match when no lastOutput', () => {
    const checker = new DoneConditionChecker({ type: 'output_match', pattern: 'success' });
    const result = checker.check({ iterations: 1, toolCalls: 1, lastOutput: undefined });
    expect(result.done).toBe(false);
  });

  it('returns done=false for output_match when pattern does not match', () => {
    const checker = new DoneConditionChecker({ type: 'output_match', pattern: 'success' });
    const result = checker.check({ iterations: 1, toolCalls: 1, lastOutput: 'task failed' });
    expect(result.done).toBe(false);
  });

  it('handles custom type without crashing (reserved)', () => {
    const checker = new DoneConditionChecker({ type: 'custom' } as DoneCondition);
    const result = checker.check({ iterations: 1, toolCalls: 1, lastOutput: 'test' });
    expect(result.done).toBe(false);
  });

  it('handles all_tasks_done type without crashing', () => {
    const checker = new DoneConditionChecker({ type: 'all_tasks_done' });
    const result = checker.check({ iterations: 1, toolCalls: 1 });
    expect(result.done).toBe(false);
  });
});

describe('AutonomousRunner', () => {
  let abortController: AbortController;

  beforeEach(() => {
    abortController = new AbortController();
  });

  afterEach(() => {
    abortController.abort();
  });

  it('stops when max iterations condition is met', async () => {
    const agent = mockAgent({
      run: vi.fn().mockResolvedValue(makeResult('done', 'out')),
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 2 },
      iterationTimeoutMs: 5000,
    });

    const result = await runner.run();

    expect(result.status).toBe('done');
    expect(result.reason).toMatch(/max iterations/);
    // Should have run once per iteration until hitting max
    expect(agent.run).toHaveBeenCalled();
  });

  it('completes immediately without running the agent when maxIterations is 0', async () => {
    // Regression (round r15): a zero-iteration budget is fail-closed — the
    // runner stops on the first done-check, before the first agent.run.
    // The old truthiness guard made `maxIterations: 0` mean "no cap", so the
    // outer loop never finished (each inner run capped at 1 iteration).
    const agent = mockAgent();
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 0 },
      iterationTimeoutMs: 5000,
    });

    const result = await runner.run();

    expect(result.status).toBe('done');
    expect(result.reason).toMatch(/max iterations \(0\) reached/);
    expect(result.iterations).toBe(0);
    expect(agent.run).not.toHaveBeenCalled();
  });

  it('stops when max tool_calls condition is met', async () => {
    // BUG-001: toolCalls now counts actual `tool.executed` events, not
    // iterations. The mocked `agent.run` emits one `tool.executed` per
    // call so the budget of 3 fires after exactly 3 iterations.
    const agent = mockAgent({});
    (agent.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      agent.events.emit('tool.executed', { id: 't', name: 'mock', durationMs: 0, ok: true });
      return makeResult('done', 'out');
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'tool_calls', maxToolCalls: 3 },
    });

    const result = await runner.run();

    expect(result.status).toBe('done');
    expect(result.reason).toMatch(/max tool calls/);
    expect(result.toolCalls).toBe(3);
  });

  it('toolCalls counts individual tool.executed events, not iterations', async () => {
    // Regression test for BUG-001. A single iteration that fires 5 tools
    // must bump `toolCalls` by 5, not 1. Without this, per-tool budgets
    // would silently let the agent burn through far more tools than
    // allowed.
    const agent = mockAgent({});
    (agent.run as ReturnType<typeof vi.fn>).mockImplementationOnce(async () => {
      for (let i = 0; i < 5; i++) {
        agent.events.emit('tool.executed', { id: `t${i}`, name: 'mock', durationMs: 0, ok: true });
      }
      return makeResult('done', 'out');
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'tool_calls', maxToolCalls: 3 },
    });

    const result = await runner.run();

    // After one iteration the loop sees toolCalls=5 >= 3 and stops on
    // the next done-check. The asserted count is the cumulative emit count.
    expect(result.toolCalls).toBeGreaterThanOrEqual(3);
    expect(result.reason).toMatch(/max tool calls/);
  });

  it('stops when output matches pattern', async () => {
    const agent = mockAgent({
      run: vi.fn().mockResolvedValue(makeResult('done', 'DONE_TASK')),
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'output_match', pattern: 'DONE_' },
    });

    const result = await runner.run();

    expect(result.status).toBe('done');
    expect(result.reason).toMatch(/output matched pattern/);
  });

  it('calls onIteration callback each iteration before agent run', async () => {
    const agent = mockAgent({
      run: vi.fn().mockResolvedValue(makeResult('done', 'out')),
    });
    const onIteration = vi.fn();
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 2 },
      onIteration,
    });

    await runner.run();

    expect(onIteration).toHaveBeenCalled();
  });

  it('calls onDone callback when done condition is met', async () => {
    const agent = mockAgent({
      run: vi.fn().mockResolvedValue(makeResult('done', 'out')),
    });
    const onDone = vi.fn();
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 1 },
      onDone,
    });

    await runner.run();

    expect(onDone).toHaveBeenCalled();
  });

  it('returns failed result when agent returns failed status', async () => {
    const agent = mockAgent({
      run: vi.fn().mockResolvedValue(makeResult('failed', 'error occurred')),
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 5 },
    });

    const result = await runner.run();

    expect(result.status).toBe('failed');
  });

  it('returns aborted result when agent returns aborted status', async () => {
    const agent = mockAgent({
      run: vi.fn().mockResolvedValue(makeResult('aborted')),
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 5 },
    });

    const result = await runner.run();

    expect(result.status).toBe('aborted');
  });

  it('handles timeout error and returns failed result', async () => {
    const agent = mockAgent({
      run: vi
        .fn()
        .mockRejectedValue(Object.assign(new Error('iteration timeout'), { name: 'AbortError' })),
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 5 },
      iterationTimeoutMs: 10,
    });

    const result = await runner.run();

    expect(result.status).toBe('failed');
    expect(result.reason).toBe('iteration timeout');
  });

  it('fails on non-timeout errors instead of continuing', async () => {
    let callCount = 0;
    const agent = mockAgent({
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        if (callCount === 1) throw new Error('some error');
        return makeResult('done', 'recovered');
      }),
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 3 },
      iterationTimeoutMs: 5000,
    });

    const result = await runner.run();

    // Non-timeout errors should stop the runner immediately — silently
    // swallowing them would cause an infinite loop burning provider tokens.
    expect(result.status).toBe('failed');
    expect(callCount).toBe(1);
  });

  it('stop() prevents further iterations', async () => {
    let callCount = 0;
    const agent = mockAgent({
      run: vi.fn().mockImplementation(async () => {
        callCount++;
        return makeResult('done', `run ${callCount}`);
      }),
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 100 },
      iterationTimeoutMs: 5000,
    });

    // Start run but immediately stop it
    const runPromise = runner.run();
    runner.stop();
    const result = await runPromise;

    expect(result.status).toBe('aborted');
    expect(result.reason).toBe('stopped externally');
  });

  it('returns aborted when stopped externally before first iteration', async () => {
    const agent = mockAgent();
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 10 },
      iterationTimeoutMs: 5000,
    });

    runner.stop();
    const result = await runner.run();

    expect(result.status).toBe('aborted');
  });

  it('tracks iterations and toolCalls in result', async () => {
    // Mock emits one tool.executed per run() call so the 1:1 iter:tool
    // relationship asserted below still holds after the BUG-001 fix
    // (which moved toolCalls counting from per-iter to per-event).
    const agent = mockAgent({});
    (agent.run as ReturnType<typeof vi.fn>).mockImplementation(async () => {
      agent.events.emit('tool.executed', { id: 't', name: 'mock', durationMs: 0, ok: true });
      return makeResult('done', 'out');
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 3 },
    });

    const result = await runner.run();

    expect(result.iterations).toBeGreaterThan(0);
    expect(result.toolCalls).toBe(result.iterations);
  });

  it('uses default iteration timeout of 30s', async () => {
    const agent = mockAgent({
      run: vi.fn().mockResolvedValue(makeResult('done', 'out')),
    });
    const runner = new AutonomousRunner({
      agent,
      context: mockContext(),
      doneCondition: { type: 'iterations', maxIterations: 1 },
      // not setting iterationTimeoutMs
    });

    const result = await runner.run();

    expect(result.status).toBe('done');
  });
});
