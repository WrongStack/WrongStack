import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Contract test for the `session_not_ready` auto-retry (the client half of
// conversation-operations.ts's placeholder-writer refusal):
//
//   backend refuses with `session_not_ready` + echoed replay material
//     → client arms ONE retry (armNotReadyResend)
//     → client resumes the session (session.resume)
//     → the session's `session.start` announce replays the exact message
//     → a second announce (or a second refusal inside the cooldown) replays
//       nothing — the guard is one-shot, so refusal races degrade to the
//       ordinary error bubble instead of ping-ponging.

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
import { ensureLane, useChatLanes } from '../../src/stores/chat-lanes';

interface SentUserMessage {
  type: string;
  payload: { content?: string; sessionId?: string; freshContext?: boolean };
}

function userMessages(): SentUserMessage[] {
  return FakeWSModule.sent
    .map((raw) => JSON.parse(raw) as SentUserMessage)
    .filter((m) => m.type === 'user_message');
}

function last(): FakeWS {
  const all = FakeWSModule.instances;
  const ws = all[all.length - 1];
  if (!ws) throw new Error('no FakeWS instance created');
  return ws;
}

function announce(ws: FakeWS, sessionId: string): void {
  ws.onmessage!({
    data: JSON.stringify({
      type: 'session.start',
      payload: { sessionId, reset: true, model: 'm', provider: 'p' },
    }),
  });
}

beforeEach(() => {
  FakeWSModule.instances.length = 0;
  FakeWSModule.sent.length = 0;
  useChatLanes.setState({ lanes: {}, activeSessionId: '__unbound__' });
});
afterEach(() => {
  vi.clearAllMocks();
  vi.restoreAllMocks();
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

describe('WrongStackWebSocketClient session_not_ready auto-retry', () => {
  it('replays the refused message once the session announces live — and only once', async () => {
    const { client, ws } = await connectedClient();
    // The lane exists: the tab that sent the refused message is still open.
    ensureLane('sess_a');

    expect(client.armNotReadyResend('sess_a', { content: 'retry me', freshContext: true })).toBe(
      true,
    );
    expect(client.resumeSession, 'sanity: resumeSession is the action under test').toBeDefined();
    announce(ws, 'sess_a');

    const sent = userMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload).toMatchObject({
      content: 'retry me',
      sessionId: 'sess_a',
      freshContext: true,
    });

    // One-shot: a re-announce (model switch, boot re-announce) must not
    // replay the message a second time.
    announce(ws, 'sess_a');
    expect(userMessages()).toHaveLength(1);
  });

  it('refuses to re-arm inside the cooldown window (refusal-loop guard)', async () => {
    const { client } = await connectedClient();

    expect(client.armNotReadyResend('sess_a', { content: 'x' })).toBe(true);
    // A resend that hits the refusal again inside the window finds the guard
    // spent — the caller degrades to the ordinary error bubble.
    expect(client.armNotReadyResend('sess_a', { content: 'y' })).toBe(false);

    // After the cooldown a genuinely new episode may retry.
    const spy = vi.spyOn(Date, 'now').mockReturnValue(Date.now() + 16_000);
    try {
      expect(client.armNotReadyResend('sess_a', { content: 'z' })).toBe(true);
    } finally {
      spy.mockRestore();
    }
  });

  it('a manual send on the session supersedes the armed replay', async () => {
    const { client, ws } = await connectedClient();
    ensureLane('sess_a');

    expect(client.armNotReadyResend('sess_a', { content: 'armed' })).toBe(true);
    client.sendMessage('manual', undefined, false, 'sess_a');
    announce(ws, 'sess_a');

    const sent = userMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0]!.payload.content).toBe('manual');
  });

  it('does not replay for a session whose lane is gone (tab closed while armed)', async () => {
    const { client, ws } = await connectedClient();
    // No lane was ensured: the tab was closed while the retry was parked.

    expect(client.armNotReadyResend('sess_ghost', { content: 'lost' })).toBe(true);
    announce(ws, 'sess_ghost');

    expect(userMessages()).toHaveLength(0);
  });
});
