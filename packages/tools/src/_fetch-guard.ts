import * as dns from 'node:dns/promises';
import * as net from 'node:net';
import { isPrivateIPv4, isPrivateIPv6 } from '@wrongstack/core/utils';
import { FetchError, ToolValidationError } from '@wrongstack/core/types';
import { Agent, fetch as undiciFetch } from 'undici';

/**
 * SSRF guard machinery shared by the `fetch` and `search` tools. Split out of
 * fetch.ts so entries that only need `guardedFetch` (search) don't bundle the
 * whole fetch tool. Everything here is security-critical: the pinned undici
 * dispatcher performs the SINGLE DNS resolution the TCP connection uses, so
 * there is no DNS-rebinding TOCTOU between validation and connect.
 */

const nativeGlobalFetch = globalThis.fetch;

export const ALLOW_PRIVATE = process.env['WRONGSTACK_FETCH_ALLOW_PRIVATE'] === '1';
/* v8 ignore next 8 -- module-load-time opt-in warning; gated on an env var not set during tests. */
if (ALLOW_PRIVATE && !process.env['CI']) {
  console.warn(
    '[WrongStack] WARNING: WRONGSTACK_FETCH_ALLOW_PRIVATE=1 is active —\n' +
      '  fetch tool can now access private IPs (10.x, 192.168.x, 169.254.x),\n' +
      '  cloud metadata endpoints, and plaintext HTTP. Use only on isolated networks.',
  );
}

type LookupCallback = (
  err: NodeJS.ErrnoException | null,
  address?: string | Array<{ address: string | undefined; family: number }>,
  family?: number | undefined,
) => void;

/**
 * DNS lookup used by the undici dispatcher below. It performs the SINGLE name
 * resolution that the TCP connection actually uses, and rejects if any
 * resolved address is private/loopback/link-local. Because the connection
 * reuses exactly this result, there is no DNS-rebinding TOCTOU window between
 * the security check and the connect — closing the gap the old code documented
 * (validate with one dns.lookup, then let fetch re-resolve independently).
 * TLS still validates the certificate against the hostname (SNI is set by
 * undici from the URL), so pinning the IP does not weaken cert checking.
 */
export function guardedLookup(
  hostname: string,
  options: { all?: boolean | undefined; family?: number | undefined },
  callback: LookupCallback,
): void {
  dns
    .lookup(hostname, { all: true })
    .then((records) => {
      const family = options?.family;
      const byFamily =
        family === 4 || family === 6 ? records.filter((r) => r.family === family) : records;
      const list = byFamily.length > 0 ? byFamily : records;
      if (!ALLOW_PRIVATE) {
        for (const r of list) {
          const bad = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
          if (bad) {
            callback(
              Object.assign(new Error(`fetch: resolved to private address ${r.address}`), {
                code: 'EAI_FAIL',
              }),
            );
            return;
          }
        }
      }
      if (options?.all) {
        callback(
          null,
          list.map((r) => ({ address: r.address, family: r.family })),
        );
        return;
      }
      const first = list.at(0);
      if (!first) {
        callback(
          Object.assign(new Error(`fetch: no address for ${hostname}`), { code: 'ENOTFOUND' }),
        );
        return;
      }
      callback(null, first.address, first.family);
    })
    .catch((err) => callback(err as NodeJS.ErrnoException));
}

// Reused across requests; guardedLookup re-validates on every new connection,
// so connection pooling is safe. Literal-IP targets bypass lookup entirely and
// are caught by assertNotPrivate's pre-check instead.
// Destroyed on process exit so long-running processes (eternal autonomy,
// MCP server mode) don't let the connection pool grow unboundedly.
let pinnedAgent: Agent | undefined;
function getPinnedDispatcher(): Agent {
  if (!pinnedAgent) {
    // Undici 8 enables HTTP/2 negotiation by default. Its H2 stream can emit a
    // late, unhandled `error` after fetch already rejected when the peer closes
    // the TLS socket, terminating the whole WrongStack process. The fetch tool
    // does not need multiplexing, so retain the proven HTTP/1.1 transport while
    // preserving the pinned DNS lookup and connection pooling.
    pinnedAgent = new Agent({ allowH2: false, connect: { lookup: guardedLookup as never } });
  }
  return pinnedAgent;
}

function dispatcherFetch(): typeof globalThis.fetch {
  // Node's built-in global fetch is backed by its own bundled undici version.
  // Passing an Agent from the workspace's `undici` package to that different
  // dispatcher ABI fails on recent Node with:
  //   UND_ERR_INVALID_ARG: invalid onRequestStart method
  // Use the matching package fetch+Agent pair in real runs, but keep honoring
  // test/user fetch shims that replace globalThis.fetch after this module loads.
  return globalThis.fetch === nativeGlobalFetch
    ? (undiciFetch as unknown as typeof globalThis.fetch)
    : globalThis.fetch;
}
// Clean up the global dispatcher on exit — undici Agents maintain connection
// pools and DNS caches that should be torn down in long-running processes.
// Guard against duplicate registration (module reload/HMR would otherwise
// accumulate listeners).
let _beforeExitRegistered = false;
if (!_beforeExitRegistered) {
  _beforeExitRegistered = true;
  /* v8 ignore next 4 -- process 'beforeExit' cleanup; not deterministically triggerable in-test. */
  process.on('beforeExit', () => {
    pinnedAgent?.destroy();
    pinnedAgent = undefined;
  });
}

