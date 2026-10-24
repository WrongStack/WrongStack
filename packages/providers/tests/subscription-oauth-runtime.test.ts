import type {
  ProviderApiKey,
  ProviderConfig,
  Request,
  SecretVault,
} from '@wrongstack/contracts/types';
import { decryptConfigSecrets, encryptConfigSecrets } from '@wrongstack/core/security';
import {
  __resetProxyConfigForTests,
  applyProxyConfig,
  rewriteBaseUrl,
} from '@wrongstack/core/wiring/proxy-rewrite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { discoverOpenAICompatibleModels, resolveDiscoveryTargets } from '../src/auto-discover.js';
import { makeProviderFromConfig } from '../src/index.js';
import { resetSharedOAuthRefreshState } from '../src/oauth-refresh-coordinator.js';
import { applyProviderOAuthRefresh } from '../src/provider-credential-state.js';
import { SubscriptionOAuthProvider } from '../src/subscription-oauth.js';
import {
  createSubscriptionRefreshTransaction,
  setSubscriptionRefreshTransaction,
} from '../src/subscription-refresh-store.js';

const request: Request = {
  model: 'account-model',
  messages: [{ role: 'user', content: [{ type: 'text', text: 'hello' }] }],
};
const signal = () => new AbortController().signal;
const scope = 'openid chatgpt.tokens.use.direct';
const credential = (id: string, expired = false): ProviderApiKey => ({
  label: 'personal',
  apiKey: 'old-access',
  refreshToken: 'old-refresh',
  createdAt: '',
  authMethod: 'oauth',
  oauthStrategyId: id,
  expiresAt: new Date(Date.now() + (expired ? -1000 : 3600000)).toISOString(),
  ...(id === 'chatgpt-api' ? { oauthClientId: 'oaiapp_user', oauthSubject: 'subject', scope } : {}),
});
const sse = (...events: unknown[]) =>
  new Response(
    events
      .map((event) => `data: ${typeof event === 'string' ? event : JSON.stringify(event)}\n\n`)
      .join(''),
    { headers: { 'content-type': 'text/event-stream' } },
  );
const success = () =>
  sse(
    { type: 'response.output_text.delta', delta: 'ok' },
    {
      type: 'response.completed',
      response: { status: 'completed', usage: { input_tokens: 3, output_tokens: 1 } },
    },
  );

beforeEach(() => resetSharedOAuthRefreshState());
afterEach(() => {
  __resetProxyConfigForTests();
  setSubscriptionRefreshTransaction(undefined);
  vi.unstubAllGlobals();
});

