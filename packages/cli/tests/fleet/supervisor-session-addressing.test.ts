import { sessionNoteHub } from '@wrongstack/core/coordination';
import { EventBus } from '@wrongstack/core/kernel';
import { afterEach, describe, expect, it } from 'vitest';
import { createHostFleetSupervisor } from '../../src/fleet/host-supervisor.js';

/**
 * The supervisor watches ONE fleet but speaks to MANY conversations.
 *
 * Watching is genuinely process-wide: there is one director, one task queue,
 * one backlog. Speaking is not. Steers and leader notes go through the
 * session-note hub, which routes strictly by session id and drops what matches
 * no inbox — so posting under the host's own session meant a nudge aimed at a
 * background tab's worker reached nobody, and the leader told about it was the
 * boot tab's, which could not act on work it had not started.
 */

const OWNER_OF: Record<string, string> = { w_tab2: 'sess_tab2' };

function buildSupervisor() {
  const events = new EventBus();
  const director = {
    fleet: { filter: () => () => {}, onAny: () => () => {}, emit: () => {} },
    status: () => ({ subagents: [] }),
    listPendingTasks: () => [],
    isWorkComplete: () => false,
    retargetPendingTask: () => true,
    terminate: async () => {},
    dispatchClassifier: undefined,
    spawn: async (cfg: Record<string, unknown>) => {
      spawned.push(cfg);
      return String(cfg['id']);
    },
  };
  const spawned: Array<Record<string, unknown>> = [];
  const supervisor = createHostFleetSupervisor({
    director: director as never,
    brain: { decide: async () => ({ type: 'answer', text: 'no' }) } as never,
    supervisorConfig: undefined,
    events,
    sessionId: 'sess_boot',
    sessionFor: (subagentId) => OWNER_OF[subagentId] ?? 'sess_boot',
    mailboxProjectDir: '/tmp',
    roster: { executor: { name: 'Executor', role: 'executor' } },
  });
  if (!supervisor) throw new Error('supervisor not built');
  // Reach the action port the way the supervisor's own decision paths do.
  const actions = (supervisor as unknown as { opts: { actions: Record<string, never> } }).opts
    .actions as unknown as {
    steerAgent(id: string, subject: string, body: string): Promise<void>;
    notifyLeader(subject: string, body: string, subagentId?: string): Promise<void>;
    spawnHelper(input: {
      reason: string;
      task?: { subagentId?: string };
    }): Promise<{ subagentId: string } | { error: string }>;
  };
  return { supervisor, actions, spawned };
}

/** Register a leader inbox and collect what lands in it. */
function leaderInbox(sessionId: string) {
  const got: string[] = [];
  const off = sessionNoteHub.register({
    sessionId,
    agentId: 'leader',
    aliases: ['leader'],
    deliver: (note) => got.push(note.body),
  });
  return { got, off };
}

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const off of cleanup.splice(0)) off();
});

describe('fleet supervisor addresses the owning conversation', () => {
  it('steers a worker in its own session, where its inbox actually is', () => {
    const { supervisor, actions } = buildSupervisor();
    cleanup.push(() => supervisor.stop());
    const got: string[] = [];
    const off = sessionNoteHub.register({
      sessionId: 'sess_tab2',
      agentId: 'w_tab2',
      deliver: (note) => got.push(note.body),
    });
    cleanup.push(off);

    void actions.steerAgent('w_tab2', 'Progress check', 'you look stalled');

    expect(got).toEqual(['you look stalled']);
  });

  it('tells the leader that owns the worker, not the boot tab', () => {
    const { supervisor, actions } = buildSupervisor();
    cleanup.push(() => supervisor.stop());
    const owner = leaderInbox('sess_tab2');
    const boot = leaderInbox('sess_boot');
    cleanup.push(owner.off, boot.off);

    void actions.notifyLeader('Worker may be stuck', 'nudged it', 'w_tab2');

    expect(owner.got).toEqual(['nudged it']);
    expect(boot.got).toEqual([]);
  });

  it('sends a fleet-wide observation to the host session — it names no worker', () => {
    const { supervisor, actions } = buildSupervisor();
    cleanup.push(() => supervisor.stop());
    const boot = leaderInbox('sess_boot');
    cleanup.push(boot.off);

    void actions.notifyLeader('Idle workers with undispatchable tasks', 'queue is stuck');

    expect(boot.got).toEqual(['queue is stuck']);
  });

  it('gives a backlog helper the session that owns the backlog', async () => {
    const { supervisor, actions, spawned } = buildSupervisor();
    cleanup.push(() => supervisor.stop());

    await actions.spawnHelper({ reason: 'queue backlog', task: { subagentId: 'w_tab2' } });

    expect(spawned[0]?.['originSessionId']).toBe('sess_tab2');
  });
});
