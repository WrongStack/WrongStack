import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { forceKill } = vi.hoisted(() => ({ forceKill: vi.fn() }));
vi.mock('../src/client-process.js', () => ({ forceKillTree: forceKill }));

import type { MCPClientInternals } from '../src/client-internals.js';
import { closeClient } from '../src/client-lifecycle.js';

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  vi.useRealTimers();
  forceKill.mockReset();
});

function fixture(exitOnEof = false) {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(),
    stdin: { destroyed: false, writable: true, end: vi.fn() },
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
  child.stdin.end.mockImplementation(() => {
    if (exitOnEof) {
      child.exitCode = 0;
      child.emit('exit', 0);
    }
  });
  const self = {
    child,
    toolCatalogVersion: 0,
    opts: { name: 'owned-close-fixture' },
    failPending: vi.fn(),
    serverRequests: { dispose: vi.fn() },
    state: 'connected',
  };
  return { self, child, close: () => closeClient(self as unknown as MCPClientInternals) };
}

describe('Windows MCP close ordering', () => {
  it('keeps the owner until a slow tree kill actually ends the child', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { self, child, close } = fixture();
    let settled = false;
    const closing = close().then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(8000);
    expect(forceKill).toHaveBeenCalledExactlyOnceWith(child);
    expect(settled).toBe(false);
    expect(self.child).toBe(child);
    child.exitCode = 1;
    child.emit('exit', 1);
    await closing;
    expect(self.child).toBeUndefined();
    expect(self.state).toBe('disconnected');
  });

  it('does not delay a server that exits on EOF', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    const { self, close } = fixture(true);
    await close();
    expect(forceKill).not.toHaveBeenCalled();
    expect(self.child).toBeUndefined();
  });
});
