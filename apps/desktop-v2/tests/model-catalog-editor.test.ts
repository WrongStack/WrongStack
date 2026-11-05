import { describe, expect, it } from 'vitest';
import { catalogMatchDefinition } from '../src/CatalogModelSearch';
import {
  buildModelDefinition,
  containsModelDefinition,
  modelDefinition,
  modelEditorDraft,
  modelTextInputType,
} from '../src/model-catalog-editor';

describe('native model definitions', () => {
  it('imports reported catalog metadata including free prices without inventing negative capabilities', () => {
    expect(
      catalogMatchDefinition({
        name: 'Catalog example',
        modelId: 'example',
        inputCost: 0,
        outputCost: 2,
        contextWindow: 1000,
        capabilities: [],
      }),
    ).toEqual({
      modelsDev: {
        name: 'Catalog example',
        cost: { input: 0, output: 2 },
        limit: { context: 1000 },
      },
    });
  });
  it('preserves unedited schema and synchronizes explicit false and numeric overrides', () => {
    const initial = {
      provider: 'local',
      name: 'Old model',
      maxOutput: 8192,
      capabilities: { tools: true, vision: true, streaming: false },
      modelsDev: {
        name: 'Old model',
        tool_call: true,
        reasoning_options: { type: 'effort', values: ['low', 'high'] },
        cost: { input: 1, tiers: [{ from: 200000, input: 2 }] },
        limit: { output: 8192, custom_budget: 42 },
        modalities: { input: ['text', 'image'], output: ['text'], extra: 'keep' },
        experimental: true,
      },
    };
    const draft = modelEditorDraft('test/model', initial);
    draft.text['name'] = 'Reviewed model';
    draft.flags['tool_call'] = 'false';
    draft.numbers['limit.output'] = '16384';
    draft.numbers['cost.input'] = '0';
    const { definition } = buildModelDefinition(draft, initial);
    expect(definition).toMatchObject({
      provider: 'local',
      name: 'Reviewed model',
      maxOutput: 16384,
      capabilities: { tools: false, vision: true, streaming: false },
      modelsDev: {
        tool_call: false,
        experimental: true,
        reasoning_options: { type: 'effort', values: ['low', 'high'] },
        limit: { output: 16384, custom_budget: 42 },
        cost: { input: 0, tiers: [{ from: 200000, input: 2 }] },
        modalities: { extra: 'keep' },
      },
    });
    expect(initial.capabilities.tools).toBe(true);
    expect(initial.modelsDev.limit.output).toBe(8192);
  });
  it('clears controlled overrides to inherit without dropping unrelated properties', () => {
    const initial = {
      maxOutput: 123,
      capabilities: { tools: true, maxOutput: 123, maxContext: 456, vision: false },
      modelsDev: {
        name: 'Test',
        tool_call: true,
        limit: { output: 123, context: 456 },
        cost: { input: 1, cache_write_1h: 3 },
      },
    };
    const draft = modelEditorDraft('test', initial);
    draft.numbers['limit.output'] = '';
    draft.numbers['limit.context'] = '';
    draft.numbers['cost.input'] = '';
    draft.flags['tool_call'] = 'inherit';
    const { definition } = buildModelDefinition(draft, initial);
    expect(definition['maxOutput']).toBeUndefined();
    expect(definition['capabilities']).toEqual({ vision: false });
    expect(definition['modelsDev']).toEqual({ name: 'Test', cost: { cache_write_1h: 3 } });
  });
  it.each(['-1', 'NaN', 'Infinity', '1.5', '0', '9007199254740992'])(
    'rejects invalid token limit %s before any write',
    (value) => {
      const draft = modelEditorDraft('test', { name: 'Test' });
      draft.numbers['limit.context'] = value;
      expect(() => buildModelDefinition(draft, {})).toThrow('positive integer');
    },
  );
  it.each(['__proto__', 'constructor', '', 'x'.repeat(257)])(
    'rejects invalid model identity',
    (id) => {
      expect(() => buildModelDefinition(modelEditorDraft(id, { name: 'Test' }), {})).toThrow(
        'model ID',
      );
    },
  );
  it('verifies saved fields without requiring normalization output to have identical keys', () => {
    expect(
      containsModelDefinition(
        { name: 'Test', modelsDev: { name: 'Test', tool_call: false, extra: true } },
        { modelsDev: { name: 'Test', tool_call: false } },
      ),
    ).toBe(true);
    expect(
      containsModelDefinition(
        { modelsDev: { tool_call: true } },
        { modelsDev: { tool_call: false } },
      ),
    ).toBe(false);
    expect(modelDefinition({ customModels: {} }, 'constructor')).toBeUndefined();
  });
  it('verifies normalized arrays independent of object key order while checking every value and array position', () => {
    const expected = {
      modelsDev: { reasoning_options: [{ type: 'budget_tokens', min: 1024, max: 32768 }] },
    };
    expect(
      containsModelDefinition(
        { modelsDev: { reasoning_options: [{ max: 32768, min: 1024, type: 'budget_tokens' }] } },
        expected,
      ),
    ).toBe(true);
    expect(
      containsModelDefinition(
        { modelsDev: { reasoning_options: [{ max: 32769, min: 1024, type: 'budget_tokens' }] } },
        expected,
      ),
    ).toBe(false);
    expect(containsModelDefinition({ modelsDev: { reasoning_options: [] } }, expected)).toBe(false);
  });
});

describe('model date fields', () => {
  it('edit each recorded shape in its own picker and keep other text as text', () => {
    expect(modelTextInputType('knowledge', '2024-10')).toBe('month');
    expect(modelTextInputType('knowledge', '2024-10-01')).toBe('date');
    expect(modelTextInputType('knowledge', '')).toBe('month');
    expect(modelTextInputType('release_date', '2025-02')).toBe('month');
    expect(modelTextInputType('release_date', '')).toBe('date');
    expect(modelTextInputType('last_updated', 'early 2025')).toBe('text');
    expect(modelTextInputType('family', '2025-02-19')).toBe('text');
  });
});
