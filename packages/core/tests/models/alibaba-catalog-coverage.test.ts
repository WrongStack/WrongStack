/**
 * Coverage for core/src/models/alibaba-token-plan-catalog.ts
 */
import { describe, expect, it } from 'vitest';
import {
  ALIBABA_TOKEN_PLAN_MODELS,
  alibabaTokenPlanModelMeta,
} from '../../src/models/alibaba-token-plan-catalog.js';

describe('ALIBABA_TOKEN_PLAN_MODELS', () => {
  it('exports a non-empty array', () => {
    expect(Array.isArray(ALIBABA_TOKEN_PLAN_MODELS)).toBe(true);
    expect(ALIBABA_TOKEN_PLAN_MODELS.length).toBeGreaterThan(0);
  });

  it('every entry has an id', () => {
    for (const model of ALIBABA_TOKEN_PLAN_MODELS) {
      expect(model.id).toBeDefined();
      expect(typeof model.id).toBe('string');
    }
  });
});

describe('alibabaTokenPlanModelMeta', () => {
  it('returns meta for a known model', () => {
    const first = ALIBABA_TOKEN_PLAN_MODELS[0];
    if (first) {
      const result = alibabaTokenPlanModelMeta(first.id);
      expect(result).toBeDefined();
      expect(result?.id).toBe(first.id);
    }
  });

  it('returns undefined for unknown model', () => {
    expect(alibabaTokenPlanModelMeta('nonexistent-model-xyz')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(alibabaTokenPlanModelMeta('')).toBeUndefined();
  });
});
