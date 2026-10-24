import { EventBus } from '@wrongstack/contracts/kernel/events';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type {
  SubagentRunContext,
  SubagentRunOutcome,
  TaskSpec,
} from '@wrongstack/contracts/types/multi-agent';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createDelegateTool, type DelegateHost } from '../../src/coordination/delegate-tool.js';
import { findDelegationForTask } from '../../src/coordination/delegation/delegation-lookup.js';
import { DelegationTracker } from '../../src/coordination/delegation/delegation-tracker.js';
import {
  delegationDeliveryId,
  LeaderDeliveryHub,
} from '../../src/coordination/delegation/leader-delivery-hub.js';
import {
  type DelegationAttempt,
  prepareDelegation,
  settleDelegation,
  startDelegationAttempt,
  validateDelegationInput,
} from '../../src/coordination/delegation/run-delegation.js';
import { Director } from '../../src/coordination/director.js';
import { makeAwaitTasksTool } from '../../src/coordination/director-basic-tools.js';
import type { DirectorOptions } from '../../src/coordination/director-options.js';
import { FLEET_ROSTER } from '../../src/coordination/fleet.js';

const SESSION = 'sess-bg';
/** The delegate tool only reads `ctx.session.id` to resolve the owning session. */
function testCtx(ctx: { session?: { id: string } } | null): AgentContext {
  return ctx as unknown as AgentContext;
}
const CTX = testCtx({ session: { id: SESSION } });
const BOUNDARY = {
  scope: 'The named target only — read, verify, report.',
  outOfScope: ['Do not modify any files'],
} as const;

function hostFor(director: Director | null): DelegateHost {
  return {
    isDirectorMode: () => !!director,
    ensureDirector: async () => director,
    promoteToDirector: async () => director,
  };
}

interface Gate {
  task: TaskSpec;
  ctx: SubagentRunContext;
  release(outcome?: SubagentRunOutcome): void;
}

/** Real Director whose runner blocks until the test releases each task. */
function gatedDirector(opts: { notifier?: DirectorOptions['taskResultNotifier'] } = {}) {
  const gates: Gate[] = [];
  const runner = vi.fn(
    (task: TaskSpec, ctx: SubagentRunContext) =>
      new Promise<SubagentRunOutcome>((resolve, reject) => {
        const release = (outcome?: SubagentRunOutcome) =>
          resolve(outcome ?? { result: `done:${task.id}`, iterations: 1, toolCalls: 1 });
        // A real runner unwinds with an abort error when its signal fires.
        ctx.signal.addEventListener(
          'abort',
          () => reject(new DOMException('subagent aborted', 'AbortError')),
          { once: true },
        );
        gates.push({ task, ctx, release });
      }),
  );
  const director = new Director({
    sessionId: SESSION,
    config: {
      coordinatorId: 'bg-director',
      doneCondition: { type: 'all_tasks_done' },
      maxConcurrent: 4,
    },
    runner,
    ...(opts.notifier ? { taskResultNotifier: opts.notifier } : {}),
  });
  return { director, gates, runner };
}

function setup(director: Director | null, extra: { events?: EventBus } = {}) {
  const hub = new LeaderDeliveryHub();
  const events = extra.events ?? new EventBus();
  const tracker = new DelegationTracker({ hub, events });
  const tool = createDelegateTool({
    host: hostFor(director),
    roster: FLEET_ROSTER,
    events,
    tracker,
  });
  return { hub, events, tracker, tool };
}

type Launch = {
  ok: boolean;
  status: string;
  delegationId: string;
  taskId: string;
  subagentId: string;
  note: string;
};

const cleanups: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn();
});

