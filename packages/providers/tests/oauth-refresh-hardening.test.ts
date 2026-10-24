/**
 * OAuth renewal paths that used to end in a forced re-login.
 *
 * 1. Codex rotates its refresh token on every use but renewed process-locally:
 *    a second process holding the same stored pair replayed the consumed token
 *    (`refresh_token_reused`). It now renews inside the host's locked config
 *    transaction, like the ChatGPT plan provider.
 * 2. A failed refresh inside the skew window killed a request whose access
 *    token was still valid.
 * 3. ChatGPT plan renewal re-verified the ID token AFTER the server had
 *    rotated the refresh token, so a JWKS blip discarded the new pair.
 */
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/contracts/types';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { refreshChatGPTDirect } from '../src/oauth/chatgpt-direct.js';
import {
  OAuthRefreshCoordinator,
  resetSharedOAuthRefreshState,
} from '../src/oauth-refresh-coordinator.js';
import { type CodexOAuthTokens, OpenAICodexProvider } from '../src/openai-codex.js';
import {
  createSubscriptionRefreshTransaction,
  setSubscriptionRefreshTransaction,
} from '../src/subscription-refresh-store.js';

function jwt(claims: Record<string, unknown>): string {
  const part = (v: unknown) => Buffer.from(JSON.stringify(v)).toString('base64url');
  return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

/** An in-memory config file with the host's mutate-under-lock contract. */
function fakeConfigDisk(providers: Record<string, ProviderConfig>) {
  let lock: Promise<void> = Promise.resolve();
  const mutate = (mutator: (all: Record<string, ProviderConfig>) => Promise<void>) => {
    const run = lock.then(async () => {
      // Each transaction works on a fresh read of "disk", as a process would.
      const working = structuredClone(providers);
      await mutator(working);
      for (const key of Object.keys(providers)) delete providers[key];
      Object.assign(providers, working);
    });
    lock = run.catch(() => {});
    return run;
  };
  return { providers, mutate };
}

const catalogFetch = (async () => Response.json({ models: [] })) as typeof fetch;

describe('Codex renewal across processes', () => {
  beforeEach(() => resetSharedOAuthRefreshState());
  afterEach(() => {
    setSubscriptionRefreshTransaction(undefined);
    resetSharedOAuthRefreshState();
  });

  it('a second process adopts the token the first one rotated instead of replaying it', async () => {
    const stale: ProviderApiKey = {
      label: 'oauth-default',
      apiKey: jwt({ exp: 1 }),
      refreshToken: 'r0',
      authMethod: 'oauth',
      createdAt: '2026-10-01T00:00:00.000Z',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const disk = fakeConfigDisk({
      'openai-codex': { type: 'openai-codex', activeKey: 'oauth-default', apiKeys: [stale] },
    });
    setSubscriptionRefreshTransaction(createSubscriptionRefreshTransaction(disk.mutate));

    const exchanged: string[] = [];
    const refreshFn = vi.fn(async (refreshToken: string): Promise<CodexOAuthTokens> => {
      exchanged.push(refreshToken);
      if (refreshToken !== 'r0') throw new Error(`replayed ${refreshToken}`);
      return {
        access: jwt({ exp: 9_999_999_999 }),
        refresh: 'r1',
        expires: Date.now() + 3_600_000,
      };
    });
    const build = () =>
      new OpenAICodexProvider({
        id: 'openai-codex',
        credentials: {
          accessToken: stale.apiKey,
          refreshToken: 'r0',
          expiresAt: Date.parse(stale.expiresAt!),
        },
        credential: stale,
        fetchImpl: catalogFetch,
        refreshFn,
      });

    const signal = new AbortController().signal;
    await build().refreshContextLimit('gpt-6-astra', { signal });
    // A separate process: no shared in-memory rotation state, same stale boot config.
    resetSharedOAuthRefreshState();
    await build().refreshContextLimit('gpt-6-astra', { signal });

    expect(exchanged).toEqual(['r0']);
    expect(disk.providers['openai-codex']?.apiKeys?.[0]).toMatchObject({
      label: 'oauth-default',
      refreshToken: 'r1',
    });
  });

  it('persists through the transaction, not the legacy persister', async () => {
    const entry: ProviderApiKey = {
      label: 'oauth-default',
      apiKey: 'a0',
      refreshToken: 'r0',
      authMethod: 'oauth',
      createdAt: '',
      expiresAt: new Date(Date.now() - 1000).toISOString(),
    };
    const disk = fakeConfigDisk({
      'openai-codex': { type: 'openai-codex', activeKey: 'oauth-default', apiKeys: [entry] },
    });
    setSubscriptionRefreshTransaction(createSubscriptionRefreshTransaction(disk.mutate));
    const onRefresh = vi.fn();
    await new OpenAICodexProvider({
      id: 'openai-codex',
      credentials: { accessToken: 'a0', refreshToken: 'r0', expiresAt: 0 },
      credential: entry,
      fetchImpl: catalogFetch,
      refreshFn: async () => ({ access: 'a1', refresh: 'r1', expires: Date.now() + 3_600_000 }),
      onRefresh,
    }).refreshContextLimit('m', { signal: new AbortController().signal });
    expect(onRefresh).not.toHaveBeenCalled();
    expect(disk.providers['openai-codex']?.apiKeys?.[0]?.apiKey).toBe('a1');
  });
});

describe('proactive refresh inside the skew window', () => {
  const coordinator = (expiresAt: number) =>
    new OAuthRefreshCoordinator<{ access: string }, unknown>({
      initialRefreshKey: 'r0',
      initialExpiresAt: expiresAt,
      refreshSkewMs: 5 * 60_000,
      label: 'test',
      hooks: {
        refreshFn: async () => {
          throw new Error('token endpoint 503');
        },
        projectTokens: (t) => ({ accessToken: t.access, expiresAt: 0 }),
        applyTokens: () => {},
        formatPayload: () => ({}),
      },
    });
  beforeEach(() => resetSharedOAuthRefreshState());

  it('keeps the request alive while the current access token still works', async () => {
    await expect(
      coordinator(Date.now() + 60_000).ensureFreshToken(new AbortController().signal),
    ).resolves.toBeUndefined();
  });

  it('still fails once the access token has actually expired', async () => {
    await expect(
      coordinator(Date.now() - 1).ensureFreshToken(new AbortController().signal),
    ).rejects.toThrow('token endpoint 503');
  });
});

describe('ChatGPT plan renewal', () => {
  const previous: ProviderApiKey = {
    label: 'oauth-1',
    apiKey: 'old-access',
    refreshToken: 'old-refresh',
    authMethod: 'oauth',
    createdAt: '',
    oauthStrategyId: 'chatgpt-api',
    oauthClientId: 'oaiapp_user',
    oauthSubject: 'user-subject',
    scope: 'openid chatgpt.tokens.use.direct',
  };

  it('keeps the rotated pair even when identity keys are unreachable', async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith('/oauth/token'))
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          scope: 'openid chatgpt.tokens.use.direct',
          expires_in: 3600,
          id_token: 'header.claims.sig',
        });
      // JWKS outage: re-verifying here used to throw the new pair away.
      return new Response('unavailable', { status: 503 });
    }) as unknown as typeof fetch;
    const renewed = await refreshChatGPTDirect(previous, fetchImpl);
    expect(renewed).toMatchObject({
      apiKey: 'new-access',
      refreshToken: 'new-refresh',
      oauthSubject: 'user-subject',
    });
  });

  it('keeps the previous refresh token and scope when the server does not resend them', async () => {
    const fetchImpl = (async () =>
      Response.json({ access_token: 'new-access', expires_in: 3600 })) as unknown as typeof fetch;
    const renewed = await refreshChatGPTDirect(previous, fetchImpl);
    expect(renewed.refreshToken).toBe('old-refresh');
    expect(renewed.scope).toBe(previous.scope);
  });
});
