/**
 * HQ browser auth — single source of truth for the dashboard credential.
 *
 * Primary flow (bootstrap exchange): the startup URL carries a one-time code
 * in the fragment (`#bootstrap=…`). The SPA extracts it, POSTs it to
 * `/api/auth/bootstrap`, and receives an HttpOnly session cookie. The code
 * is consumed atomically and never persisted client-side.
 *
 * Reload-survival credential: after token login (`?token=` URLs, manual token
 * entry, or the gate), the raw token is persisted in localStorage under
 * `wrongstack.hq.token.v1` and re-attached as `Authorization: Bearer` on every
 * request. The HttpOnly cookie is defense-in-depth, but server sessions are
 * in-memory — idle-evicted after 30 minutes and wiped by any server restart —
 * so the stored token is what keeps the dashboard alive across F5. It is
 * removed by explicit logout, when the operator logs in through the
 * password/TOTP flow (which authenticates with the cookie, not a token), or
 * when a fresh bootstrap exchange succeeds (that flow is the tokenless
 * identity-refresh path — a legacy stored token must not shadow the new
 * cookie's identity); a revoked token surfaces as a rejected-token gate,
 * not as a silent lockout.
 *
 * Legacy: older builds stored the token in sessionStorage under the same key.
 * `readStoredToken` migrates any surviving copy into localStorage on first
 * read, so upgrading the SPA does not log anyone out.
 */

const STORAGE_KEY = 'wrongstack.hq.token.v1';

function readUrlToken(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const token = new URLSearchParams(window.location.search).get('token');
    return token !== null && token.length > 0 ? token : null;
  } catch {
    return null;
  }
}

/**
 * localStorage, or null when unavailable. Even ACCESSING the property can
 * throw (SecurityError with storage disabled / strict private modes), so the
 * read itself is guarded — not just the getItem/setItem calls.
 *
 * localStorage (not sessionStorage) is the reload-survival store: it survives
 * F5, tab restarts, and browser restarts, which is exactly the durability the
 * dashboard needs because the server-side session cookie alone is wiped by
 * HQ restarts and idle eviction.
 */
function storage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Guarded sessionStorage access — used only for the legacy-token migration. */
function legacySessionStorage(): Storage | null {
  if (typeof window === 'undefined') return null;
  try {
    return window.sessionStorage ?? null;
  } catch {
    return null;
  }
}

function readStoredToken(): string | null {
  try {
    const token = storage()?.getItem(STORAGE_KEY) ?? null;
    if (token !== null && token.length > 0) return token;
  } catch {
    /* fall through — try the legacy sessionStorage copy below */
  }
  return migrateLegacySessionToken();
}

/**
 * One-time migration: builds before the F5-persistence fix stored the token
 * in sessionStorage under the same key. Move any surviving copy into
 * localStorage so reload survival keeps working after the SPA upgrade, then
 * delete the session-scoped duplicate — but ONLY when the localStorage write
 * verifiably succeeded (checked by read-back). If storage is unavailable
 * (private mode) or silently no-ops, the sessionStorage copy is the sole
 * credential and must not be destroyed; the migration then retries
 * harmlessly on the next read.
 */
function migrateLegacySessionToken(): string | null {
  try {
    const legacy = legacySessionStorage()?.getItem(STORAGE_KEY) ?? null;
    if (legacy === null || legacy.length === 0) return null;
    // saved must only become true when the value can be READ BACK after the
    // write. `storage()` returns null (not throws) when the property access
    // fails, and some storages silently no-op setItem (older Safari private
    // mode, embedded webviews) — without the read-back, the session copy
    // would be destroyed even though nothing was persisted.
    let saved = false;
    try {
      const store = storage();
      if (store !== null) {
        store.setItem(STORAGE_KEY, legacy);
        saved = store.getItem(STORAGE_KEY) === legacy;
      }
    } catch {
      /* leave saved = false — the write did not verifiably succeed */
    }
    if (saved) {
      try {
        legacySessionStorage()?.removeItem(STORAGE_KEY);
      } catch {
        /* best-effort */
      }
    }
    return legacy;
  } catch {
    return null; // private mode / storage disabled
  }
}

