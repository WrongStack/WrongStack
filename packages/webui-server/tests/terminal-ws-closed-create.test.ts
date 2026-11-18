import type { TrustBoundary } from '@wrongstack/core/security';
import { createCompatibilityTrustBoundary } from '@wrongstack/core/security';
import { describe, expect, it } from 'vitest';
import { TerminalWebSocketHandler } from '../src/server/terminal-ws-handler.js';

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

function makeWs(readyState = 1) {
  const listeners = new Map<string, Set<() => void>>();
  return {
    readyState,
    listenerCount: () => [...listeners.values()].reduce((n, s) => n + s.size, 0),
    send: () => {},
    on(ev: string, cb: () => void) {
      const set = listeners.get(ev) ?? new Set<() => void>();
      set.add(cb);
      listeners.set(ev, set);
    },
    off(ev: string, cb: () => void) {
      listeners.get(ev)?.delete(cb);
    },
    fire(ev: string) {
      for (const cb of [...(listeners.get(ev) ?? [])]) cb();
    },
  };
}

const logger = {
  level: 'error' as const,
  trace: () => {},
  debug: () => {},
  info: () => {},
  warn: () => {},
  error: () => {},
  child: () => logger,
};
const allowBoundary = createCompatibilityTrustBoundary({ denyCriticalRiskRemoteClient: false });

describe('TerminalWebSocketHandler closed-socket and disposed-handler PTY fence', () => {
  it('never spawns an orphan PTY after client disconnect or handler.dispose()', async () => {
    let spawns = 0;
    const handler = new TerminalWebSocketHandler(
      () => process.cwd(),
      logger as never,
      () => ({
        spawn: () => {
          spawns += 1;
          return {
            pid: undefined,
            onData: () => {},
            onExit: () => {},
            write: () => {},
            resize: () => {},
            kill: () => {},
          };
        },
      }),
      undefined,
      allowBoundary,
    );

    const ws1 = makeWs();
    handler.addClient(ws1 as never);
    ws1.readyState = 3;
    ws1.fire('close');
    expect(ws1.listenerCount()).toBe(0);
    await handler.handleMessage(ws1 as never, { type: 'terminal.create', payload: { id: 't1' } });

    const ws2 = makeWs();
    handler.addClient(ws2 as never);
    handler.dispose();
    expect(ws2.listenerCount()).toBe(0);
    await handler.handleMessage(ws2 as never, { type: 'terminal.create', payload: { id: 't2' } });

    expect(spawns).toBe(0);
  });

  it('cancels in-flight terminal.create when handler.dispose() runs during authorization', async () => {
    const authEntered = deferred<void>();
    const authGate = deferred<{ kind: 'allow'; reason: string }>();
    const boundary: TrustBoundary = {
      evaluate: async () => {
        authEntered.resolve();
        return authGate.promise;
      },
    };
    let spawns = 0;
    const handler = new TerminalWebSocketHandler(
      () => process.cwd(),
      logger as never,
      () => ({
        spawn: () => {
          spawns += 1;
          return {
            pid: undefined,
            onData: () => {},
            onExit: () => {},
            write: () => {},
            resize: () => {},
            kill: () => {},
          };
        },
      }),
      undefined,
      boundary,
    );

    const ws = makeWs();
    handler.addClient(ws as never);
    const pending = handler.handleMessage(ws as never, {
      type: 'terminal.create',
      payload: { id: 't-gated' },
    });
    await authEntered.promise;
    handler.dispose();
    authGate.resolve({ kind: 'allow', reason: 'ok' });
    await pending;

    expect(spawns).toBe(0);
  });
});