describe('subscription OAuth inference', () => {
  it('persists startup discovery renewal through the host transaction before using the token', async () => {
    const initial = credential('kimi', true);
    const durable = { plan: { type: 'kimi-for-coding', apiKeys: [{ ...initial }] } };
    const saved = { type: 'kimi-for-coding', apiKeys: [{ ...initial }] };
    const mutate = vi.fn(
      async (mutator: (providers: Record<string, ProviderConfig>) => Promise<void>) => {
        await mutator(durable);
      },
    );
    setSubscriptionRefreshTransaction(createSubscriptionRefreshTransaction(mutate));
    const [target] = resolveDiscoveryTargets({ providers: { plan: saved } } as never);
    const result = await discoverOpenAICompatibleModels('plan', {
      baseUrl: target!.baseUrl,
      prepareApiKey: target!.prepareApiKey,
      fetchImpl: async (input, init) => {
        if (String(input).endsWith('/token'))
          return Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          });
        expect(durable.plan.apiKeys[0]!.apiKey).toBe('new-access');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new-access');
        return Response.json({ data: [{ id: 'account-model' }] });
      },
    });
    expect(result?.models['account-model']).toBeDefined();
    expect(mutate).toHaveBeenCalledOnce();
    expect(durable.plan.apiKeys[0]!.refreshToken).toBe('new-refresh');
    expect(saved.apiKeys[0]!.apiKey).toBe('new-access');
  });
  it.each([
    ['xai', 'https://api.x.ai/v1', 'responses'],
    ['meta', 'https://api.meta.ai/v1', 'responses'],
    ['chatgpt-api', 'https://api.openai.com/v1', 'responses'],
    ['kimi', 'https://api.kimi.com/coding/v1', 'messages'],
    ['kimi', 'https://api.kimi.ai/coding/v1', 'messages'],
  ])(
    'builds and streams %s through the configured WrongProxy with the official upstream %s',
    async (strategy, official, wire) => {
      const proxyUrl = 'http://localhost:3444';
      applyProxyConfig({ enabled: true, active: true, url: proxyUrl });
      const baseUrl = rewriteBaseUrl(official, proxyUrl)!;
      vi.stubGlobal(
        'fetch',
        vi.fn<typeof fetch>(async (input, init) => {
          expect(String(input)).toBe(`${baseUrl}/${wire}`);
          expect(new Headers(init?.headers).get('authorization')).toBe('Bearer old-access');
          return wire === 'messages'
            ? sse(
                {
                  type: 'message_start',
                  message: { model: request.model, usage: { input_tokens: 1 } },
                },
                {
                  type: 'message_delta',
                  delta: { stop_reason: 'end_turn' },
                  usage: { output_tokens: 1 },
                },
                { type: 'message_stop' },
              )
            : success();
        }),
      );
      const provider = makeProviderFromConfig('my-account', {
        type: 'my-account',
        family: strategy === 'kimi' ? 'anthropic' : 'openai',
        baseUrl,
        apiKeys: [credential(strategy)],
        activeKey: 'personal',
      });
      expect(provider.id).toBe('my-account');
      expect((await provider.complete(request, { signal: signal() })).stopReason).toBe('end_turn');
    },
  );

  it.each([
    'https://attacker.test/proxy/api.openai.com/v1',
    'http://localhost:9999/proxy/api.openai.com/v1',
    'http://localhost:3444/proxy/api.openai.com/v1?forward=attacker',
    'http://localhost:3444/proxy/api.openai.com/backend-api',
    'http://localhost:3444/proxy/attacker.test/v1',
  ])(
    'rejects a proxy route that does not exactly match the configured proxy and official upstream: %s',
    (baseUrl) => {
      applyProxyConfig({ enabled: true, active: true, url: 'http://localhost:3444' });
      expect(
        () =>
          new SubscriptionOAuthProvider({
            id: 'plan',
            credential: credential('chatgpt-api'),
            baseUrl,
          }),
      ).toThrow('must use');
    },
  );

  it.each([
    { enabled: false, active: true },
    { enabled: true, active: false },
  ])('rejects proxy routing while the configured proxy is unavailable: %j', (state) => {
    applyProxyConfig({ ...state, url: 'http://localhost:3444' });
    expect(
      () =>
        new SubscriptionOAuthProvider({
          id: 'plan',
          credential: credential('chatgpt-api'),
          baseUrl: 'http://localhost:3444/proxy/api.openai.com/v1',
        }),
    ).toThrow('must use');
  });

  it('uses the international Kimi endpoint through the config factory and renews its shared OAuth grant', async () => {
    const urls: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input, init) => {
        urls.push(String(input));
        if (String(input) === 'https://auth.kimi.ai/api/oauth/token') {
          return Response.json({
            access_token: 'new-access',
            refresh_token: 'new-refresh',
            expires_in: 3600,
          });
        }
        expect(String(input)).toBe('https://api.kimi.ai/coding/v1/messages');
        expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new-access');
        return sse(
          { type: 'message_start', message: { model: request.model, usage: { input_tokens: 1 } } },
          { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
          {
            type: 'content_block_delta',
            index: 0,
            delta: { type: 'text_delta', text: 'KIMI_LOGIN_OK' },
          },
          { type: 'content_block_stop', index: 0 },
          {
            type: 'message_delta',
            delta: { stop_reason: 'end_turn' },
            usage: { output_tokens: 5 },
          },
          { type: 'message_stop' },
        );
      }),
    );
    const provider = makeProviderFromConfig('international-kimi', {
      type: 'kimi-for-coding',
      family: 'anthropic',
      baseUrl: 'https://api.kimi.ai/coding/v1/',
      apiKeys: [credential('kimi', true)],
      activeKey: 'personal',
    });
    expect((await provider.complete(request, { signal: signal() })).content).toContainEqual({
      type: 'text',
      text: 'KIMI_LOGIN_OK',
    });
    expect(urls).toEqual([
      'https://auth.kimi.ai/api/oauth/token',
      'https://api.kimi.ai/coding/v1/messages',
    ]);
  });

  it.each([
    'https://api.kimi.ai.attacker.test/coding/v1',
    'https://api.kimi.ai/coding/v1/elsewhere',
    'https://api.kimi.ai/coding/v1?proxy=true',
  ])('rejects a Kimi endpoint outside the exact official allowlist: %s', (baseUrl) => {
    expect(
      () => new SubscriptionOAuthProvider({ id: 'kimi', credential: credential('kimi'), baseUrl }),
    ).toThrow('must use');
  });

  it('attributes an invalid renewable session to its account alias and stops before inference', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValue(Response.json({ error: 'invalid_grant' }, { status: 400 }));
    const provider = new SubscriptionOAuthProvider({
      id: 'personal-grok',
      credential: credential('xai', true),
      fetchImpl,
    });
    await expect(provider.complete(request, { signal: signal() })).rejects.toMatchObject({
      providerId: 'personal-grok',
      kind: 'auth',
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it('surfaces the parsed OAuth body.error code in the auto-discovery failure message', async () => {
    const initial = credential('kimi', true);
    const failures: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn<typeof fetch>(async (input) => {
        if (String(input) === 'https://auth.kimi.ai/api/oauth/token')
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        throw new Error(`unexpected fetch in discovery: ${String(input)}`);
      }),
    );
    const [target] = resolveDiscoveryTargets({
      providers: { plan: { type: 'kimi-for-coding', apiKeys: [{ ...initial }] } },
    } as never);
    const result = await discoverOpenAICompatibleModels('plan', {
      baseUrl: target!.baseUrl,
      prepareApiKey: target!.prepareApiKey,
      fetchImpl: fetch as typeof fetch,
      onFailure: (reason) => failures.push(reason),
    });
    expect(result).toBeUndefined();
    expect(failures).toHaveLength(1);
    // Pinned format: code FIRST, then HTTP status. Lets the next failure be
    // re-diagnosed from the message alone without re-running the renewal.
    expect(failures[0]).toBe(
      'OAuth credential renewal failed (invalid_grant, HTTP 400); check account sign-in',
    );
  });

  it('keeps the original wording when the failure is not an OAuth-style ProviderError', async () => {
    const initial = credential('kimi', true);
    const failures: string[] = [];
    const [target] = resolveDiscoveryTargets({
      providers: { plan: { type: 'kimi-for-coding', apiKeys: [{ ...initial }] } },
    } as never);
    const result = await discoverOpenAICompatibleModels('plan', {
      baseUrl: target!.baseUrl,
      prepareApiKey: async () => {
        throw new Error('network down');
      },
      onFailure: (reason) => failures.push(reason),
    });
    expect(result).toBeUndefined();
    expect(failures).toEqual(['OAuth credential renewal failed; check account sign-in']);
  });
  it('runs a namespaced ChatGPT tool turn and replays encrypted reasoning without unsupported preview fields', async () => {
    let calls = 0;
    const fetchImpl = vi.fn<typeof fetch>(async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      expect(body).not.toHaveProperty('max_output_tokens');
      expect(body).not.toHaveProperty('temperature');
      expect(body).not.toHaveProperty('top_p');
      expect(body).not.toHaveProperty('previous_response_id');
      expect(body.tools).toEqual([
        expect.objectContaining({
          type: 'namespace',
          name: 'wrongstack',
          tools: [expect.objectContaining({ type: 'function', name: 'read' })],
        }),
      ]);
      expect(body.tool_choice).toEqual({ type: 'function', name: 'read', namespace: 'wrongstack' });
      if (calls++ === 0)
        return sse(
          { type: 'response.output_item.added', item: { type: 'reasoning', id: 'rs_local' } },
          {
            type: 'response.output_item.done',
            item: { type: 'reasoning', id: 'rs_local', encrypted_content: 'opaque-reasoning' },
          },
          {
            type: 'response.output_item.added',
            item: {
              type: 'function_call',
              name: 'read',
              namespace: 'wrongstack',
              call_id: 'call_local',
              arguments: '{"path":"a.ts"}',
            },
          },
          {
            type: 'response.output_item.done',
            item: { type: 'function_call', call_id: 'call_local', arguments: '{"path":"a.ts"}' },
          },
          { type: 'response.completed', response: { status: 'completed' } },
        );
      expect(body.input).toContainEqual({
        type: 'reasoning',
        id: 'rs_local',
        encrypted_content: 'opaque-reasoning',
        summary: [],
      });
      expect(body.input).toContainEqual(
        expect.objectContaining({
          type: 'function_call',
          name: 'read',
          namespace: 'wrongstack',
          call_id: 'call_local',
        }),
      );
      expect(body.input).toContainEqual({
        type: 'function_call_output',
        call_id: 'call_local',
        output: 'file content',
      });
      return success();
    });
    const provider = new SubscriptionOAuthProvider({
      id: 'plan',
      credential: credential('chatgpt-api'),
      fetchImpl,
    });
    const input: Request = {
      ...request,
      maxTokens: 100,
      temperature: 0.5,
      topP: 0.9,
      toolChoice: { type: 'tool', name: 'read' },
      tools: [
        {
          name: 'read',
          description: 'Read a file',
          permission: 'auto',
          mutating: false,
          inputSchema: { type: 'object', properties: { path: { type: 'string' } } },
          execute: async () => 'file content',
        },
      ],
    };
    const first = await provider.complete(input, { signal: signal() });
    expect(first.stopReason).toBe('tool_use');
    expect(first.content).toContainEqual(
      expect.objectContaining({ type: 'tool_use', name: 'read', id: 'call_local' }),
    );
    const second = await provider.complete(
      {
        ...input,
        messages: [
          ...input.messages,
          { role: 'assistant', content: first.content },
          {
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'call_local', content: 'file content' }],
          },
        ],
      },
      { signal: signal() },
    );
    expect(second.stopReason).toBe('end_turn');
    expect(calls).toBe(2);
  });
  it.each([
    ['xai', 'https://api.x.ai/v1/responses'],
    ['meta', 'https://api.meta.ai/v1/responses'],
    ['chatgpt-api', 'https://api.openai.com/v1/responses'],
    ['kimi', 'https://api.kimi.com/coding/v1/messages'],
  ])('sends %s to its actual inference wire using the account token', async (id, endpoint) => {
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      expect(String(input)).toBe(endpoint);
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBe('Bearer old-access');
      expect(headers.has('x-api-key')).toBe(false);
      const body = JSON.parse(String(init?.body));
      expect(body.stream).toBe(true);
      if (id === 'chatgpt-api') {
        expect(body.store).toBe(false);
        expect(body.include).toContain('reasoning.encrypted_content');
      }
      return id === 'kimi'
        ? sse(
            {
              type: 'message_start',
              message: { model: request.model, usage: { input_tokens: 1 } },
            },
            {
              type: 'message_delta',
              delta: { stop_reason: 'end_turn' },
              usage: { output_tokens: 1 },
            },
            { type: 'message_stop' },
          )
        : success();
    });
    const provider = new SubscriptionOAuthProvider({
      id: 'work-account',
      credential: credential(id),
      fetchImpl,
    });
    expect(provider.id).toBe('work-account');
    expect((await provider.complete(request, { signal: signal() })).stopReason).toBe('end_turn');
  });

  it('refreshes an expired account before the first request and shares one exchange across provider instances', async () => {
    const onRefresh = vi.fn();
    const fetchImpl = vi.fn<typeof fetch>(async (input, init) => {
      if (String(input).includes('/oauth2/token'))
        return Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        });
      expect(new Headers(init?.headers).get('authorization')).toBe('Bearer new-access');
      return success();
    });
    const opts = { id: 'work', credential: credential('xai', true), fetchImpl, onRefresh };
    const a = new SubscriptionOAuthProvider(opts);
    const b = new SubscriptionOAuthProvider(opts);
    await Promise.all([
      a.complete(request, { signal: signal() }),
      b.complete(request, { signal: signal() }),
    ]);
    expect(
      fetchImpl.mock.calls.filter((call) => String(call[0]).includes('/oauth2/token')),
    ).toHaveLength(1);
    expect(onRefresh).toHaveBeenCalledTimes(1);
    expect(a.accountQuotaToken).toBe('new-access');
    expect(b.accountQuotaToken).toBe('new-access');
  });

  it('retries one HTTP 401 with a refreshed token, without retrying a stream that already emitted data', async () => {
    const fetchImpl = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(Response.json({ error: { message: 'expired' } }, { status: 401 }))
      .mockResolvedValueOnce(
        Response.json({
          access_token: 'new-access',
          refresh_token: 'new-refresh',
          expires_in: 3600,
        }),
      )
      .mockResolvedValueOnce(success());
    const provider = new SubscriptionOAuthProvider({
      id: 'xai',
      credential: credential('xai'),
      fetchImpl,
    });
    await provider.complete(request, { signal: signal() });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    const broken = vi.fn<typeof fetch>().mockResolvedValue(
      sse(
        { type: 'response.output_text.delta', delta: 'partial' },
        {
          type: 'response.failed',
          response: {
            status_code: 401,
            error: { message: 'expired', type: 'authentication_error' },
          },
        },
      ),
    );
    const second = new SubscriptionOAuthProvider({
      id: 'xai',
      credential: credential('xai'),
      fetchImpl: broken,
    });
    await expect(second.complete(request, { signal: signal() })).rejects.toMatchObject({
      status: 401,
    });
    expect(broken).toHaveBeenCalledTimes(1);
  });

  it.each(['[DONE]', ''])(
    'does not report a bare %s stream as completed ChatGPT inference',
    async (body) => {
      const provider = new SubscriptionOAuthProvider({
        id: 'plan',
        credential: credential('chatgpt-api'),
        fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(sse(body)),
      });
      await expect(provider.complete(request, { signal: signal() })).rejects.toMatchObject({
        status: 599,
      });
    },
  );

  it.each([
    ['subscription_sharing_usage_limit_exceeded', 429, 'quota_exhausted', false],
    ['subscription_sharing_usage_unavailable', 503, 'server', true],
    ['subscription_sharing_unsupported_capability', 400, 'invalid_request', false],
    ['subscription_sharing_user_not_eligible', 403, 'auth', false],
  ])('preserves %s delivered after streaming started', async (code, status, kind, retryable) => {
    const provider = new SubscriptionOAuthProvider({
      id: 'plan',
      credential: credential('chatgpt-api'),
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        sse(
          { type: 'response.output_text.delta', delta: 'partial' },
          {
            type: 'response.failed',
            response: { error: { code, message: 'Plan request failed' } },
          },
        ),
      ),
    });
    await expect(provider.complete(request, { signal: signal() })).rejects.toMatchObject({
      status,
      kind,
      retryable,
      body: { code },
    });
  });

  it('blocks a repointed subscription endpoint and absent ChatGPT plan permission', () => {
    expect(
      () =>
        new SubscriptionOAuthProvider({
          id: 'work',
          credential: credential('xai'),
          baseUrl: 'https://attacker.test/v1',
        }),
    ).toThrow('must use');
    expect(
      () =>
        new SubscriptionOAuthProvider({
          id: 'plan',
          credential: { ...credential('chatgpt-api'), scope: 'openid' },
        }),
    ).toThrow('not enabled');
  });

  it('selects OAuth by the active credential and preserves the API-key alternative', () => {
    const config: ProviderConfig = {
      type: 'xai',
      family: 'openai-compatible',
      baseUrl: 'https://api.x.ai/v1',
      apiKeys: [credential('xai'), { label: 'api', apiKey: 'api-secret', createdAt: '' }],
      activeKey: 'personal',
    };
    expect(makeProviderFromConfig('work-grok', config)).toBeInstanceOf(SubscriptionOAuthProvider);
    config.activeKey = 'api';
    const api = makeProviderFromConfig('work-grok', config);
    expect(api).not.toBeInstanceOf(SubscriptionOAuthProvider);
    expect(api.id).toBe('work-grok');
  });

  it('updates account model choices and returns the provider context ceiling', async () => {
    const onModels = vi.fn();
    const provider = new SubscriptionOAuthProvider({
      id: 'plan',
      credential: credential('chatgpt-api'),
      onModels,
      fetchImpl: vi.fn<typeof fetch>().mockResolvedValue(
        Response.json({
          models: [{ slug: 'account-model', visibility: 'list', context_window: 400000 }],
        }),
      ),
    });
    expect(await provider.refreshContextLimit('account-model', { signal: signal() })).toEqual({
      maxContext: 400000,
      source: 'provider',
    });
    expect(onModels).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'account-model' })],
      expect.objectContaining({ apiKey: 'old-access', label: 'personal' }),
    );
  });
});