describe('delegate — background mode (default)', () => {
  it('returns immediately with a running launch and delivers the result once it settles', async () => {
    const { director, gates } = gatedDirector();
    const { hub, tracker, tool } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );

    const launch = (await tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    })) as Launch;
    expect(launch).toMatchObject({ ok: true, status: 'running', target: 'bug-hunter' });
    expect(launch.delegationId).toEqual(expect.any(String));
    expect(launch.note).toMatch(/delivered to you automatically/);
    // The worker is still gated: nothing to deliver yet.
    await expect.poll(() => gates.length).toBe(1);
    expect(hub.pending(SESSION)).toBe(0);
    expect(tracker.get(launch.delegationId)?.state).toBe('running');

    gates[0]!.release();
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    const [delivery] = hub.take(SESSION);
    expect(delivery).toMatchObject({
      deliveryId: delegationDeliveryId(launch.delegationId),
      sessionId: SESSION,
      wake: true,
      payload: { delegationId: launch.delegationId, ok: true, status: 'success', handoffs: 0 },
    });
    expect(delivery!.payload.excerpt).toContain('done:');
    expect(tracker.get(launch.delegationId)?.state).toBe('settled');
  });

  it('emits subagent.done alongside delegate.completed when a background delegation succeeds', async () => {
    const { director, gates } = gatedDirector();
    const { events, tracker, tool, hub } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const completed: Array<{ ok: boolean; summary: string }> = [];
    const done: Array<{ ok: boolean; summary: string }> = [];
    const full: unknown[] = [];
    const started: unknown[] = [];
    events.on('delegate.started', (e) => started.push(e));
    events.on('delegate.completed', (e) => {
      completed.push({ ok: e.ok, summary: e.summary });
      full.push(e);
    });
    events.on('subagent.done', (e) => done.push({ ok: e.ok, summary: e.summary }));

    const launch = (await tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    })) as Launch;
    await expect.poll(() => gates.length).toBe(1);
    gates[0]!.release();
    await expect.poll(() => hub.pending(SESSION)).toBe(1);

    expect(completed).toHaveLength(1);
    expect(completed[0]!.ok).toBe(true);
    expect(done).toEqual(completed);
    expect(started).toEqual([
      expect.objectContaining({
        sessionId: SESSION,
        delegationId: launch.delegationId,
        taskId: launch.taskId,
        mode: 'background',
      }),
    ]);
    expect(full[0]).toMatchObject({
      sessionId: SESSION,
      delegationId: launch.delegationId,
      stopReason: 'end_turn',
      mode: 'background',
      resultExcerpt: expect.stringContaining('done:'),
    });
  });

  it('emits subagent.done alongside delegate.completed on a failing background outcome', async () => {
    const { director } = gatedDirector();
    const { events, tracker, tool, hub } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const completed: Array<{ ok: boolean; summary: string }> = [];
    const done: Array<{ ok: boolean; summary: string }> = [];
    events.on('delegate.completed', (e) => completed.push({ ok: e.ok, summary: e.summary }));
    events.on('subagent.done', (e) => done.push({ ok: e.ok, summary: e.summary }));

    await tool.execute({ role: 'bug-hunter', task: 'stall', timeoutMs: 30, ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    });
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    expect(completed).toHaveLength(1);
    expect(completed[0]!.ok).toBe(false);
    expect(done).toEqual(completed);
    expect(hub.take(SESSION)[0]!.payload.stopReason).toBe('host_timeout');
  });

  it('throws validation errors synchronously and opens no tracker entry', async () => {
    const { director } = gatedDirector();
    const { tracker, tool } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    await expect(
      tool.execute({ role: 'nope', task: 'x', ...BOUNDARY }, CTX, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/Unknown role/);
    await expect(
      tool.execute({ role: 'bug-hunter', task: 'x' }, CTX, {
        signal: new AbortController().signal,
      }),
    ).rejects.toThrow(/boundary incomplete/);
    expect(tracker.list()).toHaveLength(0);
  });

  it('Esc/Stop on the leader does not cancel a running background delegation', async () => {
    const { director, gates } = gatedDirector();
    const { hub, tracker, tool } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const leaderRun = new AbortController();
    const launch = (await tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: leaderRun.signal,
    })) as Launch;
    await expect.poll(() => gates.length).toBe(1);

    leaderRun.abort('user pressed Esc');
    await new Promise((r) => setTimeout(r, 20));
    expect(gates[0]!.ctx.signal.aborted).toBe(false);
    expect(tracker.get(launch.delegationId)?.state).toBe('running');

    gates[0]!.release();
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    expect(hub.take(SESSION)[0]).toMatchObject({ wake: true, payload: { ok: true } });
  });

  it('an Esc that lands while the Director is activating still gates the launch', async () => {
    const { director, runner } = gatedDirector();
    const spawn = vi.spyOn(director, 'spawn');
    let release!: () => void;
    const activation = new Promise<void>((r) => {
      release = r;
    });
    let entered!: () => void;
    const activating = new Promise<void>((r) => {
      entered = r;
    });
    const hub = new LeaderDeliveryHub();
    const events = new EventBus();
    const tracker = new DelegationTracker({ hub, events });
    const tool = createDelegateTool({
      host: {
        isDirectorMode: () => false,
        ensureDirector: async () => null,
        promoteToDirector: async () => {
          entered();
          await activation;
          return director;
        },
      },
      roster: FLEET_ROSTER,
      events,
      tracker,
    });
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const leaderRun = new AbortController();
    const pending = tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: leaderRun.signal,
    });
    await activating;
    leaderRun.abort('user pressed Esc');
    release();

    expect(await pending).toMatchObject({ ok: false, stopReason: 'aborted' });
    expect(runner).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
    expect(tracker.list()).toHaveLength(0);
  });

  it('cancelSession aborts the worker and delivers a user-caused outcome with wake:false', async () => {
    const { director, gates } = gatedDirector();
    const { hub, tracker, tool } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const launch = (await tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    })) as Launch;
    await expect.poll(() => gates.length).toBe(1);

    expect(tracker.cancelSession('other-session')).toBe(0);
    expect(tracker.cancelSession(SESSION)).toBe(1);
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    const [delivery] = hub.take(SESSION);
    expect(delivery).toMatchObject({
      wake: false,
      payload: { delegationId: launch.delegationId, stopReason: 'aborted', cause: 'user' },
    });
    await expect.poll(() => gates[0]!.ctx.signal.aborted).toBe(true);
  });

  it('Director.terminateSession cancels the session delegations as user-caused', async () => {
    const { director, gates } = gatedDirector();
    const { hub, tracker, tool } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    await tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    });
    await expect.poll(() => gates.length).toBe(1);
    await director.terminateSession(SESSION);
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    expect(hub.take(SESSION)[0]).toMatchObject({ wake: false, payload: { cause: 'user' } });
  });

  it('dispose (host shutdown) cancels running delegations without delivering', async () => {
    const { director, gates } = gatedDirector();
    const { hub, tracker, tool, events } = setup(director);
    cleanups.push(() => director.shutdown());
    const completed: unknown[] = [];
    events.on('delegate.completed', (e) => completed.push(e));
    const launch = (await tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    })) as Launch;
    await expect.poll(() => gates.length).toBe(1);
    tracker.dispose();
    await expect.poll(() => tracker.get(launch.delegationId)?.state).toBe('cancelled');
    expect(hub.pending(SESSION)).toBe(0);
    // The journal still gets its completion line; a later resume re-queues it.
    expect(completed).toHaveLength(1);
  });

  it('terminate_subagent settles aborted without a handoff and still wakes', async () => {
    const { director, gates, runner } = gatedDirector();
    const { hub, tracker, tool } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const launch = (await tool.execute(
      { role: 'bug-hunter', task: 'audit', maxHandoffs: 3, ...BOUNDARY },
      CTX,
      { signal: new AbortController().signal },
    )) as Launch;
    await expect.poll(() => gates.length).toBe(1);
    await director.terminate(launch.subagentId);
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    const [delivery] = hub.take(SESSION);
    expect(delivery).toMatchObject({ wake: true, payload: { stopReason: 'aborted', handoffs: 0 } });
    expect(runner).toHaveBeenCalledTimes(1);
  });

  it('a background delegate result never produces taskResultNotifier mail', async () => {
    const notifier = vi.fn();
    const { director, gates } = gatedDirector({ notifier });
    const { hub, tracker, tool } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    await tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    });
    await expect.poll(() => gates.length).toBe(1);
    gates[0]!.release();
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    expect(notifier).not.toHaveBeenCalled();
  });

  it('await_tasks on the terminal attempt suppresses the delivery and is annotated', async () => {
    const { director, gates } = gatedDirector();
    const { hub, tracker, tool, events } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const deliveredEvents: unknown[] = [];
    const completed: unknown[] = [];
    events.on('delegation.delivered', (e) => deliveredEvents.push(e));
    events.on('delegate.completed', (e) => completed.push(e));
    const launch = (await tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    })) as Launch;
    await expect.poll(() => gates.length).toBe(1);

    const awaited = makeAwaitTasksTool(director).execute({ taskIds: [launch.taskId] }, CTX, {
      signal: new AbortController().signal,
    }) as Promise<{
      results: Array<{ taskId: string; delegationId?: string; delegationHint?: string }>;
    }>;
    gates[0]!.release();
    const out = await awaited;
    expect(out.results[0]).toMatchObject({
      taskId: launch.taskId,
      delegationId: launch.delegationId,
      delegationHint: expect.stringContaining(launch.delegationId),
    });
    await expect.poll(() => tracker.get(launch.delegationId)?.state).toBe('consumedInBand');
    expect(hub.pending(SESSION)).toBe(0);
    expect(deliveredEvents).toEqual([
      { sessionId: SESSION, delegationId: launch.delegationId, via: 'await_tasks' },
    ]);
    expect(completed).toHaveLength(1);
  });

  it('falls back to blocking when no owning session can be resolved', async () => {
    const { director, gates } = gatedDirector();
    const { tracker, tool } = setup(director);
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const pending = tool.execute(
      { role: 'bug-hunter', task: 'audit', ...BOUNDARY },
      testCtx(null),
      {
        signal: new AbortController().signal,
      },
    ) as Promise<{ ok: boolean; status?: string }>;
    await expect.poll(() => gates.length).toBe(1);
    gates[0]!.release();
    await expect(pending).resolves.toMatchObject({ ok: true, status: 'success' });
    expect(tracker.list()).toHaveLength(0);
  });

  it('honors defaultWait (rollback switch) when the model omits wait', async () => {
    const { director, gates } = gatedDirector();
    const hub = new LeaderDeliveryHub();
    const tracker = new DelegationTracker({ hub });
    const tool = createDelegateTool({
      host: hostFor(director),
      roster: FLEET_ROSTER,
      tracker,
      defaultWait: () => true,
    });
    cleanups.push(
      () => tracker.dispose(),
      () => director.shutdown(),
    );
    const pending = tool.execute({ role: 'bug-hunter', task: 'audit', ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    }) as Promise<{ ok: boolean; status?: string }>;
    await expect.poll(() => gates.length).toBe(1);
    gates[0]!.release();
    await expect(pending).resolves.toMatchObject({ ok: true, status: 'success' });
    expect(tracker.list()).toHaveLength(0);
    expect(hub.pending(SESSION)).toBe(0);
  });
});

