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

/** Redirect hops to follow before giving up. Matches undici's default. */
const MAX_REDIRECTS = 20;

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
  if (lower === 'authorization' || lower === 'cookie' || lower === 'proxy-authorization') {
    return true;
  }
  return /(^|[-_])(api[-_]?key|key|token|secret|auth|credential|password|session)([-_]|$)/.test(
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

function sameOrigin(a: string, b: string): boolean {
  try {
    return new URL(a).origin === new URL(b).origin;
  } catch {
    return false;
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

    const nextUrl = new URL(location, currentUrl).toString();
    if (!sameOrigin(currentUrl, nextUrl)) headers = stripCredentials(headers);

    // 301/302 after a POST, and 303 after any method except HEAD, become GET
    // without a body — the same normalisation fetch performs internally.
    if (
      (status === 303 && method.toUpperCase() !== 'HEAD') ||
      ((status === 301 || status === 302) && method === 'POST')
    ) {
      method = 'GET';
      body = undefined;
    }

    // Drain so the connection can be reused.
    await res.text?.().catch(() => undefined);
    currentUrl = nextUrl;
  }

  throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting at ${url}`);
}
