import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMailboxStore, isUnreadIncomingMailboxMessage } from '../src/lib/mailbox-store.js';

describe('SimpleUI mailbox store', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-28T12:00:00.000Z'));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps the NEWEST messages when a payload exceeds the cap', () => {
    // The server sends `mb.query()` output, sorted newest-first (SQLite
    // `ORDER BY timestamp DESC`). The cap used to be `slice(-100)` — written
    // as "keep the most recent", but on a newest-first list that keeps the
    // OLDEST 100 and throws away exactly the new mail the panel is for. The
    // WebUI store hit this and fixed it; this store carried the unfixed copy.
    // The payload can exceed the cap: the `unreadOnly` path without an agent
    // id asks the server for `max(limit * 5, 100)`.
    const store = createMailboxStore();
    const total = 130;
    const messages = Array.from({ length: total }, (_, index) => ({
      id: `mail-${index}`,
      from: 'worker@one',
      to: 'leader',
      type: 'note',
      subject: `s${index}`,
      body: 'b',
      priority: 'normal',
      // Newest first, as the server sends them.
      timestamp: new Date(Date.UTC(2026, 6, 28, 12, 0, total - index)).toISOString(),
      completed: false,
      readByCount: 0,
    }));

    store.applyMessage({ type: 'mailbox.messages', payload: { messages } });

    const kept = store.getSnapshot().messages;
    expect(kept).toHaveLength(100);
    // mail-0 is the newest; mail-129 the oldest. The newest must survive.
    expect(kept[0]?.id).toBe('mail-0');
    expect(kept.map((m) => m.id)).toContain('mail-99');
    expect(kept.map((m) => m.id)).not.toContain('mail-129');
  });

  it('prefers online agents when the agent payload exceeds the cap', () => {
    const store = createMailboxStore();
    const agents = [
      ...Array.from({ length: 60 }, (_, index) => ({
        agentId: `offline-${index}`,
        name: `offline-${index}`,
        status: 'idle',
        online: false,
      })),
      { agentId: 'live-1', name: 'live-1', status: 'running', online: true },
    ];

    store.applyMessage({ type: 'mailbox.agents', payload: { agents } });

    const kept = store.getSnapshot().agents;
    expect(kept).toHaveLength(50);
    expect(kept.map((a) => a.agentId)).toContain('live-1');
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

  it('filters self-sent WebUI messages out of the client-visible unread count', () => {
    const store = createMailboxStore();
    store.applyMessage({
      type: 'mailbox.messages',
      payload: {
        messages: [
          {
            id: 'mail-peer',
            from: 'worker@one',
            to: 'simpleui',
            type: 'note',
            subject: 'Peer note',
            body: 'Needs attention.',
            priority: 'normal',
            timestamp: '2026-07-28T12:00:00.000Z',
            completed: false,
            readByCount: 0,
          },
          {
            id: 'mail-webui',
            from: 'webui',
            to: 'leader',
            type: 'note',
            subject: 'Self sent',
            body: 'Sent from SimpleUI via the WebUI server.',
            priority: 'normal',
            timestamp: '2026-07-28T12:00:00.000Z',
            completed: false,
            readByCount: 0,
          },
          {
            id: 'mail-simpleui',
            from: 'simpleui',
            to: 'leader',
            type: 'note',
            subject: 'Local echo',
            body: 'Already authored locally.',
            priority: 'normal',
            timestamp: '2026-07-28T12:00:00.000Z',
            completed: false,
            readByCount: 0,
          },
          {
            id: 'mail-read',
            from: 'worker@two',
            to: 'simpleui',
            type: 'note',
            subject: 'Read peer note',
            body: 'Already read.',
            priority: 'normal',
            timestamp: '2026-07-28T12:00:00.000Z',
            completed: false,
            readByCount: 1,
          },
        ],
      },
    });

    const clientUnread = store.getSnapshot().messages.filter(isUnreadIncomingMailboxMessage);

    expect(clientUnread.map((message) => message.id)).toEqual(['mail-peer']);

    store.applyMessage({
      type: 'mailbox.messages',
      payload: {
        unreadOnly: true,
        messages: store.getSnapshot().messages,
      },
    });

    expect(store.getSnapshot().unreadCount).toBe(1);
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
