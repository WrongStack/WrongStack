import { describe, expect, it, vi } from 'vitest';
import { createMailboxStore } from '../src/lib/mailbox-store.js';

describe('SimpleUI mailbox store', () => {
  it('projects mailbox messages, agents, and SQLite IPC health', () => {
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
    store.applyMessage({
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

    expect(store.getSnapshot()).toMatchObject({
      messages: [{ id: 'mail-1', readByCount: 0 }],
      agents: [{ agentId: 'worker@one', online: true }],
      service: { protocolVersion: 3, pid: 123, storageKind: 'sqlite' },
      error: null,
    });
  });

  it('requests a fresh snapshot after mailbox activity events', () => {
    const refresh = vi.fn();
    const store = createMailboxStore(refresh);

    store.applyMessage({ type: 'mailbox.received', payload: { id: 'mail-1' } });
    store.applyMessage({ type: 'mailbox.agent_registered', payload: { agentId: 'worker@one' } });
    store.applyMessage({ type: 'mailbox.sent', payload: { success: true } });

    expect(refresh).toHaveBeenCalledTimes(3);
  });
});
