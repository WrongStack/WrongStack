/**
 * Fleet status broadcaster — peer-awareness mails on subagent transitions.
 *
 * Pins: one broadcast per terminal transition, per-agent throttle with
 * coalescing (newest wins, nothing silently lost), global per-minute cap
 * with drop accounting, spawn/budget one-shots, heartbeat enrichment on
 * task start/stop, and stop() teardown.
 */

import type { Mailbox } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFleetStatusBroadcaster } from '../src/fleet/status-broadcast.js';

type SentMail = { to: string; type: string; subject: string; body: string; priority?: string };

function makeFakeMailbox(): {
  mailbox: Mailbox;
  sent: SentMail[];
  heartbeats: unknown[];
  deregistered: string[];
} {
  const sent: SentMail[] = [];
  const heartbeats: unknown[] = [];
  const deregistered: string[] = [];
  const mailbox = {
    send: vi.fn(async (m: SentMail) => {
      sent.push(m);
      return { ...m, id: `m${sent.length}` };
    }),
    heartbeat: vi.fn(async (h: unknown) => {
      heartbeats.push(h);
    }),
    deregisterAgent: vi.fn(async (agentId: string) => {
      deregistered.push(agentId);
    }),
  } as never as Mailbox;
  return { mailbox, sent, heartbeats, deregistered };
}

function completedEvent(subagentId: string, over: Record<string, unknown> = {}) {
  return {
    subagentId,
    taskId: `t-${Math.random().toString(36).slice(2, 8)}`,
    status: 'success' as const,
    iterations: 3,
    toolCalls: 10,
    durationMs: 42_000,
    ...over,
  };
}