/** Persist a token so later fetches and reloads survive without `?token=`. */
export function setHqToken(token: string): void {
  try {
    storage()?.setItem(STORAGE_KEY, token);
  } catch {
    /* best-effort: quota / private mode */
  }
}

export function clearHqToken(): void {
  try {
    storage()?.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort */
  }
  try {
    legacySessionStorage()?.removeItem(STORAGE_KEY);
  } catch {
    /* best-effort — legacy copy, if any */
  }
}

/**
 * Resolve the active browser token: `?token=` wins (and is persisted for
 * later), else the persisted one. `null` means open mode — or a token gate.
 */
export function resolveHqToken(): string | null {
  const fromUrl = readUrlToken();
  if (fromUrl !== null) {
    setHqToken(fromUrl);
    return fromUrl;
  }
  return readStoredToken();
}

/**
 * Persist a URL-supplied token, then remove `?token=` from the address bar
 * (history.replaceState) so the credential stops living in browser history,
 * screenshots, and copied links. Deliberately a no-op when the token cannot
 * be read back from localStorage (private mode / storage disabled) — in
 * that case the URL is the only place the token survives a re-render.
 */
export function scrubTokenFromUrl(): void {
  if (typeof window === 'undefined') return;
  const urlToken = readUrlToken();
  if (urlToken === null) return;
  setHqToken(urlToken);
  if (readStoredToken() !== urlToken) return; // storage unavailable — keep it in the URL
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('token');
    window.history.replaceState(null, '', `${url.pathname}${url.search}${url.hash}`);
  } catch {
    /* best-effort */
  }
}

/** Authorization headers for the active token, `{}` in open mode. */
export function authHeaders(): Record<string, string> {
  const token = resolveHqToken();
  return token !== null ? { Authorization: `Bearer ${token}` } : {};
}

/**
 * `fetch` with the HQ token attached. All dashboard HTTP calls must go
 * through this — a bare `fetch('/api/…')` 401s whenever the server runs in
 * browser-token mode, which is the default since first-run auth.
 */
export function authorizedFetch(input: string, init?: RequestInit): Promise<Response> {
  const headers: Record<string, string> = {
    ...((init?.headers as Record<string, string> | undefined) ?? {}),
    ...authHeaders(),
  };
  return fetch(input, { ...init, headers });
}

export interface HqTokenLoginResult {
  ok: boolean;
  message?: string;
}

/**
 * Accept either the raw browser token or a complete legacy HQ URL containing
 * `?token=...`. Operators commonly copy the whole startup URL, so treating it
 * as a token verbatim would otherwise produce a confusing authentication
 * failure.
 */
export function normalizeHqTokenInput(input: string): string {
  const value = input.trim();
  if (!/[?&]token=/.test(value)) return value;
  try {
    const base = typeof window === 'undefined' ? 'http://127.0.0.1/' : window.location.href;
    return new URL(value, base).searchParams.get('token')?.trim() || value;
  } catch {
    return value;
  }
}

async function requestTokenCookieUpgrade(token: string): Promise<Response> {
  return fetch('/api/auth/upgrade', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(10_000),
  });
}

/**
 * Authenticate a manually entered browser token before reloading the SPA.
 *
 * The old token-gate flow wrote to sessionStorage and immediately reloaded.
 * When storage was unavailable (privacy mode, embedded browser policy, or a
 * quota/security error), the token disappeared during that reload and the
 * gate simply returned. Exchanging the submitted token directly for the
 * server's HttpOnly session cookie makes the current tab authoritative and
 * removes the need to open a separate `?token=` URL.
 */
