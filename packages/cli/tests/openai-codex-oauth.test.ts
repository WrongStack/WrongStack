import { createHash } from 'node:crypto';
import { isParseError, type ModelsRegistry } from '@wrongstack/core/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  buildAuthorizeUrl,
  exchangeAuthorizationCode,
  extractAccountId,
  fetchCodexModels,
  generatePkce,
  parseAuthorizationInput,
  refreshCodexToken,
  resolveCodexModels,
  startLoopbackServer,
} from '../src/auth-menu/openai-codex-oauth.js';
import { expectFetchError } from './helpers/fetch-error.js';

function b64url(s: string): string {
  return Buffer.from(s).toString('base64url');
}

function fakeJwt(accountId: string): string {
  const payload = b64url(
    JSON.stringify({ 'https://api.openai.com/auth': { chatgpt_account_id: accountId } }),
  );
  return `${b64url('{}')}.${payload}.sig`;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('generatePkce', () => {
  it('produces a base64url verifier with a matching S256 challenge', () => {
    const { verifier, challenge } = generatePkce();
    expect(verifier).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(challenge).toMatch(/^[A-Za-z0-9_-]+$/);
    const expected = createHash('sha256')
      .update(verifier)
      .digest('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    expect(challenge).toBe(expected);
  });

  it('is random per call', () => {
    expect(generatePkce().verifier).not.toBe(generatePkce().verifier);
  });
});

describe('startLoopbackServer cancellation', () => {
  it('resolves waitForCode() to null when the abort signal fires (Ctrl+C)', async () => {
    const ac = new AbortController();
    const server = await startLoopbackServer('STATE', ac.signal);
    try {
      const pending = server.waitForCode();
      // Simulate the user pressing Ctrl+C while we wait on the loopback.
      ac.abort();
      await expect(pending).resolves.toBeNull();
    } finally {
      server.close();
    }
  });

  it('resolves immediately when handed an already-aborted signal', async () => {
    const server = await startLoopbackServer('STATE', AbortSignal.abort());
    try {
      await expect(server.waitForCode()).resolves.toBeNull();
    } finally {
      server.close();
    }
  });
});

describe('buildAuthorizeUrl', () => {
  it('includes all Codex-required query params', () => {
    const url = new URL(buildAuthorizeUrl('CHAL', 'STATE'));
    expect(url.origin + url.pathname).toBe('https://auth.openai.com/oauth/authorize');
    const p = url.searchParams;
    expect(p.get('response_type')).toBe('code');
    expect(p.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(p.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(p.get('scope')).toBe(
      'openid profile email offline_access api.connectors.read api.connectors.invoke',
    );
    expect(p.get('code_challenge')).toBe('CHAL');
    expect(p.get('code_challenge_method')).toBe('S256');
    expect(p.get('state')).toBe('STATE');
    expect(p.get('id_token_add_organizations')).toBe('true');
    expect(p.get('codex_cli_simplified_flow')).toBe('true');
    expect(p.get('originator')).toBe('wrongstack');
  });

  it('uses the selected callback port in the redirect URI', () => {
    const url = new URL(buildAuthorizeUrl('CHAL', 'STATE', 1457));
    expect(url.searchParams.get('redirect_uri')).toBe('http://localhost:1457/auth/callback');
  });
});

describe('parseAuthorizationInput', () => {
  it('parses a full redirect URL', () => {
    expect(
      parseAuthorizationInput('http://localhost:1455/auth/callback?code=abc&state=xyz'),
    ).toEqual({ code: 'abc', state: 'xyz' });
  });
  it('parses a bare query string', () => {
    expect(parseAuthorizationInput('code=abc&state=xyz')).toEqual({ code: 'abc', state: 'xyz' });
  });
  it('treats a bare token as the code', () => {
    expect(parseAuthorizationInput('justcode')).toEqual({ code: 'justcode' });
  });
});

describe('extractAccountId', () => {
  it('decodes the chatgpt_account_id claim', () => {
    expect(extractAccountId(fakeJwt('acc_7'))).toBe('acc_7');
  });
  it('returns null when absent', () => {
    expect(extractAccountId('garbage')).toBeNull();
  });
});

describe('exchangeAuthorizationCode', () => {
  it('POSTs the authorization_code grant and maps the token response', async () => {
    let captured: {
      url: string | undefined;
      body: string | undefined;
    } = {
      url: undefined,
      body: undefined,
    };
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: { body?: string }) => {
        captured = { url, body: init.body };
        return new Response(
          JSON.stringify({
            access_token: 'AT',
            refresh_token: 'RT',
            expires_in: 3600,
            id_token: 'ID',
          }),
          { status: 200 },
        );
      }),
    );

    const before = Date.now();
    const tokens = await exchangeAuthorizationCode('CODE', 'VERIFIER');
    expect(captured.url).toBe('https://auth.openai.com/oauth/token');
    const body = new URLSearchParams(captured.body ?? '');
    expect(body.get('grant_type')).toBe('authorization_code');
    expect(body.get('client_id')).toBe('app_EMoamEEZ73f0CkXaXp7hrann');
    expect(body.get('code')).toBe('CODE');
    expect(body.get('code_verifier')).toBe('VERIFIER');
    expect(body.get('redirect_uri')).toBe('http://localhost:1455/auth/callback');
    expect(tokens.access).toBe('AT');
    expect(tokens.refresh).toBe('RT');
    expect(tokens.idToken).toBe('ID');
    expect(tokens.expires).toBeGreaterThanOrEqual(before + 3600 * 1000);
  });

  it('uses the selected callback port for token exchange', async () => {
    let body = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        body = init.body ?? '';
        return new Response(
          JSON.stringify({ access_token: 'AT', refresh_token: 'RT', expires_in: 1 }),
          {
            status: 200,
          },
        );
      }),
    );

    await exchangeAuthorizationCode('CODE', 'VERIFIER', undefined, 1457);
    expect(new URLSearchParams(body).get('redirect_uri')).toBe(
      'http://localhost:1457/auth/callback',
    );
  });

  it('throws on a non-2xx token response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('bad', { status: 400 })),
    );
    await expect(exchangeAuthorizationCode('CODE', 'V')).rejects.toThrow(/token exchange failed/i);
  });

  it('non-2xx token response throws a structured FetchError (openai-codex provider context)', async () => {
    // Locks in the FetchError class + structured context so the migration
    // can't accidentally regress to a bare Error.
    const fe = await expectFetchError(() => exchangeAuthorizationCode('CODE', 'V'), {
      status: 400,
      body: '{"error":"invalid_grant"}',
      context: {
        provider: 'openai-codex',
        op: 'exchange',
        url: 'https://auth.openai.com/oauth/token',
      },
    });
    expect(fe).toBeDefined();
  });
});

