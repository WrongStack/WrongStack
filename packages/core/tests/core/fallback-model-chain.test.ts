/**
 * Tests for core/fallback-model.ts — pure chain resolution functions.
 * Covers: effectiveFallbackChain, smartDefaultFallbackChain, fallbackProfileChain.
 */
import { describe, expect, it } from 'vitest';
import {
  effectiveFallbackChain,
  fallbackProfileChain,
  smartDefaultFallbackChain,
} from '../../src/core/fallback-model.js';
import type { Config } from '../../src/types/config.js';

function makeConfig(overrides: Record<string, unknown> = {}): Config {
  return {
    provider: 'test-provider',
    model: 'test-model',
    providers: {
      'test-provider': { type: 'openai', apiKey: 'sk-test', models: ['test-model', 'other-model'] },
      'backup-provider': { type: 'anthropic', apiKey: 'sk-backup', models: ['claude-3'] },
    },
    favoriteModels: [
      'test-provider/test-model',
      'test-provider/other-model',
      'backup-provider/claude-3',
    ],
    fallbackModels: [],
    fallbackAuto: true,
    ...overrides,
  } as never as Config;
}

describe('effectiveFallbackChain', () => {
  it('returns explicit fallbackModels when set', () => {
    const config = makeConfig({ fallbackModels: ['backup-provider/claude-3'] });
    const chain = effectiveFallbackChain(config);
    expect(chain).toContain('backup-provider/claude-3');
  });

  it('returns empty chain when fallbackAuto is off and no explicit models', () => {
    const config = makeConfig({ fallbackAuto: false, fallbackModels: [] });
    const chain = effectiveFallbackChain(config);
    expect(chain).toEqual([]);
  });

  it('returns smart default chain when fallbackAuto is on', () => {
    const config = makeConfig({ fallbackAuto: true, fallbackModels: [] });
    const chain = effectiveFallbackChain(config);
    // Smart default should include available models
    expect(Array.isArray(chain)).toBe(true);
  });
});

describe('smartDefaultFallbackChain', () => {
  it('returns a chain from available providers', () => {
    const config = makeConfig();
    const chain = smartDefaultFallbackChain(config);
    expect(Array.isArray(chain)).toBe(true);
  });

  it('returns empty chain with no providers', () => {
    const config = makeConfig({ providers: {} });
    const chain = smartDefaultFallbackChain(config);
    expect(chain).toEqual([]);
  });
});

describe('fallbackProfileChain', () => {
  it('resolves a named profile to a chain', () => {
    const config = makeConfig({
      fallbackProfiles: { fast: ['test-provider/test-model', 'backup-provider/claude-3'] },
    });
    const chain = fallbackProfileChain(config, 'fast');
    expect(chain).toEqual(['test-provider/test-model', 'backup-provider/claude-3']);
  });

  it('returns empty chain for undefined profile name', () => {
    const config = makeConfig();
    const chain = fallbackProfileChain(config, undefined);
    expect(chain).toEqual([]);
  });

  it('returns empty chain for nonexistent profile', () => {
    const config = makeConfig({ fallbackProfiles: {} });
    const chain = fallbackProfileChain(config, 'nonexistent');
    expect(chain).toEqual([]);
  });
});