// ── Fake director for handoff scenarios ──────────────────────────────────────

function fakeDirector(results: Array<(taskId: string) => unknown>) {
  const spawned: string[] = [];
  let attempt = 0;
  return {
    director: {
      fleet: { filter: () => () => {} },
      spawn: vi.fn(async () => {
        const id = `sub-${spawned.length + 1}`;
        spawned.push(id);
        return id;
      }),
      assign: vi.fn(async (task: { id: string }) => task.id),
      awaitTasks: vi.fn(async (taskIds: string[]) => [results[attempt++]!(taskIds[0]!)]),
      snapshot: vi.fn(() => ({ perSubagent: {} })),
      terminate: vi.fn(async () => {}),
    } as never as Director,
    spawned,
  };
}

const partialReport = {
  summary: 'Checkpoint.',
  findings: [],
  files_examined: [],
  confidence: 0.9,
  suggested_next_steps: [],
  completion: 'partial' as const,
  remaining_work: 'Finish the second half.',
};

describe('DelegationTracker', () => {
  it('follows a background handoff to one delivery for the terminal attempt', async () => {
    const { director } = fakeDirector([
      (taskId) => ({
        status: 'success',
        result: 'half',
        report: partialReport,
        iterations: 1,
        toolCalls: 1,
        durationMs: 5,
        subagentId: 'sub-1',
        taskId,
      }),
      (taskId) => ({
        status: 'success',
        result: 'all done',
        iterations: 1,
        toolCalls: 1,
        durationMs: 5,
        subagentId: 'sub-2',
        taskId,
      }),
    ]);
    const { hub, tracker, tool } = setup(director);
    cleanups.push(() => tracker.dispose());
    const launch = (await tool.execute(
      { role: 'bug-hunter', task: 'big', maxHandoffs: 1, ...BOUNDARY },
      CTX,
      { signal: new AbortController().signal },
    )) as Launch;
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    const entry = tracker.get(launch.delegationId)!;
    expect(entry.taskIds).toHaveLength(2);
    expect(entry.attempt).toBe(1);
    expect(tracker.isTerminalAttempt(entry.taskIds[0]!)).toBe(false);
    expect(tracker.isTerminalAttempt(entry.taskIds[1]!)).toBe(true);
    expect(findDelegationForTask(entry.taskIds[0]!)?.delegationId).toBe(launch.delegationId);
    const [delivery] = hub.take(SESSION);
    expect(delivery!.payload).toMatchObject({ handoffs: 1, ok: true, taskId: entry.taskIds[1] });
  });

  it('work_complete during a handoff: the continuation settles stopped → aborted, no further handoff', async () => {
    const { director, spawned } = fakeDirector([
      (taskId) => ({
        status: 'success',
        report: partialReport,
        iterations: 1,
        toolCalls: 1,
        durationMs: 5,
        subagentId: 'sub-1',
        taskId,
      }),
      (taskId) => ({
        status: 'stopped',
        error: { kind: 'aborted_by_parent', message: 'workComplete', retryable: false },
        iterations: 0,
        toolCalls: 0,
        durationMs: 0,
        subagentId: 'sub-2',
        taskId,
      }),
    ]);
    const { hub, tracker, tool } = setup(director);
    cleanups.push(() => tracker.dispose());
    await tool.execute({ role: 'bug-hunter', task: 'big', maxHandoffs: 4, ...BOUNDARY }, CTX, {
      signal: new AbortController().signal,
    });
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    expect(hub.take(SESSION)[0]!.payload).toMatchObject({ stopReason: 'aborted', handoffs: 1 });
    expect(spawned).toHaveLength(2);
  });

  function attempt(taskId: string, handoffCount: number): DelegationAttempt {
    return { taskId, subagentId: `sub-${taskId}`, handoffCount, attemptConfig: { name: 'w' } };
  }

  it('awaiting a NON-terminal attempt does not suppress the final delivery', async () => {
    const hub = new LeaderDeliveryHub();
    const tracker = new DelegationTracker({ hub });
    cleanups.push(() => tracker.dispose());
    const entry = tracker.begin({ sessionId: SESSION, target: 'w', task: 't' });
    const hooks = tracker.hooksFor(entry.delegationId);
    hooks.onAttempt!(attempt('t0', 0));
    tracker.noteLeaderConsumed('t0');
    hooks.onAttempt!(attempt('t1', 1));
    expect(entry.state).toBe('running');
    tracker.track(entry.delegationId, Promise.resolve({ ok: true, taskId: 't1', summary: 's' }));
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
  });

  it('a terminal attempt consumed after settlement pulls the pending delivery', async () => {
    const hub = new LeaderDeliveryHub();
    const tracker = new DelegationTracker({ hub });
    cleanups.push(() => tracker.dispose());
    const entry = tracker.begin({ sessionId: SESSION, target: 'w', task: 't' });
    tracker.hooksFor(entry.delegationId).onAttempt!(attempt('t0', 0));
    tracker.track(entry.delegationId, Promise.resolve({ ok: true, taskId: 't0', summary: 's' }));
    await expect.poll(() => hub.pending(SESSION)).toBe(1);
    expect(tracker.noteLeaderConsumed('t0')).toBe(true);
    expect(hub.pending(SESSION)).toBe(0);
    expect(entry.state).toBe('consumedInBand');
  });

  it('ignores illegal transitions', async () => {
    const hub = new LeaderDeliveryHub();
    const tracker = new DelegationTracker({ hub });
    cleanups.push(() => tracker.dispose());
    const entry = tracker.begin({ sessionId: SESSION, target: 'w', task: 't' });
    tracker.markDelivered(entry.delegationId);
    expect(entry.state).toBe('running');
    tracker.track(entry.delegationId, Promise.resolve({ ok: true, summary: 's' }));
    await expect.poll(() => entry.state).toBe('settled');
    tracker.markDelivered(entry.delegationId);
    expect(entry.state).toBe('delivered');
    tracker.markDelivered(entry.delegationId);
    expect(entry.state).toBe('delivered');
  });

  it('rehydrate re-queues undelivered background results from the journal, never waking', () => {
    const hub = new LeaderDeliveryHub();
    const tracker = new DelegationTracker({ hub });
    cleanups.push(() => tracker.dispose());
    const ts = '2026-09-13T00:00:00.000Z';
    const events: SessionEvent[] = [
      // Completed, never delivered → re-queued from its excerpt.
      {
        type: 'delegate_started',
        ts,
        target: 'a',
        task: 'ta',
        delegationId: 'd-a',
        mode: 'background',
      },
      {
        type: 'delegate_completed',
        ts,
        target: 'a',
        task: 'ta',
        ok: true,
        summary: '[a] done',
        durationMs: 1,
        iterations: 1,
        toolCalls: 1,
        delegationId: 'd-a',
        taskId: 'task-a',
        resultExcerpt: 'EXCERPT A',
        mode: 'background',
      },
      // Started, never completed → lost on restart.
      {
        type: 'delegate_started',
        ts,
        target: 'b',
        task: 'tb',
        delegationId: 'd-b',
        mode: 'background',
      },
      // Already delivered → skipped.
      {
        type: 'delegate_started',
        ts,
        target: 'c',
        task: 'tc',
        delegationId: 'd-c',
        mode: 'background',
      },
      {
        type: 'delegate_completed',
        ts,
        target: 'c',
        task: 'tc',
        ok: true,
        summary: '[c] done',
        durationMs: 1,
        iterations: 1,
        toolCalls: 1,
        delegationId: 'd-c',
        mode: 'background',
      },
      { type: 'delegation_delivered', ts, delegationId: 'd-c' },
      // Blocking delegation → the leader already had its result.
      { type: 'delegate_started', ts, target: 'w', task: 'tw', delegationId: 'd-w', mode: 'wait' },
    ];
    expect(tracker.rehydrate(SESSION, events)).toBe(2);
    expect(tracker.rehydrate(SESSION, events)).toBe(0);
    const items = hub.take(SESSION);
    expect(items.map((d) => d.payload.delegationId)).toEqual(['d-a', 'd-b']);
    expect(items.every((d) => d.wake === false)).toBe(true);
    expect(items[0]!.payload).toMatchObject({ excerpt: 'EXCERPT A', cause: 'restart', ok: true });
    expect(items[1]!.payload).toMatchObject({ ok: false, status: 'lost', cause: 'restart' });
  });
});

