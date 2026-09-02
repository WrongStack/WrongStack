/**
 * HQ session flows — exchanging a credential for the server's HttpOnly cookie.
 *
 * Three entry points, all of which end with the tab holding a cookie session:
 *  - `exchangeBootstrapIfNeeded()` — the startup URL's one-time `#bootstrap=`
 *    code. Fragments never reach access logs, Referer headers or proxy caches.
 *  - `loginWithHqToken()` — an operator pasting a browser token into the gate.
 *  - `upgradeStoredTokenToCookie()` — WS-065, minting a cookie for the token
 *    already in storage on every boot.
 */
import { clearHqToken, normalizeHqTokenInput, readStoredToken, setHqToken } from './token-storage.js';

const EXCHANGE_TIMEOUT_MS = 10_000;

function requestTokenCookieUpgrade(token: string): Promise<Response> {
  return fetch('/api/auth/upgrade', {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}` },
    credentials: 'same-origin',
    signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
  });
}

export interface HqTokenLoginResult {
  ok: boolean;
  message?: string;
}

/**
 * Authenticate a manually entered browser token.
 *
 * The old gate wrote the token to storage and immediately reloaded; when
 * storage was unavailable (privacy mode, embedded-browser policy, quota) the
 * token vanished during that reload and the gate silently returned. Exchanging
 * the submitted token directly for the server's session cookie makes the
 * current tab authoritative and removes the need to open a `?token=` URL.
 */
export async function loginWithHqToken(input: string): Promise<HqTokenLoginResult> {
  const token = normalizeHqTokenInput(input);
  if (token.length === 0) return { ok: false, message: 'Enter a browser token.' };

  try {
    const response = await requestTokenCookieUpgrade(token);
    let body: { loggedIn?: unknown; error?: { message?: unknown } | string } = {};
    try {
      body = (await response.json()) as typeof body;
    } catch {
      // A status-specific fallback below reads better than a parse error.
    }

    if (response.ok && body.loggedIn === true) {
      // Keep the stored token — it is the reload-survival fallback. The cookie
      // alone dies with the server's in-memory session table on restart or
      // idle eviction, which is exactly when F5 must keep working.
      setHqToken(token);
      return { ok: true };
    }

    const serverError = body.error;
    const message =
      typeof serverError === 'string'
        ? serverError
        : typeof serverError?.message === 'string'
          ? serverError.message
          : response.status === 401
            ? 'The browser token was rejected. It may be invalid, expired, or revoked.'
            : 'HQ could not start a browser session with this token.';
    return { ok: false, message };
  } catch {
    return { ok: false, message: 'Could not reach the HQ server. Try again.' };
  }
}

/** Read the one-time bootstrap code from the URL fragment (`#bootstrap=…`). */
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

/** Remove the bootstrap fragment so the one-time code leaves the address bar. */
function scrubBootstrapFromUrl(): void {
  if (typeof window === 'undefined') return;
  try {
    const url = new URL(window.location.href);
    if (url.hash.startsWith('#bootstrap=')) {
      url.hash = '';
      window.history.replaceState(null, '', `${url.pathname}${url.search}`);
    }
  } catch {
    // Best-effort.
  }
}

/**
 * POST the bootstrap code to `/api/auth/bootstrap`; the server consumes it
 * atomically and returns an HttpOnly session cookie.
 *
 * On success any stored token is cleared: bootstrap is the tokenless
 * identity-refresh path, and the server authenticates Bearer BEFORE the
 * cookie — a still-valid legacy token would otherwise shadow the fresh
 * cookie's identity and capabilities on every request.
 *
 * Returns true only when the exchange actually happened.
 */
export async function exchangeBootstrapIfNeeded(): Promise<boolean> {
  const code = readBootstrapCode();
  if (code === null) return false;
  try {
    const response = await fetch('/api/auth/bootstrap', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ code }),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(EXCHANGE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    scrubBootstrapFromUrl();
    clearHqToken();
    return true;
  } catch {
    return false;
  }
}

/**
 * WS-065 — mint the HttpOnly session cookie for a stored browser token.
 *
 * The stored token is deliberately NOT deleted on success: it is the
 * reload-survival fallback for when the server's in-memory session is gone.
 * The cookie is strictly stronger (HttpOnly, same-origin, server-expiring)
 * but it must not be the only credential the tab holds.
 *
 * Every non-success outcome — nothing stored, a server too old to know the
 * route, a network failure, a token with no server-side record — returns false
 * and leaves storage exactly as it was.
 */
export async function upgradeStoredTokenToCookie(): Promise<boolean> {
  const token = readStoredToken();
  if (token === null) return false;
  try {
    const response = await requestTokenCookieUpgrade(token);
    if (!response.ok) return false;
    const body = (await response.json()) as { loggedIn?: unknown };
    return body.loggedIn === true;
  } catch {
    return false;
  }
}
