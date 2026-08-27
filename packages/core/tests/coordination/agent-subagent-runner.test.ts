import { describe, expect, it, vi } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import { SUBAGENT_STRUCTURED_REPORT_META_KEY } from '../../src/coordination/subagent-result-tool.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

/** Owning session for coordinator-scoped work under test. */
const TEST_SESSION_ID = 'sess_test';

/**
 * Stub agent that emits the events a real Agent would emit during one run.
 * Lets us exercise the adapter's budget bookkeeping without dragging in the
 * full Agent dependency graph (Container, registries, provider, etc.).
 */
function makeStubAgent(opts: {
  iterations: number;
  toolCallsPerIteration?: number;
  finalText?: string;
  durationMs?: number;
  fail?: boolean;
  streamedText?: string;
  structuredReport?: Record<string, unknown>;
  emitFileEvent?: boolean;
  toolInput?: unknown;
}): { agent: Agent; events: EventBus } {
  const events = new EventBus();
  const ctx = { meta: {} as Record<string, unknown> } as any;
  if (opts.structuredReport) {
    ctx.meta[SUBAGENT_STRUCTURED_REPORT_META_KEY] = opts.structuredReport;
  }
  const usage = { input: 100, output: 50 };
  const toolCallsPerIter = opts.toolCallsPerIteration ?? 1;

  const agent = {
    ctx,
    async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
      for (let i = 0; i < opts.iterations; i++) {
        if (runOpts.signal.aborted) {
          return { status: 'aborted', iterations: i };
        }
        events.emit('iteration.started', { ctx, index: i });
        if (opts.streamedText) {
          events.emit('provider.text_delta', { ctx, text: opts.streamedText });
        }
        for (let t = 0; t < toolCallsPerIter; t++) {
          events.emit('tool.started', { name: 'stub', id: `t${i}-${t}` });
          // Pair with executed — the runner's budget hook now counts
          // tool calls on the executed event (D2/M5), so the stub must
          // emit both halves of the lifecycle to model a real tool.
          events.emit('tool.executed', {
            name: 'stub',
            id: `t${i}-${t}`,
            durationMs: 0,
            ok: true,
            input: opts.toolInput,
          });
        }
        if (opts.emitFileEvent) {
          events.emit('file.event', {
            operation: 'update',
            filePath: 'src/task.ts',
            absPath: '/project/src/task.ts',
            sessionId: 'worker-session',
            agentId: 'a1',
            agentName: 'A1',
            provider: 'test',
            model: 'test-model',
            toolName: 'edit',
            toolUseId: 'file-1',
            scope: 'session',
            timestamp: '2026-07-18T12:00:00.000Z',
          });
        }
        events.emit('provider.response', {
          ctx,
          usage,
          stopReason: 'end_turn',
          model: 'test-model',
        });
        events.emit('iteration.completed', { ctx, index: i });
        if (opts.durationMs) {
          await new Promise<void>((r) => setTimeout(r, opts.durationMs));
        }
      }
      if (opts.fail) {
        return { status: 'failed', error: new Error('stub failure'), iterations: opts.iterations };
      }
      return { status: 'done', iterations: opts.iterations, finalText: opts.finalText };
    },
  } as never as Agent;

  return { agent, events };
}

const makeConfig = (overrides: Record<string, unknown> = {}) => ({
  coordinatorId: 'coord1',
  doneCondition: { type: 'all_tasks_done' as const },
  maxConcurrent: 4,
  ...overrides,
});

function waitForCompletion(
  coord: DefaultMultiAgentCoordinator,
  timeoutMs = 2000,
): Promise<TaskResult> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error(`task did not complete within ${timeoutMs}ms`)),
      timeoutMs,
    );
    coord.once('task.completed', (e: { result: TaskResult }) => {
      clearTimeout(t);
      resolve(e.result);
    });
  });
}

