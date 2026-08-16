// @vitest-environment jsdom

import { describe, expect, it, vi } from 'vitest';
import { socketRequest } from '../src/lib/socket-request.js';
import type { ServerFrame } from '../src/lib/socket-request.js';

function mockSocket() {
  const listeners = new Set<(frame: ServerFrame) => void>();
  return {
    listeners,
    send: vi.fn(),
    onMessage: vi.fn((fn: (frame: ServerFrame) => void) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    }),
    emit(frame: ServerFrame): void {
      for (const listener of listeners) listener(frame);
    },
  };
}

describe('socketRequest', () => {
  it('resolves with the payload of the matching reply', async () => {
    const socket = mockSocket();
    const handle = socketRequest({
      socket: socket as never,
      sendType: 'files.read',
      payload: { filePath: 'a.ts' },
      expectType: 'files.read',
    });
    expect(socket.send).toHaveBeenCalledWith('files.read', { filePath: 'a.ts' });
    socket.emit({ type: 'other.frame' });
    socket.emit({ type: 'files.read', payload: { filePath: 'a.ts', content: 'x' } });
    await expect(handle.promise).resolves.toEqual({ filePath: 'a.ts', content: 'x' });
  });

  it('ignores replies rejected by the accept predicate', async () => {
    const socket = mockSocket();
    const handle = socketRequest({
      socket: socket as never,
      sendType: 'files.read',
      payload: { filePath: 'a.ts' },
      expectType: 'files.read',
      accept: (frame) => (frame.payload as { filePath?: string })?.filePath === 'a.ts',
    });
    socket.emit({ type: 'files.read', payload: { filePath: 'other.ts' } });
    socket.emit({ type: 'files.read', payload: { filePath: 'a.ts' } });
    await expect(handle.promise).resolves.toEqual({ filePath: 'a.ts' });
  });

  it('resolves with null on timeout', async () => {
    const socket = mockSocket();
    const handle = socketRequest({
      socket: socket as never,
      sendType: 'brain.status',
      payload: {},
      expectType: 'brain.status',
      timeoutMs: 5,
    });
    await expect(handle.promise).resolves.toBeNull();
  });

  it('cancel() resolves null immediately and stops the timer', async () => {
    const socket = mockSocket();
    const handle = socketRequest({
      socket: socket as never,
      sendType: 'files.tree',
      payload: {},
      expectType: 'files.tree',
      timeoutMs: 60_000,
    });
    handle.cancel();
    await expect(handle.promise).resolves.toBeNull();
    // A late reply must not resurrect the request.
    socket.emit({ type: 'files.tree', payload: { tree: [] } });
    await expect(handle.promise).resolves.toBeNull();
    expect(socket.onMessage).toHaveBeenCalledTimes(1);
  });

  it('cancel after a reply is a no-op', async () => {
    const socket = mockSocket();
    const handle = socketRequest({
      socket: socket as never,
      sendType: 'files.tree',
      payload: {},
      expectType: 'files.tree',
    });
    socket.emit({ type: 'files.tree', payload: { ok: true } });
    handle.cancel();
    await expect(handle.promise).resolves.toEqual({ ok: true });
  });
});
