import { afterEach, describe, expect, it, vi } from 'vitest';
import { bindSocketLifecycle } from '../../src/lib/ws-client-connection';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function createSocket() {
  return { close: vi.fn() } as unknown as WebSocket;
}

function createCallbacks(isCurrentGeneration: () => boolean) {
  return {
    isCurrentGeneration,
    onOpen: vi.fn(),
    onMessage: vi.fn(),
    onError: vi.fn(),
    onClose: vi.fn(),
    onTimeout: vi.fn(),
  };
}

describe('socket lifecycle generation', () => {
  it('still times out a socket whose generation is current', () => {
    vi.useFakeTimers();
    const socket = createSocket();
    const callbacks = createCallbacks(() => true);
    bindSocketLifecycle(socket, callbacks, 30_000);

    vi.advanceTimersByTime(30_000);

    expect(callbacks.onTimeout).toHaveBeenCalledTimes(1);
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it('ignores a pending connection timeout after the socket generation is replaced', () => {
    vi.useFakeTimers();
    let isCurrent = true;
    const socket = createSocket();
    const callbacks = createCallbacks(() => isCurrent);
    const lifecycle = bindSocketLifecycle(socket, callbacks, 30_000);

    // The timer is pending; a newer socket takes ownership before it fires.
    isCurrent = false;
    vi.advanceTimersByTime(30_000);

    expect(callbacks.onTimeout).not.toHaveBeenCalled();
    expect(socket.close).not.toHaveBeenCalled();
    expect(callbacks.onClose).not.toHaveBeenCalled();
    lifecycle.cancelTimeout();
  });
});
