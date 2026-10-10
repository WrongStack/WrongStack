import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserSessionManager } from '../src/browser/manager.js';

/**
 * Concurrent open() calls share one Chromium launch and one browser. An
 * opener that is aborted (or fails) must not close that browser while another
 * opener holds it but has not registered its session yet.
 *
 * Completion order is gated: the launch is a deferred released only after the
 * abort has been issued, so the stale opener always finishes last.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

function makeFakeBrowser(options: { newContextFailsOnCall?: number } = {}) {
  const state = { closed: false, closeCalls: 0, newContextCalls: 0 };
  const page = { on: () => undefined, url: () => 'https://example.com/', title: async () => '' };
  const context = {
    newPage: async () => page,
    close: async () => undefined,
    route: async () => undefined,
    tracing: { start: async () => undefined, stop: async () => undefined },
    browser: () => browser,
  };
  const browser = {
    isConnected: () => !state.closed,
    on: () => undefined,
    close: async () => {
      state.closed = true;
      state.closeCalls++;
    },
    // A real Playwright browser refuses new contexts once it is closed.
    newContext: async () => {
      state.newContextCalls++;
      if (state.closed) throw new Error('browser has been closed');
      if (options.newContextFailsOnCall === state.newContextCalls) {
        throw new Error('injected newContext failure');
      }
      return context;
    },
  };
  return { browser, state };
}

function makeManager(gate: { promise: Promise<unknown> }): BrowserSessionManager {
  return new BrowserSessionManager(
    { artifactRoot: path.join(os.tmpdir(), 'wstack-browser-shared-launch-artifacts') },
    () => gate.promise as never,
  );
}

const open = (
  manager: BrowserSessionManager,
  owner: string,
  signal = new AbortController().signal,
) => manager.open(owner, { trace: false }, signal);

/** Let every opener reach the shared launch before the test acts. */
async function parkOpeners(): Promise<void> {
  for (let i = 0; i < 5; i++) await Promise.resolve();
}

describe('BrowserSessionManager shared browser launch', () => {
  it('keeps the browser for a concurrent opener when another opener is aborted', async () => {
    const { browser, state } = makeFakeBrowser();
    const gate = deferred<unknown>();
    const manager = makeManager(gate);
    try {
      const aborted = new AbortController();
      const first = open(manager, 'a', aborted.signal).then(
        () => 'opened',
        () => 'rejected',
      );
      const second = open(manager, 'b');
      await parkOpeners();
      aborted.abort(new Error('a cancelled'));
      gate.resolve(browser);

      await expect(first).resolves.toBe('rejected');
      await expect(second).resolves.toMatchObject({ ownerId: 'b' });
      expect(state.closed).toBe(false);
    } finally {
      await manager.dispose();
    }
  });

  it('reclaims the browser once the last opener has gone', async () => {
    const { browser, state } = makeFakeBrowser();
    const gate = deferred<unknown>();
    const manager = makeManager(gate);
    try {
      const first = new AbortController();
      const second = new AbortController();
      const results = Promise.allSettled([
        open(manager, 'a', first.signal),
        open(manager, 'b', second.signal),
      ]);
      await parkOpeners();
      first.abort(new Error('a cancelled'));
      second.abort(new Error('b cancelled'));
      gate.resolve(browser);

      await results;
      expect(state.closeCalls).toBe(1);
    } finally {
      await manager.dispose();
    }
  });

  it('reclaims the browser when the surviving opener fails after the other aborted', async () => {
    const { browser, state } = makeFakeBrowser({ newContextFailsOnCall: 1 });
    const gate = deferred<unknown>();
    const manager = makeManager(gate);
    try {
      const aborted = new AbortController();
      const results = Promise.allSettled([open(manager, 'a', aborted.signal), open(manager, 'b')]);
      await parkOpeners();
      aborted.abort(new Error('a cancelled'));
      gate.resolve(browser);

      const [a, b] = await results;
      expect(a?.status).toBe('rejected');
      expect(b?.status).toBe('rejected');
      expect(state.closeCalls).toBe(1);
    } finally {
      await manager.dispose();
    }
  });

  it('does not close a browser that already serves a live session', async () => {
    const { browser, state } = makeFakeBrowser();
    const gate = deferred<unknown>();
    gate.resolve(browser);
    const manager = makeManager(gate);
    try {
      await open(manager, 'a');
      const cancelled = new AbortController();
      cancelled.abort(new Error('b cancelled'));
      await expect(open(manager, 'b', cancelled.signal)).rejects.toThrow('b cancelled');
      expect(state.closed).toBe(false);
    } finally {
      await manager.dispose();
    }
  });
});
