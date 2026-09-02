/**
 * Unit tests for the WrongProxy / WrongTrace base-URL rewriter.
 *
 * The rewriter is pure logic — no I/O, no timers, no side effects. These
 * tests pin the runtime contract:
 *
 *   rewriteBaseUrl(originalBaseUrl, proxyUrl) | → | description |
 *   ----------------------------------------+---+------------------------------|
 *   undefined                              | undefined | missing input → undefined |
 *   "https://api.openai.com/v1"            | undefined | no proxy → original |
 *   "https://api.openai.com/v1"            | ""        | no proxy → original |
 *   "https://api.openai.com/v1"            | "http://x" | rewrite happy path |
 *   "http://x/proxy/api.openai.com/v1"     | "http://x" | double-wrap guard |
 *   "not a url"                            | "http://x" | malformed → original |
 *   "https://api.openai.com/v1"            | "no-scheme" | malformed proxy → original |
 *   "https://api.openai.com/v1?q=1#h"      | "http://x" | query + hash preserved |
 *
 * `isProxyEligible` pins the openai-codex exclusion (the OAuth-only
 * provider whose token audience forbids generic proxying).
 *
 * `shouldRewriteFor` centralizes the "enabled + active + url + eligible"
 * rule so future call sites can't accidentally skip a check.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyProxyConfig,
  createProxyInstantApply,
  deactivateProxyOnConnectionFailure,
  getProxyConfig,
  isProxyEligible,
  PROXY_EXCLUDED_PROVIDERS,
  rewriteBaseUrl,
  shouldRewriteFor,
  subscribeToProxyConfig,
  __resetProxyConfigForTests,
} from '../../src/wiring/proxy-rewrite.js';

describe('rewriteBaseUrl', () => {
  it('returns undefined when the original URL is missing', () => {
    expect(rewriteBaseUrl(undefined, 'http://localhost:3444')).toBeUndefined();
    expect(rewriteBaseUrl('', 'http://localhost:3444')).toBeUndefined();
  });

  it('returns the original when the proxy URL is missing', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1', undefined)).toBe(
      'https://api.openai.com/v1',
    );
    expect(rewriteBaseUrl('https://api.openai.com/v1', '')).toBe('https://api.openai.com/v1');
  });

  it('rewrites a standard base URL through the proxy', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1', 'http://localhost:3444')).toBe(
      'http://localhost:3444/proxy/api.openai.com/v1',
    );
  });

  it('strips trailing slashes from the proxy URL', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1', 'http://localhost:3444/')).toBe(
      'http://localhost:3444/proxy/api.openai.com/v1',
    );
    expect(rewriteBaseUrl('https://api.openai.com/v1', 'http://localhost:3444///')).toBe(
      'http://localhost:3444/proxy/api.openai.com/v1',
    );
  });

  it('preserves query string and hash on the rewritten URL', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1?q=1#hash', 'http://x')).toBe(
      'http://x/proxy/api.openai.com/v1?q=1#hash',
    );
  });

  it('does NOT double-wrap when the original already starts with the proxy path', () => {
    expect(
      rewriteBaseUrl('http://localhost:3444/proxy/api.openai.com/v1', 'http://localhost:3444'),
    ).toBe('http://localhost:3444/proxy/api.openai.com/v1');
  });

  it('does NOT rewrite a base URL that already targets localhost with a port', () => {
    expect(rewriteBaseUrl('http://localhost:11434/v1', 'http://localhost:3444')).toBe(
      'http://localhost:11434/v1',
    );
  });

  it('does NOT rewrite a base URL that already targets 127.0.0.1 with a port', () => {
    expect(rewriteBaseUrl('http://127.0.0.1:11434/v1', 'http://localhost:3444')).toBe(
      'http://127.0.0.1:11434/v1',
    );
  });

  it('does NOT rewrite a base URL that already targets IPv6 loopback with a port', () => {
    expect(rewriteBaseUrl('http://[::1]:11434/v1', 'http://localhost:3444')).toBe(
      'http://[::1]:11434/v1',
    );
  });

  it('rewrites a localhost base URL WITHOUT a port (no local endpoint to short-circuit)', () => {
    expect(rewriteBaseUrl('http://localhost/v1', 'http://localhost:3444')).toBe(
      'http://localhost:3444/proxy/localhost/v1',
    );
  });

  it('returns the original when the original is malformed', () => {
    expect(rewriteBaseUrl('not a url', 'http://localhost:3444')).toBe('not a url');
  });

  it('does NOT throw on a scheme-but-unparseable original — returns it unchanged (regression: unguarded new URL in composeRewrittenUrl)', () => {
    // These contain '://' so isProxyEligibleForRewrite's early checks pass
    // (and its own new URL() catch deliberately falls through to
    // "eligible"), but Node's WHATWG parser rejects them — previously the
    // unguarded new URL() in composeRewrittenUrl threw, violating the
    // module contract that a misconfigured URL must never hard-fail
    // provider construction.
    const malformed = ['https://[::1', 'http://exa mple.com/v1'];
    for (const url of malformed) {
      // Sanity: the input really is unparseable (test invalid if Node
      // ever starts accepting these).
      expect(() => new URL(url)).toThrow();
      expect(rewriteBaseUrl(url, 'http://localhost:3444')).toBe(url);
    }
  });

  it('returns the original when the proxy URL is malformed', () => {
    expect(rewriteBaseUrl('https://api.openai.com/v1', 'no-scheme')).toBe(
      'https://api.openai.com/v1',
    );
  });
});

describe('isProxyEligible', () => {
  it('excludes openai-codex (OAuth-bound token audience)', () => {
    expect(isProxyEligible('openai-codex')).toBe(false);
    expect(PROXY_EXCLUDED_PROVIDERS.has('openai-codex')).toBe(true);
  });

  it('eligible providers pass through', () => {
    expect(isProxyEligible('openai')).toBe(true);
    expect(isProxyEligible('anthropic')).toBe(true);
    expect(isProxyEligible('google')).toBe(true);
    expect(isProxyEligible('openai-compatible')).toBe(true);
    expect(isProxyEligible('my-custom-saved-config-alias')).toBe(true);
  });

  it('rejects empty / missing provider ids', () => {
    expect(isProxyEligible('')).toBe(false);
  });
});

describe('shouldRewriteFor', () => {
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  it('returns false when the toggle is off', () => {
    applyProxyConfig({ enabled: false, url: 'http://localhost:3444', active: true });
    expect(shouldRewriteFor('openai')).toBe(false);
  });

  it('returns false when the proxy URL is missing', () => {
    applyProxyConfig({ enabled: true, url: '', active: true });
    expect(shouldRewriteFor('openai')).toBe(false);
  });

  it('returns false when the daemon is not active', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: false });
    expect(shouldRewriteFor('openai')).toBe(false);
  });

  it('returns false for openai-codex even when everything else is on', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    expect(shouldRewriteFor('openai-codex')).toBe(false);
  });

  it('returns true only when all four guards pass', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    expect(shouldRewriteFor('openai')).toBe(true);
    expect(shouldRewriteFor('anthropic')).toBe(true);
  });
});

describe('applyProxyConfig / getProxyConfig', () => {
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  it('applies a partial patch without dropping siblings', () => {
    applyProxyConfig({ enabled: true, url: 'http://a', active: true });
    expect(getProxyConfig()).toEqual({ enabled: true, url: 'http://a', active: true });
    applyProxyConfig({ url: 'http://b' });
    expect(getProxyConfig()).toEqual({ enabled: true, url: 'http://b', active: true });
    applyProxyConfig({ active: false });
    expect(getProxyConfig()).toEqual({ enabled: true, url: 'http://b', active: false });
  });
});

describe('subscribeToProxyConfig', () => {
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  it('notifies listeners with next + previous on a material change', () => {
    applyProxyConfig({ enabled: true, url: 'http://a', active: true });
    const listener = vi.fn();
    const unsubscribe = subscribeToProxyConfig(listener);
    applyProxyConfig({ active: false });
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith(
      { enabled: true, url: 'http://a', active: false },
      { enabled: true, url: 'http://a', active: true },
    );
    unsubscribe();
  });

  it('does NOT notify on value-identical writes (periodic probe ticks)', () => {
    applyProxyConfig({ enabled: true, url: 'http://a', active: true });
    const listener = vi.fn();
    const unsubscribe = subscribeToProxyConfig(listener);
    // The healthy probe re-writes the same triple every interval.
    applyProxyConfig({ active: true });
    applyProxyConfig({ enabled: true, url: 'http://a', active: true });
    applyProxyConfig({});
    expect(listener).not.toHaveBeenCalled();
    unsubscribe();
  });

  it('stops notifying after unsubscribe', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeToProxyConfig(listener);
    applyProxyConfig({ enabled: true });
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    applyProxyConfig({ enabled: false });
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('isolates a throwing listener — remaining subscribers still notified', () => {
    const good = vi.fn();
    const unsubscribeBad = subscribeToProxyConfig(() => {
      throw new Error('subscriber bug');
    });
    const unsubscribeGood = subscribeToProxyConfig(good);
    expect(() => applyProxyConfig({ enabled: true })).not.toThrow();
    expect(good).toHaveBeenCalledTimes(1);
    unsubscribeBad();
    unsubscribeGood();
  });

  it('__resetProxyConfigForTests drops listeners', () => {
    const listener = vi.fn();
    subscribeToProxyConfig(listener);
    __resetProxyConfigForTests();
    applyProxyConfig({ enabled: true });
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('createProxyInstantApply', () => {
  const RAW_URL = 'https://api.example.com/v1';
  const PROXY_URL = 'http://localhost:3444';

  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  function proxyOn(url = PROXY_URL): void {
    applyProxyConfig({ enabled: true, url, active: true });
  }

  function makeHandle(overrides: Partial<Parameters<typeof createProxyInstantApply>[0]> = {}) {
    const rebuildProvider = vi.fn(async () => {});
    const logger = { info: vi.fn(), warn: vi.fn() };
    let activeProviderId = 'openai';
    const handle = createProxyInstantApply({
      getActiveProviderId: () => activeProviderId,
      getRawBaseUrl: (providerId) => (providerId === 'openai' ? RAW_URL : undefined),
      rebuildProvider,
      logger,
      ...overrides,
    });
    return {
      handle,
      rebuildProvider,
      logger,
      setActiveProviderId: (id: string) => {
        activeProviderId = id;
      },
    };
  }

  /** Drain the serialized rebuild chain. The extra ~20ms round lets a
   * rebuild whose body awaits a short timer finish before assertions. */
  async function flush(): Promise<void> {
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 25));
  }

  it('rebuilds once when the probe deactivates a proxy-routed provider', async () => {
    proxyOn();
    const h = makeHandle();
    applyProxyConfig({ active: false });
    await flush();
    expect(h.rebuildProvider).toHaveBeenCalledTimes(1);
    expect(h.rebuildProvider).toHaveBeenCalledWith('openai');
    expect(h.logger.info).toHaveBeenCalledTimes(1);
    h.handle.dispose();
  });

  it('rebuilds when the proxy re-activates (raw → rewritten)', async () => {
    proxyOn();
    const h = makeHandle();
    applyProxyConfig({ active: false });
    await flush();
    applyProxyConfig({ active: true });
    await flush();
    expect(h.rebuildProvider).toHaveBeenCalledTimes(2);
    h.handle.dispose();
  });

  it('does NOT rebuild on value-identical probe ticks', async () => {
    proxyOn();
    const h = makeHandle();
    applyProxyConfig({ active: true });
    applyProxyConfig({ enabled: true, url: PROXY_URL, active: true });
    applyProxyConfig({});
    await flush();
    expect(h.rebuildProvider).not.toHaveBeenCalled();
    h.handle.dispose();
  });

  it('rebuilds when the proxy URL changes while enabled (different rewrite target)', async () => {
    proxyOn();
    const h = makeHandle();
    applyProxyConfig({ url: 'http://localhost:9999' });
    await flush();
    expect(h.rebuildProvider).toHaveBeenCalledTimes(1);
    h.handle.dispose();
  });

  it('does NOT rebuild a provider without a baseUrl (no routing decision to make)', async () => {
    proxyOn();
    const h = makeHandle();
    h.setActiveProviderId('no-base-url-provider');
    applyProxyConfig({ active: false });
    await flush();
    expect(h.rebuildProvider).not.toHaveBeenCalled();
    h.handle.dispose();
  });

  it('does NOT rebuild excluded providers (openai-codex)', async () => {
    proxyOn();
    const h = makeHandle();
    h.setActiveProviderId('openai-codex');
    applyProxyConfig({ active: false });
    await flush();
    expect(h.rebuildProvider).not.toHaveBeenCalled();
    h.handle.dispose();
  });

  it('re-baselines (no rebuild) when the active provider moves via another path', async () => {
    proxyOn();
    const h = makeHandle();
    // /model switch: active provider changes AND the config change fires.
    h.setActiveProviderId('anthropic');
    applyProxyConfig({ active: false });
    await flush();
    // The new provider's raw URL is undefined — and even a verdict flip
    // for the OLD provider must not trigger a stale rebuild.
    expect(h.rebuildProvider).not.toHaveBeenCalled();
    h.handle.dispose();
  });

  it('rebuilds a provider that switched in under proxy-ON when the next change deactivates', async () => {
    // Regression for the re-baseline ordering gap: the switch-installed
    // provider was built under the PREVIOUS config (rewritten). Seeding
    // the baseline from the NEW config swallowed this rebuild — the
    // provider stayed pinned to the dead proxy. The honest baseline is
    // effectiveBaseUrlFor(previous, …).
    proxyOn();
    const h = makeHandle({
      getRawBaseUrl: (providerId) =>
        providerId === 'openai' || providerId === 'openai-2' ? RAW_URL : undefined,
    });
    // A /model switch to a second eligible provider happens BETWEEN
    // notifications (provider built rewritten while the proxy was on)…
    h.setActiveProviderId('openai-2');
    // …and the very next change deactivates the proxy.
    applyProxyConfig({ active: false });
    await flush();
    expect(h.rebuildProvider).toHaveBeenCalledTimes(1);
    expect(h.rebuildProvider).toHaveBeenCalledWith('openai-2');
    h.handle.dispose();
  });

  it('logs a warning instead of throwing when the rebuild fails', async () => {
    proxyOn();
    const h = makeHandle({
      rebuildProvider: vi.fn(async () => {
        throw new Error('build boom');
      }),
    });
    applyProxyConfig({ active: false });
    await flush();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn).toHaveBeenCalledWith(expect.stringContaining('build boom'));
    h.handle.dispose();
  });

  it('serializes rapid successive changes — rebuilds queue, never interleave', async () => {
    proxyOn();
    const order: string[] = [];
    const rebuildProvider = vi.fn(async () => {
      order.push('start');
      await new Promise((resolve) => setTimeout(resolve, 5));
      order.push('end');
    });
    const h = makeHandle({ rebuildProvider });
    applyProxyConfig({ active: false });
    applyProxyConfig({ active: true });
    await flush();
    expect(rebuildProvider).toHaveBeenCalledTimes(2);
    // Strict alternation proves no interleaving: start,end,start,end.
    expect(order).toEqual(['start', 'end', 'start', 'end']);
    h.handle.dispose();
  });

  it('stops rebuilding after dispose', async () => {
    proxyOn();
    const h = makeHandle();
    h.handle.dispose();
    applyProxyConfig({ active: false });
    await flush();
    expect(h.rebuildProvider).not.toHaveBeenCalled();
  });

  it('baseline is seeded from current state — a toggle-off at boot proxy-on rebuilds', async () => {
    proxyOn();
    const h = makeHandle();
    applyProxyConfig({ enabled: false });
    await flush();
    expect(h.rebuildProvider).toHaveBeenCalledTimes(1);
    h.handle.dispose();
  });

  it('boot proxy-off + toggle-on rebuilds (raw baseline → rewritten verdict)', async () => {
    const h = makeHandle();
    applyProxyConfig({ enabled: true, url: PROXY_URL, active: true });
    await flush();
    expect(h.rebuildProvider).toHaveBeenCalledTimes(1);
    h.handle.dispose();
  });
});

