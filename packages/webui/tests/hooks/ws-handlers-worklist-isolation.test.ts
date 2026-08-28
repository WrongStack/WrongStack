import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The worklist contract the user stated: a tab's Todos panel shows that tab's
 * session and nothing else. `todos.updated` / `todos.cleared` are always
 * session-scoped, so a frame without a usable sessionId must be DROPPED, not
 * poured into whichever lane is in front — that fallback is how one tab's
 * board surfaced in another tab's worklist mid-update. Stamped frames keep
 * positive routing: a background tab's board stays live while the foreground
 * tab never sees it.
 */

const send = vi.fn();
vi.mock('@/lib/ws-client', () => ({ getWSClient: () => ({ send }) }));

const { WS_HANDLERS } = await import('../../src/hooks/ws-handlers');
const {
  SESSION_DEFAULT_LANE_ID,
  ensureSessionLane,
  readSessionLane,
  sessionLane,
  useSessionLanes,
} = await import('../../src/stores/session-lanes');

/** Dispatch through the map exactly as `useWebSocket` does. */
function fire(type: string, payload: unknown = {}) {
  const handler = WS_HANDLERS[type as keyof typeof WS_HANDLERS];
  expect(handler, `no handler registered for ${type}`).toBeTypeOf('function');
  handler?.({ type, payload } as never);
}

const BOARD_A = [
  { id: 'a1', content: 'tab A item', status: 'pending' as const },
  { id: 'a2', content: 'tab A done', status: 'completed' as const },
];

function bindForeground(id: string): void {
  ensureSessionLane(id);
  useSessionLanes.setState({ activeSessionId: id });
}

beforeEach(() => {
  vi.clearAllMocks();
  useSessionLanes.setState({ lanes: {}, activeSessionId: SESSION_DEFAULT_LANE_ID });
});

describe('todos.updated lands on the lane it names', () => {
  it('a stamped frame updates its own session lane, never the tab in front', () => {
    bindForeground('sess-a');
    ensureSessionLane('sess-b');
    sessionLane('sess-a').setTodos(BOARD_A);

    fire('todos.updated', {
      sessionId: 'sess-b',
      todos: [{ id: 'b1', content: 'tab B item', status: 'in_progress' as const }],
    });

    expect(readSessionLane('sess-a').todos).toEqual(BOARD_A);
    expect(readSessionLane('sess-b').todos.map((t) => t.id)).toEqual(['b1']);
  });

  it('an untagged frame is dropped while a real session is bound', () => {
    bindForeground('sess-a');
    sessionLane('sess-a').setTodos(BOARD_A);

    fire('todos.updated', {
      todos: [{ id: 'x1', content: 'foreign board', status: 'pending' as const }],
    });

    expect(readSessionLane('sess-a').todos).toEqual(BOARD_A);
  });

  it('an empty-string session stamp is dropped too', () => {
    bindForeground('sess-a');
    sessionLane('sess-a').setTodos(BOARD_A);

    fire('todos.updated', {
      sessionId: '',
      todos: [{ id: 'x1', content: 'no-session board', status: 'pending' as const }],
    });

    expect(readSessionLane('sess-a').todos).toEqual(BOARD_A);
  });
});

describe('todos.cleared', () => {
  it('an untagged frame never empties the bound tab in front', () => {
    bindForeground('sess-a');
    sessionLane('sess-a').setTodos(BOARD_A);

    fire('todos.cleared', {});

    expect(readSessionLane('sess-a').todos).toEqual(BOARD_A);
  });

  it('still empties the pre-session default lane (boot-time snapshot)', () => {
    ensureSessionLane(SESSION_DEFAULT_LANE_ID);
    sessionLane(SESSION_DEFAULT_LANE_ID).setTodos(BOARD_A);

    fire('todos.cleared', {});

    expect(readSessionLane(SESSION_DEFAULT_LANE_ID).todos).toEqual([]);
  });
});
