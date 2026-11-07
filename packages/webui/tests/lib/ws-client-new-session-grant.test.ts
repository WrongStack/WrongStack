import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The answer to a `session.new` has to be recognised, or the New Session
 * button does nothing at all.
 *
 * The client cannot know the id of the session the server is about to create,
 * so it recognises the answer as "the first RESET announcement for a session
 * it has never seen". The server announces the session it just created TWICE:
 * once as a plain re-announcement (the model re-point that follows a session
 * swap broadcasts one) and once as the authoritative `reset: true` answer.
 *
 * Counting the plain announcement in the "already seen" set made the
 * authoritative answer unrecognisable: the grant was never spent, the new
 * session never took the foreground, and the browser kept rendering the
 * previous tab's transcript instead of the welcome screen.
 */

interface FakeWS {
  url: string;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: string }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: ((err: unknown) => void) | null;
  close: (code?: number, reason?: string) => void;
  send: (data: string) => void;
  binaryType: string;
}

const FakeWSModule = vi.hoisted(() => {
  const instances: FakeWS[] = [];
  const sent: string[] = [];
  const klass = class FakeWS {
    url: string;
    readyState = 0;
    close: (code?: number, reason?: string) => void = () => {};
    send: (data: string) => void = () => {};
    onopen: (() => void) | null = null;
    onmessage: ((ev: { data: string }) => void) | null = null;
    onclose: ((ev: { code: number; reason: string }) => void) | null = null;
    onerror: ((err: unknown) => void) | null = null;
    binaryType = 'array/binary';
    static OPEN = 1;
    static CONNECTING = 0;
    static CLOSING = 2;
    static CLOSED = 3;
    constructor(url: string) {
      this.url = url;
      const self = this as unknown as FakeWS;
      self.close = (_code?: number, _reason?: string) => {
        self.readyState = 3;
      };
      self.send = (data: string) => {
        sent.push(data);
      };
      instances.push(self);
    }
  };
  return { instances, sent, klass };
});

vi.stubGlobal('WebSocket', FakeWSModule.klass);
vi.stubGlobal(
  'fetch',
  vi.fn(() => Promise.resolve({ ok: true, status: 200 } as unknown as Response)),
);

import { WrongStackWebSocketClient } from '../../src/lib/ws-client';

function last(): FakeWS {
  const all = FakeWSModule.instances;
  const ws = all[all.length - 1];
  if (!ws) throw new Error('no FakeWS instance created');
  return ws;
}

function sentTypesOf(kind: string): number {
  return FakeWSModule.sent.filter((raw) => (JSON.parse(raw) as { type: string }).type === kind)
    .length;
}

beforeEach(() => {
  FakeWSModule.instances.length = 0;
  FakeWSModule.sent.length = 0;
});
afterEach(() => {
  vi.clearAllMocks();
  vi.useRealTimers();
});

async function connectedClient(): Promise<{ client: WrongStackWebSocketClient; ws: FakeWS }> {
  const client = new WrongStackWebSocketClient('ws://127.0.0.1:65535');
  const p = client.connect();
  await new Promise((r) => setTimeout(r, 20));
  const ws = last();
  ws.readyState = 1;
  ws.onopen!();
  await p;
  return { client, ws };
}

function announce(ws: FakeWS, sessionId: string, extra: Record<string, unknown> = {}): void {
  ws.onmessage!({
    data: JSON.stringify({
      type: 'session.start',
      payload: { sessionId, reset: true, model: 'gpt-5', provider: 'openai', ...extra },
    }),
  });
}

