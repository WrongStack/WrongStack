// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost:3466/chat" }

import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaultWsUrl, exchangeAuthCookie, scrubPageToken } from '../src/lib/ws.js';

const TOKEN_STORAGE_KEY = 'wrongstack.simpleui.token.v1';

afterEach(() => {
  document.head.querySelector('meta[name="wrongstack-ws-url"]')?.remove();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/chat');
  vi.unstubAllGlobals(); // removes stubGlobal('fetch', ...) — restoreAllMocks alone does not
});

function stubWsAuth(status: number): void {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('ok', { status })));
}

describe('SimpleUI WebSocket URL', () => {
  it('uses the exact HTTP page host and port for the same-origin socket', () => {
    expect(defaultWsUrl().toString()).toBe('ws://localhost:3466/');
  });

  it('uses an explicitly configured public WebSocket URL', () => {
    const meta = document.createElement('meta');
    meta.name = 'wrongstack-ws-url';
    meta.content = 'wss://public.example.test/socket';
    document.head.append(meta);

    expect(defaultWsUrl().toString()).toBe('wss://public.example.test/socket');
  });
});

describe('SimpleUI token persistence (F5 survival)', () => {
  it('persists the page token only after a successful /ws-auth exchange', async () => {
    window.history.replaceState(null, '', '/chat?token=f5-token');
    const wsUrl = defaultWsUrl();
    expect(wsUrl.searchParams.get('token')).toBe('f5-token');
    // Not persisted on sight — a token is stored only once the server
    // accepted it, so a stale link cannot poison localStorage.
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();

    stubWsAuth(200);
    const exchanged = await exchangeAuthCookie(wsUrl);
    expect(exchanged.searchParams.has('token')).toBe(false); // same-host cookie path
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('f5-token');
    expect(window.location.search).toBe(''); // page URL scrubbed

    // Simulate F5: no URL token, but the stored credential re-attaches so the
    // socket can re-authenticate after a server restart.
    window.history.replaceState(null, '', '/chat');
    expect(defaultWsUrl().searchParams.get('token')).toBe('f5-token');
  });

  it('keeps the token in the page URL when localStorage is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      window.history.replaceState(null, '', '/chat?token=url-only');
      expect(defaultWsUrl().searchParams.get('token')).toBe('url-only');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('does not scrub the page token until the exchange persisted it', async () => {
    window.history.replaceState(null, '', '/chat?token=scrub-me');
    // Nothing persisted yet — the URL is the only copy and must NOT be
    // stripped, or a reload would lose the credential entirely.
    scrubPageToken();
    expect(window.location.search).toBe('?token=scrub-me');

    stubWsAuth(200);
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.location.search).toBe('');
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('scrub-me');
  });

  it('clears a stored token the server explicitly rejects', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'stale-token');
    window.history.replaceState(null, '', '/chat');

    stubWsAuth(401);
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('strips a rejected token from URL and storage so reconnects stop replaying it', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'dead-token');
    window.history.replaceState(null, '', '/chat?token=dead-token');

    stubWsAuth(401);
    const exchanged = await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(exchanged.searchParams.has('token')).toBe(false);
    expect(window.location.search).toBe(''); // dead token scrubbed from address bar
  });

  it('falls back to a valid stored token when the URL token is rejected', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'valid-stored');
    window.history.replaceState(null, '', '/chat?token=stale-url');

    stubWsAuth(401);
    const exchanged = await exchangeAuthCookie(defaultWsUrl());
    // The rejected URL token is dropped and the stored credential takes over
    // instead of looping on the stale one forever.
    expect(exchanged.searchParams.get('token')).toBe('valid-stored');
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('valid-stored');
    expect(window.location.search).toBe(''); // stale URL token scrubbed
  });

  it('keeps a stored token on transient /ws-auth failure (blip, not revocation)', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'good-token');
    window.history.replaceState(null, '', '/chat');

    stubWsAuth(503);
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('good-token');
  });

  it('never persists or scrubs on a cross-host (public WS) success', async () => {
    // A public-WS tunnel host is a different server — its credential must not
    // be stored into (or removed from) page-origin localStorage.
    window.history.replaceState(null, '', '/chat');
    const wsUrl = new URL('wss://public.example.test/socket');
    wsUrl.searchParams.set('token', 'tunnel-token');

    stubWsAuth(200);
    const exchanged = await exchangeAuthCookie(wsUrl);
    expect(exchanged.searchParams.get('token')).toBe('tunnel-token'); // kept for the tunnel host
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.location.search).toBe(''); // page untouched
  });

  it('never swaps in page-origin storage on a cross-host 401', async () => {
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'page-token');
    window.history.replaceState(null, '', '/chat');
    const wsUrl = new URL('wss://public.example.test/socket');
    wsUrl.searchParams.set('token', 'tunnel-token');

    stubWsAuth(401);
    const exchanged = await exchangeAuthCookie(wsUrl);
    // Cross-host: the tunnel token stays in the URL and the page-origin
    // stored token is untouched — no cross-server fallback swap.
    expect(exchanged.searchParams.get('token')).toBe('tunnel-token');
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('page-token');
  });

  it('strips a rejected URL-only token when nothing is stored (no replay loop)', async () => {
    window.history.replaceState(null, '', '/chat?token=dead-url-token');

    stubWsAuth(401);
    const exchanged = await exchangeAuthCookie(defaultWsUrl());
    expect(exchanged.searchParams.has('token')).toBe(false);
    expect(window.location.search).toBe('');
  });
});
