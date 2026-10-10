/**
 * A sealed subagent (host-owned companion) cannot be pulled outside the work
 * its host assigns: not by unpinned dispatch, a foreign pin, a retarget, a
 * delegated message, or a budget extension.
 */
import { describe, expect, it } from 'vitest';
import { makeAgentSubagentRunner } from '../../src/coordination/agent-subagent-runner.js';
import { DirectorTaskRegistry } from '../../src/coordination/director/director-task-registry.js';
import { DefaultMultiAgentCoordinator } from '../../src/coordination/multi-agent-coordinator.js';
import type { Agent, RunResult } from '../../src/core/agent.js';
import { SEALED_AGENT_META_KEY } from '../../src/core/sealed-agent.js';
import { EventBus } from '../../src/kernel/events.js';
import type { TaskResult } from '../../src/types/multi-agent.js';

const SESSION = 'sess_sealed';

function stubAgent(
  opts: {
    sealed?: boolean | undefined;
    toolCalls?: number | undefined;
    gate?: Promise<void> | undefined;
  } = {},
) {
  const events = new EventBus();
  const ctx = { meta: opts.sealed ? { [SEALED_AGENT_META_KEY]: true } : {} } as never;
  const agent = {
    ctx,
    async run(_input: unknown, runOpts: { signal: AbortSignal }): Promise<RunResult> {
      events.emit('iteration.started', { ctx, index: 0 });
      for (let t = 0; t < (opts.toolCalls ?? 0); t++) {
        if (runOpts.signal.aborted) return { status: 'aborted', iterations: 1 };
        events.emit('tool.started', { name: 'stub', id: `t${t}` });
        events.emit('tool.executed', { name: 'stub', id: `t${t}`, durationMs: 0, ok: true });
        await new Promise((resolve) => setTimeout(resolve, 1));
      }
      if (opts.gate) await opts.gate;
      events.emit('provider.response', {
        ctx,
        usage: { input: 1, output: 1 },
        stopReason: 'end_turn',
        model: 'm',
      });
      return { status: 'done', iterations: 1, finalText: 'ok' };
    },
  } as never as Agent;
  return { agent, events };
}

function coordinator(
  factory: (config: { id?: string | undefined }) => ReturnType<typeof stubAgent>,
) {
  return new DefaultMultiAgentCoordinator(
    { coordinatorId: 'sealed', doneCondition: { type: 'all_tasks_done' }, maxConcurrent: 4 },
    { runner: makeAgentSubagentRunner({ factory: async (c) => factory(c) }), sessionId: SESSION },
  );
}

function completion(coord: DefaultMultiAgentCoordinator, taskId: string): Promise<TaskResult> {
  return new Promise((resolve) => {
    const onDone = (event: { result: TaskResult }) => {
      if (event.result.taskId !== taskId) return;
      coord.off('task.completed', onDone);
      resolve(event.result);
    };
    coord.on('task.completed', onDone);
  });
}

