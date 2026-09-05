import {
  getTokenFromPageUrl,
  getTokenFromWsUrl,
  httpOriginForAuth,
  stripTokenFromAddressBar,
  stripTokenFromUrl,
} from './ws-client-utils';

export function wsUrlCanUseAuthCookie(wsUrl: string): boolean {
  try {
    const ws = new URL(wsUrl);
    const auth = new URL(httpOriginForAuth());
    return ws.hostname === auth.hostname;
  } catch {
    return true;
  }
}

/**
 * Exchange a stored token for an HttpOnly auth cookie via `/ws-auth`.
 * Called once before the first connect so subsequent reconnections can
 * drop the `?token=` from the WS URL (C-2 fix — token-in-URL closes
 * the C-598 query-string exposure class). No-op when the cookie is
 * already set, when the server is on a loopback bind (no token
 * required), or when no token is available yet.
 *
 * Failure is non-fatal only for local loopback or explicit public-WS URL
 * flows. Normal remote browser clients need the cookie path so the token does
 * not remain in the WebSocket URL.
 *
 * Returns the possibly-stripped WS URL.
 */
export async function ensureAuthCookie(wsUrl: string): Promise<string> {
  if (typeof window === 'undefined') return wsUrl;
  if (document.cookie.split(';').some((c) => c.trim().startsWith('ws_token='))) {
    // Cookie already set — the browser sends it automatically on the
    // WS upgrade. Nothing to do.
    let updatedUrl = wsUrl;
    if (wsUrlCanUseAuthCookie(wsUrl)) updatedUrl = stripTokenFromUrl(wsUrl);
    stripTokenFromAddressBar();
    return updatedUrl;
  }
  // The token, if any, is in the initial page URL or in an explicitly
  // configured WS URL. sessionStorage persistence was removed in the C-2
  // fix: the token must not live in client-accessible storage.
  const token = getTokenFromWsUrl(wsUrl) ?? getTokenFromPageUrl();
  if (!token) return wsUrl; // first boot, no token yet — fallback to loopback-bootstrap
  const authUrl = httpOriginForAuth() + `/ws-auth?token=${encodeURIComponent(token)}`;
  try {
    const res = await fetch(authUrl, {
      method: 'GET',
      credentials: 'same-origin',
      // Cache-Control: no-store on the server side. Don't let the
      // browser cache a 401 or replay a stale response.
      cache: 'no-store',
    });
    if (!res.ok) {
      console.warn(
        JSON.stringify({
          level: 'warn',
          event: 'ws_client.ws_auth_failed',
          status: res.status,
          timestamp: new Date().toISOString(),
        }),
      );
    } else {
      let updatedUrl = wsUrl;
      if (wsUrlCanUseAuthCookie(wsUrl)) {
        updatedUrl = stripTokenFromUrl(wsUrl);
      }
      stripTokenFromAddressBar();
      return updatedUrl;
    }
  } catch (err) {
    // Network failure on the auth bootstrap may still work for loopback or
    // explicit public-WS URL flows. Log it and let the handshake policy decide.
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'ws_client.ws_auth_error',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    );
  }
  return wsUrl;
}
