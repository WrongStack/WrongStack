/**
 * Per-socket backpressure on HQ's outbound frames.
 *
 * A `readyState === OPEN` check says the socket is connected, not that anyone
 * is reading it. `ws` buffers whatever it cannot flush, so a dashboard tab
 * that stalled made HQ retain every subsequent broadcast for it — and these
 * frames are full fleet snapshots. The guard trades a stalled viewer for a
 * bounded process, which is the right trade: the viewer reconnects and
 * re-reads the current snapshot.
 */
import { describe, expect, it, vi } from 'vitest';
import { WebSocket } from 'ws';
import { HQ_BROWSER_MAX_BUFFERED_BYTES, sendGuarded } from '../src/hq-server/snapshot.js';

interface FakeSocket {
  readyState: number;
  bufferedAmount: number;
  send: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function fakeSocket(overrides: Partial<FakeSocket> = {}): FakeSocket {
  return {
    readyState: WebSocket.OPEN,
    bufferedAmount: 0,
    send: vi.fn(),
    terminate: vi.fn(),
    close: vi.fn(),
    ...overrides,
  };
}

describe('sendGuarded', () => {
  it('sends on a socket that is keeping up', () => {
    const ws = fakeSocket();

    expect(sendGuarded(ws as never as WebSocket, 'frame')).toBe(true);
    expect(ws.send).toHaveBeenCalledWith('frame');
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('drops a socket whose queue is already past the cap', () => {
    const ws = fakeSocket({ bufferedAmount: HQ_BROWSER_MAX_BUFFERED_BYTES });

    expect(sendGuarded(ws as never as WebSocket, 'one more frame')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalledTimes(1);
  });

  it('counts the pending frame toward the cap, not just what is already queued', () => {
    // Just under the cap, but this frame pushes it over — the check has to
    // account for the frame it is about to add or the bound is off by one
    // whole broadcast.
    const ws = fakeSocket({ bufferedAmount: HQ_BROWSER_MAX_BUFFERED_BYTES - 4 });

    expect(sendGuarded(ws as never as WebSocket, 'aaaaaaaa')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).toHaveBeenCalled();
  });

  it('falls back to close() when terminate() throws', () => {
    const ws = fakeSocket({
      bufferedAmount: HQ_BROWSER_MAX_BUFFERED_BYTES + 1,
      terminate: vi.fn(() => {
        throw new Error('already gone');
      }),
    });

    expect(sendGuarded(ws as never as WebSocket, 'frame')).toBe(false);
    expect(ws.close).toHaveBeenCalledWith(1013, 'client cannot keep up');
  });

  it('skips a socket that is not open', () => {
    const ws = fakeSocket({ readyState: WebSocket.CLOSING });

    expect(sendGuarded(ws as never as WebSocket, 'frame')).toBe(false);
    expect(ws.send).not.toHaveBeenCalled();
    expect(ws.terminate).not.toHaveBeenCalled();
  });

  it('reports failure instead of throwing when send() throws', () => {
    const ws = fakeSocket({
      send: vi.fn(() => {
        throw new Error('socket died mid-write');
      }),
    });

    // A broadcast loop must not abort partway through because one peer died.
    expect(() => sendGuarded(ws as never as WebSocket, 'frame')).not.toThrow();
    expect(sendGuarded(ws as never as WebSocket, 'frame')).toBe(false);
  });

  it('tolerates a non-finite bufferedAmount', () => {
    const ws = fakeSocket({ bufferedAmount: Number.NaN });

    expect(sendGuarded(ws as never as WebSocket, 'frame')).toBe(true);
    expect(ws.send).toHaveBeenCalled();
  });
});
