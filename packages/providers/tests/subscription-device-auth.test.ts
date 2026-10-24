import type { ProviderApiKey } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { applyProviderAuthOutcome, createBuiltinProviderAuthRegistry } from '../src/oauth/index.js';
import {
  createKimiAuthStrategy,
  createMetaAuthStrategy,
  createXaiAuthStrategy,
  refreshDeviceSubscription,
} from '../src/oauth/subscription-flows.js';

const device = {
  device_code: 'device-secret',
  user_code: 'VISIBLE',
  verification_uri: 'https://auth.example.com/device',
  interval: 1,
  expires_in: 600,
};
const token = { access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600 };
const json = (body: unknown, status = 200) => Response.json(body, { status });

afterEach(() => vi.useRealTimers());

describe('subscription device authorization', () => {
  it.each([
    [
      'xai',
      createXaiAuthStrategy,
      'xai',
      'https://auth.x.ai/oauth2/device/code',
      'https://auth.x.ai/oauth2/token',
    ],
    [
      'kimi',
      createKimiAuthStrategy,
      'kimi-for-coding',
      'https://auth.kimi.ai/api/oauth/device_authorization',
      'https://auth.kimi.ai/api/oauth/token',
    ],
    [
      'meta',
      createMetaAuthStrategy,
      'meta',
      'https://auth.meta.com/oidc/device/authorization/',
      'https://auth.meta.com/oidc/device/token/',
    ],
  ] as const)(
    'completes %s from device approval through account model discovery',
    async (id, factory, providerId, deviceUrl, tokenUrl) => {
      vi.useFakeTimers();
      const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        expect(init?.redirect).toBe('error');
        if (url === deviceUrl) {
          expect(new URLSearchParams(String(init?.body)).get('client_id')).toBeTruthy();
          return json(device);
        }
        if (url === tokenUrl) {
          const fields = new URLSearchParams(String(init?.body));
          expect(fields.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:device_code');
          expect(fields.get('device_code')).toBe(device.device_code);
          return json(token);
        }
        if (url.endsWith('/muse-code/key')) {
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer access-secret');
          return json({ api_key: 'minted-meta-key' });
        }
        expect(new Headers(init?.headers).get('authorization')).toBe(
          `Bearer ${id === 'meta' ? 'minted-meta-key' : 'access-secret'}`,
        );
        return json({ data: [{ id: 'account-model' }] });
      });
      const session = await factory(fetchImpl).begin();
      expect(session.interaction).toMatchObject({ type: 'device_code', userCode: 'VISIBLE' });
      const completion = session.waitForCompletion();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1000);
      const outcome = await completion;
      expect(outcome).toMatchObject({
        providerId,
        models: ['account-model'],
        credential: { authMethod: 'oauth', oauthStrategyId: id },
      });
      expect(outcome?.credential.refreshToken).toBe(
        id === 'meta' ? token.access_token : token.refresh_token,
      );
      expect(session.waitForCompletion()).toBe(completion);
      session.close();
    },
  );

  it('honors authorization_pending and increases the interval on slow_down', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json(device))
      .mockResolvedValueOnce(json({ error: 'authorization_pending' }, 400))
      .mockResolvedValueOnce(json({ error: 'slow_down', interval: 3 }, 400))
      .mockResolvedValueOnce(json(token))
      .mockResolvedValueOnce(json({ data: [] }));
    const session = await createXaiAuthStrategy(fetchImpl).begin();
    const completion = session.waitForCompletion();
    await vi.advanceTimersByTimeAsync(2000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(5999);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    expect((await completion)?.credential.apiKey).toBe(token.access_token);
    session.close();
  });

  it('cancels before polling and never exchanges after closing', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json(device));
    const session = await createKimiAuthStrategy(fetchImpl).begin();
    const completion = session.waitForCompletion();
    const rejection = expect(completion).rejects.toBeDefined();
    session.close();
    await rejection;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    'javascript:alert(1)',
    'http://auth.example.com/device',
    'https://user:secret@auth.example.com',
  ])('rejects verification URL %s', async (uri) => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(json({ ...device, verification_uri_complete: uri }));
    await expect(createXaiAuthStrategy(fetchImpl).begin()).rejects.toThrow();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(['access_denied', 'expired_token'])(
    'reports %s without saving a credential or echoing secrets',
    async (error) => {
      vi.useFakeTimers();
      const fetchImpl = vi
        .fn<typeof fetch>()
        .mockResolvedValueOnce(json(device))
        .mockResolvedValueOnce(json({ error, error_description: token.refresh_token }, 400));
      const session = await createKimiAuthStrategy(fetchImpl).begin();
      const completion = session.waitForCompletion();
      const rejection = expect(completion).rejects.toThrow(error);
      await vi.advanceTimersByTimeAsync(1000);
      await rejection;
      session.close();
    },
  );

  it('resolves new aliases without changing the existing Codex login', () => {
    const registry = createBuiltinProviderAuthRegistry();
    expect(registry.resolveId('grok')).toBe('xai');
    expect(registry.resolveId('kimi-coding')).toBe('kimi');
    expect(registry.resolveId('muse')).toBe('meta');
    expect(registry.resolveId('openai-chatgpt')).toBe('chatgpt-api');
    expect(registry.resolveId('openai')).toBe('chatgpt');
  });

  it('adds OAuth beside an existing API key on the same provider', () => {
    const providers = {
      xai: {
        type: 'xai',
        family: 'openai-compatible' as const,
        apiKeys: [{ label: 'api', apiKey: 'api-secret', createdAt: '' }],
        activeKey: 'api',
      },
    };
    applyProviderAuthOutcome(providers, {
      providerId: 'xai',
      family: 'openai-compatible',
      models: [],
      credential: {
        label: 'oauth-default',
        apiKey: token.access_token,
        createdAt: '',
        authMethod: 'oauth',
        oauthStrategyId: 'xai',
      },
    });
    expect(providers.xai.apiKeys.map((key) => key.label)).toEqual(['api', 'oauth-default']);
    expect(providers.xai.activeKey).toBe('oauth-default');
  });
  it('migrates a legacy single API key instead of discarding it when adding OAuth', () => {
    const providers = {
      xai: { type: 'xai', family: 'openai-compatible' as const, apiKey: 'legacy-api-secret' },
    };
    const applied = applyProviderAuthOutcome(providers, {
      providerId: 'xai',
      family: 'openai-compatible',
      models: [],
      credential: {
        label: 'oauth-default',
        apiKey: token.access_token,
        createdAt: '',
        authMethod: 'oauth',
        oauthStrategyId: 'xai',
      },
    });
    expect(applied.provider.apiKeys).toEqual([
      expect.objectContaining({ label: 'default', apiKey: 'legacy-api-secret' }),
      expect.objectContaining({ label: 'oauth-default' }),
    ]);
    expect(applied.provider.apiKey).toBeUndefined();
  });
});

