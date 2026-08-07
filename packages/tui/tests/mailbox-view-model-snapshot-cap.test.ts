// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { useMailboxViewModel } from '../src/hooks/use-mailbox-view-model.js';

type Handler = (event: string, payload: unknown) => void;

function makeEventsBus() {
  const handlers = new Map<string, Handler[]>();
  return {
    bus: {
      onPattern(pattern: string, handler: Handler) {
        const list = handlers.get(pattern) ?? [];
        list.push(handler);
        handlers.set(pattern, list);
        return () => {};
      },
    } as never,
    emit(pattern: string, payload: unknown) {
      for (const handler of handlers.get(pattern) ?? []) handler(pattern, payload);
    },
  };
}

function message(id: number) {
  return {
    id: `m${id}`,
    from: 'agent-a',
    to: '*',
    type: 'note',
    subject: `s${id}`,
    body: '',
    priority: 'normal',
    readBy: {},
    completed: false,
    // Ascending: higher id = newer.
    timestamp: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
  };
}

function agent(id: number, online: boolean) {
  return {
    agentId: `a${id}`,
    name: `Agent ${id}`,
    sessionId: 's',
    status: 'idle',
    lastSeenAt: new Date(Date.UTC(2026, 0, 1, 0, 0, id)).toISOString(),
    online,
  };
}

describe('useMailboxViewModel snapshot retention', () => {
  // The bug this pins: the incremental handlers cap at 50 messages /
  // 30 agents, but the mailbox.snapshot handler in the same effect put the
  // FULL lists into state — the consumer half of the measured
  // mailbox.snapshot storm (every mailbox event publishes a full-list
  // snapshot).
  it('caps a snapshot to the 50 newest messages and 30 agents, online first', () => {
    const { bus, emit } = makeEventsBus();
    const { result, unmount } = renderHook(() => useMailboxViewModel(bus));

    act(() =>
      emit('mailbox.snapshot', {
        actorId: 'me',
        messages: Array.from({ length: 120 }, (_, index) => message(index)),
        agents: [
          // 10 online agents with the OLDEST lastSeenAt … they must survive.
          ...Array.from({ length: 10 }, (_, index) => agent(index, true)),
          // …ahead of 35 newer offline ones.
          ...Array.from({ length: 35 }, (_, index) => agent(100 + index, false)),
        ],
      }),
    );

    const messages = result.current.mailboxMessages;
    expect(messages).toHaveLength(50);
    // Newest-first: the highest timestamps (ids 70..119) are the keepers.
    expect(messages[0]?.id).toBe('m119');
    expect(messages.at(-1)?.id).toBe('m70');

    const agents = result.current.mailboxAgents;
    expect(agents).toHaveLength(30);
    expect(agents.filter((entry) => entry.online)).toHaveLength(10);
    expect(agents[0]?.online).toBe(true);
    unmount();
  });
});
