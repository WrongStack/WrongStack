import { describe, expect, it } from 'vitest';
import {
  diagnoseFallbackConfig,
  simulateFallbackFailover,
} from '../../src/core/fallback-doctor.js';
import type { Config } from '../../src/types/config.js';

describe('FallbackDoctor', () => {
  it('detects empty fallback chains and flags as critical', () => {
    const config: Config = {
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      fallbackAuto: false,
      fallbackModels: [],
      providers: {
        anthropic: { apiKey: 'test-key', models: ['claude-3-7-sonnet'] },
      },
    } as unknown as Config;

    const report = diagnoseFallbackConfig(config);
    expect(report.status).toBe('critical');
    expect(report.effectiveOrder).toEqual([]);
    expect(report.warnings.some((w) => w.code === 'EMPTY_CHAIN')).toBe(true);
  });

  it('detects single-provider sibling quarantine risks', () => {
    const config: Config = {
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      fallbackModels: ['anthropic/claude-3-5-haiku'],
      providers: {
        anthropic: { apiKey: 'test-key', models: ['claude-3-7-sonnet', 'claude-3-5-haiku'] },
      },
    } as unknown as Config;

    const report = diagnoseFallbackConfig(config);
    expect(report.status).toBe('warning');
    expect(report.warnings.some((w) => w.code === 'SIBLING_QUARANTINE_RISK')).toBe(true);
    expect(report.crossProviderCount).toBe(0);
  });

  it('reports healthy when multi-provider fallback is configured and valid', () => {
    const config: Config = {
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      fallbackModels: ['openai/gpt-4o', 'google/gemini-2.0-flash'],
      providers: {
        anthropic: { apiKey: 'ant-key', models: ['claude-3-7-sonnet'] },
        openai: { apiKey: 'oai-key', models: ['gpt-4o'] },
        google: { apiKey: 'gem-key', models: ['gemini-2.0-flash'] },
      },
    } as unknown as Config;

    const report = diagnoseFallbackConfig(config);
    expect(report.status).toBe('healthy');
    expect(report.warnings).toHaveLength(0);
    expect(report.crossProviderCount).toBe(2);
    expect(report.effectiveOrder).toEqual(['openai/gpt-4o', 'google/gemini-2.0-flash']);
  });

  it('simulates failover for rate_limit and identifies rotation target', () => {
    const config: Config = {
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      fallbackModels: ['openai/gpt-4o', 'google/gemini-2.0-flash'],
      providers: {
        anthropic: { apiKey: 'ant-key', models: ['claude-3-7-sonnet'] },
        openai: { apiKey: 'oai-key', models: ['gpt-4o'] },
        google: { apiKey: 'gem-key', models: ['gemini-2.0-flash'] },
      },
    } as unknown as Config;

    const sim = simulateFallbackFailover(config, { errorKind: 'rate_limit' });
    expect(sim.isFallbackEligible).toBe(true);
    expect(sim.finalTarget).toEqual({ providerId: 'openai', model: 'gpt-4o' });
    expect(sim.steps[0]?.skipped).toBe(false);
    expect(sim.steps[0]?.providerSwitched).toBe(true);
  });

  it('correctly handles non-fallback-worthy errors like context_overflow', () => {
    const config: Config = {
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      fallbackModels: ['openai/gpt-4o'],
      providers: {
        anthropic: { apiKey: 'ant-key', models: ['claude-3-7-sonnet'] },
        openai: { apiKey: 'oai-key', models: ['gpt-4o'] },
      },
    } as unknown as Config;

    const sim = simulateFallbackFailover(config, { errorKind: 'context_overflow' });
    expect(sim.isFallbackEligible).toBe(false);
    expect(sim.finalTarget).toBeNull();
    expect(sim.summary).toContain('not fallback-worthy');
  });

  it('simulates skipping candidates whose context window is smaller than current tokens', () => {
    const config: Config = {
      provider: 'anthropic',
      model: 'claude-3-7-sonnet',
      fallbackModels: ['smallprov/small-model', 'bigprov/big-model'],
      providers: {
        anthropic: { apiKey: 'ant-key', models: ['claude-3-7-sonnet'] },
        smallprov: { apiKey: 'key1', models: ['small-model'] },
        bigprov: { apiKey: 'key2', models: ['big-model'] },
      },
    } as unknown as Config;

    const sim = simulateFallbackFailover(config, {
      errorKind: 'rate_limit',
      currentTokens: 50000,
      modelContextLimitMap: {
        'smallprov/small-model': 32000,
        'bigprov/big-model': 128000,
      },
    });

    expect(sim.isFallbackEligible).toBe(true);
    expect(sim.steps[0]?.skipped).toBe(true);
    expect(sim.steps[0]?.reason).toContain('exceeds model window');
    expect(sim.steps[1]?.skipped).toBe(false);
    expect(sim.finalTarget).toEqual({ providerId: 'bigprov', model: 'big-model' });
  });

  it('diagnoses context window downgrade warning when fallback has smaller context than primary', () => {
    const config: Config = {
      provider: 'google',
      model: 'gemini-2.0-flash',
      fallbackModels: ['anthropic/claude-3-7-sonnet', 'openai/gpt-4o'],
      providers: {
        google: { apiKey: 'k1', models: ['gemini-2.0-flash'] },
        anthropic: { apiKey: 'k2', models: ['claude-3-7-sonnet'] },
        openai: { apiKey: 'k3', models: ['gpt-4o'] },
      },
    } as unknown as Config;

    const report = diagnoseFallbackConfig(config, undefined, {
      modelContextLimitMap: {
        'google/gemini-2.0-flash': 1_048_576,
        'anthropic/claude-3-7-sonnet': 200_000,
        'openai/gpt-4o': 128_000,
      },
    });

    expect(report.status).toBe('warning');
    const warnings = report.warnings.filter((w) => w.code === 'CONTEXT_WINDOW_WARNING');
    expect(warnings).toHaveLength(2);
    expect(warnings[0]?.target).toBe('anthropic/claude-3-7-sonnet');
    expect(warnings[0]?.message).toContain('Context window downgrade');
  });
});