describe('makeAgentSubagentRunner', () => {
  it('drives a real agent and reports success', async () => {
    const factory = vi.fn(async () =>
      makeStubAgent({
        iterations: 2,
        finalText: 'all done',
        structuredReport: {
          summary: 'Root cause confirmed.',
          findings: ['Null guard is missing.'],
          files_examined: ['src/a.ts'],
          confidence: 0.9,
          suggested_next_steps: ['Add a regression test.'],
        },
      }),
    );
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'task body' });
    const result = await completion;

    expect(result.status).toBe('success');
    expect(result.result).toBe('all done');
    expect(result.report).toMatchObject({
      summary: 'Root cause confirmed.',
      confidence: 0.9,
    });
    expect(result.iterations).toBe(2);
    expect(result.toolCalls).toBe(2); // 1 per iteration
    expect(factory).toHaveBeenCalledOnce();
  });

  it('bridges task-correlated tool telemetry and stamps file-event context', async () => {
    const hostEvents = new EventBus();
    const bridged: Array<{
      taskId?: string | undefined;
      runId?: string | undefined;
      name: string;
      input?: unknown;
    }> = [];
    const bridgedFiles: Array<{
      taskId?: string | undefined;
      boardId?: string | undefined;
      runId?: string | undefined;
      scope: string;
    }> = [];
    hostEvents.on('subagent.tool_executed', (event) => bridged.push(event));
    hostEvents.on('file.event', (event) => bridgedFiles.push(event));
    const setCurrentKanbanTask = vi.fn();
    const factory = vi.fn(async () => {
      const built = makeStubAgent({
        iterations: 1,
        finalText: 'done',
        emitFileEvent: true,
        toolInput: { command: 'echo pwd=short-secret' },
      });
      (built.agent as Agent & { ctx: Record<string, unknown> }).ctx['setCurrentKanbanTask'] =
        setCurrentKanbanTask;
      return built;
    });
    const runner = makeAgentSubagentRunner({ factory, hostEvents });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completion = waitForCompletion(coord);
    await coord.assign({
      id: 'correlation-id',
      description: 'task body',
      context: {
        telemetryTaskId: 'graph-task',
        telemetryRunId: 'sdd-run',
        telemetryBoardId: 'graph-1',
      },
    });
    await completion;

    expect(setCurrentKanbanTask).toHaveBeenCalledWith('graph-task', 'graph-1');
    expect(bridged).toEqual([
      expect.objectContaining({
        taskId: 'graph-task',
        runId: 'sdd-run',
        name: 'stub',
      }),
    ]);
    expect(bridged[0]).not.toHaveProperty('input');
    expect(bridgedFiles).toEqual([
      expect.objectContaining({
        taskId: 'graph-task',
        boardId: 'graph-1',
        runId: 'sdd-run',
        scope: 'task',
      }),
    ]);
  });

  it('enforces tool-call budget via event hook', async () => {
    // Agent would run 5 iterations × 2 tool calls = 10 tool calls, but
    // budget allows only 3. The adapter must abort the agent and surface
    // failure.
    const factory = async () => makeStubAgent({ iterations: 5, toolCallsPerIteration: 2 });
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'a1', name: 'A1', maxToolCalls: 3 });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'over-budget' });
    const result = await completion;

    expect(result.status).toBe('failed');
    // Error envelope (D1) — assert on the structured `kind` so the
    // test fails loudly if budget classification ever drifts back into
    // an opaque string bucket.
    expect(result.error?.kind).toBe('budget_tool_calls');
    expect(result.error?.message).toMatch(/tool_calls/);
    // Tool calls observed at least breached the limit
    expect(result.toolCalls).toBeGreaterThanOrEqual(3);
  });

  it('records iterations and respects iteration budget', async () => {
    const factory = async () => makeStubAgent({ iterations: 10 });
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'a1', name: 'A1', maxIterations: 2 });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'iter-budget' });
    const result = await completion;

    expect(result.status).toBe('failed');
    expect(result.error?.kind).toBe('budget_iterations');
    expect(result.error?.message).toMatch(/iterations/);
  });

  it('agent failure surfaces as failed task', async () => {
    const factory = async () =>
      makeStubAgent({
        iterations: 1,
        fail: true,
        streamedText: 'evidence collected before failure',
      });
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'will fail' });
    const result = await completion;

    expect(result.status).toBe('failed');
    // The stub agent throws a vanilla `Error('stub failure')` which the
    // classifier can't route to a structured kind — falls into
    // 'unknown' but the original message is preserved.
    expect(result.error?.kind).toBe('unknown');
    expect(result.error?.message).toMatch(/stub failure/);
    expect(result.partial?.text).toBe('evidence collected before failure');
  });

  it('coordinator stop() propagates as abort signal to the agent', async () => {
    let observedAbort = false;
    const factory = async () => {
      const stub = makeStubAgent({ iterations: 100, durationMs: 30 });
      // Wrap run() to capture abort observation
      const inner = stub.agent.run.bind(stub.agent);
      stub.agent.run = async (input, opts) => {
        const res = await inner(input, opts);
        if (opts.signal.aborted) observedAbort = true;
        return res;
      };
      return stub;
    };
    const runner = makeAgentSubagentRunner({ factory });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'a1', name: 'A1' });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'long' });
    await new Promise((r) => setTimeout(r, 50));
    await coord.stop('a1');
    const result = await completion;

    expect(observedAbort).toBe(true);
    expect(result.status).toBe('stopped');
  });

  it('custom formatTaskInput is used to build the agent input', async () => {
    const inputs: unknown[] = [];
    const factory = async () => {
      const stub = makeStubAgent({ iterations: 1 });
      const inner = stub.agent.run.bind(stub.agent);
      stub.agent.run = async (input, opts) => {
        inputs.push(input);
        return inner(input, opts);
      };
      return stub;
    };
    const runner = makeAgentSubagentRunner({
      factory,
      formatTaskInput: (task, config) => `[${config.name}] ${task.description}`,
    });
    const coord = new DefaultMultiAgentCoordinator(makeConfig(), {
      runner,
      sessionId: TEST_SESSION_ID,
    });

    await coord.spawn({ id: 'a1', name: 'Researcher' });
    const completion = waitForCompletion(coord);
    await coord.assign({ id: 't1', description: 'investigate X' });
    await completion;

    expect(inputs).toEqual(['[Researcher] investigate X']);
  });
});
