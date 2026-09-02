/**
 * Tests for the HQ browser auth layer (`src/data/auth/*`) — the single
 * source of truth for the dashboard token. Regression net for the "every
 * /api/* fetch 401s in token mode" bug: bare `fetch` calls carried no token
 * even though the server has been token-mode-by-default since first-run
 * auth landed.
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { authorizedFetch } from '../../src/data/api.js';
import {
  authHeaders,
  clearHqToken,
  exchangeBootstrapIfNeeded,
  HQ_TOKEN_STORAGE_KEY,
  loginWithHqToken,
  normalizeHqTokenInput,
  resolveHqToken,
  scrubTokenFromUrl,
  setHqToken,
  upgradeStoredTokenToCookie,
} from '../../src/data/auth/index.js';

function setUrl(pathAndQuery: string): void {
  window.history.replaceState(null, '', pathAndQuery);
}

afterEach(() => {
  clearHqToken();
  setUrl('/');
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('resolveHqToken', () => {
  it('returns null in open mode (no ?token=, nothing stored)', () => {
    expect(resolveHqToken()).toBeNull();
  });

  it('reads ?token= from the URL and persists it to localStorage', () => {
    setUrl('/?token=tok-from-url');
    expect(resolveHqToken()).toBe('tok-from-url');
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-from-url');
  });

  it('falls back to the persisted token when the URL carries no query', () => {
    setHqToken('tok-persisted');
    expect(resolveHqToken()).toBe('tok-persisted');
  });

  it('migrates a legacy sessionStorage token into localStorage on first read', () => {
    // Pre-F5-persistence builds kept the token in sessionStorage under the
    // same key. Upgrading the SPA must not log anyone out: the copy is moved
    // to localStorage and the session-scoped duplicate removed.
    window.sessionStorage.setItem(HQ_TOKEN_STORAGE_KEY, 'tok-legacy-session');
    expect(resolveHqToken()).toBe('tok-legacy-session');
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-legacy-session');
    expect(window.sessionStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('keeps the legacy sessionStorage copy when localStorage is unavailable', () => {
    // If the localStorage write fails (private mode / quota), the session
    // copy is the ONLY credential — deleting it would log the user out on
    // the next reload.
    window.sessionStorage.setItem(HQ_TOKEN_STORAGE_KEY, 'tok-keep-session');
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      expect(resolveHqToken()).toBe('tok-keep-session');
      expect(window.sessionStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-keep-session');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('keeps the legacy sessionStorage copy when localStorage silently no-ops writes', () => {
    // Some storages accept setItem without persisting anything (older Safari
    // private mode, embedded webviews). The read-back guard must catch that
    // and leave the session copy alone — it is the only surviving credential.
    window.sessionStorage.setItem(HQ_TOKEN_STORAGE_KEY, 'tok-noop-storage');
    const origDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    const noopStorage = {
      getItem: () => null,
      setItem: () => {},
      removeItem: () => {},
      get length() {
        return 0;
      },
      key: () => null,
      clear: () => {},
    };
    Object.defineProperty(window, 'localStorage', { configurable: true, value: noopStorage });
    try {
      expect(resolveHqToken()).toBe('tok-noop-storage');
      expect(window.sessionStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-noop-storage');
    } finally {
      Object.defineProperty(window, 'localStorage', origDescriptor);
    }
  });

  it('URL token wins over a previously persisted one and replaces it', () => {
    setHqToken('tok-old');
    setUrl('/?token=tok-new');
    expect(resolveHqToken()).toBe('tok-new');
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-new');
  });

  it('clears a stored token when a bootstrap exchange succeeds', async () => {
    // The bootstrap flow is the tokenless identity-refresh path. The server
    // authenticates Bearer BEFORE the cookie, so a still-valid legacy stored
    // token would shadow the fresh cookie's identity — it must be cleared.
    setHqToken('tok-legacy');
    setUrl('/#bootstrap=one-time-code');
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ loggedIn: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(exchangeBootstrapIfNeeded()).resolves.toBe(true);
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBeNull();
    expect(window.location.hash).toBe(''); // one-time fragment scrubbed
  });

  it('ignores an empty ?token= value', () => {
    setUrl('/?token=');
    expect(resolveHqToken()).toBeNull();
  });

  it('clearHqToken drops the persisted token', () => {
    setHqToken('tok-gone');
    clearHqToken();
    expect(resolveHqToken()).toBeNull();
  });
});

describe('scrubTokenFromUrl', () => {
  it('persists the URL token, then strips it from the address bar', () => {
    setUrl('/?token=tok-scrub&view=fleet#frag');
    scrubTokenFromUrl();
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-scrub');
    expect(window.location.search).toBe('?view=fleet');
    expect(window.location.hash).toBe('#frag');
    expect(resolveHqToken()).toBe('tok-scrub');
  });

  it('is a no-op when the URL carries no token', () => {
    setUrl('/?view=fleet');
    scrubTokenFromUrl();
    expect(window.location.search).toBe('?view=fleet');
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBeNull();
  });

  it('keeps the token in the URL when localStorage is unavailable', () => {
    setUrl('/?token=tok-keep');
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    try {
      scrubTokenFromUrl();
      // The URL is the only surviving token source — it must NOT be stripped.
      expect(window.location.search).toBe('?token=tok-keep');
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });
});

describe('authHeaders', () => {
  it('is empty in open mode', () => {
    expect(authHeaders()).toEqual({});
  });

  it('carries Authorization: Bearer when a token is active', () => {
    setHqToken('tok-h');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer tok-h' });
  });
});

describe('authorizedFetch', () => {
  it('attaches the Authorization header to the request', async () => {
    setHqToken('tok-f');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await authorizedFetch('/api/snapshot');

    expect(fetchMock).toHaveBeenCalledWith('/api/snapshot', {
      headers: { Authorization: 'Bearer tok-f' },
    });
  });

  it('merges with caller-supplied init/headers without dropping them', async () => {
    setHqToken('tok-m');
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 202 }));
    vi.stubGlobal('fetch', fetchMock);

    await authorizedFetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"x":1}',
    });

    expect(fetchMock).toHaveBeenCalledWith('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer tok-m' },
      body: '{"x":1}',
    });
  });

  it('sends no Authorization header in open mode', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    await authorizedFetch('/api/snapshot');

    expect(fetchMock).toHaveBeenCalledWith('/api/snapshot', { headers: {} });
  });
});

describe('manual token login', () => {
  it('accepts a raw token or extracts it from a complete HQ URL', () => {
    expect(normalizeHqTokenInput('  raw-browser-token  ')).toBe('raw-browser-token');
    expect(normalizeHqTokenInput('http://127.0.0.1:3499/?view=fleet&token=url-token#frag')).toBe(
      'url-token',
    );
  });

  it('exchanges the submitted token directly for a cookie without localStorage', async () => {
    const original = Object.getOwnPropertyDescriptor(window, 'localStorage');
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      get() {
        throw new Error('storage disabled');
      },
    });
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ loggedIn: true, upgraded: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }),
    );
    vi.stubGlobal('fetch', fetchMock);
    try {
      await expect(loginWithHqToken('manual-token')).resolves.toEqual({ ok: true });
      expect(fetchMock).toHaveBeenCalledWith('/api/auth/upgrade', {
        method: 'POST',
        headers: { Authorization: 'Bearer manual-token' },
        credentials: 'same-origin',
        signal: expect.any(AbortSignal),
      });
    } finally {
      if (original) Object.defineProperty(window, 'localStorage', original);
    }
  });

  it('persists the submitted token on success so reloads keep working', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ loggedIn: true, upgraded: true }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );
    await expect(loginWithHqToken('manual-token')).resolves.toEqual({ ok: true });
    // The cookie alone dies with the server's in-memory session table on
    // restart / idle eviction — the stored token is what survives F5.
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('manual-token');
  });

  it('returns the server rejection instead of triggering a silent reload loop', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: { message: 'Token revoked.' } }), {
          status: 401,
          headers: { 'Content-Type': 'application/json' },
        }),
      ),
    );

    await expect(loginWithHqToken('revoked-token')).resolves.toEqual({
      ok: false,
      message: 'Token revoked.',
    });
  });
});

describe('storage() null-fallback and SSR guard', () => {
  it('storage() returns null via ?? fallback when localStorage is null', () => {
    // Make window.localStorage null so that `null ?? null` in storage()
    // returns null, causing resolveHqToken to skip stored-token lookup.
    const orig = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    Object.defineProperty(window, 'localStorage', { configurable: true, value: null });
    try {
      expect(resolveHqToken()).toBeNull();
    } finally {
      Object.defineProperty(window, 'localStorage', orig);
    }
  });

  it('scrubTokenFromUrl SSR guard: no-op when window is undefined', () => {
    // Make window undefined → scrubTokenFromUrl returns early.
    const origWindow = (globalThis as { window?: unknown }).window;
    delete (globalThis as { window?: unknown }).window;
    try {
      expect(() => scrubTokenFromUrl()).not.toThrow();
    } finally {
      (globalThis as { window?: unknown }).window = origWindow;
    }
  });
});

describe('error-path catch blocks', () => {
  it('readUrlToken catch: returns null when URLSearchParams throws', async () => {
    // URLSearchParams can throw when the query string is extreme; the catch
    // safety-net must return null so the caller falls through to stored token.
    setUrl('/?token=boom');
    const OrigURLSearchParams = globalThis.URLSearchParams;
    // @ts-expect-error: assigning a throwing stub
    globalThis.URLSearchParams = class {
      constructor() {
        throw new Error('parse fail');
      }
      get() {
        return null;
      }
    };
    try {
      // Re-import fresh to exercise the catch inside readUrlToken
      const { resolveHqToken: resolveAgain } = await import('../../src/data/auth/index.js');
      expect(resolveAgain()).toBeNull();
    } finally {
      globalThis.URLSearchParams = OrigURLSearchParams;
    }
  });

  it('readStoredToken catch: returns null when getItem throws', () => {
    setHqToken('stored-tok');
    // Replace localStorage with a mock where getItem throws, so the
    // try-catch in readStoredToken fires and returns null.
    const origDescriptor = Object.getOwnPropertyDescriptor(window, 'localStorage')!;
    const mockStorage = {
      getItem: () => {
        throw new Error('quota exceeded');
      },
      setItem: () => {
        throw new Error('readonly');
      },
      removeItem: () => {
        throw new Error('readonly');
      },
      get length() {
        return 0;
      },
      key: () => null,
      clear: () => {},
    };
    Object.defineProperty(window, 'localStorage', {
      configurable: true,
      value: mockStorage,
    });
    try {
      // Without URL token and with a throwing storage, resolveHqToken
      // should fall through readStoredToken's catch and return null.
      setUrl('/');
      expect(resolveHqToken()).toBeNull();
    } finally {
      Object.defineProperty(window, 'localStorage', origDescriptor);
    }
  });
});

describe('upgradeStoredTokenToCookie (WS-065)', () => {
  /** A fetch stub that records the request and replies with `body`. */
  function stubFetch(reply: { ok: boolean; body?: unknown } | Error): {
    calls: Array<[string, RequestInit | undefined]>;
  } {
    const calls: Array<[string, RequestInit | undefined]> = [];
    vi.stubGlobal('fetch', (input: string, init?: RequestInit) => {
      calls.push([input, init]);
      if (reply instanceof Error) return Promise.reject(reply);
      return Promise.resolve({
        ok: reply.ok,
        json: () => Promise.resolve(reply.body ?? {}),
      } as unknown as Response);
    });
    return { calls };
  }

  it('does not call the server when nothing is stored', async () => {
    const { calls } = stubFetch({ ok: true, body: { loggedIn: true } });
    await expect(upgradeStoredTokenToCookie()).resolves.toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('sends the stored token as Bearer and KEEPS it as the reload fallback on success', async () => {
    setHqToken('tok-legacy');
    const { calls } = stubFetch({ ok: true, body: { loggedIn: true, upgraded: true } });

    await expect(upgradeStoredTokenToCookie()).resolves.toBe(true);

    expect(calls[0]?.[0]).toBe('/api/auth/upgrade');
    expect(calls[0]?.[1]?.method).toBe('POST');
    const headers = calls[0]?.[1]?.headers as Record<string, string> | undefined;
    expect(headers?.Authorization).toBe('Bearer tok-legacy');
    // Cookie must be accepted from the response, so the request has to opt in.
    expect(calls[0]?.[1]?.credentials).toBe('same-origin');
    // The cookie upgrade must NOT delete the stored copy — it is the
    // reload-survival fallback when the server session is gone.
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-legacy');
  });

  it('KEEPS the stored token when the server rejects', async () => {
    // The stored token is the user's only credential on the legacy paths.
    // Clearing it without a confirmed cookie locks them out of the dashboard —
    // strictly worse than the exposure this change removes.
    setHqToken('tok-legacy');
    stubFetch({ ok: false });
    await expect(upgradeStoredTokenToCookie()).resolves.toBe(false);
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-legacy');
  });

  it('KEEPS the stored token when the server is too old to know the route', async () => {
    // A 404 arrives as ok:false, but pin the 200-with-wrong-body case too:
    // an SPA served by an older HQ could get an HTML fallback parsed as JSON.
    setHqToken('tok-legacy');
    stubFetch({ ok: true, body: { notWhatWeExpect: true } });
    await expect(upgradeStoredTokenToCookie()).resolves.toBe(false);
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-legacy');
  });

  it('KEEPS the stored token when the request throws', async () => {
    setHqToken('tok-legacy');
    stubFetch(new Error('network down'));
    await expect(upgradeStoredTokenToCookie()).resolves.toBe(false);
    expect(window.localStorage.getItem(HQ_TOKEN_STORAGE_KEY)).toBe('tok-legacy');
  });

  it('keeps the stored token findable after a successful upgrade', async () => {
    // F5 survival: even after the cookie exchange succeeds, the token must
    // still resolve — it is the credential that keeps the dashboard alive
    // when the in-memory server session is evicted or the server restarts.
    setHqToken('tok-legacy');
    stubFetch({ ok: true, body: { loggedIn: true } });
    await expect(upgradeStoredTokenToCookie()).resolves.toBe(true);
    setUrl('/');
    expect(resolveHqToken()).toBe('tok-legacy');
    expect(authHeaders()).toEqual({ Authorization: 'Bearer tok-legacy' });
  });
});
