/**
 * Edge-case tests for src/lib/ws-client-utils.ts — URL parsing failures,
 * SSR guards, and fallback branches.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('getTokenFromPageUrl — catch branch (line 132)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when URLSearchParams constructor throws', async () => {
    // Make URLSearchParams throw to exercise the catch block
    const orig = globalThis.URLSearchParams;
    vi.stubGlobal(
      'URLSearchParams',
      vi.fn().mockImplementation(() => {
        throw new Error('parse error');
      }),
    );

    const { getTokenFromPageUrl } = await import('../../src/lib/ws-client-utils');
    expect(getTokenFromPageUrl()).toBeNull();

    vi.stubGlobal('URLSearchParams', orig);
  });

  it('returns null when window is undefined (early return)', async () => {
    vi.stubGlobal('window', undefined);
    const { getTokenFromPageUrl } = await import('../../src/lib/ws-client-utils');
    expect(getTokenFromPageUrl()).toBeNull();
  });
});

describe('defaultWsUrl — SSR guard (line 196)', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns ws://127.0.0.1:port when window is undefined', async () => {
    vi.stubGlobal('window', undefined);
    const { defaultWsUrl } = await import('../../src/lib/ws-client-utils');
    const url = defaultWsUrl();
    expect(url).toMatch(/^ws:\/\/127\.0\.0\.1:\d+/);
  });
});

describe('stripTokenFromUrl — invalid URL fallback', () => {
  it('returns raw URL when parsing fails', async () => {
    const { stripTokenFromUrl } = await import('../../src/lib/ws-client-utils');
    const raw = 'not-a-valid-url';
    expect(stripTokenFromUrl(raw)).toBe(raw);
  });
});

describe('resolvePublicWsUrl — null cases', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns null when document is undefined', async () => {
    vi.stubGlobal('document', undefined);
    const { resolvePublicWsUrl } = await import('../../src/lib/ws-client-utils');
    expect(resolvePublicWsUrl()).toBeNull();
  });
});

describe('httpOriginForAuth — SSR guard', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('returns http://127.0.0.1:3456 when window is undefined', async () => {
    vi.stubGlobal('window', undefined);
    const { httpOriginForAuth } = await import('../../src/lib/ws-client-utils');
    expect(httpOriginForAuth()).toBe('http://127.0.0.1:3456');
  });
});

describe('stripTokenFromAddressBar — no-op when window is undefined', () => {
  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('does not throw when window is undefined', async () => {
    vi.stubGlobal('window', undefined);
    const { stripTokenFromAddressBar } = await import('../../src/lib/ws-client-utils');
    expect(() => stripTokenFromAddressBar()).not.toThrow();
  });
});
