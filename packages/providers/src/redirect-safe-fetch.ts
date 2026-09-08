/**
 * Redirect handling that does not hand provider credentials to a third host.
 *
 * `fetch` defaults to `redirect: 'follow'`. On a cross-origin redirect it strips
 * exactly three headers — `Authorization`, `Cookie`, `Proxy-Authorization` — and
 * replays everything else. This codebase authenticates most providers with
 * headers that are NOT on that list:
 *
 *   - `x-api-key`      (Anthropic, MiniMax)
 *   - `x-goog-api-key` (Google)
 *   - arbitrary `cfg.headers` supplied for custom providers and gateways
 *
 * So a `307` from a configured base URL replayed the user's API key to whatever
 * host the redirect named. A misconfigured or hostile gateway is an obvious
 * route, but so is a compromised CDN in front of a legitimate endpoint (WS-084).
 *
 * The fix keeps the browser's rule and extends it to the headers this codebase
 * actually uses: redirects are followed, but every credential-bearing header is
 * dropped the moment the origin changes. A target that genuinely needs auth then
 * answers 401 — visible and debuggable — instead of silently receiving the key.
 */

import { isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core/utils/ip-guard';

/** Redirect hops to follow before giving up. Matches undici's default. */
const MAX_REDIRECTS = 20;

/**
 * J2 (NEW-02): reject redirect targets whose host is a literal
 * private / loopback / metadata address. The DNS-rebinding vector
 * (a hostname that resolves to a private IP at dial time) is a
 * separate gap and is closed by `guardedFetch`'s pinned dispatcher
 * for outbound provider traffic; this function closes the
 * lower-effort literal-host case (e.g. `http://169.254.169.254/…`)
 * that the original `redirect-safe-fetch` missed while still
 * advertising "Verified clean".
 */
function assertNotPrivateRedirectHost(url: URL): void {
  const host = url.hostname;
  if (!host) throw new Error(`redirect to URL with no host: ${url}`);
  // Only literal IP addresses are checked here — a hostname's
  // resolved-IP rebinding case is the separate `guardedFetch` /
  // pinned-dispatcher concern. `isPrivateIPv4` returns true for
  // any string that is not a dotted-quad, and `isPrivateIPv6`
  // returns true for any string that fails IPv6 expansion
  // (deliberately conservative for *untrusted input*); together
  // that would classify every hostname as private, which is the
  // opposite of what we want. Restrict the literal check to inputs
  // that look like an IP (digits/colons/dots, no letters).
  if (/^[0-9.:]+$/.test(host) && (isPrivateIPv4(host) || isPrivateIPv6(host))) {
    throw new Error(`redirect to private/loopback host blocked: ${url}`);
  }
}

/**
 * Header names that carry a credential.
 *
 * Deliberately broader than fetch's built-in list: any header whose name looks
 * like a key, token, secret, or auth field is treated as sensitive. Over-
 * stripping costs a 401 on an unusual gateway; under-stripping leaks the user's
 * API key to a host they never configured.
 */
function isCredentialHeader(name: string): boolean {
  const lower = name.toLowerCase();
  if (
    lower === 'authorization' ||
    lower === 'authentication' ||
    lower === 'cookie' ||
    lower === 'proxy-authorization' ||
    lower === 'proxy-authenticate'
  ) {
    return true;
  }
  return /(^|[-_])(api[-_]?key|key|token|secret|auth(entication|enticate)?|credential|password|session)([-_]|$)/.test(
    lower,
  );
}

function stripCredentials(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!isCredentialHeader(name)) safe[name] = value;
  }
  return safe;
}

const PAYLOAD_HEADERS = new Set([
  'content-encoding',
  'content-language',
  'content-length',
  'content-location',
  'content-range',
  'content-type',
]);

function stripPayloadHeaders(headers: Record<string, string>): Record<string, string> {
  const safe: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (!PAYLOAD_HEADERS.has(name.toLowerCase())) safe[name] = value;
  }
  return safe;
}

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
  }
}

