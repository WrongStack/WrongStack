import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMailboxStore } from '../src/lib/mailbox-store.js';

describe('SimpleUI mailbox store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('projects mailbox messages, agents, and stamps lastEventAt on real traffic', () => {
    const store = createMailboxStore();
    store.applyMessage({
      type: 'mailbox.messages',
      payload: {
        messages: [
          {
            id: 'mail-1',
            from: 'worker@one',
            to: 'leader',
            type: 'result',
            subject: 'Done',
            body: 'Implemented the fix.',
            priority: 'high',
            timestamp: '2026-07-28T12:00:00.000Z',
            completed: false,
            readByCount: 0,
          },
        ],
      },
    });
    store.applyMessage({
      type: 'mailbox.agents',
      payload: {
        agents: [{ agentId: 'worker@one', name: 'Worker', status: 'idle', online: true }],
      },
    });

    expect(store.getSnapshot()).toMatchObject({
      messages: [{ id: 'mail-1', readByCount: 0 }],
      agents: [{ agentId: 'worker@one', online: true }],
      lastEventAt: new Date('2026-07-28T12:00:00.000Z').getTime(),
      error: null,
    });
  });

  it('ignores legacy mailbox.status frames — server does not broadcast them', () => {
    const store = createMailboxStore();
    const before = store.getSnapshot().lastEventAt;
    const accepted = store.applyMessage({
      type: 'mailbox.status',
      payload: {
        status: {
          protocolVersion: 3,
          pid: 123,
          clients: 3,
          pendingRequests: 0,
          storageKind: 'sqlite',
        },
      },
    });
    expect(accepted).toBe(false);
    const after = store.getSnapshot();
    expect(after.lastEventAt).toBe(before);
    expect(after).not.toHaveProperty('service');
  });

  it('requests a fresh snapshot after mailbox activity events and stamps lastEventAt', () => {
    const refresh = vi.fn();
    const store = createMailboxStore(refresh);

    store.applyMessage({ type: 'mailbox.received', payload: { id: 'mail-1' } });
    store.applyMessage({ type: 'mailbox.agent_registered', payload: { agentId: 'worker@one' } });
    store.applyMessage({ type: 'mailbox.sent', payload: { success: true } });

    expect(refresh).toHaveBeenCalledTimes(3);
    expect(store.getSnapshot().lastEventAt).toBe(new Date('2026-07-28T12:00:00.000Z').getTime());
  });
});
