import { afterEach, describe, expect, it } from 'vitest';
import {
  classifyMailboxRecipient,
  type MailboxMessage,
  selectUnreadCount,
  useMailboxStore,
} from '../../src/stores/mailbox-store';

function makeMessage(overrides: Partial<MailboxMessage> = {}): MailboxMessage {
  return {
    id: 'msg_1',
    from: 'agent-a',
    to: '*',
    type: 'note',
    subject: 'hello',
    body: 'body',
    priority: 'normal',
    readBy: {},
    readByCount: 0,
    completed: false,
    timestamp: new Date(0).toISOString(),
    ...overrides,
  };
}

describe('mailbox store', () => {
  afterEach(() => {
    // Clean up persisted state between tests
    useMailboxStore.setState({ messages: [], agents: [] });
  });

  it('counts only unread, uncompleted messages', () => {
    useMailboxStore.getState().setMessages([
      makeMessage({ id: 'a' }), // unread
      makeMessage({ id: 'b', readByCount: 2 }), // read
      makeMessage({ id: 'c', completed: true }), // completed
      makeMessage({ id: 'd' }), // unread
    ]);
    expect(selectUnreadCount(useMailboxStore.getState())).toBe(2);
  });

  it('is zero when empty', () => {
    useMailboxStore.getState().setMessages([]);
    expect(selectUnreadCount(useMailboxStore.getState())).toBe(0);
  });

  it('setMessages updates the messages array (and derives scope)', () => {
    const msgs = [makeMessage({ id: 'x' }), makeMessage({ id: 'y' })];
    useMailboxStore.getState().setMessages(msgs);
    const stored = useMailboxStore.getState().messages;
    expect(stored).toHaveLength(2);
    expect(stored[0]).toMatchObject({ id: 'x', to: msgs[0]!.to, scope: 'project' });
    expect(stored[1]).toMatchObject({ id: 'y', to: msgs[1]!.to, scope: 'project' });
  });

  it('setAgents updates the agents array', () => {
    const agents = [
      { id: 'agent-1', name: 'Alice' },
      { id: 'agent-2', name: 'Bob' },
    ];
    useMailboxStore.getState().setAgents(agents as any);
    expect(useMailboxStore.getState().agents).toEqual(agents);
  });

  it('setMessages derives scope + recipientSessionId from the recipient', () => {
    useMailboxStore
      .getState()
      .setMessages([
        makeMessage({ id: 'm1', to: '*' }),
        makeMessage({ id: 'm2', to: '@session:session-7' }),
        makeMessage({ id: 'm3', to: 'leader@abcd' }),
      ]);
    const byId = Object.fromEntries(useMailboxStore.getState().messages.map((m) => [m.id, m]));
    expect(byId.m1?.scope).toBe('project');
    expect(byId.m1?.recipientSessionId).toBeUndefined();
    expect(byId.m2?.scope).toBe('session');
    expect(byId.m2?.recipientSessionId).toBe('session-7');
    expect(byId.m3?.scope).toBe('agent');
    expect(byId.m3?.recipientSessionId).toBeUndefined();
  });

  it('caps to the NEWEST messages when the payload exceeds the cap', () => {
    // Regression: the server returns newest-first (sqlite ORDER BY
    // timestamp DESC) and the old `.slice(-MAX)` kept the tail — i.e. the
    // OLDEST messages — while its comment claimed "the most recent".
    const oversized = Array.from({ length: 120 }, (_, index) =>
      makeMessage({
        id: `m${index}`,
        // Descending timestamps: m0 is the newest, m119 the oldest.
        timestamp: new Date(Date.UTC(2026, 0, 1, 0, 120 - index)).toISOString(),
      }),
    );
    useMailboxStore.getState().setMessages(oversized);
    const kept = useMailboxStore.getState().messages;
    expect(kept).toHaveLength(100);
    expect(kept[0]?.id).toBe('m0');
    expect(kept.at(-1)?.id).toBe('m99');
    expect(kept.some((message) => message.id === 'm119')).toBe(false);
  });

  it('setMessages preserves server-provided scope when present', () => {
    useMailboxStore
      .getState()
      .setMessages([
        makeMessage({ id: 'm1', to: '@session:s', scope: 'project', recipientSessionId: 'unused' }),
      ]);
    const msg = useMailboxStore.getState().messages[0]!;
    // Server wins — derived classification is skipped.
    expect(msg.scope).toBe('project');
    expect(msg.recipientSessionId).toBe('unused');
  });
});

describe('classifyMailboxRecipient', () => {
  it('classifies project broadcasts', () => {
    expect(classifyMailboxRecipient('*')).toEqual({ scope: 'project' });
    expect(classifyMailboxRecipient('all')).toEqual({ scope: 'project' });
  });

  it('classifies session-scoped recipients', () => {
    expect(classifyMailboxRecipient('@session:abc-123')).toEqual({
      scope: 'session',
      recipientSessionId: 'abc-123',
    });
  });

  it('classifies direct agent recipients', () => {
    expect(classifyMailboxRecipient('leader@abcd')).toEqual({ scope: 'agent' });
  });

  it('falls back to agent scope when @session has no id', () => {
    expect(classifyMailboxRecipient('@session:')).toEqual({ scope: 'agent' });
  });
});
