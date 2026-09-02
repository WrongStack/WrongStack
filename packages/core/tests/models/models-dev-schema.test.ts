import { describe, expect, it } from 'vitest';
import {
  MODELS_DEV_MODALITY_VALUES,
  modelsDevModelSchema,
  modelsDevPayloadSchema,
  modelsDevProviderSchema,
  type ModelsDevModelParsed,
} from '../../src/models/models-dev-schema.js';
import type { ModelsDevModel } from '../../src/types/models-registry.js';

/**
 * Fixtures sampled from the LIVE https://models.dev/api.json on 2026-08-03
 * (3.45 MB, 179 providers, 6,044 models) so the schema is proven against
 * real upstream shapes, not hand-invented ones.
 */
const CLAUDE_SONNET_4_6 = {
  id: 'claude-sonnet-4-6',
  name: 'Claude Sonnet 4.6',
  description: 'Claude workhorse for coding agents, careful analysis, and production cost control',
  family: 'claude-sonnet',
  attachment: true,
  reasoning: true,
  reasoning_options: [
    { type: 'effort', values: ['low', 'medium', 'high', 'max'] },
    { type: 'budget_tokens', min: 1024 },
  ],
  tool_call: true,
  structured_output: true,
  temperature: true,
  knowledge: '2025-08-31',
  release_date: '2026-02-17',
  last_updated: '2026-03-13',
  modalities: { input: ['text', 'image', 'pdf'], output: ['text'] },
  open_weights: false,
  limit: { context: 1_000_000, output: 128_000 },
  cost: { input: 3, output: 15, cache_read: 0.3, cache_write: 3.75 },
};

const GPT_IMAGE_2 = {
  id: 'gpt-image-2',
  name: 'gpt-image-2',
  description: 'Image model for prompt-driven generation, editing, and visual design workflows',
  family: 'gpt-image',
  attachment: true,
  reasoning: false,
  tool_call: false,
  temperature: false,
  release_date: '2026-04-21',
  last_updated: '2026-04-21',
  modalities: { input: ['text', 'image'], output: ['image'] },
  open_weights: false,
  // Edge case: zero-valued limits including the subset-only `input` field.
  limit: { context: 0, input: 0, output: 0 },
  cost: { input: 5, output: 30, cache_read: 1.25 },
};

/** Synthetic but representative of observed upstream shapes (2026-08-03 census). */
const MODEL_WITH_RARE_FIELDS = {
  id: 'acme-tiered-1',
  name: 'Acme Tiered 1',
  status: 'deprecated',
  experimental: true,
  interleaved: { field: 'thinking' },
  reasoning_options: { type: 'toggle' },
  cost: {
    input: 2,
    output: 8,
    // `tiers` was observed on ~300 upstream models; it is NOT a plain number,
    // so the cost schema must pass it through without numeric validation.
    tiers: [{ up_to: 200_000, input: 2, output: 8 }],
  },
  limit: { context: 200_000, output: 16_384 },
  // Unknown future field — must survive passthrough.
  future_field: { whatever: true },
};

