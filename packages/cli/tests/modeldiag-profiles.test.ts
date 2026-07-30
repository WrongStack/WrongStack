import { describe, expect, it } from 'vitest';
import {
  checkMark,
  costLabel,
  EVAL_CATEGORIES,
  EVAL_TASKS,
  findProfile,
  fmtMs,
  fmtPrice,
  fmtTokens,
  MODEL_PROFILES,
  rankModels,
  roleCat,
  scoreBar,
  scoreModel,
  speedLabel,
} from '../src/subcommands/handlers/modeldiag-profiles.js';

describe('modeldiag profiles', () => {
  it('formats token, duration, price, status, cost, and speed values', () => {
    expect(fmtTokens(999)).toBe('999');
    expect(fmtTokens(1_500)).toBe('1.5k');
    expect(fmtTokens(1_500_000)).toBe('1.5M');
    expect(fmtMs(999)).toBe('999ms');
    expect(fmtMs(1_500)).toBe('1.5s');
    expect(fmtPrice(undefined)).toContain('?');
    expect(fmtPrice(2.345)).toBe('$2.35');
    expect(fmtPrice(12.34)).toBe('$12.3');
    expect(checkMark(true)).toContain('✓');
    expect(checkMark(false)).toContain('✗');

    expect(costLabel('premium')).toContain('$$$');
    expect(costLabel('standard')).toContain('$$');
    expect(costLabel('budget')).toContain('$');
    expect(costLabel('unknown')).toContain('?');
    expect(speedLabel('fast')).toContain('⚡');
    expect(speedLabel('normal')).toContain('→');
    expect(speedLabel('slow')).toContain('🐢');
    expect(speedLabel('unknown')).toContain('?');
  });

  it('renders bounded score bars', () => {
    expect(scoreBar(-10, 100)).toContain('-10/100');
    expect(scoreBar(50, 100)).toContain('50/100');
    expect(scoreBar(200, 100)).toContain('200/100');
  });

  it('finds provider-specific model profiles', () => {
    expect(findProfile('anthropic', 'claude-opus-4')?.family).toBe('Claude Opus');
    expect(findProfile('openai', 'gpt-4')?.family).toBe('GPT-4');
    expect(findProfile('missing', 'gpt-4')).toBeUndefined();
    expect(MODEL_PROFILES.length).toBeGreaterThan(5);
  });

  it('scores strengths, weaknesses, cost, speed, and context tiers', () => {
    expect(scoreModel('anthropic', 'claude-opus-4', 'planning', 300_000).score).toBe(120);
    expect(scoreModel('anthropic', 'claude-haiku', 'planning', 120_000).score).toBe(5);
    expect(scoreModel('anthropic', 'claude-haiku', 'docs', 40_000).score).toBe(97);
    expect(scoreModel('missing', 'unknown', 'general', 10_000)).toEqual({
      score: 50,
      profile: undefined,
    });
  });

  it('ranks keyed provider models and projects optional metadata', () => {
    const providers = [
      {
        id: 'openai',
        name: 'OpenAI',
        family: 'openai',
        models: [
          {
            id: 'gpt-5',
            capabilities: { contextWindow: 300_000, maxOutputTokens: 16_000 },
            pricing: { input: 1, output: 2 },
          },
          { id: 'gpt-4', capabilities: { contextWindow: 64_000 } },
        ],
      },
      {
        id: 'anthropic',
        name: 'Anthropic',
        family: 'anthropic',
      },
      {
        id: 'missing-key',
        name: 'Missing',
        family: 'other',
        models: [{ id: 'never-ranked' }],
      },
    ];

    expect(rankModels(providers, (provider) => provider !== 'missing-key', 'coding', 1)).toEqual([
      expect.objectContaining({
        provider: 'openai',
        model: 'gpt-5',
        ctxWindow: 300_000,
        maxOutput: 16_000,
        inputPrice: 1,
        outputPrice: 2,
      }),
    ]);
    expect(
      rankModels(
        [{ id: providers[0]!.id, name: providers[0]!.name, family: providers[0]!.family }],
        () => true,
        'coding',
        5,
      ),
    ).toEqual([]);
  });

  it('maps roles and exposes every standardized evaluation prompt', () => {
    expect(roleCat('security-scanner')).toBe('security');
    expect(roleCat('unknown-role')).toBe('general');
    expect(EVAL_CATEGORIES).toEqual(Object.keys(EVAL_TASKS));
    expect(EVAL_CATEGORIES).toContain('coding');
    expect(EVAL_TASKS['security']?.prompt).toContain('security issues');
  });
});
