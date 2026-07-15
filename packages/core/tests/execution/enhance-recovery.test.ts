import { describe, expect, it } from 'vitest';
import {
  ENHANCE_MIN_RETRY_TIMEOUT_MS,
  nextEnhanceTimeout,
  resolveEnhanceFallbackRef,
} from '../../src/execution/enhance-recovery.js';
import type { Config } from '../../src/types/config.js';

function cfg(over: Partial<Config> = {}): Config {
  return {
    provider: 'openai',
    model: 'gpt-5',
    providers: {},
    ...over,
  } as Config;
}

describe('nextEnhanceTimeout', () => {
  it('doubles the base window, floored at the minimum', () => {
    // 90s * 2 = 180s, which equals the floor.
    expect(nextEnhanceTimeout(90_000)).toBe(180_000);
    // A tiny base still floors to the minimum.
    expect(nextEnhanceTimeout(10_000)).toBe(ENHANCE_MIN_RETRY_TIMEOUT_MS);
    // A large base doubles above the floor.
    expect(nextEnhanceTimeout(120_000)).toBe(240_000);
  });

  it('honors an explicit override but never shortens below the base', () => {
    expect(nextEnhanceTimeout(90_000, { enhanceRetryTimeoutMs: 300_000 })).toBe(300_000);
    // Override smaller than base is clamped up to the base.
    expect(nextEnhanceTimeout(90_000, { enhanceRetryTimeoutMs: 10_000 })).toBe(90_000);
    // Non-positive / non-finite overrides fall back to the derived value.
    expect(nextEnhanceTimeout(90_000, { enhanceRetryTimeoutMs: 0 })).toBe(180_000);
  });
});

describe('resolveEnhanceFallbackRef', () => {
  it('prefers an explicit enhanceFallbackModel', () => {
    const ref = resolveEnhanceFallbackRef(
      cfg({ autonomy: { enhanceFallbackModel: 'anthropic/claude-haiku-4-5' } as never }),
    );
    expect(ref).toBe('anthropic/claude-haiku-4-5');
  });

  it('normalizes a bare model on the explicit ref against the session provider', () => {
    const ref = resolveEnhanceFallbackRef(
      cfg({ provider: 'openai', autonomy: { enhanceFallbackModel: 'gpt-4o-mini' } as never }),
    );
    expect(ref).toBe('openai/gpt-4o-mini');
  });

  it('falls back to the first entry of the effective fallback chain when unset', () => {
    const ref = resolveEnhanceFallbackRef(
      cfg({
        provider: 'openai',
        model: 'gpt-5',
        fallbackModels: ['anthropic/claude-sonnet-5', 'deepseek/deepseek-chat'],
      }),
    );
    expect(ref).toBe('anthropic/claude-sonnet-5');
  });

  it('returns undefined when nothing is configured or derivable', () => {
    const ref = resolveEnhanceFallbackRef(
      cfg({ provider: 'openai', model: 'gpt-5', fallbackModels: [], fallbackAuto: false }),
    );
    expect(ref).toBeUndefined();
  });
});