describe('fetchCodexModels', () => {
  it('returns model ids from a standard OpenAI { data: [...] } response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            { id: 'gpt-5.5', object: 'model' },
            { id: 'gpt-5.4', object: 'model' },
            { id: 'gpt-5.4-mini', object: 'model' },
          ],
        }),
      ),
    );
    const ids = await fetchCodexModels('test-token');
    expect(ids).toEqual(['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini']);
  });

  it('returns model ids from a { models: [...] } response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          models: [{ id: 'gpt-5.3-codex-spark' }, { id: 'gpt-5.2' }],
        }),
      ),
    );
    const ids = await fetchCodexModels('test-token');
    expect(ids).toEqual(['gpt-5.3-codex-spark', 'gpt-5.2']);
  });

  it('returns [] on HTTP error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Forbidden', { status: 403 })),
    );
    const ids = await fetchCodexModels('test-token');
    expect(ids).toEqual([]);
  });

  it('returns [] on network error', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('ECONNREFUSED');
      }),
    );
    const ids = await fetchCodexModels('test-token');
    expect(ids).toEqual([]);
  });

  it('returns [] when json has no models array', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => Response.json({})),
    );
    const ids = await fetchCodexModels('test-token');
    expect(ids).toEqual([]);
  });

  it('uses custom baseUrl when provided', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return Response.json({ data: [{ id: 'gpt-5.5' }] });
      }),
    );
    await fetchCodexModels('tok', 'https://my-proxy.example.com');
    expect(capturedUrl).toBe('https://my-proxy.example.com/models');
  });

  it('strips trailing slashes from baseUrl before appending /models', async () => {
    let capturedUrl = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string) => {
        capturedUrl = url;
        return Response.json({});
      }),
    );
    await fetchCodexModels('tok', 'https://chatgpt.com/backend-api/');
    expect(capturedUrl).toBe('https://chatgpt.com/backend-api/models');
  });

  it('skips entries without a string id', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [{ id: 'gpt-5.5' }, { id: null }, { id: '' }, { notId: 'gpt-5.4' }],
        }),
      ),
    );
    const ids = await fetchCodexModels('test-token');
    expect(ids).toEqual(['gpt-5.5']);
  });
});