describe('subscription credential renewal', () => {
  const credential = (id: string): ProviderApiKey => ({
    label: 'personal',
    apiKey: 'old',
    refreshToken: 'identity-or-refresh',
    createdAt: '',
    authMethod: 'oauth',
    oauthStrategyId: id,
  });

  it('preserves a nonrotating xAI refresh token and defaults the lifetime', async () => {
    const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ access_token: 'new-access' }));
    const renewed = await refreshDeviceSubscription(credential('xai'), fetchImpl);
    expect(renewed).toMatchObject({
      label: 'personal',
      refreshToken: 'identity-or-refresh',
      apiKey: 'new-access',
    });
    expect(Date.parse(renewed.expiresAt!) - Date.now()).toBeGreaterThan(3_590_000);
  });

  it('re-mints Meta keys with the identity token instead of a refresh grant', async () => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe('https://api.meta.ai/muse-code/key');
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer identity-or-refresh');
      expect(init?.body).toBe('{}');
      return json({ api_key: 'new-key' });
    });
    expect(await refreshDeviceSubscription(credential('meta'), fetchImpl)).toMatchObject({
      apiKey: 'new-key',
      refreshToken: 'identity-or-refresh',
    });
  });

  it('retries transient Kimi failures but stops on invalid_grant', async () => {
    vi.useFakeTimers();
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(json({}, 429))
      .mockResolvedValueOnce(json({ error: 'invalid_grant' }, 400));
    const pending = refreshDeviceSubscription(credential('kimi'), fetchImpl);
    const rejection = expect(pending).rejects.toThrow('invalid_grant');
    await vi.advanceTimersByTimeAsync(1000);
    await rejection;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it.each([0, -1, '3600', Number.POSITIVE_INFINITY])(
    'rejects malformed token lifetime %s',
    async (expires_in) => {
      const fetchImpl = vi.fn<typeof fetch>().mockResolvedValue(json({ ...token, expires_in }));
      await expect(refreshDeviceSubscription(credential('kimi'), fetchImpl)).rejects.toThrow(
        'expires_in',
      );
    },
  );
});
