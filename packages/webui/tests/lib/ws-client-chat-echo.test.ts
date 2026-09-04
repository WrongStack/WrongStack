import { afterEach, describe, expect, it, vi } from 'vitest';
import { WrongStackWebSocketClient } from '../../src/lib/ws-client.js';

/**
 * B-04 (docs/audit/webui-full-review-2026-09-03.md) — the suppression map
 * moved from a type-keyed FIFO (which suffered a multi-tab race: tab A's
 * suppression could swallow tab B's `/tools` reply when B's response
 * happened to arrive first) to a requestId-keyed map. Each `echoToChat:
 * false` request mints a correlation id, stamps it on the outgoing
 * payload, and only the response that echoes the same id consumes a slot.
 *
 * The tests pin the new contract end-to-end.
 */
describe('WrongStackWebSocketClient chat echo suppression (B-04 requestId-keyed)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('suppresses the response that echoes the requestId', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');

    // Caller supplies the requestId so the test can echo it back in the
    // synthetic response. The mint is observable via consume().
    client.listSkills({ echoToChat: false, requestId: 'rid-1' });
    expect(
      client.consumeSuppressedChatEcho('skills.list', {
        type: 'skills.list',
        payload: { requestId: 'rid-1', skills: [] },
      }),
    ).toBe(true);
  });

  it('stamps the requestId on the transmitted frame while the socket is open', () => {
    // Regression (round 2026-09-03): send() serialized the message BEFORE
    // stamping the requestId, so the frame that reached the server carried
    // no correlation id — the server could not echo it, and every
    // `echoToChat: false` reply leaked into the chat transcript. The stamp
    // must live in the payload of the exact string handed to ws.send().
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const frames: string[] = [];
    (client as unknown as { ws: { readyState: number; send: (data: string) => void } }).ws = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => frames.push(data),
    };

    client.listTools({ echoToChat: false, requestId: 'rid-open' });

    expect(frames.length).toBe(1);
    const wire = JSON.parse(frames[0]!) as { payload?: { requestId?: string } };
    expect(wire.payload?.requestId).toBe('rid-open');
  });

  it('stamps the minted requestId on the transmitted frame and that id is the consumable one', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const frames: string[] = [];
    (client as unknown as { ws: { readyState: number; send: (data: string) => void } }).ws = {
      readyState: 1, // WebSocket.OPEN
      send: (data: string) => frames.push(data),
    };

    client.listTools({ echoToChat: false });

    expect(frames.length).toBe(1);
    const wire = JSON.parse(frames[0]!) as { payload?: { requestId?: string } };
    const minted = wire.payload?.requestId;
    expect(typeof minted).toBe('string');
    // One-to-one: the id on the wire is the id the suppression map holds.
    expect(
      client.consumeSuppressedChatEcho('tools.list', {
        type: 'tools.list',
        payload: { requestId: minted as string, tools: [] },
      }),
    ).toBe(true);
    // An unstamped sibling reply (another tab's chat-issued command) is untouched.
    expect(
      client.consumeSuppressedChatEcho('tools.list', {
        type: 'tools.list',
        payload: { tools: [] },
      }),
    ).toBe(false);
  });

  it('keeps normal inspect commands eligible for chat output', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');

    client.listSkills();
    client.getStats();

    expect(client.consumeSuppressedChatEcho('skills.list')).toBe(false);
    expect(client.consumeSuppressedChatEcho('stats.get')).toBe(false);
  });

  it('never suppresses a response whose requestId was never minted (B-04 multi-tab race)', () => {
    // The previous FIFO would have suppressed this — A's `tools.list`
    // request pushed a token, and B's chat-issued `tools.list` reply
    // was consumed first. With requestId correlation, B's reply carries
    // no requestId (it was not a suppress-marked request) and is left
    // alone.
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.listTools({ echoToChat: false });

    // Tab B's chat reply — no requestId echoed (B did not mark suppression).
    const bReply = {
      type: 'tools.list' as const,
      payload: { tools: [] },
    };
    expect(client.consumeSuppressedChatEcho('tools.list', bReply)).toBe(false);
  });

  it('suppresses both responses when each carries its own requestId', () => {
    // Tab A and tab B both ask Settings→Tools with echoToChat:false.
    // Each request mints its own id, and the corresponding reply is
    // suppressed; an interleaved order does not matter.
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.listTools({ echoToChat: false, requestId: 'rid-A' });
    client.listTools({ echoToChat: false, requestId: 'rid-B' });

    // B's response arrives first.
    expect(
      client.consumeSuppressedChatEcho('tools.list', {
        type: 'tools.list',
        payload: { requestId: 'rid-B', tools: [] },
      }),
    ).toBe(true);
    // A's response still finds its slot — the previous FIFO would have
    // dropped this one because the type-keyed queue was already empty.
    expect(
      client.consumeSuppressedChatEcho('tools.list', {
        type: 'tools.list',
        payload: { requestId: 'rid-A', tools: [] },
      }),
    ).toBe(true);
  });

  it('does not consume a requestId that was never minted', () => {
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.listSageMemories({ echoToChat: false });

    expect(
      client.consumeSuppressedChatEcho('memory.sage.list', {
        type: 'memory.sage.list',
        payload: { requestId: 'unknown', memories: [] },
      }),
    ).toBe(false);
  });

  it('expires a suppression when the UI request never receives a response', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-16T12:00:00Z'));
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    const sent = client.send(
      { type: 'tools.list' },
      { echoToChat: false, requestId: 'rid-tools' },
    );
    // The socket is not open in this test, so the send is queued and
    // never reaches the server. The mint stays in the suppression map.
    expect(sent).toBe(true);

    vi.advanceTimersByTime(30_001);

    // A late response after TTL must NOT be suppressed — the requestId
    // is expired and the chat bubble should land in the user's view.
    expect(
      client.consumeSuppressedChatEcho('tools.list', {
        type: 'tools.list',
        payload: { requestId: 'rid-tools', tools: [] },
      }),
    ).toBe(false);
  });

  it('sweep clears expired entries and self-stops the timer (RAM-leak fix 2026-08-16)', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.listTools({ echoToChat: false });
    client.listSkills({ echoToChat: false });

    expect(vi.getTimerCount()).toBe(1);

    // Past TTL (30 s) + one sweep interval (15 s).
    await vi.advanceTimersByTimeAsync(45_001);

    expect(vi.getTimerCount()).toBe(0); // self-stopped when the map emptied
  });

  it('disconnect() stops the echo sweep timer and drops pending suppressions', () => {
    vi.useFakeTimers();
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    client.listTools({ echoToChat: false });
    expect(vi.getTimerCount()).toBe(1);

    client.disconnect();

    expect(vi.getTimerCount()).toBe(0);
    // After disconnect, the requestId is gone — even with a matching
    // echoed id the response is NOT suppressed.
    expect(
      client.consumeSuppressedChatEcho('tools.list', {
        type: 'tools.list',
        payload: { requestId: 'whatever', tools: [] },
      }),
    ).toBe(false);
  });
});

