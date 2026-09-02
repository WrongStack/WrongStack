import { describe, expect, it } from 'vitest';
import type { ModelsDevPayload } from '../../src/types/models-registry.js';
import { mergeModelsPayload } from '../../src/utils/merge-models-payload.js';

function payload(p: ModelsDevPayload): ModelsDevPayload {
  return p;
}

describe('mergeModelsPayload', () => {
  it('overlay model field overrides the base', () => {
    const base = payload({
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        npm: '@ai-sdk/openai-compatible',
        models: {
          'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'V4 Pro', limit: { context: 32_000 } },
        },
      },
    });
    const overlay = payload({
      deepseek: {
        id: 'deepseek',
        name: 'DeepSeek',
        models: {
          'deepseek-v4-pro': { id: 'deepseek-v4-pro', name: 'V4 Pro', limit: { context: 128_000 } },
        },
      },
    });
    const merged = mergeModelsPayload(base, overlay);
    expect(merged.deepseek!.models['deepseek-v4-pro']!.limit!.context).toBe(128_000);
  });

  it('partial nested override keeps the base sub-fields (limit.output preserved)', () => {
    const base = payload({
      p: {
        id: 'p',
        name: 'P',
        models: {
          m: { id: 'm', name: 'M', limit: { context: 8_000, output: 4_000 }, tool_call: true },
        },
      },
    });
    const overlay = payload({
      p: { id: 'p', name: 'P', models: { m: { id: 'm', name: 'M', limit: { context: 200_000 } } } },
    });
    const merged = mergeModelsPayload(base, overlay);
    const m = merged.p!.models.m!;
    expect(m.limit!.context).toBe(200_000); // overridden
    expect(m.limit!.output).toBe(4_000); // preserved from base
    expect(m.tool_call).toBe(true); // preserved from base
  });

  it('adds a provider that is absent from the base', () => {
    const base = payload({ a: { id: 'a', name: 'A', models: {} } });
    const overlay = payload({
      custom: {
        id: 'custom',
        name: 'Custom Co',
        npm: '@ai-sdk/openai-compatible',
        api: 'https://api.custom.example',
        env: ['CUSTOM_API_KEY'],
        models: { 'custom-1': { id: 'custom-1', name: 'Custom One', limit: { context: 64_000 } } },
      },
    });
    const merged = mergeModelsPayload(base, overlay);
    expect(merged.a).toBeDefined();
    expect(merged.custom!.api).toBe('https://api.custom.example');
    expect(merged.custom!.models['custom-1']!.limit!.context).toBe(64_000);
  });

  it('adds a model to an existing provider without dropping siblings', () => {
    const base = payload({
      p: { id: 'p', name: 'P', models: { old: { id: 'old', name: 'Old' } } },
    });
    const overlay = payload({
      p: { id: 'p', name: 'P', models: { fresh: { id: 'fresh', name: 'Fresh' } } },
    });
    const merged = mergeModelsPayload(base, overlay);
    expect(Object.keys(merged.p!.models).sort()).toEqual(['fresh', 'old']);
  });

  it('overlay provider scalar fields override base; undefined fields keep base', () => {
    const base = payload({
      p: { id: 'p', name: 'Old Name', npm: '@ai-sdk/openai', api: 'https://old', models: {} },
    });
    const overlay = payload({ p: { id: 'p', name: 'New Name', models: {} } });
    const merged = mergeModelsPayload(base, overlay);
    expect(merged.p!.name).toBe('New Name'); // overridden
    expect(merged.p!.api).toBe('https://old'); // not in overlay → base kept
    expect(merged.p!.npm).toBe('@ai-sdk/openai'); // not in overlay → base kept
  });

  it('empty overlay returns the base unchanged (deep-cloned)', () => {
    const base = payload({ p: { id: 'p', name: 'P', models: { m: { id: 'm', name: 'M' } } } });
    const merged = mergeModelsPayload(base, {});
    expect(merged).toEqual(base);
    expect(merged.p).not.toBe(base.p); // cloned, not the same reference
  });

  it('empty base returns the overlay', () => {
    const overlay = payload({ p: { id: 'p', name: 'P', models: { m: { id: 'm', name: 'M' } } } });
    const merged = mergeModelsPayload({}, overlay);
    expect(merged).toEqual(overlay);
  });

  it('does not mutate its inputs', () => {
    const base = payload({
      p: { id: 'p', name: 'P', models: { m: { id: 'm', name: 'M', limit: { context: 1 } } } },
    });
    const overlay = payload({
      p: { id: 'p', name: 'P', models: { m: { id: 'm', name: 'M', limit: { context: 2 } } } },
    });
    const baseSnapshot = JSON.stringify(base);
    const overlaySnapshot = JSON.stringify(overlay);
    mergeModelsPayload(base, overlay);
    expect(JSON.stringify(base)).toBe(baseSnapshot);
    expect(JSON.stringify(overlay)).toBe(overlaySnapshot);
  });
});
