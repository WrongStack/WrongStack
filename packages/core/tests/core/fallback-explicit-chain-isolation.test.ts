/**
 * Regression: the leader agent's fallback chain must NOT mix favorites,
 * auto-discovered models, the "default" profile, or every configured
 * provider when the user has set an explicit fallbackModels list or
 * a named fallbackProfile. The explicit chain is authoritative.
 */
import { describe, expect, it } from 'vitest';
import { FallbackProfileManager } from '../../src/core/fallback-profile-manager.js';
import type { Config } from '../../src/types/config.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    provider: 'primary',
    model: 'model-a',
    providers: {
      primary: { type: 'openai', apiKey: 'k1', models: ['model-a', 'model-b'] },
      secondary: { type: 'anthropic', apiKey: 'k2', models: ['claude-3'] },
      tertiary: { type: 'openai', apiKey: 'k3', models: ['gpt-4o'] },
    },
    favoriteModels: ['primary/model-b'],
    fallbackModels: [],
    fallbackProfiles: {
      default: ['secondary/claude-3'],
      custom: ['tertiary/gpt-4o'],
    },
    fallbackAuto: true,
    ...overrides,
  } as never as Config;
}

const target = { providerId: 'primary', model: 'model-a' };

describe('explicit fallback chain isolation', () => {
  it('resolveEffective with explicit fallbackModels does not append every configured provider', () => {
    const cfg = makeConfig({
      fallbackModels: ['secondary/claude-3'],
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackModels: ['secondary/claude-3'],
      fallbackAuto: true, // auto should be ignored when explicit list is non-empty
      exclude: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    // Only the explicit model — NOT gpt-4o, NOT model-b (favorites)
    expect(keys).toEqual(['secondary/claude-3']);
  });

  it('resolveEffective with named profile does not append favorites or auto models', () => {
    const cfg = makeConfig({
      favoriteModels: ['primary/model-b', 'tertiary/gpt-4o'],
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackProfile: 'custom', // -> tertiary/gpt-4o
      fallbackAuto: true,
      exclude: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    expect(keys).toEqual(['tertiary/gpt-4o']);
  });

  it('resolveEffective falls through to auto when profile name is unknown', () => {
    const cfg = makeConfig();
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackProfile: 'nonexistent',
      fallbackAuto: true,
      exclude: target,
    });
    // Should get auto-derived models, not empty
    expect(chain.length).toBeGreaterThan(0);
  });

  it('resolveAllConfigured returns every configured model', () => {
    const cfg = makeConfig();
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveAllConfigured(target);
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    // Should include models from all providers
    expect(keys).toContain('primary/model-b');
    expect(keys).toContain('secondary/claude-3');
    expect(keys).toContain('tertiary/gpt-4o');
  });

  it('resolveAllConfigured is NOT merged into an explicit chain in resolveEffective', () => {
    const cfg = makeConfig({
      fallbackModels: ['secondary/claude-3'],
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackModels: ['secondary/claude-3'],
      fallbackAuto: true,
      exclude: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    // Must NOT contain auto-discovered models from other providers
    expect(keys).not.toContain('tertiary/gpt-4o');
    expect(keys).not.toContain('primary/model-b');
    expect(keys).toEqual(['secondary/claude-3']);
  });

  it('smart default includes favorites first when no explicit chain', () => {
    const cfg = makeConfig({
      favoriteModels: ['primary/model-b'],
    });
    const mgr = new FallbackProfileManager(cfg);
    const chain = mgr.resolveEffective({
      fallbackAuto: true,
      exclude: target,
    });
    const keys = chain.map((e) => `${e.providerId}/${e.model}`);
    // Favorite should come first in auto-derived chain
    expect(keys[0]).toBe('primary/model-b');
  });
});
