import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';

vi.mock('ws', () => {
  const MockWebSocket = vi.fn();
  (MockWebSocket as unknown as { OPEN: number; CLOSED: number }).OPEN = 1;
  (MockWebSocket as unknown as { OPEN: number; CLOSED: number }).CLOSED = 3;
  return { WebSocket: MockWebSocket };
});

import { cleanupOwnerlessEmptySessions } from '../src/server/session-cleanup-scheduler.js';
import { broadcast, clientWantsSession } from '../src/server/ws-utils.js';

/**
 * A WebUI page holds up to four session tabs on ONE socket.
 *
 * The server therefore cannot decide anything per-tab from `client.sessionId`
 * — that is only the tab the user last touched. Every place that used to do so
 * treated the other three tabs as if they did not exist: their runs were
 * filtered out of broadcasts before leaving the process (a background tab that
 * simply stops producing output), and their brand-new, still-empty sessions
 * were eligible for the ownerless-session sweep.
 *
 * `session.subscribe` is how the page declares its open set; these tests pin
 * that the declaration is actually honoured.
 */

function socket() {
  return { readyState: WebSocket.OPEN, send: vi.fn(), bufferedAmount: 0 } as never;
}

function page(sessionIds: string[], lastTouched = sessionIds[0]) {
  const ws = socket();
  return {
    ws,
    client: {
      ws,
      sessionId: lastTouched ?? null,
      sessionIds: new Set(sessionIds),
      connId: `c_${sessionIds.join('_')}`,
      connectedAt: 0,
    },
    sent: () => (ws as unknown as { send: { mock: { calls: string[][] } } }).send.mock.calls,
  };
}

describe('broadcast delivery for a page with four tabs', () => {
  it('delivers a BACKGROUND tab run to the page showing it', () => {
    // The regression this exists for: one socket, four lanes, and the user is
    // looking at tab 1 while tab 2 streams. Filtering on the last-touched
    // session dropped tab 2's tokens at the wire.
    const p = page(['tab-1', 'tab-2', 'tab-3', 'tab-4'], 'tab-1');
    const clients = new Map([[p.ws, p.client]]);

    broadcast(clients as never, {
      type: 'provider.text_delta',
      payload: { sessionId: 'tab-2', text: 'tokens for the background tab' },
    });

    expect(p.sent()).toHaveLength(1);
  });

  it('does not deliver a session the page has no tab for', () => {
    const p = page(['tab-1', 'tab-2'], 'tab-1');
    const clients = new Map([[p.ws, p.client]]);

    broadcast(clients as never, {
      type: 'provider.text_delta',
      payload: { sessionId: 'someone-elses-session', text: 'not ours' },
    });

    expect(p.sent()).toHaveLength(0);
  });

  it('keeps two separate pages isolated from each other', () => {
    const a = page(['a1', 'a2'], 'a1');
    const b = page(['b1'], 'b1');
    const clients = new Map([
      [a.ws, a.client],
      [b.ws, b.client],
    ]);

    broadcast(clients as never, {
      type: 'provider.text_delta',
      payload: { sessionId: 'a2', text: 'for page A tab 2' },
    });

    expect(a.sent()).toHaveLength(1);
    expect(b.sent()).toHaveLength(0);
  });

  it('still delivers untagged, project-wide messages everywhere', () => {
    const p = page(['tab-1'], 'tab-1');
    const clients = new Map([[p.ws, p.client]]);
    broadcast(clients as never, { type: 'sessions.list', payload: { sessions: [] } });
    expect(p.sent()).toHaveLength(1);
  });

  it('falls back to the single-session filter for a surface that declared nothing', () => {
    // Surfaces that only ever show one session (and older clients) never send
    // `session.subscribe`; their behaviour must not change.
    expect(clientWantsSession({ sessionId: 'x', sessionIds: undefined }, 'x')).toBe(true);
    expect(clientWantsSession({ sessionId: 'x', sessionIds: undefined }, 'y')).toBe(false);
    expect(clientWantsSession({ sessionId: null, sessionIds: undefined }, 'y')).toBe(true);
  });
});

describe('ownerless empty-session cleanup respects background tabs', () => {
  function ctx(overrides: Partial<Parameters<typeof cleanupOwnerlessEmptySessions>[0]> = {}) {
    const deleted: string[] = [];
    const store = {
      list: async () => [{ id: 'active' }, { id: 'background-tab' }, { id: 'orphan' }],
      isEmpty: async () => true,
      delete: async (id: string) => {
        deleted.push(id);
      },
    };
    return {
      deleted,
      ctx: {
        getSessionStore: () => store as never,
        getActiveSessionId: () => 'active',
        hasParticipants: () => false,
        refreshSessions: async () => undefined,
        logger: { info: vi.fn(), error: vi.fn() },
        ...overrides,
      } as Parameters<typeof cleanupOwnerlessEmptySessions>[0],
    };
  }

  it('deletes an orphan but never a session a tab is displaying', async () => {
    const { ctx: c, deleted } = ctx({
      getActiveSessionIds: () => ['active', 'background-tab'],
    });
    await cleanupOwnerlessEmptySessions(c);
    expect(deleted).toEqual(['orphan']);
  });

  it('without a declared set it still protects the runtime session', async () => {
    const { ctx: c, deleted } = ctx();
    await cleanupOwnerlessEmptySessions(c);
    expect(deleted).not.toContain('active');
  });
});

describe('audit journalling for a background tab', () => {
  it('appends a background session’s events to ITS journal, not nowhere', async () => {
    const { createSetupEventSessionHelpers } = await import(
      '../src/server/setup-events-session-helpers.js'
    );
    const foreground: unknown[] = [];
    const background: unknown[] = [];
    const helpers = createSetupEventSessionHelpers(
      { session: { id: 'tab-1' } } as never,
      { append: async (e: unknown) => void foreground.push(e) } as never,
      {
        bridgeForSession: (id) =>
          id === 'tab-2'
            ? ({ append: async (e: unknown) => void background.push(e) } as never)
            : undefined,
      },
    );

    helpers.appendForCurrentSession('tab-1', { type: 'tool_started' } as never);
    helpers.appendForCurrentSession('tab-2', { type: 'tool_started' } as never);
    await new Promise((r) => setTimeout(r, 0));

    // Each tab journals its own work. Before this, the second call was simply
    // dropped for not being the session in front, and resuming tab 2 showed a
    // run with no tool history.
    expect(foreground).toHaveLength(1);
    expect(background).toHaveLength(1);
  });

  it('drops an unaddressable session rather than writing it to the wrong journal', async () => {
    const { createSetupEventSessionHelpers } = await import(
      '../src/server/setup-events-session-helpers.js'
    );
    const foreground: unknown[] = [];
    const helpers = createSetupEventSessionHelpers(
      { session: { id: 'tab-1' } } as never,
      { append: async (e: unknown) => void foreground.push(e) } as never,
      { bridgeForSession: () => undefined },
    );

    helpers.appendForCurrentSession('a-session-with-no-agent', { type: 'tool_started' } as never);
    await new Promise((r) => setTimeout(r, 0));

    expect(foreground).toHaveLength(0);
  });
});