describe('deactivateProxyOnConnectionFailure', () => {
  beforeEach(() => __resetProxyConfigForTests());
  afterEach(() => __resetProxyConfigForTests());

  it('returns false when proxy is not enabled or not active', () => {
    applyProxyConfig({ enabled: false, url: 'http://localhost:3444', active: false });
    expect(
      deactivateProxyOnConnectionFailure(new Error('connect ECONNREFUSED 127.0.0.1:3444')),
    ).toBe(false);
    expect(getProxyConfig().active).toBe(false);
  });

  it('immediately deactivates proxy on ECONNREFUSED or proxy connection errors', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const err = new Error(
      'request to http://localhost:3444/proxy/api.openai.com/v1 failed, reason: connect ECONNREFUSED 127.0.0.1:3444',
    );
    expect(deactivateProxyOnConnectionFailure(err)).toBe(true);
    expect(getProxyConfig().active).toBe(false);
  });

  it('immediately deactivates proxy on 502/503/504 proxy errors', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const err = new Error('502 Bad Gateway from proxy');
    expect(deactivateProxyOnConnectionFailure(err)).toBe(true);
    expect(getProxyConfig().active).toBe(false);
  });

  it('immediately deactivates proxy on fetch failed', () => {
    applyProxyConfig({ enabled: true, url: 'http://localhost:3444', active: true });
    const err = new TypeError('fetch failed');
    expect(deactivateProxyOnConnectionFailure(err)).toBe(true);
    expect(getProxyConfig().active).toBe(false);
  });
});