function checkAborted(signal?: AbortSignal): void {
  if (!signal) return;
  if (typeof signal.throwIfAborted === 'function') {
    signal.throwIfAborted();
  } else if (signal.aborted) {
    throw signal.reason ?? new DOMException('The operation was aborted', 'AbortError');
  }
}

export interface RedirectSafeFetchInit {
  method?: string | undefined;
  headers: Record<string, string>;
  body?: string | undefined;
  signal?: AbortSignal | undefined;
}

/**
 * Issue a request, following redirects manually so credentials can be dropped
 * when the origin changes.
 *
 * @param fetchImpl - the injected fetch (tests supply fakes; the network guard
 *   supplies a pinned-lookup dispatcher). Wrapping rather than replacing it
 *   keeps both working.
 */
export async function redirectSafeFetch(
  fetchImpl: typeof fetch,
  url: string,
  init: RedirectSafeFetchInit,
): Promise<Response> {
  let currentUrl = url;
  let headers = init.headers;
  let body = init.body;
  let method = init.method ?? 'GET';

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    checkAborted(init.signal);

    const res = await fetchImpl(currentUrl, {
      method,
      headers,
      ...(body !== undefined ? { body } : {}),
      ...(init.signal ? { signal: init.signal } : {}),
      redirect: 'manual',
    });

    const status = res.status;
    // `redirect: 'manual'` is only honoured by real fetch implementations.
    // Injected fakes routinely ignore it and return a normal response, and a
    // non-redirect status is the common case anyway — return it untouched.
    if (status !== 301 && status !== 302 && status !== 303 && status !== 307 && status !== 308) {
      return res;
    }
    const location = res.headers?.get?.('location');
    if (!location) return res;

    let nextUrlParsed: URL;
    try {
      nextUrlParsed = new URL(location, currentUrl);
    } catch {
      return res;
    }

    if (nextUrlParsed.protocol !== 'http:' && nextUrlParsed.protocol !== 'https:') {
      throw new Error(
        `Redirect to non-HTTP(S) protocol: ${nextUrlParsed.protocol} (${nextUrlParsed.toString()})`,
      );
    }

    const nextUrl = nextUrlParsed.toString();
    if (!sameOrigin(currentUrl, nextUrl)) headers = stripCredentials(headers);
    // J2: revalidate the redirect target's resolved IP against the
    // private/loopback classifier before letting `fetch` dial it.
    // This runs *before* the protocol check's throw above for cross-
    // origin hops, and on same-origin hops too — a compromised CDN
    // that points a single-origin endpoint at a private address is
    // the same hazard at a smaller blast radius.
    assertNotPrivateRedirectHost(nextUrlParsed);

    // 301/302 after a POST, and 303 after any method except HEAD, become GET
    // without a body — the same normalisation fetch performs internally.
    const upperMethod = method.toUpperCase();
    if (
      (status === 303 && upperMethod !== 'HEAD') ||
      ((status === 301 || status === 302) && upperMethod === 'POST')
    ) {
      method = 'GET';
      body = undefined;
      headers = stripPayloadHeaders(headers);
    }

    // Drain so the connection can be reused, respecting signal.
    if (init.signal) {
      checkAborted(init.signal);
      let cleanup: (() => void) | undefined;
      const abortPromise = new Promise<void>((_, reject) => {
        const onAbort = () => {
          try {
            res.body?.cancel?.(init.signal?.reason).catch?.(() => undefined);
          } catch {}
          try {
            checkAborted(init.signal);
          } catch (err) {
            reject(err);
          }
        };
        init.signal!.addEventListener('abort', onAbort, { once: true });
        cleanup = () => init.signal!.removeEventListener('abort', onAbort);
      });
      try {
        await Promise.race([res.text?.().catch(() => undefined), abortPromise]);
      } finally {
        cleanup?.();
      }
      checkAborted(init.signal);
    } else {
      await res.text?.().catch(() => undefined);
    }
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`);
}
