/**
 * HQ browser token storage — where the dashboard credential lives.
 *
 * The token is persisted in localStorage under `wrongstack.hq.token.v1` and
 * re-attached as `Authorization: Bearer` on every request. The HttpOnly
 * session cookie minted by `session.ts` is defence-in-depth, but server
 * sessions are in-memory — idle-evicted after 30 minutes and wiped by any
 * server restart — so the stored token is what keeps the dashboard alive
 * across F5. It is removed only by explicit logout, by the password/TOTP
 * login flow (which authenticates with the cookie, not a token), or by a
 * successful bootstrap exchange (the tokenless identity-refresh path, where a
 * legacy stored token must not shadow the new cookie's identity).
 *
 * Legacy: older builds stored the token in sessionStorage under the same key.
 * `readStoredToken` migrates any surviving copy on first read, so upgrading
 * the SPA does not log anyone out.
 */

export const HQ_TOKEN_STORAGE_KEY = 'wrongstack.hq.token.v1';

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

/**
 * One-time migration out of sessionStorage.
 *
 * The session copy is deleted ONLY when the localStorage write verifiably
 * succeeded, checked by read-back: `storage()` returns null (rather than
 * throwing) when property access fails, and some storages silently no-op
 * `setItem` (older Safari private mode, embedded webviews). Without the
 * read-back the sole credential would be destroyed for a write that never
 * landed. When it does not land, the migration simply retries on the next read.
 */
function migrateLegacySessionToken(): string | null {
  try {
    const legacy = legacySessionStorage()?.getItem(HQ_TOKEN_STORAGE_KEY) ?? null;
    if (legacy === null || legacy.length === 0) return null;

    let saved = false;
    try {
      const store = storage();
      if (store !== null) {
        store.setItem(HQ_TOKEN_STORAGE_KEY, legacy);
        saved = store.getItem(HQ_TOKEN_STORAGE_KEY) === legacy;
      }
    } catch {
      // Leave saved = false: the write did not verifiably succeed.
    }

    if (saved) {
      try {
        legacySessionStorage()?.removeItem(HQ_TOKEN_STORAGE_KEY);
      } catch {
        // Best-effort cleanup of the duplicate.
      }
    }
    return legacy;
  } catch {
    return null; // private mode / storage disabled
  }
}

export function readStoredToken(): string | null {
  try {
    const token = storage()?.getItem(HQ_TOKEN_STORAGE_KEY) ?? null;
    if (token !== null && token.length > 0) return token;
  } catch {
    // Fall through to the legacy sessionStorage copy.
  }
  return migrateLegacySessionToken();
}

/** Persist a token so later fetches and reloads survive without `?token=`. */
export function setHqToken(token: string): void {
  try {
    storage()?.setItem(HQ_TOKEN_STORAGE_KEY, token);
  } catch {
    // Best-effort: quota / private mode.
  }
}

export function clearHqToken(): void {
  try {
    storage()?.removeItem(HQ_TOKEN_STORAGE_KEY);
  } catch {
    // Best-effort.
  }
  try {
    legacySessionStorage()?.removeItem(HQ_TOKEN_STORAGE_KEY);
  } catch {
    // Best-effort — the legacy copy, if any.
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
 * Persist a URL-supplied token, then remove `?token=` from the address bar so
 * the credential stops living in browser history, screenshots and copied
 * links. Deliberately a no-op when the token cannot be read back from storage
 * (private mode) — there the URL is the only place it survives a re-render.
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
    // Best-effort.
  }
}

/**
 * Accept either the raw browser token or a complete HQ URL containing
 * `?token=…`. Operators commonly paste the whole startup URL, and treating
 * that as a token verbatim produces a confusing authentication failure.
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

/** Authorization headers for the active token, `{}` in open mode. */
export function authHeaders(): Record<string, string> {
  const token = resolveHqToken();
  return token !== null ? { Authorization: `Bearer ${token}` } : {};
}
