import { describe, expect, it } from 'vitest';
import { deriveRows, type ModelRowData } from '../../src/components/SettingsPanel/ModelListEditor';

/**
 * ME-4 ModelListEditor helper tests.
 *
 * Tests the real `deriveRows` helper exported from the component (not a
 * re-implementation) — source classification, name fallback, and the
 * maxOutput + modelsDev limit.output resolution chain.
 */

type CustomModels = Parameters<typeof deriveRows>[1];

function rows(models: string[], customModels: CustomModels = undefined): ModelRowData[] {
  return deriveRows(models, customModels);
}

describe('ME-4: deriveRows', () => {
  it('classifies catalog models without overrides as "catalog"', () => {
    const out = rows(['gpt-4o', 'gpt-4o-mini']);
    expect(out).toEqual([
      {
        modelId: 'gpt-4o',
        name: 'gpt-4o',
        source: 'catalog',
        maxOutput: undefined,
        capabilities: undefined,
        modelsDev: undefined,
      },
      {
        modelId: 'gpt-4o-mini',
        name: 'gpt-4o-mini',
        source: 'catalog',
        maxOutput: undefined,
        capabilities: undefined,
        modelsDev: undefined,
      },
    ]);
  });

  it('classifies models with a customModels entry as "overridden" and prefers its name', () => {
    const out = rows(['gpt-4o'], {
      'gpt-4o': { name: 'My GPT-4o', maxOutput: 16_384 },
    } as CustomModels);
    expect(out[0]?.source).toBe('overridden');
    expect(out[0]?.name).toBe('My GPT-4o');
    expect(out[0]?.maxOutput).toBe(16_384);
  });

  it('resolves name and maxOutput from modelsDev when legacy fields are absent', () => {
    const out = rows(['acme-pro'], {
      'acme-pro': {
        modelsDev: {
          name: 'Acme Pro',
          limit: { context: 500_000, output: 64_000 },
        },
      },
    } as CustomModels);
    expect(out[0]?.name).toBe('Acme Pro');
    expect(out[0]?.source).toBe('overridden');
    expect(out[0]?.modelsDev?.['limit']).toMatchObject({ output: 64_000 });
  });

  it('prefers the legacy maxOutput over modelsDev.limit.output', () => {
    const out = rows(['m1'], {
      m1: { maxOutput: 4096, modelsDev: { limit: { context: 128_000, output: 8192 } } },
    } as CustomModels);
    expect(out[0]?.maxOutput).toBe(4096);
  });
});
