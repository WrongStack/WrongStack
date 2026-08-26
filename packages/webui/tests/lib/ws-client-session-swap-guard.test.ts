import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Regression coverage for a double-click / key-repeat race: firing
// session.new (or session.resume) twice before the first round-trip's
// `session.start` broadcast lands used to send two requests with the
// SAME stale sessionId. The server processes them serially, the first
// swaps sessions, and the second then gets rejected with "Request
// targeted session X, but this WebUI runtime is currently on Y" even
// though nothing actually went wrong client-side.

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
    binaryType = 'arraybuffer';
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

describe('WrongStackWebSocketClient session-swap double-fire guard', () => {
  it('drops a second session.new fired before the first session.start reply lands', async () => {
    const { client, ws } = await connectedClient();

    client.newSession();
    client.newSession();

    expect(sentTypesOf('session.new')).toBe(1);

    ws.onmessage!({
      data: JSON.stringify({
        type: 'session.start',
        payload: { sessionId: 'sess_new', reset: true, model: 'gpt-5', provider: 'openai' },
      }),
    });

    client.newSession();
    expect(sentTypesOf('session.new')).toBe(2);
  });

  it('re-arms the guard after the server rejects a mismatched session.new', async () => {
    const { client, ws } = await connectedClient();

    client.newSession();
    expect(sentTypesOf('session.new')).toBe(1);

    ws.onmessage!({
      data: JSON.stringify({
        type: 'error',
        payload: {
          phase: 'session.new',
          message:
            'Request targeted session sess_old, but this WebUI runtime is currently on sess_current.',
        },
      }),
    });

    client.newSession();
    expect(sentTypesOf('session.new')).toBe(2);
  });

  it('re-arms the guard once the socket drops', async () => {
    const { client, ws } = await connectedClient();

    client.newSession();
    expect(sentTypesOf('session.new')).toBe(1);
    expect(client['pendingSwapTarget']).not.toBe(null);

    ws.readyState = 3;
    ws.onclose!({ code: 1006, reason: 'lost connection' });

    expect(client['pendingSwapTarget']).toBe(null);
    client['shouldReconnect'] = false;
    if (client['reconnectTimer']) clearTimeout(client['reconnectTimer']);
  });

  // The guard exists to swallow a double-click, NOT to swallow the user
  // changing their mind. Clicking tab A then tab B before A's answer lands
  // used to drop B's request entirely: the server stayed on A, this client had
  // already pointed its lane at B, and A's answer then dragged the surface
  // back to A — "I clicked tab 2 and got tab 1's transcript".
  it('supersedes a pending resume when a DIFFERENT session is requested', async () => {
    const { client } = await connectedClient();

    client.resumeSession('sess_a');
    client.resumeSession('sess_b');

    expect(sentTypesOf('session.resume')).toBe(2);
    expect(client['pendingSwapTarget']).toBe('sess_b');
  });

  it('still dedupes a repeated resume of the SAME session', async () => {
    const { client } = await connectedClient();

    client.resumeSession('sess_a');
    client.resumeSession('sess_a');

    expect(sentTypesOf('session.resume')).toBe(1);
  });

  // A `session.start` for a session nobody clicked must not spend the grant
  // issued for the one they did.
  it('grants focus only to the requested session', async () => {
    const { client, ws } = await connectedClient();

    client.resumeSession('sess_b');

    ws.onmessage!({
      data: JSON.stringify({
        type: 'session.start',
        payload: { sessionId: 'sess_a', reset: true, model: 'gpt-5', provider: 'openai' },
      }),
    });
    expect(client.consumeRequestedSwitch('sess_a')).toBe(false);
    expect(client['pendingSwapTarget']).toBe('sess_b');

    ws.onmessage!({
      data: JSON.stringify({
        type: 'session.start',
        payload: { sessionId: 'sess_b', reset: true, model: 'gpt-5', provider: 'openai' },
      }),
    });
    expect(client.consumeRequestedSwitch('sess_b')).toBe(true);
    // One-shot: a re-announce of the same session does not inherit the grant.
    expect(client.consumeRequestedSwitch('sess_b')).toBe(false);
    expect(client['pendingSwapTarget']).toBe(null);
  });

  it('matches a session.new answer by first-sight + reset, not by arrival order', async () => {
    const { client, ws } = await connectedClient();

    // A session this client already knows about announces itself first.
    ws.onmessage!({
      data: JSON.stringify({
        type: 'session.start',
        payload: { sessionId: 'sess_known', reset: true, model: 'gpt-5', provider: 'openai' },
      }),
    });

    client.newSession();

    ws.onmessage!({
      data: JSON.stringify({
        type: 'session.start',
        payload: { sessionId: 'sess_known', reset: true, model: 'gpt-5', provider: 'openai' },
      }),
    });
    expect(client.consumeRequestedSwitch('sess_known')).toBe(false);

    ws.onmessage!({
      data: JSON.stringify({
        type: 'session.start',
        payload: { sessionId: 'sess_fresh', reset: true, model: 'gpt-5', provider: 'openai' },
      }),
    });
    expect(client.consumeRequestedSwitch('sess_fresh')).toBe(true);
  });
});