describe('subscription storage transactions', () => {
  it('keeps token exchange inside the serialized persistence boundary and adopts a sibling rotation', async () => {
    const source = credential('chatgpt-api', true);
    const providers: Record<string, ProviderConfig> = {
      work: { type: 'openai-chatgpt', activeKey: 'personal', apiKeys: [source] },
    };
    let tail = Promise.resolve();
    let locked = false;
    const transaction = createSubscriptionRefreshTransaction((mutator) => {
      const pending = tail.then(async () => {
        locked = true;
        try {
          await mutator(providers);
        } finally {
          locked = false;
        }
      });
      tail = pending.catch(() => {});
      return pending;
    });
    const renew = vi.fn(async (current: ProviderApiKey) => {
      expect(locked).toBe(true);
      expect(current.refreshToken).toBe('old-refresh');
      return {
        ...current,
        apiKey: 'new',
        refreshToken: 'rotated',
        scope: `${scope} profile`,
        expiresAt: new Date(Date.now() + 3600000).toISOString(),
      };
    });
    const [a, b] = await Promise.all([
      transaction('work', source, renew),
      transaction('work', source, renew),
    ]);
    expect(renew).toHaveBeenCalledTimes(1);
    expect(a).toEqual(b);
    expect(providers.work?.apiKeys?.[0]).toEqual(a);
  });

  it('refuses renewal after an account was replaced or removed', async () => {
    const source = credential('chatgpt-api');
    const providers: Record<string, ProviderConfig> = {
      work: { type: 'openai-chatgpt', apiKeys: [{ ...source, oauthSubject: 'someone-else' }] },
    };
    const renew = vi.fn();
    const transaction = createSubscriptionRefreshTransaction(async (mutator) => {
      await mutator(providers);
    });
    await expect(transaction('work', source, renew)).rejects.toThrow('changed or was removed');
    delete providers.work;
    await expect(transaction('work', source, renew)).rejects.toThrow('changed or was removed');
    expect(renew).not.toHaveBeenCalled();
  });

  it('preserves selection and encrypts retained ID tokens with the existing vault walker', () => {
    const config: ProviderConfig = {
      type: 'openai-chatgpt',
      activeKey: 'api',
      apiKeys: [credential('chatgpt-api'), { label: 'api', apiKey: 'manual', createdAt: '' }],
    };
    expect(
      applyProviderOAuthRefresh(
        config,
        {
          accessToken: 'new',
          refreshToken: 'rotated',
          expiresAt: Date.now() + 3600000,
          scope,
          idToken: 'signed-id-token',
          oauthClientId: 'oaiapp_user',
          oauthSubject: 'subject',
        },
        { label: 'personal', accessToken: 'old-access', refreshToken: 'old-refresh' },
      ),
    ).toBe(true);
    expect(config.activeKey).toBe('api');
    const vault: SecretVault = {
      keyVersion: 1,
      encrypt: (value) => `enc:${value}`,
      decrypt: (value) => value.slice(4),
      isEncrypted: (value) => value.startsWith('enc:'),
    };
    const encrypted = encryptConfigSecrets(config, vault);
    expect(encrypted.apiKeys?.[0]?.idToken).toBe('enc:signed-id-token');
    expect(decryptConfigSecrets(encrypted, vault)).toEqual(config);
  });
});