describe('the answer to a session.new', () => {
  it('survives a plain re-announcement of the same session id', async () => {
    const { client, ws } = await connectedClient();

    client.newSession();

    // The server announces the session it just created once as a plain
    // re-announcement — no `reset` — before the authoritative answer.
    ws.onmessage!({
      data: JSON.stringify({
        type: 'session.start',
        payload: { sessionId: 'sess_new', model: 'gpt-5', provider: 'openai' },
      }),
    });
    expect(client.consumeRequestedSwitch('sess_new')).toBe(false);

    // …and then the answer itself. It must still be recognised, or the new
    // session never takes the foreground.
    announce(ws, 'sess_new');
    expect(client.consumeRequestedSwitch('sess_new')).toBe(true);
  });

  it('is still recognised when the plain re-announcement arrives second', async () => {
    const { client, ws } = await connectedClient();

    client.newSession();

    announce(ws, 'sess_new');
    expect(client.consumeRequestedSwitch('sess_new')).toBe(true);

    // The re-announcement that follows must not spend the grant a second
    // time, and must not un-recognise the answer.
    ws.onmessage!({
      data: JSON.stringify({
        type: 'session.start',
        payload: { sessionId: 'sess_new', model: 'gpt-5', provider: 'openai' },
      }),
    });
    expect(client.consumeRequestedSwitch('sess_new')).toBe(false);
  });

  it('does not let a re-announcement of a KNOWN session steal the grant', async () => {
    const { client, ws } = await connectedClient();

    // A session this client already holds, announced with `reset`.
    announce(ws, 'sess_known');

    client.newSession();

    // Its re-announcement must not be mistaken for the answer.
    announce(ws, 'sess_known');
    expect(client.consumeRequestedSwitch('sess_known')).toBe(false);

    // The answer is still the fresh one.
    announce(ws, 'sess_fresh');
    expect(client.consumeRequestedSwitch('sess_fresh')).toBe(true);
  });

  it('refreshes existing seenSessionIds and armedResends entries at capacity without evicting live sessions (F89)', async () => {
    const {
      armNotReadyResendHelper,
      MAX_ARMED_RESENDS,
      MAX_SEEN_SESSION_IDS,
      NOT_READY_RETRY_COOLDOWN_MS,
      rememberSeenSession,
    } = await import('../../src/lib/ws-client-swap');

    const seen = new Set<string>();
    for (let i = 0; i < MAX_SEEN_SESSION_IDS; i++) {
      rememberSeenSession(seen, `sess-${i}`);
    }
    // Re-remembering an already-present session at capacity must not shrink the set or evict sess-0
    rememberSeenSession(seen, 'sess-32');
    expect(seen.size).toBe(MAX_SEEN_SESSION_IDS);
    expect(seen.has('sess-0')).toBe(true);
    // Refreshing sess-0 moves it to most-recent so adding sess-64 evicts sess-1 instead of sess-0
    rememberSeenSession(seen, 'sess-0');
    rememberSeenSession(seen, 'sess-64');
    expect(seen.has('sess-0')).toBe(true);
    expect(seen.has('sess-1')).toBe(false);

    const armed = new Map<string, { content: string; armedAt: number }>();
    const expiredAt = Date.now() - NOT_READY_RETRY_COOLDOWN_MS - 1000;
    for (let i = 0; i < MAX_ARMED_RESENDS; i++) {
      armed.set(`s-${i}`, { content: `msg-${i}`, armedAt: expiredAt });
    }
    expect(armNotReadyResendHelper(armed, 's-4', { content: 'retry-s4' })).toBe(true);
    expect(armed.size).toBe(MAX_ARMED_RESENDS);
    expect(armed.has('s-0')).toBe(true);
  });
});

describe('the New Session button', () => {
  it('is not locked out by a swap whose answer never arrived', async () => {
    const { client } = await connectedClient();

    client.newSession();
    expect(sentTypesOf('session.new')).toBe(1);

    // No answer ever arrives. The outstanding swap used to hold the duplicate
    // guard forever, so every later click was dropped silently and the button
    // looked permanently broken.
    vi.useFakeTimers();
    vi.setSystemTime(Date.now() + 2000);

    client.newSession();
    expect(sentTypesOf('session.new')).toBe(2);
  });

  it('still swallows a double-click', async () => {
    const { client } = await connectedClient();

    client.newSession();
    client.newSession();
    expect(sentTypesOf('session.new')).toBe(1);
  });
});
