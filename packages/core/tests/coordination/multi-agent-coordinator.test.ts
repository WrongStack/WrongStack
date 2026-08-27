import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';

// Read the cap from source instead of hardcoding it here: the behavior test
// and the implementation drifted once already (10_000 → 200_000) and the
// stale literal silently stopped exercising the trim.
function readCompletedResultsCap(): number {
  const file = path.resolve(
    path.dirname(fileURLToPath(import.meta.url)),
    '../../src/coordination/multi-agent-coordinator.ts',
  );
  const source = readFileSync(file, 'utf8');
  const match = source.match(/MAX_COMPLETED_RESULTS\s*=\s*(\d[\d_]*)/);
  if (!match) throw new Error('MAX_COMPLETED_RESULTS not found in multi-agent-coordinator.ts');
  return Number(match[1]!.replaceAll('_', ''));
}

const MAX_COMPLETED_RESULTS = readCompletedResultsCap();

describe('DefaultMultiAgentCoordinator', () => {
  const makeConfig = (overrides = {}) => ({
    coordinatorId: 'coord1',
    doneCondition: { type: 'all_tasks_done' as const },
    maxConcurrent: 4,
    ...overrides,
  });

  const makeCoordinator = (config: ReturnType<typeof makeConfig>): DefaultMultiAgentCoordinator =>
    new DefaultMultiAgentCoordinator(config, {
      sessionId: '2026-08-26/sess_01TESTCOORDINATOR000000000',
    });

  it('has correct coordinator id', () => {
    const coord = makeCoordinator(makeConfig());
    expect(coord.coordinatorId).toBe('coord1');
  });

  it('spawn returns subagent id', async () => {
    const coord = makeCoordinator(makeConfig());
    const result = await coord.spawn({ id: 'agent1', name: 'Agent 1' });
    expect(result.subagentId).toBe('agent1');
    expect(result.agentId).toBe('agent1');
  });

  it('spawn auto-generates id if not provided', async () => {
    const coord = makeCoordinator(makeConfig());
    const result = await coord.spawn({ name: 'Agent' });
    expect(result.subagentId).toBeDefined();
  });

  it('getStatus returns status with done=true when no pending tasks', () => {
    // isDone for all_tasks_done returns true when pendingTasks.length === 0
    const coord = makeCoordinator(makeConfig());
    const status = coord.getStatus();
    expect(status.coordinatorId).toBe('coord1');
    expect(status.subagents).toEqual([]);
    expect(status.pendingTasks).toBe(0);
    expect(status.completedTasks).toBe(0);
    expect(status.done).toBe(true); // vacuously true with no tasks
  });

  it('assign queues task', async () => {
    const coord = makeCoordinator(makeConfig());
    await coord.assign({ id: 'task1' });
    const status = coord.getStatus();
    expect(status.pendingTasks).toBe(1);
  });

  it('stop removes subagent', async () => {
    const coord = makeCoordinator(makeConfig());
    await coord.spawn({ id: 'agent1', name: 'A1' });
    await coord.stop('agent1');
    const status = coord.getStatus();
    const agent = status.subagents.find((s) => s.id === 'agent1');
    expect(agent?.status).toBe('stopped');
  });

  // `emitPendingAborted` pushes its synthetic result directly — it must bypass
  // `recordCompletion` for inFlight accounting, but it used to bypass the
  // MAX_COMPLETED_RESULTS cap along with it. A coordinator whose fleet has died
  // synthetic-completes every task the caller keeps assigning, and with no real
  // completion ever running the trim, the results array grew without bound.
  it('caps completedResults on the synthetic dead-fleet path too', async () => {
    const coord = makeCoordinator(makeConfig());
    await coord.spawn({ id: 'a1', name: 'A1' });
    await coord.stop('a1');

    const total = MAX_COMPLETED_RESULTS + 50;
    for (let i = 0; i < total; i++) {
      await coord.assign({ id: `dead-task-${i}` });
    }

    const results = coord.results();
    expect(results.length).toBeLessThanOrEqual(MAX_COMPLETED_RESULTS);
    // The newest results are the ones kept.
    expect(results.at(-1)?.taskId).toBe(`dead-task-${total - 1}`);
    expect(results.at(-1)?.status).toBe('stopped');
  });

  it('stopAll stops all subagents', async () => {
    const coord = makeCoordinator(makeConfig());
    await coord.spawn({ id: 'a1', name: 'A1' });
    await coord.spawn({ id: 'a2', name: 'A2' });
    await coord.stopAll();
    const status = coord.getStatus();
    expect(status.subagents.every((s) => s.status === 'stopped')).toBe(true);
  });

  it('delegate throws for unknown subagent', async () => {
    const coord = makeCoordinator(makeConfig());
    await expect(
      coord.delegate('ghost', {
        id: '1',
        type: 'task',
        from: 'c',
        payload: {},
        timestamp: Date.now(),
        priority: 'normal',
      }),
    ).rejects.toThrow('not found');
  });

  it('setSubagentBridge wires up subagent', async () => {
    const coord = makeCoordinator(makeConfig());
    await coord.spawn({ id: 'agent1', name: 'A1' });
    const mockBridge = {
      send: vi.fn().mockResolvedValue(undefined),
      agentId: 'agent1',
      coordinatorId: 'coord1',
      subscribe: vi.fn(),
      stop: vi.fn(),
      request: vi.fn(),
    } as any;
    expect(() => coord.setSubagentBridge('agent1', mockBridge)).not.toThrow();
  });

  it('completeTask shifts pending and marks subagent idle', async () => {
    const coord = makeCoordinator(makeConfig());
    await coord.spawn({ id: 'agent1', name: 'A1' });
    await coord.assign({ id: 'task1' });
    coord.completeTask({ subagentId: 'agent1', taskId: 'task1', status: 'success', iterations: 1 });
    const status = coord.getStatus();
    expect(status.completedTasks).toBe(1);
    expect(status.pendingTasks).toBe(0);
  });

  it('emits events', async () => {
    const coord = makeCoordinator(makeConfig());
    const events: any[] = [];
    coord.on('subagent.started', (e) => events.push(e));
    await coord.spawn({ id: 'agent1', name: 'A1' });
    expect(events.some((e) => e.subagent?.id === 'agent1')).toBe(true);
  });

  it('done=true when all_tasks_done and no pending', () => {
    const coord = makeCoordinator(makeConfig({ doneCondition: { type: 'all_tasks_done' } }));
    expect(coord.getStatus().done).toBe(true); // no pending tasks
  });

  it('done=true when maxIterations reached via completeTask', async () => {
    const coord = makeCoordinator(
      makeConfig({ doneCondition: { type: 'max_iterations', maxIterations: 1 } }),
    );
    await coord.spawn({ id: 'agent1', name: 'A1' });
    await coord.assign({ id: 'task1' });
    // Simulate task completion which increments totalIterations
    coord.completeTask({ subagentId: 'agent1', taskId: 'task1', status: 'success', iterations: 1 });
    expect(coord.getStatus().done).toBe(true);
  });

  it('does NOT warn on inFlight=0 completion when no runner is wired (caller-driven path)', async () => {
    // The no-runner pattern is intentional: callers drive task lifecycle
    // via completeTask, and runDispatched skips inFlight++ to avoid
    // underflow. The warning that used to fire on every such completion
    // was noise — it should only fire on true double-completion (runner
    // wired but inFlight already at 0).
    const coord = makeCoordinator(makeConfig());
    const warnings: any[] = [];
    coord.on('warning' as any, (e: any) => warnings.push(e));
    await coord.spawn({ id: 'agent1', name: 'A1' });
    await coord.assign({ id: 'task1' });
    coord.completeTask({ subagentId: 'agent1', taskId: 'task1', status: 'success', iterations: 1 });
    expect(warnings.filter((w) => w.type === 'inFlight_underflow')).toHaveLength(0);
  });

  describe('public API: setters + results + awaitTasks', () => {
    it('setRunner wires a runner that drives dispatch to completion', async () => {
      const coord = makeCoordinator(makeConfig());
      coord.setRunner((async (task: { id: string }) => ({
        result: `done:${task.id}`,
        iterations: 1,
        toolCalls: 0,
      })) as never);
      await coord.spawn({ id: 'a1', name: 'A1' });
      await coord.assign({ id: 't1' });
      await new Promise((r) => setTimeout(r, 30));
      expect(coord.results().some((r) => r.taskId === 't1' && r.result === 'done:t1')).toBe(true);
    });

    it('setFleetBus routes lifecycle events to the fleet bus', async () => {
      const coord = makeCoordinator(makeConfig());
      const emitted: string[] = [];
      coord.setFleetBus({ emit: (e: { type: string }) => emitted.push(e.type) } as never);
      await coord.spawn({ id: 'a1', name: 'A1' });
      expect(emitted).toContain('subagent.assigned');
    });

    it('setMaxConcurrent accepts a valid cap and rejects an invalid one', () => {
      const coord = makeCoordinator(makeConfig({ maxConcurrent: 2 }));
      expect(() => coord.setMaxConcurrent(8)).not.toThrow();
      expect(() => coord.setMaxConcurrent(0)).toThrow(/maxConcurrent/);
      expect(() => coord.setMaxConcurrent(Number.NaN)).toThrow(/maxConcurrent/);
    });

    it('results() exposes completed task results', async () => {
      const coord = makeCoordinator(makeConfig());
      await coord.spawn({ id: 'a1', name: 'A1' });
      coord.completeTask({
        subagentId: 'a1',
        taskId: 't1',
        status: 'success',
        result: 'x',
        iterations: 1,
        toolCalls: 0,
        durationMs: 5,
      });
      expect(coord.results().some((r) => r.taskId === 't1')).toBe(true);
    });

    it('awaitTasks returns a cached result immediately and polls a pending one', async () => {
      const coord = makeCoordinator(makeConfig());
      await coord.spawn({ id: 'a1', name: 'A1' });
      coord.completeTask({
        subagentId: 'a1',
        taskId: 'cached',
        status: 'success',
        result: 'c',
        iterations: 1,
        toolCalls: 0,
        durationMs: 1,
      });
      const cached = await coord.awaitTasks(['cached']);
      expect(cached[0]?.taskId).toBe('cached');

      const pollP = coord.awaitTasks(['pending']);
      coord.completeTask({
        subagentId: 'a1',
        taskId: 'pending',
        status: 'success',
        result: 'p',
        iterations: 1,
        toolCalls: 0,
        durationMs: 1,
      });
      const polled = await pollP;
      expect(polled[0]?.taskId).toBe('pending');
    });

    it('awaitTasks rejects on timeout for a never-completing task', async () => {
      const coord = makeCoordinator(makeConfig({ timeoutMs: 20 }));
      await expect(coord.awaitTasks(['never'])).rejects.toThrow(/timed out/);
    });

    it('awaitTasks honors a per-call timeoutMs over config.timeoutMs', async () => {
      // A long config default must not cut a caller's explicit budget short,
      // and an explicit short budget must apply despite a long config.
      const coord = makeCoordinator(makeConfig({ timeoutMs: 60_000 }));
      await expect(coord.awaitTasks(['never'], { timeoutMs: 20 })).rejects.toThrow(/timed out/);
    });
  });
});
