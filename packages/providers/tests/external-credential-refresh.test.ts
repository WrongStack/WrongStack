/**
 * An OAuth account whose refresh token a host holds (the HQ key vault) is
 * renewed by that host: through the host's durable refresh transaction, with
 * a placeholder refresh key that only ever lives in memory.
 */
import type { ProviderApiKey, ProviderConfig } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it } from 'vitest';
import {
  externalRefreshPlaceholder,
  isExternallyRenewed,
  renewExternally,
  setExternalCredentialRefresher,
} from '../src/external-credential-refresh.js';
import {
  buildProvider,
  oauthPersistenceCallbacks,
  setOAuthTokenPersister,
} from '../src/provider-build.js';
import { applyProviderOAuthRefresh } from '../src/provider-credential-state.js';
import {
  createSubscriptionRefreshTransaction,
  renewRotatingOAuthCredential,
  setSubscriptionRefreshTransaction,
} from '../src/subscription-refresh-store.js';

const HQ_KEY: ProviderApiKey = {
  label: 'chatgpt',
  apiKey: 'access-1',
  createdAt: '2026-11-24T10:00:00.000Z',
  authMethod: 'oauth',
  expiresAt: '2026-11-24T10:00:00.000Z',
  source: { kind: 'hq', hqId: 'hq-1', keyId: 'key-1', version: 1, profileId: 'openai-codex' },
};

afterEach(() => {
  setExternalCredentialRefresher(undefined);
  setOAuthTokenPersister(undefined);
  setSubscriptionRefreshTransaction(undefined);
});

describe('externally renewed OAuth accounts', () => {
  it('applies only with a host renewer, to OAuth entries with a source and no refresh token', () => {
    expect(isExternallyRenewed(HQ_KEY)).toBe(false);
    setExternalCredentialRefresher(async () => HQ_KEY);
    expect(isExternallyRenewed(HQ_KEY)).toBe(true);
    expect(isExternallyRenewed({ ...HQ_KEY, refreshToken: 'own' })).toBe(false);
    expect(isExternallyRenewed({ ...HQ_KEY, source: undefined })).toBe(false);
    expect(isExternallyRenewed({ ...HQ_KEY, authMethod: 'api_key' })).toBe(false);
  });

  it('never hands the host the placeholder', async () => {
    const seen: ProviderApiKey[] = [];
    setExternalCredentialRefresher(async (_id, credential) => {
      seen.push(credential);
      return { ...credential, apiKey: 'access-2' };
    });
    const renewed = await renewExternally('openai-codex', {
      ...HQ_KEY,
      refreshToken: externalRefreshPlaceholder(HQ_KEY),
    });
    expect(renewed.apiKey).toBe('access-2');
    expect(seen[0]).not.toHaveProperty('refreshToken');
  });

  it('renews through the host transaction and stores no refresh token', async () => {
    const providers: Record<string, ProviderConfig> = {
      'openai-codex': { type: 'openai-codex', apiKeys: [{ ...HQ_KEY }], activeKey: 'chatgpt' },
    };
    setSubscriptionRefreshTransaction(
      createSubscriptionRefreshTransaction(async (mutator) => {
        await mutator(providers);
      }),
    );
    setExternalCredentialRefresher(async (_id, credential) => ({
      ...credential,
      apiKey: 'access-2',
      expiresAt: '2026-11-24T11:00:00.000Z',
    }));
    const result = await renewRotatingOAuthCredential({
      providerId: 'openai-codex',
      stored: HQ_KEY,
      accessToken: 'access-1',
      refreshToken: externalRefreshPlaceholder(HQ_KEY),
      exchange: async () => {
        throw new Error('the provider token endpoint must not be called');
      },
      signInHint: 'sign in',
    });
    expect(result?.tokens).toMatchObject({
      access: 'access-2',
      refresh: externalRefreshPlaceholder(HQ_KEY),
    });
    const stored = providers['openai-codex']!.apiKeys![0]!;
    expect(stored).toMatchObject({ apiKey: 'access-2', expiresAt: '2026-11-24T11:00:00.000Z' });
    expect(stored.refreshToken).toBeUndefined();
  });

  it('buildProvider gives an HQ-held Codex account a refresher instead of a dead token', () => {
    setExternalCredentialRefresher(async (_id, credential) => credential);
    const provider = buildProvider(
      {
        id: 'openai-codex',
        name: 'OpenAI Codex',
        family: 'openai-codex',
        envVars: [],
        models: [],
      },
      { type: 'openai-codex', apiKeys: [{ ...HQ_KEY }], activeKey: 'chatgpt' },
    );
    expect(provider.id).toBe('openai-codex');
    // The placeholder is the refresh key the coordinator holds, in memory only.
    expect(JSON.stringify(provider)).toContain(externalRefreshPlaceholder(HQ_KEY));
  });

  // What a device actually holds for each sign-in HQ offers: no refresh token,
  // id token, OAuth client or subject — those stay on HQ.
  it.each([
    ['copilot', 'github-copilot', 'github-copilot', undefined],
    ['xai', 'xai', 'openai-compatible', 'xai'],
    ['kimi', 'kimi-for-coding', 'anthropic', 'kimi'],
    ['meta', 'meta', 'openai-compatible', 'meta'],
    ['chatgpt-api', 'openai-chatgpt', 'openai', 'chatgpt-api'],
  ] as const)(
    'a %s account from HQ builds and renews through the host',
    (_signIn, type, family, strategy) => {
      setExternalCredentialRefresher(async (_id, credential) => credential);
      const key: ProviderApiKey = {
        ...HQ_KEY,
        expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
        ...(strategy ? { oauthStrategyId: strategy } : {}),
        // HQ seals the scope to the device; ChatGPT plan usage is gated on it.
        ...(strategy === 'chatgpt-api' ? { scope: 'openid chatgpt.tokens.use.direct' } : {}),
      };
      const provider = buildProvider(
        { id: type, name: type, family, envVars: [], models: [] },
        { type, family, apiKeys: [key], activeKey: key.label },
      );
      expect(provider.id).toBe(type);
      expect(JSON.stringify(provider)).toContain(externalRefreshPlaceholder(key));
    },
  );

  // How the Desktop engine runs: a token persister, but no refresh transaction,
  // so the provider's own onRefresh carries the placeholder to the persister.
  it('without a host transaction, every refresh reaches storage and no placeholder does', () => {
    const providers: Record<string, ProviderConfig> = {
      'openai-codex': { type: 'openai-codex', apiKeys: [{ ...HQ_KEY }], activeKey: 'chatgpt' },
    };
    setOAuthTokenPersister((id, creds, source) => {
      applyProviderOAuthRefresh(providers[id]!, creds, source);
    });
    const { onRefresh } = oauthPersistenceCallbacks(
      'openai-codex',
      providers['openai-codex']!,
      'access-1',
    );
    const placeholder = externalRefreshPlaceholder(HQ_KEY);
    onRefresh({ accessToken: 'access-2', refreshToken: placeholder, expiresAt: 2_000_000_000_000 });
    onRefresh({ accessToken: 'access-3', refreshToken: placeholder, expiresAt: 2_000_000_100_000 });
    const stored = providers['openai-codex']!.apiKeys![0]!;
    expect(stored.apiKey).toBe('access-3');
    expect(JSON.stringify(providers)).not.toContain('external-renewal:');
  });
});
