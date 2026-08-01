/**
 * WS-009 — HQ browser tokens in the URL query are confined to loopback requests.
 *
 * `assessHqExposure` warns that on a non-loopback bind "tokens travel in
 * cleartext and appear in the URL query", and `extractBrowserToken` told
 * operators to use the Authorization header once HQ is exposed beyond
 * localhost — but nothing enforced either statement. Off-loopback the leak
 * channels are real (reverse-proxy access logs, shared browser history, Referer
 * to third-party origins), so the query param is refused there. On loopback it
 * stays available, because the inline dashboard fallback and manual curl access
 * depend on it.
 *
 * The Host header is authoritative here: `hasTrustedRequestAuthority` pins it to
 * the configured bind before any handler runs, so a request cannot claim a
 * loopback Host it did not arrive on.
 */
import type * as http from 'node:http';
import { hqTokenVerifier } from '@wrongstack/core/hq';
import { describe, expect, it } from 'vitest';
import { authenticateBrowserRequest } from '../src/hq-server/auth.js';

const TOKEN = 'hq-browser-token-abcdefghijklmnop';

function fakeReq(host: string | undefined, authorization?: string): http.IncomingMessage {
  return {
    headers: {
      ...(host !== undefined ? { host } : {}),
      ...(authorization !== undefined ? { authorization } : {}),
    },
  } as unknown as http.IncomingMessage;
}

// WS-044: the live sets hold `sha256(secret)` verifiers, never the secret —
// `authenticateBrowserRequest` hashes what the caller presented before it
// looks anything up. Mirror the server's projection here or the fixture would
// be testing a shape that no longer exists.
const VERIFIER = hqTokenVerifier(TOKEN);

function mutableAuth(expiresAt?: string) {
  return {
    browserTokens: new Set([VERIFIER]),
    browserTokenObjs: new Map([
      [VERIFIER, { id: 'tok_1', ...(expiresAt !== undefined ? { expiresAt } : {}) }],
    ]),
  };
}

function authFor(
  host: string | undefined,
  urlStr: string,
  authorization?: string,
  expiresAt?: string,
) {
  return authenticateBrowserRequest(
    fakeReq(host, authorization),
    new URL(urlStr, 'http://placeholder.invalid'),
    mutableAuth(expiresAt),
    new Map(),
  );
}

describe('HQ browser token — query-param scope', () => {
  it('accepts a query token on a loopback request', () => {
    const auth = authFor('127.0.0.1:3499', `/api/state?token=${TOKEN}`);
    expect(auth).toBeDefined();
    expect(auth?.kind).toBe('token');
  });

  it('accepts a query token on localhost and on the wider 127/8 block', () => {
    for (const host of ['localhost:3499', '127.0.0.5:3499', '[::1]:3499']) {
      expect(authFor(host, `/api/state?token=${TOKEN}`)?.kind).toBe('token');
    }
  });

  it('refuses a query token on a LAN request', () => {
    expect(authFor('192.168.1.42:3499', `/api/state?token=${TOKEN}`)).toBeUndefined();
  });

  it('refuses a query token on a public hostname', () => {
    expect(authFor('hq.example.com', `/api/state?token=${TOKEN}`)).toBeUndefined();
  });

  it('refuses a query token when the Host header is absent or unparseable', () => {
    expect(authFor(undefined, `/api/state?token=${TOKEN}`)).toBeUndefined();
    expect(authFor('%%%', `/api/state?token=${TOKEN}`)).toBeUndefined();
  });

  it('still accepts the Authorization header off-loopback', () => {
    const auth = authFor('192.168.1.42:3499', '/api/state', `Bearer ${TOKEN}`);
    expect(auth?.kind).toBe('token');
  });

  it('prefers the header and ignores a rejected query token off-loopback', () => {
    const auth = authFor('192.168.1.42:3499', `/api/state?token=${TOKEN}`, `Bearer ${TOKEN}`);
    expect(auth?.kind).toBe('token');
  });
});

/**
 * WS-011 — token expiry is enforced at the authentication boundary.
 *
 * Expiry was previously applied only when the auth watcher rebuilt the live
 * token set, so an expired token still authenticated between passes, and the
 * reload path re-admitted expired entries outright because it read the raw file
 * without filtering. `tokenHasCapability` does check expiry, but a token with no
 * `capabilities` field never reaches it.
 */
describe('HQ browser token — expiry', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  const future = new Date(Date.now() + 60 * 60_000).toISOString();

  it('rejects an expired token presented in the Authorization header', () => {
    expect(authFor('127.0.0.1:3499', '/api/state', `Bearer ${TOKEN}`, past)).toBeUndefined();
  });

  it('rejects an expired token presented in the loopback query param', () => {
    expect(authFor('127.0.0.1:3499', `/api/state?token=${TOKEN}`, undefined, past)).toBeUndefined();
  });

  it('accepts a token whose expiry is still in the future', () => {
    expect(authFor('127.0.0.1:3499', '/api/state', `Bearer ${TOKEN}`, future)?.kind).toBe('token');
  });

  it('accepts a token with no expiry at all (pre-TTL default)', () => {
    expect(authFor('127.0.0.1:3499', '/api/state', `Bearer ${TOKEN}`)?.kind).toBe('token');
  });
});
