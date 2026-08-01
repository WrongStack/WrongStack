import { describe, it, expect } from 'vitest';

import {
  isLoopbackHostname,
  isLoopbackBind,
  isWildcardBind,
  tokenMatches,
  extractToken,
  extractTokenFromCookie,
  hostHeaderOk,
  verifyClient,
} from '../src/server/ws-auth.js';

describe('ws-auth', () => {
  describe('isLoopbackHostname', () => {
    it('returns true for localhost', () => expect(isLoopbackHostname('localhost')).toBe(true));
    it('returns true for 127.0.0.1', () => expect(isLoopbackHostname('127.0.0.1')).toBe(true));
    it('returns true for ::1', () => expect(isLoopbackHostname('::1')).toBe(true));
    it('returns true for [::1]', () => expect(isLoopbackHostname('[::1]')).toBe(true));
    it('returns false for non-loopback hosts', () => {
      expect(isLoopbackHostname('example.com')).toBe(false);
      expect(isLoopbackHostname('192.168.1.1')).toBe(false);
    });
  });

  describe('isLoopbackBind', () => {
    it('returns true for 127.0.0.1', () => expect(isLoopbackBind('127.0.0.1')).toBe(true));
    it('returns true for ::1', () => expect(isLoopbackBind('::1')).toBe(true));
    it('returns true for localhost', () => expect(isLoopbackBind('localhost')).toBe(true));
    it('returns false for wildcard', () => expect(isLoopbackBind('0.0.0.0')).toBe(false));
    it('returns false for LAN', () => expect(isLoopbackBind('192.168.1.1')).toBe(false));
  });

  describe('isWildcardBind', () => {
    it('returns true for 0.0.0.0', () => expect(isWildcardBind('0.0.0.0')).toBe(true));
    it('returns true for ::', () => expect(isWildcardBind('::')).toBe(true));
    it('returns true for [::]', () => expect(isWildcardBind('[::]')).toBe(true));
    it('returns false for loopback', () => expect(isWildcardBind('127.0.0.1')).toBe(false));
  });

  describe('tokenMatches', () => {
    it('returns true for matching tokens', () => expect(tokenMatches('abc123', 'abc123')).toBe(true));
    it('returns false for undefined', () => expect(tokenMatches(undefined, 'abc123')).toBe(false));
    it('returns false for empty string', () => expect(tokenMatches('', 'abc123')).toBe(false));
    it('returns false for length mismatch', () => expect(tokenMatches('short', 'long-token')).toBe(false));
    it('returns false for different tokens same length', () => expect(tokenMatches('aaaaaa', 'bbbbbb')).toBe(false));
  });

  describe('extractToken', () => {
    it('extracts token from query param', () => expect(extractToken('/?token=mysecret')).toBe('mysecret'));
    it('extracts token among other params', () => expect(extractToken('/p?foo=1&token=secret&bar=2')).toBe('secret'));
    it('returns undefined when no token param', () => expect(extractToken('/?foo=bar')).toBeUndefined());
    it('returns undefined on empty url', () => expect(extractToken('')).toBeUndefined());
  });

  describe('extractTokenFromCookie', () => {
    it('extracts ws_token', () => expect(extractTokenFromCookie('ws_token=secret')).toBe('secret'));
    it('handles array of headers', () => expect(extractTokenFromCookie(['ws_token=secret1', 'x=y'])).toBe('secret1'));
    it('returns undefined when no cookie', () => expect(extractTokenFromCookie(undefined)).toBeUndefined());
    it('returns undefined when ws_token missing', () => expect(extractTokenFromCookie('other=val')).toBeUndefined());
    it('decodes url-encoded values', () => expect(extractTokenFromCookie('ws_token=secret%20value')).toBe('secret value'));
    it('handles malformed encoding', () => {
      const result = extractTokenFromCookie('ws_token=secret%GG');
      expect(result).toBeDefined();
    });
    it('handles empty cookie parts', () => expect(extractTokenFromCookie(';; ws_token=val ;;')).toBe('val'));
  });

  describe('hostHeaderOk', () => {
    it('passes non-loopback bind regardless of host', () => {
      expect(hostHeaderOk({ hostHeader: 'evil.com', wsHost: '0.0.0.0' })).toBe(true);
    });
    it('rejects missing host on loopback bind', () => {
      expect(hostHeaderOk({ hostHeader: undefined, wsHost: '127.0.0.1' })).toBe(false);
    });
    it('rejects empty host on loopback bind', () => {
      expect(hostHeaderOk({ hostHeader: '', wsHost: '127.0.0.1' })).toBe(false);
    });
    it('accepts localhost on loopback bind', () => {
      expect(hostHeaderOk({ hostHeader: 'localhost:3456', wsHost: '127.0.0.1' })).toBe(true);
    });
    it('accepts 127.0.0.1 on loopback bind', () => {
      expect(hostHeaderOk({ hostHeader: '127.0.0.1:3456', wsHost: '127.0.0.1' })).toBe(true);
    });
    it('rejects non-loopback host on loopback bind', () => {
      expect(hostHeaderOk({ hostHeader: 'evil.com', wsHost: '127.0.0.1' })).toBe(false);
    });
    it('accepts IPv6 bracketed host', () => {
      expect(hostHeaderOk({ hostHeader: '[::1]:3456', wsHost: '::1' })).toBe(true);
    });
    it('accepts allowed hostnames', () => {
      expect(hostHeaderOk({ hostHeader: 'tun.example.com', wsHost: '127.0.0.1', allowedHostnames: ['tun.example.com'] })).toBe(true);
    });
    it('rejects unparseable host header', () => {
      expect(hostHeaderOk({ hostHeader: 'bad header here', wsHost: '127.0.0.1' })).toBe(false);
    });
  });

  describe('verifyClient', () => {
    const TOKEN = 'test-token-123';

    it('allows loopback browser origin without token (loopback bind)', () => {
      expect(verifyClient({
        origin: 'http://localhost:3456',
        url: '/',
        hostHeader: 'localhost:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(true);
    });

    it('allows 127.0.0.1 browser origin without token', () => {
      expect(verifyClient({
        origin: 'http://127.0.0.1:3456',
        url: '/',
        hostHeader: '127.0.0.1:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(true);
    });

    // WS-003: the WS handshake is exempt from the same-origin policy, so a
    // hostname-only loopback check trusts every other process listening on this
    // machine. An XSS on any local dev server could otherwise open a tokenless
    // socket here and drive the agent.
    it('rejects a loopback browser origin on a DIFFERENT port', () => {
      expect(verifyClient({
        origin: 'http://localhost:9999',
        url: '/',
        hostHeader: 'localhost:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(false);
    });

    it('rejects a cross-port loopback origin even across loopback aliases', () => {
      expect(verifyClient({
        origin: 'http://127.0.0.1:5173',
        url: '/',
        hostHeader: 'localhost:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(false);
    });

    it('still admits a cross-port origin when it presents a valid cookie', () => {
      expect(verifyClient({
        origin: 'http://localhost:9999',
        url: '/',
        hostHeader: 'localhost:3456',
        cookieHeader: `ws_token=${TOKEN}`,
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(true);
    });

    it('rejects a loopback origin when the Host header is missing', () => {
      expect(verifyClient({
        origin: 'http://localhost:3456',
        url: '/',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(false);
    });

    it('rejects file:// origin even on loopback', () => {
      expect(verifyClient({
        origin: 'file:///index.html',
        url: '/',
        hostHeader: 'localhost:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(false);
    });

    it('rejects non-loopback browser origin without token', () => {
      expect(verifyClient({
        origin: 'http://example.com',
        url: '/',
        hostHeader: 'example.com',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(false);
    });

    it('allows non-loopback browser origin with valid cookie token on wildcard bind', () => {
      // Non-loopback origins need a non-loopback bind (0.0.0.0) so Host check passes
      expect(verifyClient({
        origin: 'http://example.com',
        url: '/',
        hostHeader: 'example.com',
        cookieHeader: 'ws_token=test-token-123',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      })).toBe(true);
    });

    it('allows non-loopback origin with URL token when allowBrowserUrlToken + allowedHostname match', () => {
      expect(verifyClient({
        origin: 'http://tunnel.example.com',
        url: '/?token=test-token-123',
        hostHeader: 'tunnel.example.com',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
        allowBrowserUrlToken: true,
        allowedHostnames: ['tunnel.example.com'],
      })).toBe(true);
    });

    it('rejects non-loopback origin without matching allowedHostname', () => {
      expect(verifyClient({
        origin: 'http://evil.com',
        url: '/?token=test-token-123',
        hostHeader: 'evil.com',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
        allowBrowserUrlToken: true,
        allowedHostnames: ['good.example.com'],
      })).toBe(false);
    });

    it('rejects unparseable origin', () => {
      expect(verifyClient({
        origin: 'not a url',
        url: '/',
        hostHeader: 'localhost:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(false);
    });

    it('allows non-browser client with URL token on non-wildcard bind', () => {
      // Non-wildcard bind (specific LAN IP) skips the LAN exposure deny
      expect(verifyClient({
        origin: undefined,
        url: '/?token=test-token-123',
        hostHeader: '192.168.1.1',
        wsHost: '192.168.1.1',
        expectedToken: TOKEN,
      })).toBe(true);
    });

    it('rejects non-browser client from remote IP on wildcard bind without token', () => {
      expect(verifyClient({
        origin: undefined,
        url: '/',
        hostHeader: 'example.com',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
        remoteAddress: '192.168.1.1',
      })).toBe(false);
    });

    it('allows non-browser client from remote IP on wildcard bind with valid URL token', () => {
      expect(verifyClient({
        origin: undefined,
        url: '/?token=test-token-123',
        hostHeader: '100.64.0.1:3456',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
        remoteAddress: '100.64.0.1',
      })).toBe(true);
    });

    it('allows non-browser client from remote IP on wildcard bind with valid cookie token', () => {
      expect(verifyClient({
        origin: undefined,
        url: '/',
        hostHeader: '100.64.0.1:3456',
        cookieHeader: 'ws_token=test-token-123',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
        remoteAddress: '100.64.0.1',
      })).toBe(true);
    });

    it('allows non-browser client from loopback IP on wildcard bind with token', () => {
      expect(verifyClient({
        origin: undefined,
        url: '/?token=test-token-123',
        hostHeader: '127.0.0.1:3456',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
        remoteAddress: '127.0.0.1',
      })).toBe(true);
    });

    it('allows non-browser client on loopback bind without token', () => {
      expect(verifyClient({
        origin: undefined,
        url: '/',
        hostHeader: 'localhost:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(true);
    });

    it('rejects client when hostHeader fails loopback check', () => {
      expect(verifyClient({
        origin: 'http://localhost:3456',
        url: '/',
        hostHeader: 'evil.com',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(false);
    });

    it('rejects loopback origin with requireToken and no cookie', () => {
      expect(verifyClient({
        origin: 'http://localhost:3456',
        url: '/',
        hostHeader: 'localhost:3456',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
        requireToken: true,
      })).toBe(false);
    });

    it('allows loopback origin with requireToken and valid cookie', () => {
      expect(verifyClient({
        origin: 'http://localhost:3456',
        url: '/',
        hostHeader: 'localhost:3456',
        cookieHeader: 'ws_token=test-token-123',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
        requireToken: true,
      })).toBe(true);
    });

    it('rejects non-loopback origin on non-loopback bind without cookie', () => {
      expect(verifyClient({
        origin: 'http://example.com',
        url: '/',
        hostHeader: 'example.com',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      })).toBe(false);
    });

    it('allows non-browser client with valid cookie token', () => {
      expect(verifyClient({
        origin: undefined,
        url: '/',
        hostHeader: 'localhost:3456',
        cookieHeader: 'ws_token=test-token-123',
        wsHost: '127.0.0.1',
        expectedToken: TOKEN,
      })).toBe(true);
    });

    it('allows non-loopback browser origin on non-loopback bind with cookie', () => {
      expect(verifyClient({
        origin: 'http://example.com',
        url: '/',
        hostHeader: 'example.com',
        cookieHeader: 'ws_token=test-token-123',
        wsHost: '0.0.0.0',
        expectedToken: TOKEN,
      })).toBe(true);
    });
  });
});