describe('modelsDevModelSchema', () => {
  it('parses real anthropic claude-sonnet-4-6 across every field group', () => {
    const parsed = modelsDevModelSchema.parse(CLAUDE_SONNET_4_6);
    expect(parsed.id).toBe('claude-sonnet-4-6');
    expect(parsed.limit).toMatchObject({ context: 1_000_000, output: 128_000 });
    expect(parsed.cost).toMatchObject({ input: 3, output: 15 });
    expect(parsed.modalities?.input).toEqual(['text', 'image', 'pdf']);
    expect(Array.isArray(parsed.reasoning_options)).toBe(true);
  });

  it('parses openai gpt-image-2 including limit.input=0 and image output modality', () => {
    const parsed = modelsDevModelSchema.parse(GPT_IMAGE_2);
    expect(parsed.limit).toEqual({ context: 0, input: 0, output: 0 });
    expect(parsed.modalities?.output).toEqual(['image']);
  });

  it('accepts rare observed fields: cost.tiers, single reasoning_options, status, experimental, interleaved', () => {
    const parsed = modelsDevModelSchema.parse(MODEL_WITH_RARE_FIELDS);
    expect(parsed.status).toBe('deprecated');
    expect(parsed.experimental).toBe(true);
    // tiers is an array upstream — must NOT be rejected by numeric cost rules.
    expect(parsed.cost?.tiers).toEqual([{ up_to: 200_000, input: 2, output: 8 }]);
  });

  it('preserves unknown fields on parse (never strips upstream drift)', () => {
    const parsed = modelsDevModelSchema.parse(MODEL_WITH_RARE_FIELDS);
    expect(parsed.future_field).toEqual({ whatever: true });
  });

  it('rejects structurally invalid models with actionable errors', () => {
    expect(() => modelsDevModelSchema.parse({ ...CLAUDE_SONNET_4_6, id: '' })).toThrow();
    expect(() => modelsDevModelSchema.parse({ id: 'x' })).toThrow(); // missing name
    expect(() =>
      modelsDevModelSchema.parse({ ...CLAUDE_SONNET_4_6, limit: { context: -1 } }),
    ).toThrow();
    expect(() =>
      modelsDevModelSchema.parse({ ...CLAUDE_SONNET_4_6, limit: { context: 1.5 } }),
    ).toThrow();
    expect(() =>
      modelsDevModelSchema.parse({ ...CLAUDE_SONNET_4_6, modalities: { input: [42] } }),
    ).toThrow();
    expect(() =>
      modelsDevModelSchema.parse({ ...CLAUDE_SONNET_4_6, modalities: { input: [''] } }),
    ).toThrow();
    expect(() =>
      modelsDevModelSchema.parse({ ...CLAUDE_SONNET_4_6, cost: { input: 'free' } }),
    ).toThrow();
    expect(() => modelsDevModelSchema.parse(null)).toThrow();
    expect(() => modelsDevModelSchema.parse('claude')).toThrow();
  });

  it('rejects prototype-pollution model ids', () => {
    for (const badId of ['__proto__', 'constructor', 'prototype']) {
      expect(() => modelsDevModelSchema.parse({ ...CLAUDE_SONNET_4_6, id: badId })).toThrow();
    }
  });
});

describe('modelsDevProviderSchema + modelsDevPayloadSchema', () => {
  const PROVIDER = {
    id: 'anthropic',
    name: 'Anthropic',
    env: ['ANTHROPIC_API_KEY'],
    npm: '@ai-sdk/anthropic',
    doc: 'https://docs.anthropic.com',
    models: { 'claude-sonnet-4-6': CLAUDE_SONNET_4_6 },
  };

  it('parses a real provider entry', () => {
    const parsed = modelsDevProviderSchema.parse(PROVIDER);
    expect(parsed.id).toBe('anthropic');
    expect(parsed.models['claude-sonnet-4-6']?.name).toBe('Claude Sonnet 4.6');
  });

  it('parses a full api.json-shaped payload (provider id → provider)', () => {
    const parsed = modelsDevPayloadSchema.parse({
      anthropic: PROVIDER,
      openai: {
        id: 'openai',
        name: 'OpenAI',
        env: ['OPENAI_API_KEY'],
        models: { 'gpt-image-2': GPT_IMAGE_2 },
      },
    });
    expect(Object.keys(parsed)).toEqual(['anthropic', 'openai']);
    expect(parsed.openai?.models['gpt-image-2']?.limit?.input).toBe(0);
  });

  it('rejects providers without a models map and prototype-pollution provider ids', () => {
    expect(() => modelsDevProviderSchema.parse({ id: 'x', name: 'X' })).toThrow();
    expect(() => modelsDevProviderSchema.parse({ ...PROVIDER, id: '__proto__' })).toThrow();
  });
});

describe('schema ↔ static mirror sync', () => {
  it('parsed schema output stays assignable to ModelsDevModel', () => {
    // The assignment itself is the compile-time proof; the runtime asserts
    // guard against a future refactor that weakens the type-level check.
    const parsed: ModelsDevModelParsed = modelsDevModelSchema.parse(CLAUDE_SONNET_4_6);
    const mirrored: ModelsDevModel = parsed;
    expect(mirrored.id).toBe('claude-sonnet-4-6');
    expect(mirrored.limit?.context).toBe(1_000_000);
  });

  it('documents the known modality value set for editor use', () => {
    expect(MODELS_DEV_MODALITY_VALUES).toEqual(['text', 'image', 'audio', 'video', 'pdf']);
  });
});
