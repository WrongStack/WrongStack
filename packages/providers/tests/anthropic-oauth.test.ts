import { type ProviderConfig, ProviderError, type Request } from '@wrongstack/contracts/types';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  ANTHROPIC_OAUTH_RETIRED_MESSAGE,
  RetiredAnthropicOAuthProvider,
} from '../src/anthropic-oauth.js';
import { retiredProviderAuthLoginHint } from '../src/oauth/builtin-strategies.js';
import { createBuiltinProviderAuthRegistry } from '../src/oauth/index.js';
import { makeProviderFromConfig } from '../src/provider-factory.js';

// The Claude sign-in only worked by posing as Claude Code, so it was removed.
// A saved `anthropic-oauth` entry must still load, refuse every request with
// guidance, and never put its stored tokens on the wire.

const req: Request = {
  model: 'claude-test-model',
  messages: [{ role: 'user', content: 'hi' }],
  maxTokens: 16,
};

const saved: ProviderConfig = {
  type: 'anthropic-oauth',
  family: 'anthropic-oauth',
  baseUrl: 'https://api.anthropic.com',
  activeKey: 'oauth-default',
  apiKeys: [
    {
      label: 'oauth-default',
      apiKey: 'sk-ant-oat-stored',
      refreshToken: 'rt-stored',
      expiresAt: new Date(0).toISOString(),
      authMethod: 'oauth',
      createdAt: new Date(0).toISOString(),
    },
  ],
};

async function refusal(run: () => Promise<unknown>): Promise<ProviderError> {
  const err = await run().then(
    () => undefined,
    (e: unknown) => e,
  );
  expect(err).toBeInstanceOf(ProviderError);
  return err as ProviderError;
}

describe('retired anthropic-oauth family', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('a saved entry still builds, under its own id', () => {
    const provider = makeProviderFromConfig('claude-work', saved);
    expect(provider).toBeInstanceOf(RetiredAnthropicOAuthProvider);
    expect(provider.id).toBe('claude-work');
    expect(provider.capabilities.tools).toBe(true);
  });

  it('refuses stream and complete with a non-retryable auth error, sending nothing', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const provider = makeProviderFromConfig('anthropic-oauth', saved);
    const signal = new AbortController().signal;

    const streamed = await refusal(async () => {
      for await (const _ of provider.stream(req, { signal })) {
        // unreachable: the first pull rejects
      }
    });
    const completed = await refusal(() => provider.complete(req, { signal }));

    for (const err of [streamed, completed]) {
      expect(err.kind).toBe('auth');
      expect(err.retryable).toBe(false);
      expect(err.providerId).toBe('anthropic-oauth');
      expect(err.message).toBe(ANTHROPIC_OAUTH_RETIRED_MESSAGE);
    }
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('shows the whole guidance in the one-line description', async () => {
    const err = await refusal(() =>
      new RetiredAnthropicOAuthProvider().complete(req, {
        signal: new AbortController().signal,
      }),
    );
    expect(err.describe()).toContain(ANTHROPIC_OAUTH_RETIRED_MESSAGE);
    expect(err.describe()).toContain('wstack auth anthropic');
  });
});

describe('retired Claude sign-in', () => {
  it('is not offered as a login strategy', () => {
    const registry = createBuiltinProviderAuthRegistry();
    expect(registry.get('claude')).toBeUndefined();
    for (const alias of ['claude', 'anthropic', 'claude-max', 'anthropic-oauth', 'max']) {
      expect(registry.resolveId(alias)).toBeUndefined();
    }
  });

  it('answers every old login name with the API-key route', () => {
    for (const alias of ['claude', 'Anthropic', ' claude-pro ', 'claude-max', 'anthropic-oauth']) {
      const hint = retiredProviderAuthLoginHint(alias);
      expect(hint).toContain('wstack auth anthropic');
      expect(hint).toContain('/acp');
    }
    expect(retiredProviderAuthLoginHint('chatgpt')).toBeUndefined();
  });
});
