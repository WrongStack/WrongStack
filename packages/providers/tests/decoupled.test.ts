import { describe, expect, it } from 'vitest';
import { AnthropicProvider } from '../src/anthropic.js';
import { makeProviderFromConfig } from '../src/index.js';
import { OpenAICompatibleProvider } from '../src/openai-compatible.js';

describe('makeProviderFromConfig (no models.dev dependency)', () => {
  it('constructs an Anthropic provider from explicit family', () => {
    const p = makeProviderFromConfig('custom-claude', {
      type: 'custom-claude',
      family: 'anthropic',
      apiKey: 'sk-fake',
    });
    expect(p).toBeInstanceOf(AnthropicProvider);
    // The user-visible provider id MUST be preserved — not collapsed to
    // the wire family's canonical id ('anthropic'). Without this, every
    // Anthropic-compatible proxy shows up in the status bar / pickers as
    // plain 'anthropic' and the configured alias is silently lost.
    expect(p.id).toBe('custom-claude');
    expect(p.capabilities.tools).toBe(true);
  });

  it('preserves the user-visible id when constructing an Anthropic provider via the preset', () => {
    // Regression: passing the user-visible id through AnthropicProvider
    // directly (the path used by `makeProvider()`'s `case 'anthropic'`)
    // must keep the alias too. Direct construction is what plugins/tests
    // use — the `id` option is the contract.
    const p = new AnthropicProvider({ apiKey: 'sk-fake', id: 'minimax-token-plan' });
    expect(p.id).toBe('minimax-token-plan');
  });

  it('falls back to the wire-family id when no id option is provided', () => {
    // Backward-compat: direct `new AnthropicProvider({ apiKey })` calls
    // (tests, plugins that pre-date the `id` option) must still report
    // `id === 'anthropic'` so existing assertions keep passing.
    const p = new AnthropicProvider({ apiKey: 'sk-fake' });
    expect(p.id).toBe('anthropic');
  });

  it('constructs an OpenAI-compatible provider with baseUrl override', () => {
    const p = makeProviderFromConfig('my-proxy', {
      type: 'my-proxy',
      family: 'openai-compatible',
      apiKey: 'sk-fake',
      baseUrl: 'https://my-llm-proxy.internal/v1',
    });
    expect(p).toBeInstanceOf(OpenAICompatibleProvider);
    expect(p.id).toBe('my-proxy');
  });

  it('rejects missing family with a helpful error', () => {
    expect(() => makeProviderFromConfig('mystery', { type: 'mystery', apiKey: 'sk-fake' })).toThrow(
      /explicit family/,
    );
  });

  it('uses envVars from config when apiKey is absent', () => {
    process.env['MY_CUSTOM_KEY'] = 'sk-from-env';
    try {
      const p = makeProviderFromConfig('custom', {
        type: 'custom',
        family: 'anthropic',
        envVars: ['MY_CUSTOM_KEY'],
      });
      expect(p).toBeInstanceOf(AnthropicProvider);
    } finally {
      delete process.env['MY_CUSTOM_KEY'];
    }
  });

  it('throws if neither apiKey nor envVars match', () => {
    expect(() =>
      makeProviderFromConfig('nokey', {
        type: 'nokey',
        family: 'anthropic',
        envVars: ['UNSET_TEST_VAR_X'],
      }),
    ).toThrow(/requires an API key/);
  });

  // VULN-006 resolver-side sentinel coverage lives in factories.test.ts:
  // makeProviderFromConfig synthesizes `envVars: cfg.envVars ?? []`, which
  // erases the present-vs-absent distinction this sentinel depends on. The
  // distinction only materializes when the preset (p.envVars) is non-empty —
  // i.e. on the buildProviderFactoriesFromRegistry catalog path.
});
