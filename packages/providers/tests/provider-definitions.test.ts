import { describe, expect, it } from 'vitest';
import {
  LOCAL_PROVIDER_DEFINITIONS,
  PROVIDER_DEFINITIONS,
  projectCompatibleProviderPresets,
  projectLocalProviderPresets,
  projectPopularProviderCatalog,
  resolveProviderDefinition,
} from '../src/provider-definitions.js';

describe('canonical ProviderDefinition projections', () => {
  it('projects every local definition without metadata drift', () => {
    const projection = projectLocalProviderPresets();
    expect(projection.map(({ id }) => id)).toEqual(LOCAL_PROVIDER_DEFINITIONS.map(({ id }) => id));
    for (const [index, definition] of LOCAL_PROVIDER_DEFINITIONS.entries()) {
      expect(projection[index]).toEqual({
        id: definition.id,
        label: definition.name,
        defaultBaseUrl: definition.baseUrl,
        noAuth: definition.local?.noAuth,
        hint: definition.local?.hint,
      });
    }
  });

  it('keeps local definitions unique, loopback-only, and OpenAI-compatible', () => {
    expect(new Set(LOCAL_PROVIDER_DEFINITIONS.map(({ id }) => id)).size).toBe(
      LOCAL_PROVIDER_DEFINITIONS.length,
    );
    for (const definition of LOCAL_PROVIDER_DEFINITIONS) {
      expect(definition.family).toBe('openai-compatible');
      expect(definition.usage).toBe('local');
      const url = new URL(definition.baseUrl ?? '');
      expect(['localhost', '127.0.0.1']).toContain(url.hostname);
      expect(url.pathname).toBe('/v1');
    }
  });

  it('keeps canonical ids unique and projects every catalog card once', () => {
    const definitions = Object.values(PROVIDER_DEFINITIONS);
    expect(new Set(definitions.map(({ id }) => id)).size).toBe(definitions.length);

    const catalog = projectPopularProviderCatalog();
    expect(catalog.map(({ id }) => id)).toEqual(
      definitions.filter(({ catalog: metadata }) => metadata).map(({ id }) => id),
    );
    expect(new Set(catalog.map(({ id }) => id)).size).toBe(catalog.length);
    expect(catalog).toContainEqual(
      expect.objectContaining({ id: 'alibaba-token-plan', family: 'openai-compatible' }),
    );
  });

  it('projects factory tuning from provider definitions', () => {
    const presets = projectCompatibleProviderPresets();
    expect(presets.omniroute).toEqual({
      defaultBaseUrl: 'http://localhost:20128/v1',
      quirks: { stripThinkTags: true },
      autoDiscover: true,
    });
    expect(presets.openrouter).toEqual({
      defaultBaseUrl: 'https://openrouter.ai/api/v1',
      autoDiscover: true,
    });
    // The gateway's preset base URL is its MODEL-LIST endpoint; the AI SDK
    // reaches the wire on its own `/v4/ai` default.
    expect(presets['ai-gateway']).toEqual({
      defaultBaseUrl: 'https://ai-gateway.vercel.sh/v1',
      autoDiscover: true,
    });
  });

  it('resolves trusted aliases without duplicating policy metadata', () => {
    expect(resolveProviderDefinition('kimi-for-coding-work')?.requestPolicy).toBe('kimi');
    expect(resolveProviderDefinition('alibaba-token-plan-team')?.requestPolicy).toBe('alibaba');
    expect(resolveProviderDefinition('custom-gateway')).toBeUndefined();
  });
});
