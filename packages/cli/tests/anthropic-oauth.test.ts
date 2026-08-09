import { createHash } from 'node:crypto';
import { isParseError } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  generatePkce,
  parseAuthorizationInput,
} from '../src/auth-menu/anthropic-oauth.js';
import { expectFetchError } from './helpers/fetch-error.js';

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generatePkce', () => {
  it('produces a base64url verifier with a matching S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });
});

describe('buildAuthorizeUrl', () => {
  it('uses claude.ai, code=true, and the verifier as state', () => {
    const url = new URL(buildAuthorizeUrl('CHAL', 'VERIFIER'));
    expect(url.origin + url.pathname).toBe('https://claude.ai/oauth/authorize');
    const p = url.searchParams;
    expect(p.get('code')).toBe('true');
    expect(p.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(p.get('redirect_uri')).toBe('http://localhost:53692/callback');
    expect(p.get('code_challenge')).toBe('CHAL');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('VERIFIER');
    expect(p.get('scope')).toContain('user:inference');
  });
});

describe('parseAuthorizationInput', () => {
  it('parses a redirect URL, bare query, and bare code', () => {
    expect(parseAuthorizationInput('http://localhost:53692/callback?code=a&state=b')).toEqual({
      code: 'a',
      state: 'b',
    });
    expect(parseAuthorizationInput('code=a&state=b')).toEqual({ code: 'a', state: 'b' });
    expect(parseAuthorizationInput('rawcode#st')).toEqual({ code: 'rawcode', state: 'st' });
  });
});

describe('exchangeAuthorizationCode', () => {
  it('POSTs a JSON authorization_code body and maps tokens', async () => {
    let captured: {
      url: string | undefined;
      body: string | undefined;
      contentType: string | undefined;
    } = {
      url: undefined,
      body: undefined,
      contentType: undefined,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string; headers?: Record<string, string> }) => {
        captured = {
          url,
          body: init.body,
          contentType: init.headers?.['content-type'],
        };
        return new Response(
          JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 3600 }),
          { status: 200 },
        );
      }),
    );

    const tokens = await exchangeAuthorizationCode('CODE', 'STATE', 'VERIFIER');
    expect(captured.url).toBe('https://platform.claude.com/v1/oauth/token');
    expect(captured.contentType).toBe('application/json');
    const body = JSON.parse(captured.body ?? '{}');
    expect(body).toMatchObject({
      grant_type: 'authorization_code',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      code: 'CODE',
      state: 'STATE',
      redirect_uri: 'http://localhost:53692/callback',
      code_verifier: 'VERIFIER',
    });
    expect(tokens.access).toBe('AT');
    expect(tokens.refresh).toBe('RT');
  });

  it('throws on a non-2xx response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('nope', { status: 400 })),
    );
    await expect(exchangeAuthorizationCode('C', 'S', 'V')).rejects.toThrow(
      /token exchange failed/i,
    );
  });

  it('non-2xx response throws a structured FetchError (anthropic-oauth provider context)', async () => {
    // Locks in the structured FetchError shape so the migration can't
    // accidentally regress to a bare Error.
    const fe = await expectFetchError(() => exchangeAuthorizationCode('C', 'S', 'V'), {
      status: 400,
      body: '{"error":"invalid_grant"}',
      context: {
        provider: 'anthropic-oauth',
        op: 'exchange',
        // The token endpoint URL flows through `context` so consumers can
        // distinguish a 400 from the Claude token endpoint vs. any other URL.
        url: 'https://platform.claude.com/v1/oauth/token',
      },
    });
    // `fe` returned for any additional per-test assertions (currently none).
    expect(fe).toBeDefined();
  });

  it('2xx response with missing fields throws a structured ParseError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 })),
    );
    let caught: unknown;
    try {
      await exchangeAuthorizationCode('C', 'S', 'V');
    } catch (err) {
      caught = err;
    }
    expect(isParseError(caught)).toBe(true);
    const pe = caught as ReturnType<typeof isParseError> & {
      source?: string;
      context?: Record<string, unknown>;
    };
    expect(pe.source).toBe('anthropic-oauth-token-response');
    expect(pe.context?.op).toBe('exchange');
  });
});