export async function loginWithHqToken(input: string): Promise<HqTokenLoginResult> {
  const token = normalizeHqTokenInput(input);
  if (token.length === 0) return { ok: false, message: 'Enter a browser token.' };

  try {
    const res = await requestTokenCookieUpgrade(token);
    let body: { loggedIn?: unknown; error?: { message?: unknown } | string } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      /* A status-specific fallback below is clearer than a JSON parse error. */
    }

    if (res.ok && body.loggedIn === true) {
      // Keep the stored token — it is the reload-survival fallback. The
      // HttpOnly cookie alone dies with the server's in-memory session table
      // on restart or idle eviction, which is exactly when F5 must keep
      // working. Only explicit logout clears it.
      setHqToken(token);
      return { ok: true };
    }

    const serverError = body.error;
    const message =
      typeof serverError === 'string'
        ? serverError
        : typeof serverError?.message === 'string'
          ? serverError.message
          : res.status === 401
            ? 'The browser token was rejected. It may be invalid, expired, or revoked.'
            : 'HQ could not start a browser session with this token.';
    return { ok: false, message };
  } catch {
    return { ok: false, message: 'Could not reach the HQ server. Try again.' };
  }
}

// ── Bootstrap exchange ──────────────────────────────────────────────────────

/**
 * Read the one-time bootstrap code from the URL fragment (`#bootstrap=…`).
 * Fragments never reach HTTP access logs, Referer headers, or proxy caches.
 * Returns null when no fragment or not in a browser.
 */
function readBootstrapCode(): string | null {
  if (typeof window === 'undefined') return null;
  try {
    const hash = window.location.hash;
    if (!hash.startsWith('#bootstrap=')) return null;
    const code = hash.slice('#bootstrap='.length);
    return code.length > 0 ? code : null;
  } catch {
    return null;
  }
}

/**
 * Scrub the bootstrap fragment from the address bar so the one-time code
 * can't be read from browser history, screenshots, or copied links.
 */
function scrubBootstrapFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (url.hash.startsWith('#bootstrap=')) {
      url.hash = '';
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  } catch {
    /* best-effort */
  }
}

/**
 * Extract the bootstrap code from the URL fragment, POST it to
 * `/api/auth/bootstrap`, and scrub the fragment on success. The server
 * atomically consumes the code and returns an HttpOnly session cookie.
 *
 * On success any stored token is cleared: the bootstrap flow is the
 * tokenless identity-refresh path, and the server authenticates Bearer
 * BEFORE the cookie — a still-valid legacy stored token would otherwise
 * shadow the fresh cookie's identity and capabilities on every request.
 *
 * Returns true when the exchange succeeded (or was already done and the
 * server reports a valid cookie session).
 */
export async function exchangeBootstrapIfNeeded(): Promise<boolean> {
  const code = readBootstrapCode();
  if (code === null) return false;
  try {
    const res = await fetch('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      scrubBootstrapFromUrl();
      clearHqToken();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

/**
 * WS-065 — mint the HttpOnly session cookie for a stored browser token.
 *
 * Returns true when the server confirmed a cookie session. The stored token
 * is deliberately NOT deleted on success: it is the reload-survival fallback
 * that keeps the dashboard alive when the server's in-memory session is gone
 * (restart, 30-minute idle eviction). The cookie is defense-in-depth —
 * strictly stronger (HttpOnly, same-origin, server-expiring) — but it must
 * not be the only credential the tab holds.
 *
 * Every non-success outcome — nothing stored, server too old to know the
 * route, network failure, a token with no server-side record — returns false
 * and leaves storage exactly as it was.
 */
export async function upgradeStoredTokenToCookie(): Promise<boolean> {
  const token = readStoredToken();
  if (token === null) return false;
  try {
    const res = await requestTokenCookieUpgrade(token);
    if (!res.ok) return false;
    const body = (await res.json()) as { loggedIn?: unknown };
    if (body.loggedIn !== true) return false;
    return true;
  } catch {
    return false;
  }
}

export const __test__ = { STORAGE_KEY };
