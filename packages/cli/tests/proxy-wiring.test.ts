import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const probeMocks = vi.hoisted(() => ({
  startProxyProbe: vi.fn(),
}));

vi.mock('../src/wiring/proxy-probe.js', () => ({
  startProxyProbe: probeMocks.startProxyProbe,
  type: {},
}));

const rewriteMocks = vi.hoisted(() => ({
  applyProxyConfig: vi.fn(),
  getProxyConfig: vi.fn(() => ({ enabled: false, url: '', active: false })),
}));

vi.mock('@wrongstack/core/wiring/proxy-rewrite', () => ({
  applyProxyConfig: rewriteMocks.applyProxyConfig,
  getProxyConfig: rewriteMocks.getProxyConfig,
}));

import {
  applyWrongProxyPrefs,
  awaitFirstWrongProxyProbe,
  shutdownWrongProxy,
} from '../src/wiring/proxy-wiring.js';

describe('awaitFirstWrongProxyProbe', () => {
  beforeEach(() => {
    probeMocks.startProxyProbe.mockReset();
    rewriteMocks.applyProxyConfig.mockReset();
    rewriteMocks.getProxyConfig.mockClear();
  });

  afterEach(() => {
    shutdownWrongProxy();
  });

  it('resolves immediately without poking when no runner was booted', async () => {
    const poke = vi.fn(async () => true);
    probeMocks.startProxyProbe.mockReturnValue({ poke, stop: vi.fn() });

    await expect(awaitFirstWrongProxyProbe()).resolves.toBeUndefined();
    expect(poke).not.toHaveBeenCalled();
    expect(probeMocks.startProxyProbe).not.toHaveBeenCalled();
  });

  it('awaits one probe pass after the toggle boots the runner', async () => {
    const poke = vi.fn(async () => true);
    probeMocks.startProxyProbe.mockReturnValue({ poke, stop: vi.fn() });

    // Toggle on → applyWrongProxyPrefs boots the probe runner lazily.
    applyWrongProxyPrefs({ wrongProxyEnabled: true, wrongProxyUrl: 'http://localhost:3444' });
    expect(probeMocks.startProxyProbe).toHaveBeenCalledTimes(1);

    await expect(awaitFirstWrongProxyProbe()).resolves.toBeUndefined();
    expect(poke).toHaveBeenCalledTimes(1);
  });

  it('resolves when the probe pass reports inactive (failed health check)', async () => {
    const poke = vi.fn(async () => false);
    probeMocks.startProxyProbe.mockReturnValue({ poke, stop: vi.fn() });

    applyWrongProxyPrefs({ wrongProxyEnabled: true, wrongProxyUrl: 'http://localhost:9' });
    await expect(awaitFirstWrongProxyProbe()).resolves.toBeUndefined();
    expect(poke).toHaveBeenCalledTimes(1);
  });
});
