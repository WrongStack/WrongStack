import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserSessionManager } from '../src/manager.js';

/**
 * F1257: `browser_wait({ selector, timeoutMs: 0 })` is allowed by the tool
 * schema (`minimum: 0`), and the clamp passed the 0 straight to Playwright —
 * whose `locator.waitFor` reads `timeout: 0` as "no timeout". A wait for an
 * absent selector then never settled until the host aborted the call, and
 * that abort closes the whole session. Every wait must reach Playwright with
 * a bounded timeout in [1, operationTimeoutMs].
 *
 * Drives the real `open()`/`wait()` path through the manager's `launcher`
 * seam with a deterministic fake browser — no Playwright binary required.
 */
function makeManager(seen: { waitFor: number[]; sleeps: number[] }) {
  const page = {
    on: () => undefined,
    url: () => 'about:blank',
    title: async () => '',
    locator: () => ({
      waitFor: async (opts: { timeout?: number }) => {
        seen.waitFor.push(opts.timeout as number);
      },
    }),
    waitForTimeout: async (ms: number) => {
      seen.sleeps.push(ms);
    },
  };
  const context = {
    newPage: async () => page,
    close: async () => undefined,
    route: async () => undefined,
    tracing: { start: async () => undefined, stop: async () => undefined },
    browser: () => browser,
  };
  const browser = {
    isConnected: () => true,
    on: () => undefined,
    close: async () => undefined,
    newContext: async () => context,
  };
  return new BrowserSessionManager(
    {
      artifactRoot: path.join(os.tmpdir(), 'wstack-browser-wait-timeout-artifacts'),
      operationTimeoutMs: 30_000,
    },
    async () => browser as never,
  );
}

describe('BrowserSessionManager.wait timeout bound', () => {
  it('never hands Playwright timeout 0 ("no timeout") and keeps the upper cap', async () => {
    const seen = { waitFor: [] as number[], sleeps: [] as number[] };
    const manager = makeManager(seen);
    try {
      const signal = new AbortController().signal;
      const { id } = await manager.open('leader', { trace: false }, signal);
      await manager.wait(id, 'leader', { selector: '#absent', timeoutMs: 0 }, signal);
      await manager.wait(id, 'leader', { selector: '#absent', timeoutMs: 250 }, signal);
      await manager.wait(id, 'leader', { selector: '#absent', timeoutMs: 99_999 }, signal);
      await manager.wait(id, 'leader', { timeoutMs: 0 }, signal);
      expect(seen.waitFor).toEqual([1, 250, 30_000]);
      expect(seen.sleeps).toEqual([1]);
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  });
});