/**
 * SSRF-guarded fetch with manual, per-hop-revalidated redirects, exported so
 * other builtin tools (e.g. `search`) get the same protections instead of a
 * weaker `redirect: 'follow'`. Every hop is re-checked against private/loopback
 * ranges and the connection is pinned to the validated IP via the undici
 * dispatcher (no DNS-rebinding TOCTOU). `headers` defaults to the plain `fetch`
 * tool's; callers may override (e.g. a browser User-Agent for search engines).
 */
export async function guardedFetch(
  url: string,
  maxRedirects: number,
  signal: AbortSignal,
  headers: Record<string, string> = {
    'user-agent': 'WrongStack/1.0 (+https://wrongstack.com)',
    accept: 'text/html,application/json;q=0.9,text/plain;q=0.8,*/*;q=0.1',
  },
): Promise<Response> {
  let redirectCount = 0;
  let currentUrl = url;
  for (;;) {
    // Re-validate every hop. A public host can 302 to 169.254.169.254 (cloud metadata),
    // or DNS can rebind between hops; checking only the initial URL is insufficient.
    const parsed = new URL(currentUrl);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      throw new ToolValidationError({
        message: `fetch: redirect to unsupported protocol "${parsed.protocol}"`,
        field: 'url',
      });
    }
    if (parsed.protocol === 'http:' && !ALLOW_PRIVATE) {
      throw new ToolValidationError({
        message: 'fetch: redirect to http:// blocked (HTTPS required by default)',
        field: 'url',
      });
    }
    await assertNotPrivate(parsed.hostname);

    // The dispatcher pins the connection to the IP guardedLookup validated —
    // no independent re-resolution, so DNS rebinding can't swap in a private
    // address between check and connect. `dispatcher` is a runtime option of
    // Node's undici-backed global fetch but isn't in lib.dom's RequestInit, and
    // our undici Agent's type differs from the @types/node copy — hence the
    // cast. (Verified: global fetch invokes the Agent's custom lookup.)
    const init = {
      redirect: 'manual' as const,
      signal,
      headers,
      dispatcher: getPinnedDispatcher(),
    };
    const res = await dispatcherFetch()(currentUrl, init as never as RequestInit);
    if (res.status < 300 || res.status > 399) {
      return res;
    }
    // Drain the redirect hop's body before following the next hop. An unread
    // body pins its pooled connection (and buffers the payload) for as long as
    // the response object lives — across a multi-hop chain that leaks one
    // socket per hop.
    try {
      await res.body?.cancel();
    } catch {
      // Body already consumed/closed — nothing to release.
    }
    redirectCount++;
    if (redirectCount > maxRedirects) {
      throw new FetchError({
        message: `fetch: exceeded ${maxRedirects} redirects`,
        status: res.status,
        context: { url: currentUrl, maxRedirects, redirectCount },
      });
    }
    const location = res.headers.get('location');
    if (!location) {
      throw new FetchError({
        message: 'fetch: redirect status with no location header',
        status: res.status,
        context: { url: currentUrl, redirectCount },
      });
    }
    currentUrl = new URL(location, currentUrl).toString();
  }
}

export async function assertNotPrivate(hostname: string): Promise<void> {
  if (ALLOW_PRIVATE) return;

  const host =
    hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;

  if (host === 'localhost' || host.endsWith('.localhost')) {
    throw new ToolValidationError({
      message: 'fetch: blocked localhost target',
      field: 'url',
    });
  }

  const ipVersion = net.isIP(host);
  if (ipVersion === 4) {
    if (isPrivateIPv4(host)) {
      throw new ToolValidationError({
        message: `fetch: blocked private/loopback address "${host}"`,
        field: 'url',
      });
    }
  } else if (ipVersion === 6) {
    if (isPrivateIPv6(host)) {
      throw new ToolValidationError({
        message: `fetch: blocked private/loopback address "${host}"`,
        field: 'url',
      });
    }
  } else {
    // Hostname — pre-flight check: resolve and reject if any record is private,
    // so we fail fast with a clear error before opening a socket. The
    // authoritative anti-rebinding control is guardedLookup on the pinned
    // undici dispatcher (see getPinnedDispatcher): it performs the single
    // resolution the connection actually uses, so there is no TOCTOU between
    // this check and the connect. Each redirect target is re-checked too.
    try {
      // Use dns.lookup for async hostname resolution (matches guardedLookup above).
      const records = await dns.lookup(host, { all: true });
      for (const r of records) {
        const bad = r.family === 4 ? isPrivateIPv4(r.address) : isPrivateIPv6(r.address);
        if (bad) {
          throw new ToolValidationError({
            message: `fetch: resolved to private address ${r.address}`,
            field: 'url',
          });
        }
      }
    } catch (err) {
      if (err instanceof ToolValidationError) throw err;
      // DNS failure — let fetch handle it
    }
  }
}
