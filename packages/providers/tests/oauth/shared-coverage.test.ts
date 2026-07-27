/**
 * Comprehensive coverage for providers/src/oauth/shared.ts — PKCE, state,
 * parseAuthorizationInput, callbackHtml, and startLoopbackServer.
 */
import { describe, expect, it } from 'vitest';
import {
  base64url,
  generatePkce,
  createState,
  parseAuthorizationInput,
  callbackHtml,
  startLoopbackServer,
} from '../../src/oauth/shared.js';

describe('base64url', () => {
  it('encodes a buffer to URL-safe base64', () => {
    expect(base64url(Buffer.from('hello'))).toBe('aGVsbG8');
  });
  it('replaces + with -', () => {
    expect(base64url(Buffer.from([0xff, 0xff, 0xff]))).not.toContain('+');
  });
  it('replaces / with _', () => {
    const result = base64url(Buffer.from([0xff, 0xff, 0xff]));
    expect(result).not.toContain('/');
  });
  it('strips trailing =', () => {
    expect(base64url(Buffer.from('a'))).not.toContain('=');
  });
});

describe('generatePkce', () => {
  it('returns verifier and challenge strings', () => {
    const pkce = generatePkce();
    expect(pkce.verifier).toBeDefined();
    expect(pkce.challenge).toBeDefined();
    expect(typeof pkce.verifier).toBe('string');
    expect(typeof pkce.challenge).toBe('string');
  });
  it('produces different verifier each call', () => {
    const a = generatePkce();
    const b = generatePkce();
    expect(a.verifier).not.toBe(b.verifier);
  });
  it('challenge is S256 hash of verifier', () => {
    const crypto = require('node:crypto') as typeof import('node:crypto');
    const pkce = generatePkce();
    const expected = crypto
      .createHash('sha256')
      .update(pkce.verifier)
      .digest()
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(pkce.challenge).toBe(expected);
  });
});

describe('createState', () => {
  it('returns a URL-safe string', () => {
    const state = createState();
    expect(typeof state).toBe('string');
    expect(state.length).toBeGreaterThan(0);
  });
  it('produces different values each call', () => {
    expect(createState()).not.toBe(createState());
  });
});

describe('parseAuthorizationInput', () => {
  it('returns empty for empty string', () => {
    expect(parseAuthorizationInput('')).toEqual({});
  });
  it('returns empty for whitespace-only string', () => {
    expect(parseAuthorizationInput('   ')).toEqual({});
  });
  it('parses a full redirect URL with code and state', () => {
    const result = parseAuthorizationInput('http://localhost:53692/callback?code=abc123&state=xyz');
    expect(result.code).toBe('abc123');
    expect(result.state).toBe('xyz');
  });
  it('parses a full redirect URL without state', () => {
    const result = parseAuthorizationInput('http://localhost:53692/callback?code=abc123');
    expect(result.code).toBe('abc123');
    expect(result.state).toBeUndefined();
  });
  it('parses hash-separated code#state', () => {
    const result = parseAuthorizationInput('mycode#mystate');
    expect(result.code).toBe('mycode');
    expect(result.state).toBe('mystate');
  });
  it('parses query string code=&state=', () => {
    const result = parseAuthorizationInput('code=abc&state=def');
    expect(result.code).toBe('abc');
    expect(result.state).toBe('def');
  });
  it('parses bare code when no separators', () => {
    const result = parseAuthorizationInput('bare-code-123');
    expect(result.code).toBe('bare-code-123');
    expect(result.state).toBeUndefined();
  });
  it('handles code= without state', () => {
    const result = parseAuthorizationInput('code=onlycode');
    expect(result.code).toBe('onlycode');
  });
});

describe('callbackHtml', () => {
  it('generates success HTML', () => {
    const html = callbackHtml(true, 'You can close this window.');
    expect(html).toContain('Authentication successful');
    expect(html).toContain('You can close this window.');
  });
  it('generates failure HTML', () => {
    const html = callbackHtml(false, 'Something went wrong.');
    expect(html).toContain('Authentication failed');
    expect(html).toContain('Something went wrong.');
  });
});

describe('startLoopbackServer', () => {
  it('binds to the requested port and returns a server', async () => {
    const srv = await startLoopbackServer({
      port: 0, // ephemeral
      host: '127.0.0.1',
      path: '/callback',
      expectedState: 'test-state',
    });
    expect(srv.bound).toBe(true);
    expect(srv.port).toBeGreaterThan(0);
    srv.close();
  }, 5000);

  it('returns null code when close is called before any callback', async () => {
    const srv = await startLoopbackServer({
      port: 0,
      host: '127.0.0.1',
      path: '/callback',
      expectedState: 'test-state',
    });
    srv.close();
    const result = await srv.waitForCode();
    expect(result).toBeNull();
  }, 5000);

  it('aborts when signal is already aborted', async () => {
    const ac = new AbortController();
    ac.abort();
    const srv = await startLoopbackServer({
      port: 0,
      host: '127.0.0.1',
      path: '/callback',
      expectedState: 'test',
      signal: ac.signal,
    });
    const result = await srv.waitForCode();
    expect(result).toBeNull();
    srv.close();
  }, 5000);
});