describe('createFleetStatusBroadcaster', () => {
  let events: EventBus;
  let fake: ReturnType<typeof makeFakeMailbox>;
  let broadcaster: { start(): void; stop(): void };

  beforeEach(() => {
    vi.useFakeTimers();
    events = new EventBus();
    fake = makeFakeMailbox();
  });

  afterEach(() => {
    broadcaster?.stop();
    vi.useRealTimers();
  });

  function build(config?: {
    enabled?: boolean;
    minIntervalMsPerAgent?: number;
    globalPerMinuteCap?: number;
    budgetWarnings?: boolean;
  }) {
    broadcaster = createFleetStatusBroadcaster({
      events,
      mailboxFactory: () => fake.mailbox,
      sessionTag: () => 'abcd1234',
      subagentName: (id) =>
        id === 'sub-1' ? 'Einstein' : id === 'chimera-1' ? 'chimera-review' : undefined,
      config,
    });
    broadcaster.start();
    return broadcaster;
  }

  it('broadcasts a status mail on task completion, from fleet@<tag>, to everyone', async () => {
    build();
    events.emit('subagent.task_completed', completedEvent('sub-1'));
    await vi.runAllTimersAsync();
    expect(fake.sent).toHaveLength(1);
    expect(fake.sent[0]).toMatchObject({ to: '*', type: 'status', priority: 'low' });
    expect(fake.sent[0]?.subject).toBe('[Einstein] task success');
    expect(fake.sent[0]?.body).toContain('3 iter, 10 tools, 42s');
    expect((fake.mailbox.send as ReturnType<typeof vi.fn>).mock.calls[0]?.[0]?.from).toBe(
      'fleet@abcd1234',
    );
  });

  it('failure completions carry the error kind at normal priority', async () => {
    build();
    events.emit(
      'subagent.task_completed',
      completedEvent('sub-1', {
        status: 'failed',
        error: { kind: 'tool_failed', message: 'boom', retryable: false },
      }),
    );
    await vi.runAllTimersAsync();
    expect(fake.sent[0]?.priority).toBe('normal');
    expect(fake.sent[0]?.body).toContain('(tool_failed)');
  });

  it('coalesces within the per-agent window — newest wins, fires when the window reopens', async () => {
    build({ minIntervalMsPerAgent: 15_000 });
    events.emit('subagent.task_completed', completedEvent('sub-1'));
    await vi.advanceTimersByTimeAsync(1_000);
    // Two more completions inside the window → coalesce to the newest.
    events.emit(
      'subagent.task_completed',
      completedEvent('sub-1', {
        status: 'failed',
        error: { kind: 'timeout', message: 't', retryable: true },
      }),
    );
    events.emit('subagent.task_completed', completedEvent('sub-1', { status: 'stopped' }));
    expect(fake.sent).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(fake.sent).toHaveLength(2);
    expect(fake.sent[1]?.subject).toBe('[Einstein] task stopped');
  });

  it('enforces the global per-minute cap and reports drops on the next allowed send', async () => {
    build({ minIntervalMsPerAgent: 0, globalPerMinuteCap: 2 });
    for (let i = 0; i < 5; i++) {
      events.emit('subagent.task_completed', completedEvent(`agent-${i}`));
    }
    await vi.runAllTimersAsync();
    expect(fake.sent).toHaveLength(2);
    // Window slides → next broadcast reports the 3 dropped ones.
    await vi.advanceTimersByTimeAsync(61_000);
    events.emit('subagent.task_completed', completedEvent('agent-9'));
    await vi.runAllTimersAsync();
    expect(fake.sent).toHaveLength(3);
    expect(fake.sent[2]?.body).toContain('3 earlier status broadcast(s) dropped');
  });

  it('keeps recoverable budget warnings out of peer mailboxes by default', async () => {
    build({ minIntervalMsPerAgent: 0 });
    events.emit('subagent.budget_warning', {
      subagentId: 'sub-1',
      kind: 'timeout',
      used: 850,
      limit: 1000,
    });
    await vi.runAllTimersAsync();
    expect(fake.sent).toHaveLength(0);
  });

  it('announces spawn and opted-in budget pressure once each', async () => {
    build({ minIntervalMsPerAgent: 0, budgetWarnings: true });
    events.emit('subagent.spawned', {
      subagentId: 'sub-1',
      taskId: 't1',
      name: 'Einstein',
      model: 'gpt-x',
    });
    events.emit('subagent.spawned', { subagentId: 'sub-1', taskId: 't2', name: 'Einstein' });
    events.emit('subagent.budget_warning', {
      subagentId: 'sub-1',
      kind: 'iterations',
      used: 10,
      limit: 10,
    });
    events.emit('subagent.budget_warning', {
      subagentId: 'sub-1',
      kind: 'iterations',
      used: 12,
      limit: 12,
    });
    await vi.runAllTimersAsync();
    const subjects = fake.sent.map((m) => m.subject);
    expect(subjects.filter((s) => s.includes('joined the fleet'))).toHaveLength(1);
    expect(subjects.filter((s) => s.includes('budget pressure'))).toHaveLength(1);
    expect(fake.sent.find((m) => m.subject.includes('budget pressure'))?.body).toContain(
      'extension threshold',
    );
  });

  it('keeps Chimera reviewer lifecycle chatter out of the mailbox', async () => {
    build({ minIntervalMsPerAgent: 0, budgetWarnings: true });
    events.emit('subagent.spawned', {
      subagentId: 'chimera-1',
      taskId: 'review-1',
      name: 'chimera-review',
      model: 'deepseek-v4-flash',
    });
    events.emit('subagent.task_started', {
      subagentId: 'chimera-1',
      taskId: 'review-1',
      description: 'review changed files',
    });
    events.emit('subagent.budget_warning', {
      subagentId: 'chimera-1',
      kind: 'iterations',
      used: 10,
      limit: 10,
    });
    events.emit('subagent.task_completed', completedEvent('chimera-1'));
    await vi.runAllTimersAsync();

    expect(fake.sent).toHaveLength(0);
    expect(fake.heartbeats).toEqual([
      expect.objectContaining({ agentId: 'chimera-1', status: 'running' }),
      expect.objectContaining({ agentId: 'chimera-1', status: 'idle' }),
    ]);
  });

  it('pushes rich heartbeats on task start/stop (currentTask + status)', async () => {
    build();
    events.emit('subagent.task_started', {
      subagentId: 'sub-1',
      taskId: 't1',
      description: 'refactor the auth module end to end because reasons that make this long'.repeat(
        3,
      ),
    });
    events.emit('subagent.task_completed', completedEvent('sub-1'));
    await vi.runAllTimersAsync();
    expect(fake.heartbeats[0]).toMatchObject({ agentId: 'sub-1', status: 'running' });
    expect((fake.heartbeats[0] as { currentTask: string }).currentTask.length).toBeLessThanOrEqual(
      80,
    );
    expect(fake.heartbeats[1]).toMatchObject({ agentId: 'sub-1', status: 'idle' });
  });

  it('deregisters the agent from the mailbox registry on subagent.removed', async () => {
    build();
    events.emit('subagent.removed', { subagentId: 'sub-1', reason: 'retired' });
    // deregisterAgent is fire-and-forget (void mb().deregisterAgent(...).catch(...)),
    // so flush the microtask queue.
    await vi.runAllTimersAsync();
    expect(fake.deregistered).toContain('sub-1');
  });

  it('enabled:false disables everything; stop() detaches listeners', async () => {
    build({ enabled: false });
    events.emit('subagent.task_completed', completedEvent('sub-1'));
    await vi.runAllTimersAsync();
    expect(fake.sent).toHaveLength(0);

    broadcaster.stop();
    const active = createFleetStatusBroadcaster({
      events,
      mailboxFactory: () => fake.mailbox,
      sessionTag: () => 'abcd1234',
    });
    active.start();
    active.stop();
    events.emit('subagent.task_completed', completedEvent('sub-2'));
    await vi.runAllTimersAsync();
    expect(fake.sent).toHaveLength(0);
    broadcaster = active;
  });
});