describe('resolveCodexModels', () => {
  it('filters live discovery to current Codex models before saving', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          data: [
            { id: 'gpt-5.2' },
            { id: 'gpt-6-astra' },
            { id: 'gpt-5.4-mini' },
            { id: 'gpt-5.3-codex' },
            { id: 'gpt-5.5' },
            { id: 'gpt-5.6-sol' },
            { id: 'gpt-5.6-terra' },
            { id: 'gpt-5.6-luna' },
          ],
        }),
      ),
    );
    const registry = {
      getProvider: vi.fn(async () => {
        throw new Error('catalog should not be used');
      }),
    } as never as ModelsRegistry;

    await expect(resolveCodexModels(registry, 'test-token')).resolves.toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4-mini',
    ]);
  });

  it('uses Codex-family models from the catalog when live discovery is unavailable', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Forbidden', { status: 403 })),
    );
    const registry = {
      getProvider: vi.fn(async (id: string) =>
        id === 'openai'
          ? {
              models: [
                { id: 'gpt-6-astra', family: 'gpt-codex' },
                { id: 'gpt-5.6-sol', family: 'gpt-codex' },
                { id: 'gpt-5.5', family: 'gpt-codex' },
                { id: 'gpt-5.6-terra', family: 'gpt-codex' },
                { id: 'gpt-5.6-luna', family: 'gpt-codex' },
                // No longer in core's CODEX_MODELS catalog: the resolver must
                // narrow this away even though the models.dev catalog lists it.
                { id: 'gpt-5.4', family: 'gpt-codex' },
                { id: 'gpt-5.4-mini', family: 'gpt-codex' },
                { id: 'gpt-5.3-codex-spark', family: 'gpt-codex-spark' },
                { id: 'gpt-5.3-codex', family: 'gpt-codex' },
                { id: 'gpt-4o', family: 'gpt-4o' },
              ],
            }
          : undefined,
      ),
    } as never as ModelsRegistry;

    await expect(resolveCodexModels(registry, 'test-token')).resolves.toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
  });

  it('falls back to the seeded Codex model list when live discovery and catalog miss', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response('Forbidden', { status: 403 })),
    );
    const registry = {
      getProvider: vi.fn(async () => undefined),
    } as never as ModelsRegistry;

    await expect(resolveCodexModels(registry, 'test-token')).resolves.toEqual([
      'gpt-6-astra',
      'gpt-5.6-sol',
      'gpt-5.5',
      'gpt-5.6-terra',
      'gpt-5.6-luna',
      'gpt-5.4-mini',
      'gpt-5.3-codex-spark',
    ]);
  });
});

describe('refreshCodexToken', () => {
  it('POSTs the refresh_token grant', async () => {
    let body = '';
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init: { body?: string }) => {
        body = init.body ?? '';
        return new Response(
          JSON.stringify({ access_token: 'AT2', refresh_token: 'RT2', expires_in: 60 }),
          { status: 200 },
        );
      }),
    );
    const tokens = await refreshCodexToken('OLD_RT');
    const params = new URLSearchParams(body);
    expect(params.get('grant_type')).toBe('refresh_token');
    expect(params.get('refresh_token')).toBe('OLD_RT');
    expect(tokens.access).toBe('AT2');
    expect(tokens.refresh).toBe('RT2');
  });

  it('non-2xx refresh response throws a structured FetchError (openai-codex refresh context)', async () => {
    // Same shape as the exchange path, with op: 'refresh'.
    const fe = await expectFetchError(() => refreshCodexToken('OLD_RT'), {
      status: 401,
      body: '{"error":"invalid_grant"}',
      context: {
        provider: 'openai-codex',
        op: 'refresh',
        url: 'https://auth.openai.com/oauth/token',
      },
    });
    expect(fe).toBeDefined();
  });

  it('2xx response with missing fields throws a structured ParseError', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ access_token: 'AT' }), { status: 200 })),
    );
    let caught: unknown;
    try {
      await exchangeAuthorizationCode('CODE', 'V');
    } catch (err) {
      caught = err;
    }
    expect(isParseError(caught)).toBe(true);
    const pe = caught as ReturnType<typeof isParseError> & {
      source?: string;
      context?: Record<string, unknown>;
    };
    expect(pe.source).toBe('openai-codex-token-response');
    expect(pe.context?.op).toBe('exchange');
  });
});
