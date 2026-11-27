import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { BrowserSessionManager } from '../src/manager.js';

function makeFakeBrowser(onClose: () => void) {
  return {
    isConnected: () => true,
    on: () => {},
    close: async () => {
      onClose();
    },
    newContext: async () => ({
      close: async () => {},
      route: async () => {},
      tracing: { start: async () => {}, stop: async () => {} },
      newPage: async () => ({
        on: () => {},
        url: () => 'about:blank',
        title: async () => '',
        goto: async () => {},
      }),
    }),
  } as never;
}

describe('BrowserSessionManager dispose() during launch (F2708)', () => {
  const artifactRoot = path.join(os.tmpdir(), `ws-f2708-vitest-${process.pid}`);

  it('closes a late-launched browser and rejects open() when dispose() fires mid-launch', async () => {
    let launched = 0;
    let closed = 0;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    let releaseLaunch!: () => void;
    const launchGate = new Promise<void>((resolve) => {
      releaseLaunch = resolve;
    });

    const mgr = new BrowserSessionManager({ artifactRoot }, async () => {
      launched += 1;
      markEntered();
      await launchGate;
      return makeFakeBrowser(() => {
        closed += 1;
      });
    });

    const openPromise = mgr.open('owner-1', {}, new AbortController().signal).catch((err) => err);
    await entered;
    const disposePromise = mgr.dispose();
    releaseLaunch();
    const [openErr] = await Promise.all([openPromise, disposePromise]);

    expect(openErr).toBeInstanceOf(Error);
    expect(launched).toBe(1);
    expect(closed).toBeGreaterThanOrEqual(1);
    expect(mgr.isIdle()).toBe(true);
  });

  it('rejects open() after dispose() without launching a browser', async () => {
    let launched = 0;
    const mgr = new BrowserSessionManager({ artifactRoot }, async () => {
      launched += 1;
      return makeFakeBrowser(() => {});
    });
    await mgr.dispose();

    await expect(mgr.open('owner-1', {}, new AbortController().signal)).rejects.toThrow(/disposed/);
    expect(launched).toBe(0);
  });
});
