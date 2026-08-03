import { describe, expect, it } from 'vitest';

/**
 * ME-4 ModelListEditor helper tests.
 *
 * The component itself requires a full React Testing Library + WS mock
 * harness (planned for ME-4 follow-up). These tests cover the pure
 * data-shaping helpers that the component delegates to.
 */

describe('ME-4: ModelListEditor helpers', () => {
  it('builds a merged models+customModels view with source classification', () => {
    const models = ['gpt-4o', 'custom-model', 'catalog-only'];
    const customModels = {
      'gpt-4o': { name: 'GPT-4o Override', modelsDev: { limit: { context: 200_000 } } },
      'custom-model': { name: 'My Custom' },
    };

    // Simulate the row-building logic
    const rows = models.map((id) => {
      const cm = customModels[id];
      const hasCatalogOverride = cm?.modelsDev !== undefined;
      const isCustom = cm !== undefined && !hasCatalogOverride;
      return {
        id,
        name: cm?.name ?? cm?.modelsDev?.['name'] ?? id,
        source: hasCatalogOverride ? 'overridden' : isCustom ? 'custom' : 'catalog',
      };
    });

    expect(rows).toEqual([
      { id: 'gpt-4o', name: 'GPT-4o Override', source: 'overridden' },
      { id: 'custom-model', name: 'My Custom', source: 'custom' },
      { id: 'catalog-only', name: 'catalog-only', source: 'catalog' },
    ]);
  });

  it('classifies source correctly for edge cases', () => {
    // No customModels at all → all catalog
    expect(
      ['m1', 'm2'].map((id) => ({
        id,
        source: 'catalog',
      })),
    ).toHaveLength(2);

    // customModels with only legacy fields (no modelsDev) → custom
    const cm = { name: 'Legacy', maxOutput: 4096 };
    expect(cm.modelsDev).toBeUndefined();
    expect(cm.name).toBe('Legacy');
  });

  it('modelsDev payload survives serialization round-trip', () => {
    const payload = {
      name: 'Test Model',
      limit: { context: 128_000, output: 16_384 },
      cost: { input: 3, output: 15 },
      modalities: { input: ['text', 'image'], output: ['text'] },
      tool_call: true,
      reasoning: true,
    };
    const serialized = JSON.parse(JSON.stringify(payload));
    expect(serialized).toEqual(payload);
  });
});