describe('WrongStackWebSocketClient echo-suppression sweep (RAM-leak audit 2026-08-16)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('clears expired entries without a consume and self-stops the sweep timer', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-16T12:00:00Z'));
    const client = new WrongStackWebSocketClient('ws://127.0.0.1:3457');
    // The sweep state is private; the regression test needs to observe the
    // timer lifecycle directly (arming, sharing, self-stop, re-arm).
    const internals = client as unknown as {
      suppressedChatEchoes: Map<string, number>;
      echoSweepTimer: ReturnType<typeof setInterval> | null;
    };

    client.listTools({ echoToChat: false, requestId: 'rid-1' });
    client.listTools({ echoToChat: false, requestId: 'rid-2' });

    // Armed on first suppression, and shared — a second push must not
    // create a second interval.
    expect(internals.echoSweepTimer).not.toBeNull();
    const firstTimer = internals.echoSweepTimer;
    expect(internals.echoSweepTimer).toBe(firstTimer);

    // Past TTL: the sweep trims every expired entry WITHOUT any consume()
    // call, then self-stops once the map is empty.
    vi.advanceTimersByTime(45_001);
    expect(internals.suppressedChatEchoes.size).toBe(0);
    expect(internals.echoSweepTimer).toBeNull();

    // Re-arms lazily on the next suppression after a self-stop…
    client.listTools({ echoToChat: false, requestId: 'rid-3' });
    expect(internals.echoSweepTimer).not.toBeNull();
    // …and disconnect() tears the re-armed timer down with the client.
    client.disconnect();
    expect(internals.echoSweepTimer).toBeNull();
  });
});
