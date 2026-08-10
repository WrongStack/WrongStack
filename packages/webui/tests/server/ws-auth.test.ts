import * as path from 'node:path';
import {
  extractTokenFromCookie,
  hostHeaderOk,
  isLoopbackHostname,
  isWildcardBind,
  tokenMatches,
  verifyClient,
} from '@wrongstack/webui-server';
import { describe, expect, it } from 'vitest';

const TOKEN = 'abc123def456';
// A loopback Host header — required for the DNS-rebinding guard to pass on a
// loopback bind. Real same-machine browsers send this.
const LOOPBACK_HOST = '127.0.0.1:3456';

describe('verifyClient (WebSocket auth)', () => {
  it('allows loopback browser origin without token (loopback bind)', () => {
    // Same-origin: the hardened isTrustedLoopbackOrigin check requires exact
    // hostname equality between Origin and Host — not merely "both loopback."
    // Each alias is tested with its own matching Host header.
    const cases = [
      { origin: 'http://localhost:3456', hostHeader: 'localhost:3456' },
      { origin: 'http://127.0.0.1:3456', hostHeader: '127.0.0.1:3456' },
      { origin: 'http://[::1]:3456', hostHeader: '[::1]:3456' },
    ];
    for (const { origin, hostHeader } of cases) {
      expect(
        verifyClient({
          origin,
          url: '/',
          hostHeader,
          wsHost: '127.0.0.1',
          expectedToken: TOKEN,
        }),
      ).toBe(true);
    }
  });

  // WS-003: a hostname-only loopback check trusted every other process
  // listening on this machine. The WS handshake is exempt from the same-origin
  // policy, so an XSS on any local dev server could open a tokenless socket
  // here and drive the agent. This test previously asserted the opposite.
  it('rejects a tokenless loopback browser origin on a different port', () => {
    for (const origin of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://[::1]:3000']) {
      expect(
        verifyClient({
          origin,
          url: '/',
          hostHeader: LOOPBACK_HOST,
          wsHost: '127.0.0.1',
          expectedToken: TOKEN,
        }),
      ).toBe(false);
    }
  });

  // WS-005: any local process could previously open a tokenless socket on a
  // loopback bind and drive the agent (terminal.create → node-pty, mcp.add →
  // spawn). A token always exists — resolveAuthToken generates one when
  // unconfigured — and is printed in the server's access URL.
  it('rejects a tokenless non-browser client on a loopback bind', () => {
    for (const wsHost of ['127.0.0.1', '::1', 'localhost']) {
      expect(
        verifyClient({
          url: '/',
          hostHeader: LOOPBACK_HOST,
          remoteAddress: '127.0.0.1',
          wsHost,
          expectedToken: TOKEN,
        }),
      ).toBe(false);
    }
  });

  it('admits a non-browser client presenting the token on a loopback bind', () => {
    for (const wsHost of ['127.0.0.1', '::1', 'localhost']) {
      expect(
        verifyClient({
          url: `/?token=${TOKEN}`,
          hostHeader: LOOPBACK_HOST,
          remoteAddress: '127.0.0.1',
          wsHost,
          expectedToken: TOKEN,
        }),
      ).toBe(true);
    }
  });

  it('requires a token on loopback binds when requireToken is enabled', () => {
    // Origin must match the Host header exactly — the hardened
    // originMatchesHost check enforces hostname + port equality, so the
    // cookie authenticates only when the browser's origin IS this server.
    const base = {
      origin: 'http://127.0.0.1:3456',
      url: '/',
      hostHeader: LOOPBACK_HOST,
      wsHost: '127.0.0.1',
      expectedToken: TOKEN,
      requireToken: true,
    } as const;
    expect(verifyClient(base)).toBe(false);
    expect(verifyClient({ ...base, cookieHeader: `ws_token=${TOKEN}` })).toBe(true);
  });

  it('requires the cookie for a non-loopback browser origin — URL token is rejected (C-598)', () => {
    const base = { hostHeader: LOOPBACK_HOST, wsHost: '127.0.0.1', expectedToken: TOKEN } as const;
    // No credential at all → rejected.
    expect(verifyClient({ origin: 'http://192.168.1.5:3000', url: '/', ...base })).toBe(false);
    // URL `?token=` is NO LONGER accepted for a browser client (would leak the
    // token into history / referrer / proxy logs).
    expect(
      verifyClient({ origin: 'http://192.168.1.5:3000', url: `/?token=${TOKEN}`, ...base }),
    ).toBe(false);
    // Explicit public WS URL mode may keep URL-token auth for browser clients
    // when the HttpOnly cookie cannot cross hostnames.
    expect(
      verifyClient({
        origin: 'http://192.168.1.5:3000',
        url: `/?token=${TOKEN}`,
        allowBrowserUrlToken: true,
        allowedHostnames: ['192.168.1.5'],
        ...base,
      }),
    ).toBe(true);
    expect(
      verifyClient({
        origin: 'http://192.168.1.5:3000',
        url: `/?token=${TOKEN}`,
        allowBrowserUrlToken: true,
        allowedHostnames: ['other.example.com'],
        ...base,
      }),
    ).toBe(false);
    // The HttpOnly cookie is the accepted browser credential — but only when
    // the browser Origin matches the request Host (originMatchesHost). On a
    // loopback bind the Host is 127.0.0.1, so a 192.168.1.5 origin can never
    // match. Use a public bind with a matching Host to exercise the cookie
    // acceptance path.
    expect(
      verifyClient({
        origin: 'http://192.168.1.5:3000',
        url: '/',
        cookieHeader: `ws_token=${TOKEN}`,
        hostHeader: '192.168.1.5:3000',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(true);
  });

  it('requires a token for a LAN non-browser client on a public (0.0.0.0) bind', () => {
    // Public binds reject tokenless LAN peers, while a valid operator token
    // authenticates scripts and automation running elsewhere on the LAN.
    expect(
      verifyClient({
        url: '/',
        remoteAddress: '192.168.1.5',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
    expect(
      verifyClient({
        url: `/?token=${TOKEN}`,
        remoteAddress: '192.168.1.5',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(true);
  });

  it('allows a loopback-peer non-browser client on a public bind only with a token', () => {
    const base = { remoteAddress: '127.0.0.1', wsHost: '0.0.0.0', expectedToken: TOKEN } as const;
    expect(verifyClient({ url: '/', ...base })).toBe(false);
    expect(verifyClient({ url: `/?token=${TOKEN}`, ...base })).toBe(true);
  });

  it('rejects a wrong token', () => {
    expect(
      verifyClient({
        url: '/?token=wrong',
        remoteAddress: '127.0.0.1',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
    expect(
      verifyClient({
        origin: 'http://192.168.1.5:3000',
        url: '/?token=wrong',
        hostHeader: LOOPBACK_HOST,
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it('rejects a malformed origin', () => {
    expect(
      verifyClient({
        origin: 'not-a-url',
        url: '/',
        hostHeader: LOOPBACK_HOST,
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it('allows a non-loopback browser with the correct cookie on a public bind', () => {
    // The hardened originMatchesHost check requires the browser Origin to
    // match the request Host (hostname + port), so the Host header must be
    // present and consistent with the Origin for cookie auth to succeed.
    expect(
      verifyClient({
        origin: 'http://10.0.0.5:3000',
        url: '/',
        cookieHeader: `ws_token=${TOKEN}`,
        hostHeader: '10.0.0.5:3000',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(true);
    // Same client presenting the token only in the URL is rejected.
    expect(
      verifyClient({
        origin: 'http://10.0.0.5:3000',
        url: `/?token=${TOKEN}`,
        hostHeader: '10.0.0.5:3000',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it('rejects DNS-rebinding: a non-loopback Host on a loopback bind', () => {
    // Loopback origin + attacker-controlled Host header → the rebinding guard
    // fires before the origin check, so this is rejected.
    expect(
      verifyClient({
        origin: 'http://localhost:3000',
        url: '/',
        hostHeader: 'evil.com:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
    // Missing Host header on a loopback bind is likewise rejected.
    expect(
      verifyClient({
        origin: 'http://localhost:3000',
        url: '/',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it('allows a configured tunnel hostname on a loopback bind only with cookie auth', () => {
    const base = {
      origin: 'https://wrongstack.example.com',
      url: '/',
      hostHeader: 'wrongstack.example.com',
      wsHost: '127.0.0.1',
      expectedToken: TOKEN,
      requireToken: true,
    } as const;

    expect(verifyClient(base)).toBe(false);
    expect(
      verifyClient({
        ...base,
        allowedHostnames: ['wrongstack.example.com'],
      }),
    ).toBe(false);
    expect(
      verifyClient({
        ...base,
        url: `/?token=${TOKEN}`,
        allowedHostnames: ['wrongstack.example.com'],
        allowBrowserUrlToken: true,
      }),
    ).toBe(true);
    expect(
      verifyClient({
        ...base,
        allowedHostnames: ['wrongstack.example.com'],
        cookieHeader: `ws_token=${TOKEN}`,
      }),
    ).toBe(true);
  });
});

describe('isWildcardBind (IPv4 + IPv6 wildcard parity)', () => {
  it('treats 0.0.0.0, ::, and [::] as wildcard binds', () => {
    for (const h of ['0.0.0.0', '::', '[::]']) expect(isWildcardBind(h)).toBe(true);
  });
  it('does not treat loopback or LAN addresses as wildcard binds', () => {
    for (const h of ['127.0.0.1', '::1', 'localhost', '192.168.1.10']) {
      expect(isWildcardBind(h)).toBe(false);
    }
  });
});

describe('verifyClient — IPv6 wildcard (::) bind parity with 0.0.0.0', () => {
  // IPv6 wildcard binds enforce the same token policy as IPv4 wildcard binds.
  it('requires a token for a non-loopback peer (no origin) on a :: bind', () => {
    const base = { remoteAddress: 'fd00::1234', wsHost: '::', expectedToken: TOKEN } as const;
    expect(verifyClient({ url: '/', ...base })).toBe(false);
    expect(verifyClient({ url: `/?token=${TOKEN}`, ...base })).toBe(true);
  });

  it('still admits a loopback peer on a :: bind with the correct token', () => {
    expect(
      verifyClient({
        url: `/?token=${TOKEN}`,
        remoteAddress: '::1',
        wsHost: '::',
        expectedToken: TOKEN,
      }),
    ).toBe(true);
  });

  it('requires the auth cookie for loopback browser origins on a :: bind', () => {
    expect(
      verifyClient({ origin: 'file://localhost', url: '/', wsHost: '::', expectedToken: TOKEN }),
    ).toBe(false);
    expect(
      verifyClient({
        origin: 'http://localhost:3000',
        url: '/',
        wsHost: '::',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
    expect(
      verifyClient({
        origin: 'http://localhost:3000',
        url: '/',
        cookieHeader: `ws_token=${TOKEN}`,
        hostHeader: 'localhost:3000',
        wsHost: '::',
        expectedToken: TOKEN,
      }),
    ).toBe(true);
  });
});

describe('hostHeaderOk (DNS-rebinding guard)', () => {
  it('accepts a loopback Host on a loopback bind', () => {
    for (const hostHeader of ['127.0.0.1:3456', 'localhost:3000', '[::1]:3456']) {
      expect(hostHeaderOk({ hostHeader, wsHost: '127.0.0.1' })).toBe(true);
    }
  });

  it('rejects a non-loopback or missing Host on a loopback bind', () => {
    expect(hostHeaderOk({ hostHeader: 'evil.com:3456', wsHost: '127.0.0.1' })).toBe(false);
    expect(hostHeaderOk({ hostHeader: '', wsHost: '127.0.0.1' })).toBe(false);
    expect(hostHeaderOk({ hostHeader: undefined, wsHost: '127.0.0.1' })).toBe(false);
  });

  it('skips the guard on a public (non-loopback) bind', () => {
    expect(hostHeaderOk({ hostHeader: 'evil.com:3456', wsHost: '0.0.0.0' })).toBe(true);
    expect(hostHeaderOk({ hostHeader: undefined, wsHost: '0.0.0.0' })).toBe(true);
  });

  it('accepts configured tunnel hostnames on a loopback bind', () => {
    expect(
      hostHeaderOk({
        hostHeader: 'wrongstack.example.com:443',
        wsHost: '127.0.0.1',
        allowedHostnames: ['wrongstack.example.com'],
      }),
    ).toBe(true);
  });
});

describe('tokenMatches (constant-time compare)', () => {
  it('matches the exact token', () => {
    expect(tokenMatches(TOKEN, TOKEN)).toBe(true);
  });
  it('rejects a wrong, missing, or length-mismatched token', () => {
    expect(tokenMatches('wrong-token!', TOKEN)).toBe(false);
    expect(tokenMatches(undefined, TOKEN)).toBe(false);
    expect(tokenMatches('short', TOKEN)).toBe(false); // length mismatch short-circuit
  });
});

describe('isLoopbackHostname', () => {
  it('recognizes loopback names', () => {
    for (const h of ['localhost', '127.0.0.1', '::1', '[::1]']) {
      expect(isLoopbackHostname(h)).toBe(true);
    }
  });
  it('rejects non-loopback names', () => {
    for (const h of ['192.168.1.5', '10.0.0.5', 'evil.com', '0.0.0.0']) {
      expect(isLoopbackHostname(h)).toBe(false);
    }
  });
});

// ─── Cookie-based WS auth (C-2 fix) ────────────────────────────────────────

describe('extractTokenFromCookie', () => {
  it('returns undefined for absent / empty cookie header', () => {
    expect(extractTokenFromCookie(undefined)).toBeUndefined();
    expect(extractTokenFromCookie('')).toBeUndefined();
  });

  it('extracts the ws_token value from a single-cookie header', () => {
    expect(extractTokenFromCookie('ws_token=abc123def456')).toBe('abc123def456');
  });

  it('extracts ws_token when it is one of several cookies', () => {
    expect(extractTokenFromCookie('session=xyz; ws_token=abc123def456; theme=dark')).toBe(
      'abc123def456',
    );
  });

  it('URL-decodes the cookie value (server stores the encoded form)', () => {
    // A token with special chars gets encoded by the server when writing the
    // Set-Cookie header. The reader decodes on the way back out.
    expect(extractTokenFromCookie('ws_token=abc%2B123%3D')).toBe('abc+123=');
  });

  it('returns undefined when ws_token is not present', () => {
    expect(extractTokenFromCookie('session=xyz; theme=dark')).toBeUndefined();
  });

  it('accepts string[] cookie headers (some Node http clients)', () => {
    expect(extractTokenFromCookie(['ws_token=abc123def456', 'session=xyz'])).toBe('abc123def456');
  });
});

describe('verifyClient — cookie auth (C-2 path)', () => {
  const TOKEN = 'cookie-token-abc123';
  // The hardened originMatchesHost check requires the browser Origin to match
  // the request Host (hostname + port). Use the public hostname the browser
  // would actually see for both, so cookie auth succeeds.
  const LAN_HOST = 'wrongstack.example.com';

  it('accepts a non-loopback browser origin when cookie matches expected token', () => {
    // LAN-exposed bind, browser origin (so not loopback-bootstrap), valid
    // cookie — must accept. This is the new C-2 path: the token never
    // appears in the URL, the browser sends the HttpOnly cookie
    // automatically on the WS upgrade.
    expect(
      verifyClient({
        origin: 'https://wrongstack.example.com',
        url: '/',
        hostHeader: LAN_HOST,
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
        cookieHeader: `ws_token=${TOKEN}`,
      }),
    ).toBe(true);
  });

  it('rejects a non-loopback browser origin when cookie does not match', () => {
    expect(
      verifyClient({
        origin: 'https://wrongstack.example.com',
        url: '/',
        hostHeader: LAN_HOST,
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
        cookieHeader: 'ws_token=wrong-token',
      }),
    ).toBe(false);
  });

  it('rejects a non-loopback browser origin when cookie is absent', () => {
    // No cookie, no URL token — must reject for a non-loopback browser
    // origin. This is the C-598 closing case (no token leak).
    expect(
      verifyClient({
        origin: 'https://wrongstack.example.com',
        url: '/',
        hostHeader: LAN_HOST,
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
  });

  it('rejects the URL-token path for browser clients (C-598 fully closed)', () => {
    // The legacy `?token=…` URL path is no longer honored for browser clients
    // (it leaks the token into history / referrer / proxy logs). The frontend
    // bootstraps the HttpOnly cookie via /ws-auth before connecting, so browser
    // clients authenticate via the cookie; a URL-only token is rejected.
    expect(
      verifyClient({
        origin: 'https://wrongstack.example.com',
        url: `/?token=${TOKEN}`,
        hostHeader: LAN_HOST,
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(false);
    // The same browser client authenticates successfully via the cookie.
    expect(
      verifyClient({
        origin: 'https://wrongstack.example.com',
        url: '/',
        cookieHeader: `ws_token=${TOKEN}`,
        hostHeader: LAN_HOST,
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      }),
    ).toBe(true);
  });

  it('accepts cookie for non-browser clients on a loopback bind', () => {
    // Non-browser path also benefits from the cookie delivery, in case
    // a CI script wants to use the cookie jar approach instead of
    // `?token=…`. Loopback bind: any remoteAddress on 127.0.0.1 (the
    // very common local curl) is fine — non-loopback peers on a
    // non-loopback bind are denied outright (LAN exposure policy, see
    // the next test).
    expect(
      verifyClient({
        // No origin = non-browser
        url: '/',
        hostHeader: '127.0.0.1:3457',
        remoteAddress: '127.0.0.1',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
        cookieHeader: `ws_token=${TOKEN}`,
      }),
    ).toBe(true);
  });

  it('allows a LAN non-browser peer on a public bind with a valid cookie', () => {
    // Non-browser automation may authenticate with either supported token
    // source; browser-origin requests still follow the stricter cookie path.
    expect(
      verifyClient({
        url: '/',
        hostHeader: LAN_HOST,
        remoteAddress: '192.168.1.20',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
        cookieHeader: `ws_token=${TOKEN}`,
      }),
    ).toBe(true);
  });
});

// ─── HTTP static file path traversal guard ──────────────────────────────────
// Extracted from webui/src/server/index.ts for unit testing.

function isPathSafe(urlPathname: string, distDir: string): boolean {
  const filePath = path.join(distDir, urlPathname);
  const resolvedPath = path.resolve(filePath);
  const resolvedRoot = path.resolve(distDir);
  return resolvedPath.startsWith(resolvedRoot + path.sep) || resolvedPath === resolvedRoot;
}

describe('HTTP static file path traversal guard', () => {
  const DIST = path.resolve('/app/dist');

  it('allows normal paths inside dist', () => {
    expect(isPathSafe('/index.html', DIST)).toBe(true);
    expect(isPathSafe('/assets/main.js', DIST)).toBe(true);
    expect(isPathSafe('/assets/css/style.css', DIST)).toBe(true);
  });

  it('blocks basic dot-dot traversal', () => {
    expect(isPathSafe('/../../../etc/passwd', DIST)).toBe(false);
    expect(isPathSafe('/assets/../../etc/passwd', DIST)).toBe(false);
  });

  it('blocks percent-encoded dot-dot traversal (after URL decoding)', () => {
    // In the real server, new URL() decodes %2e%2e to .. before path.join.
    // Simulate that by decoding first, then checking.
    const decoded = '/../../../etc/passwd'; // what new URL('/%2e%2e/...') produces
    expect(isPathSafe(decoded, DIST)).toBe(false);
  });

  it('blocks paths that resolve outside dist via intermediate traversal', () => {
    expect(isPathSafe('/assets/../../../etc/shadow', DIST)).toBe(false);
  });

  it('allows root path', () => {
    expect(isPathSafe('/', DIST)).toBe(true);
  });
});

// ─── Rate limiter ───────────────────────────────────────────────────────────
// Extracted from cli/src/webui-server.ts for unit testing.

function createRateLimiter(maxMsgs: number, windowMs: number) {
  let msgCount = 0;
  let windowResetAt = Date.now() + windowMs;
  return {
    check(): boolean {
      const now = Date.now();
      if (now > windowResetAt) {
        msgCount = 0;
        windowResetAt = now + windowMs;
      }
      if (++msgCount > maxMsgs) return false;
      return true;
    },
  };
}

describe('WebSocket rate limiter', () => {
  it('allows messages within limit', () => {
    const limiter = createRateLimiter(3, 60_000);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
  });

  it('blocks messages exceeding limit', () => {
    const limiter = createRateLimiter(2, 60_000);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(false);
  });

  it('resets after window expires', () => {
    // Use a very short window (1ms) that expires between checks
    const limiter = createRateLimiter(1, 1);
    expect(limiter.check()).toBe(true);
    expect(limiter.check()).toBe(false);
    // Busy-wait for window to expire (1ms)
    const start = Date.now();
    while (Date.now() - start < 5) {
      /* spin */
    }
    expect(limiter.check()).toBe(true);
  });
});