describe('run-delegation parity', () => {
  it('prepare → start → settle yields exactly the blocking tool result', async () => {
    const make = () =>
      fakeDirector([
        (taskId) => ({
          status: 'failed',
          error: { kind: 'tool_failed', message: 'x', retryable: false },
          iterations: 2,
          toolCalls: 3,
          durationMs: 4_000,
          subagentId: 'sub-1',
          taskId,
        }),
      ]).director;
    const input = { role: 'bug-hunter', task: 'parity', wait: true, ...BOUNDARY };
    const viaTool = await createDelegateTool({
      host: hostFor(make()),
      roster: FLEET_ROSTER,
    }).execute(input, CTX, { signal: new AbortController().signal });

    const dir = make();
    const validated = validateDelegationInput(input, undefined);
    if (validated.kind !== 'ok') throw new Error('unexpected');
    const ready = await prepareDelegation(
      validated,
      { host: hostFor(dir), roster: FLEET_ROSTER, defaultTimeoutMs: 4 * 60 * 60 * 1000 },
      { sessionId: SESSION, mode: 'wait' },
    );
    if (ready.kind !== 'ready') throw new Error('unexpected');
    const first = await startDelegationAttempt(ready.prepared, 0, ready.prepared.baseBrief);
    const viaPhases = await settleDelegation(ready.prepared, first, undefined);

    const strip = (r: unknown) => ({ ...(r as Record<string, unknown>), taskId: 'x' });
    expect(strip(viaPhases)).toEqual(strip(viaTool));
  });
});
