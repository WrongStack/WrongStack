// @vitest-environment jsdom
// @vitest-environment-options { "url": "http://localhost:3466/chat" }

import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  __test__ as wsTestHooks,
  defaultWsUrl,
  exchangeAuthCookie,
  scrubPageToken,
} from '../src/lib/ws.js';

const TOKEN_STORAGE_KEY = 'wrongstack.simpleui.token.v1';

afterEach(() => {
  document.head.querySelector('meta[name="wrongstack-ws-url"]')?.remove();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/chat');
  vi.unstubAllGlobals(); // removes stubGlobal('fetch', ...) — restoreAllMocks alone does not
  wsTestHooks.resetCookieExchangeState();
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

  it('clears a stored token after a proven cookie path and consecutive 401s', async () => {
    // Mid-session revocation in a normal deployment: once the exchange has
    // succeeded, 3 consecutive 401s with no success interleaved clear the
    // dead stored token.
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'revoked-token');
    window.history.replaceState(null, '', '/chat');

    stubWsAuth(200);
    await exchangeAuthCookie(defaultWsUrl()); // proves the cookie path
    stubWsAuth(401);
    await exchangeAuthCookie(defaultWsUrl());
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('revoked-token'); // 2 < 3
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('preserves a stored token through repeated 401s when the cookie path never succeeded', async () => {
    // enableWsCookie:false deployments 401 a VALID token at the generic gate
    // (the /ws-auth route does not exist, so no success can ever prove it).
    // Repeated rejections must not destroy the credential.
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'valid-token');
    window.history.replaceState(null, '', '/chat');

    stubWsAuth(401);
    await exchangeAuthCookie(defaultWsUrl());
    await exchangeAuthCookie(defaultWsUrl());
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('valid-token');
  });

  it('clears a dead stored token on a fresh load when the cookie path was proven in a previous session', async () => {
    // The proven marker persists in localStorage across sessions, so a token
    // already dead at page load (e.g. a rotated secret between visits) can be
    // cleared on a fresh load — no in-session 200 required.
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'dead-token');
    window.localStorage.setItem('wrongstack.simpleui.cookie-proven.v1', '1');
    window.history.replaceState(null, '', '/chat');

    stubWsAuth(401);
    await exchangeAuthCookie(defaultWsUrl());
    await exchangeAuthCookie(defaultWsUrl());
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
    // The token clear invalidates the attestation: a stale marker must not
    // enable a second destruction after a deployment change (cookie-enabled
    // → enableWsCookie:false).
    expect(window.localStorage.getItem('wrongstack.simpleui.cookie-proven.v1')).toBeNull();
  });

  it('resets the 401 streak on a successful exchange', async () => {
    // A blip followed by a success must not accumulate toward revocation.
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'healthy-token');
    window.history.replaceState(null, '', '/chat');

    stubWsAuth(401);
    await exchangeAuthCookie(defaultWsUrl()); // streak 1
    stubWsAuth(200);
    await exchangeAuthCookie(defaultWsUrl()); // streak reset + path proven
    stubWsAuth(401);
    await exchangeAuthCookie(defaultWsUrl());
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('healthy-token'); // streak 2 < 3
    await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull(); // streak 3
  });

  it('preserves a stored token when /ws-auth fails before any success', async () => {
    // enableWsCookie:false / URL-token deployments 401 a VALID token at the
    // generic gate (the /ws-auth route does not exist). The stored credential
    // must survive — destroying it would lock out a valid user.
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'valid-token');
    window.history.replaceState(null, '', '/chat');

    stubWsAuth(401);
    const exchanged = await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('valid-token');
    expect(exchanged.searchParams.get('token')).toBe('valid-token'); // URL fallback intact
  });

  it('preserves a URL-only token on an unproven 401 (URL-token flow credential)', async () => {
    window.history.replaceState(null, '', '/chat?token=url-credential');

    stubWsAuth(401);
    const exchanged = await exchangeAuthCookie(defaultWsUrl());
    expect(exchanged.searchParams.get('token')).toBe('url-credential');
    expect(window.location.search).toBe('?token=url-credential');
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('does not treat 403 as a revocation or trigger the URL swap (origin/CSRF guard)', async () => {
    // A 403 means the token was never evaluated — neither the stored clear
    // nor the URL-token swap may fire, even with a different stored token.
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'good-token');
    window.history.replaceState(null, '', '/chat?token=url-token');

    stubWsAuth(403);
    const exchanged = await exchangeAuthCookie(defaultWsUrl());
    expect(window.localStorage.getItem(TOKEN_STORAGE_KEY)).toBe('good-token');
    expect(exchanged.searchParams.get('token')).toBe('url-token'); // no swap
    expect(window.location.search).toBe('?token=url-token'); // page untouched
  });

  it('switches to a valid stored token when a different URL token is rejected', async () => {
    // A stale access URL must not permanently shadow a valid stored
    // credential: the socket switches to the stored token and the dead URL
    // token leaves the address bar — without clearing anything.
    window.localStorage.setItem(TOKEN_STORAGE_KEY, 'valid-stored');
    window.history.replaceState(null, '', '/chat?token=stale-url-token');

    stubWsAuth(401);
    const exchanged = await exchangeAuthCookie(defaultWsUrl());
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
});
