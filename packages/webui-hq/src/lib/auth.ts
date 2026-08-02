/**
 * HQ browser auth — single source of truth for the dashboard credential.
 *
 * Primary flow (bootstrap exchange): the startup URL carries a one-time code
 * in the fragment (`#bootstrap=…`). The SPA extracts it, POSTs it to
 * `/api/auth/bootstrap`, and receives an HttpOnly session cookie. The code
 * is consumed atomically and never persisted client-side.
 *
 * Legacy fallback: `?token=` URLs and sessionStorage remain supported for
 * backward compatibility with older startup URLs and manual token entry.
 * HTTP requests attach the token as `Authorization: Bearer`.
 *
 * WS-065: those legacy paths left the raw token in `sessionStorage`, readable
 * by any script on the origin. They can't simply be deleted — an old `?token=`
 * URL and manual token entry are the only credential those users have, and
 * dropping storage would break reload survival for them. Instead
 * `upgradeStoredTokenToCookie` finishes the migration at runtime: authenticate
 * once with the stored token, take the HttpOnly cookie, delete the copy. Only
 * on a confirmed upgrade — a failed exchange leaves storage untouched, because
 * a token the user cannot recover is worse than one a script could read.
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
 * sessionStorage, or null when unavailable. Even ACCESSING the property can
 * throw (SecurityError with storage disabled / strict private modes), so the
 * read itself is guarded — not just the getItem/setItem calls.
 */
function storage(): Storage | null {
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
    return token !== null && token.length > 0 ? token : null;
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
 * be read back from sessionStorage (private mode / storage disabled) — in
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
 * atomically consumes the code and returns an HttpOnly session cookie —
 * no persistent client-side credential is stored.
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
 * WS-065 — trade a stored browser token for an HttpOnly session cookie and
 * delete the stored copy.
 *
 * Returns true when storage no longer holds a token *because* the exchange
 * succeeded. Every other outcome — nothing stored, server too old to know the
 * route, network failure, a token with no server-side record — returns false
 * and leaves storage exactly as it was. That asymmetry is the whole safety
 * argument: the only way to lose the fallback credential is to have provably
 * gained the stronger one.
 *
 * A cookie-authenticated caller gets `upgraded: false` from the server and no
 * new session, but the stored token is still cleared here — the cookie already
 * covers every request, so the copy is pure exposure.
 */
export async function upgradeStoredTokenToCookie(): Promise<boolean> {
  if (readStoredToken() === null) return false;
  try {
    const res = await fetch('/api/auth/upgrade', {
      method: 'POST',
      headers: authHeaders(),
      credentials: 'same-origin',
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return false;
    const body = (await res.json()) as { loggedIn?: unknown };
    if (body.loggedIn !== true) return false;
    clearHqToken();
    return true;
  } catch {
    return false;
  }
}

export const __test__ = { STORAGE_KEY };
