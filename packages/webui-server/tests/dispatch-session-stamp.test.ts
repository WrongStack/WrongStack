import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import {
  runWithDispatchSession,
  send,
  sendResult,
  stampDispatchSession,
} from '../src/server/ws-utils.js';

/**
 * B-05 (docs/audit/webui-full-review-2026-09-03.md).
 *
 * `key.operation_result` is the server's general-purpose result channel — 90
 * call sites through six `sendResult` helpers — and it carried no session at
 * all. One socket serves up to four tabs, so a background tab's failure toast
 * landed on whichever tab was in front while the failing tab showed nothing.
 *
 * Rather than thread a session id through 90 call sites, the asking tab is
 * bound once at the dispatch boundary and read at the single send site. These
 * tests pin that contract: what gets stamped, what deliberately does not, and
 * that the binding survives the `await`s a real handler makes.
 */

function mockWs(): WebSocket & { send: ReturnType<typeof vi.fn> } {
  return { readyState: 1, send: vi.fn(), bufferedAmount: 0 } as never as WebSocket & {
    send: ReturnType<typeof vi.fn>;
  };
}

function sent(ws: { send: ReturnType<typeof vi.fn> }): Array<Record<string, never>> {
  return ws.send.mock.calls.map(([raw]) => JSON.parse(String(raw)));
}

describe('stampDispatchSession', () => {
  it('stamps the dispatching session onto a key.operation_result', () => {
    const stamped = runWithDispatchSession('sess-a', () =>
      stampDispatchSession({
        type: 'key.operation_result',
        payload: { success: true, message: 'ok' },
      }),
    );
    expect(stamped).toEqual({
      type: 'key.operation_result',
      payload: { success: true, message: 'ok', sessionId: 'sess-a' },
    });
  });

  // The whole point of the narrow rule: everything else either names its own
  // session already or is genuinely project-wide, and blanket-stamping would
  // hide a global answer from three of the four tabs.
  it('leaves every other message type untouched', () => {
    const frame = { type: 'providers.saved', payload: { count: 2 } };
    expect(runWithDispatchSession('sess-a', () => stampDispatchSession(frame))).toBe(frame);
  });

  it('never overwrites a sessionId the handler set itself', () => {
    const frame = {
      type: 'key.operation_result',
      payload: { success: false, message: 'nope', sessionId: 'sess-explicit' },
    };
    const out = runWithDispatchSession('sess-a', () => stampDispatchSession(frame));
    expect(out.payload.sessionId).toBe('sess-explicit');
  });

  // A watcher, a timer or a broadcast has no asking tab. An unstamped frame is
  // the correct output there — the client falls back to the tab in front.
  it('is a no-op outside a dispatch', () => {
    const frame = { type: 'key.operation_result', payload: { success: true, message: 'ok' } };
    expect(stampDispatchSession(frame)).toBe(frame);
  });

  it('is a no-op when the dispatched message named no session', () => {
    const frame = { type: 'key.operation_result', payload: { success: true, message: 'ok' } };
    expect(runWithDispatchSession(undefined, () => stampDispatchSession(frame))).toBe(frame);
  });

  it('tolerates a missing or non-object payload without throwing', () => {
    const noPayload = { type: 'key.operation_result' };
    expect(runWithDispatchSession('sess-a', () => stampDispatchSession(noPayload))).toEqual({
      type: 'key.operation_result',
      payload: { sessionId: 'sess-a' },
    });
    const badPayload = { type: 'key.operation_result', payload: 'oops' };
    expect(runWithDispatchSession('sess-a', () => stampDispatchSession(badPayload))).toBe(
      badPayload,
    );
  });
});

describe('sendResult through the bound dispatch', () => {
  it('reaches the wire already addressed to the asking tab', () => {
    const ws = mockWs();
    runWithDispatchSession('sess-b', () => sendResult(ws, false, 'Commit failed'));
    expect(sent(ws)).toEqual([
      {
        type: 'key.operation_result',
        payload: { success: false, message: 'Commit failed', sessionId: 'sess-b' },
      },
    ]);
  });

  /**
   * Handlers are async — they read config, shell out to git, await a provider.
   * If the binding did not survive those awaits the stamp would be present on
   * fast paths and missing on slow ones, which is worse than never stamping.
   */
  it('survives the awaits a real handler makes', async () => {
    const ws = mockWs();
    await runWithDispatchSession('sess-c', async () => {
      await Promise.resolve();
      await new Promise((resolve) => setTimeout(resolve, 1));
      sendResult(ws, true, 'Saved');
    });
    expect(sent(ws)[0]?.payload).toMatchObject({ sessionId: 'sess-c' });
  });

  it('keeps two concurrent tabs apart', async () => {
    const ws = mockWs();
    await Promise.all([
      runWithDispatchSession('tab-1', async () => {
        await new Promise((resolve) => setTimeout(resolve, 5));
        sendResult(ws, false, 'one failed');
      }),
      runWithDispatchSession('tab-2', async () => {
        sendResult(ws, true, 'two ok');
      }),
    ]);
    const byMessage = new Map(
      sent(ws).map((frame) => [
        (frame as unknown as { payload: { message: string } }).payload.message,
        (frame as unknown as { payload: { sessionId?: string } }).payload.sessionId,
      ]),
    );
    expect(byMessage.get('one failed')).toBe('tab-1');
    expect(byMessage.get('two ok')).toBe('tab-2');
  });

  it('does not stamp an ordinary send of another type', () => {
    const ws = mockWs();
    runWithDispatchSession('sess-d', () => send(ws, { type: 'prefs.updated', payload: {} }));
    expect(sent(ws)[0]).toEqual({ type: 'prefs.updated', payload: {} });
  });
});
