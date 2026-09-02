import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { BrowserSessionManager } from '../src/browser/manager.js';

/**
 * Failure-path cleanup for BrowserSessionManager.open().
 *
 * Regression: the window between `browser.newContext()` and the
 * session-facing try/catch was unguarded — if `context.newPage()` threw,
 * the freshly created BrowserContext was never closed (leaked renderer
 * until dispose), and if `context.route()` registration threw, the session
 * stayed registered in the manager (stale state) with its context open.
 * Every other failure path in `open()` closes the context and deletes the
 * session; these two now do too.
 *
 * The manager's constructor accepts a `launcher` as its documented injection
 * seam, so these tests drive the real production `open()` path with a
 * deterministic fake browser — no Playwright binary required.
 */

function makeFakes(options: { newPageThrows?: boolean; routeThrows?: boolean } = {}) {
  const page = {
    on: vi.fn(),
    url: () => 'https://example.com/',
    title: async () => '',
  };
  const context = {
    newPage: vi.fn(async () => {
      if (options.newPageThrows) throw new Error('page creation failed');
      return page;
    }),
    close: vi.fn(async () => undefined),
    route: vi.fn(async () => {
      if (options.routeThrows) throw new Error('route registration failed');
    }),
    tracing: { start: vi.fn(async () => undefined), stop: vi.fn(async () => undefined) },
    browser: () => browser,
  };
  const browser = {
    isConnected: () => true,
    on: vi.fn(),
    close: vi.fn(async () => undefined),
    newContext: vi.fn(async () => context),
  };
  return { browser, context };
}

function makeManager(fakes: ReturnType<typeof makeFakes>): BrowserSessionManager {
  return new BrowserSessionManager(
    {
      artifactRoot: path.join(os.tmpdir(), 'wstack-browser-open-cleanup-artifacts'),
      allowPrivateHosts: false,
    },
    async () => fakes.browser,
  );
}

describe('BrowserSessionManager.open() failure-path cleanup', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('closes the created BrowserContext when context.newPage() throws', async () => {
    const fakes = makeFakes({ newPageThrows: true });
    const manager = makeManager(fakes);
    try {
      await expect(manager.open('owner', {}, new AbortController().signal)).rejects.toThrow(
        'page creation failed',
      );

      // A failed open must not leak the created context (a full renderer).
      expect(fakes.context.close).toHaveBeenCalled();
      // Nothing was registered, so the idle browser is reclaimed too.
      expect(fakes.browser.close).toHaveBeenCalled();
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  });

  it('removes the session and closes its context when route registration fails', async () => {
    const fakes = makeFakes({ routeThrows: true });
    const manager = makeManager(fakes);
    try {
      await expect(manager.open('owner', {}, new AbortController().signal)).rejects.toThrow(
        'route registration failed',
      );

      expect(fakes.context.close).toHaveBeenCalled();
      // No stale session may remain registered after a failed open.
      await expect(manager.list('owner')).resolves.toEqual([]);
    } finally {
      await manager.dispose().catch(() => undefined);
    }
  });
});