describe('sealed subagent', () => {
  it('is never picked for unpinned work, even when it is the only idle worker first', async () => {
    const ran: string[] = [];
    const coord = coordinator((config) => {
      ran.push(config.id ?? '?');
      return stubAgent({ sealed: config.id === 'companion' });
    });
    await coord.spawn({ id: 'companion', name: 'Companion', sealed: true });
    await coord.spawn({ id: 'worker', name: 'Worker' });

    const done = completion(coord, 't1');
    await coord.assign({ id: 't1', description: 'general work' });
    expect((await done).subagentId).toBe('worker');
    expect(ran).toEqual(['worker']);
  });

  it('refuses a pin that its host did not admit, and runs the host-owned one', async () => {
    const coord = coordinator((config) => stubAgent({ sealed: config.id === 'companion' }));
    await coord.spawn({ id: 'companion', name: 'Companion', sealed: true });

    await expect(
      coord.assign({ id: 'foreign', description: 'do my task', subagentId: 'companion' }),
    ).rejects.toThrow(/sealed host companion/);
    expect(coord.listPendingTasks()).toEqual([]);

    const done = completion(coord, 'host');
    await coord.assign(
      { id: 'host', description: 'judge skills', subagentId: 'companion' },
      { hostOwned: true },
    );
    expect((await done).status).toBe('success');
  });

  it('cannot be retargeted onto or away from, and refuses delegated messages', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const coord = coordinator((config) =>
      stubAgent({
        sealed: config.id === 'companion',
        gate: config.id === 'busy' ? gate : undefined,
      }),
    );
    await coord.spawn({ id: 'busy', name: 'Busy' });
    await coord.spawn({ id: 'companion', name: 'Companion', sealed: true });
    const first = completion(coord, 'running');
    await coord.assign({ id: 'running', description: 'occupy busy', subagentId: 'busy' });
    await coord.assign({ id: 'queued', description: 'starved', subagentId: 'busy' });

    // The supervisor's starvation fix must not land work on the companion.
    expect(coord.retargetPendingTask('queued', 'companion')).toBe(false);
    expect(coord.listPendingTasks().map((task) => task.subagentId)).toEqual(['busy']);
    await expect(
      coord.delegate('companion', {
        id: 'm1',
        type: 'task',
        from: 'leader',
        to: 'companion',
        payload: 'do this instead',
        timestamp: Date.now(),
        priority: 'normal',
      }),
    ).rejects.toThrow(/sealed host companion/);
    release();
    await first;
  });

  it('gets no budget extension: a soft limit is a hard stop', async () => {
    const extendAlways = (events: EventBus) =>
      events.onPattern('budget.threshold_reached', (_type, payload) => {
        (payload as { extend: (extra: Record<string, unknown>) => void }).extend({
          maxToolCalls: 1000,
        });
      });
    const coord = coordinator((config) => {
      const stub = stubAgent({ sealed: config.id === 'companion', toolCalls: 6 });
      extendAlways(stub.events);
      return stub;
    });
    await coord.spawn({ id: 'companion', name: 'Companion', sealed: true, maxToolCalls: 2 });
    await coord.spawn({ id: 'worker', name: 'Worker', maxToolCalls: 2 });

    const sealed = completion(coord, 'sealed');
    await coord.assign(
      { id: 'sealed', description: 'judge', subagentId: 'companion' },
      { hostOwned: true },
    );
    const sealedResult = await sealed;
    expect(sealedResult.status).toBe('failed');
    expect(sealedResult.error?.kind).toBe('budget_tool_calls');

    // Control: the same overrun on an ordinary worker is negotiated and extended.
    const open = completion(coord, 'open');
    await coord.assign({ id: 'open', description: 'work', subagentId: 'worker' });
    expect((await open).status).toBe('success');
  });

  it('admits the Director internal path and refuses its public one', async () => {
    const coord = coordinator((config) => stubAgent({ sealed: config.id === 'companion' }));
    await coord.spawn({ id: 'companion', name: 'Companion', sealed: true });
    const registry = new DirectorTaskRegistry({
      coordinator: coord,
      stateCheckpoint: null,
      isWorkComplete: () => false,
      dispatchableSubagentIds: () => ['companion'],
      addTaskToManifest: () => {},
      recordPendingTask: () => {},
      appendSessionEvent: async () => {},
      scheduleManifest: () => {},
      getSubagentMeta: () => undefined,
    });

    // `assign_task` / `delegate` reach the public path.
    await expect(
      registry.assign({ id: 'leader-task', description: 'x', subagentId: 'companion' }),
    ).rejects.toThrow(/sealed host companion/);

    const done = completion(coord, 'probe');
    await registry.assignInternal({ id: 'probe', description: 'judge', subagentId: 'companion' });
    expect((await done).status).toBe('success');
  });
});
