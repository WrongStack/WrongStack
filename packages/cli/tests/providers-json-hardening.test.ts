import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { PROVIDER_DEFINITIONS } from '@wrongstack/providers/definitions';
import { describe, expect, it } from 'vitest';

// ── Known knowns: which files hold provider metadata ──────────────────
const CLI_PROVIDERS_PATH = fileURLToPath(new URL('../data/providers.json', import.meta.url));
const WEBUI_PROVIDERS_PATH = fileURLToPath(
  new URL('../../webui/public/providers.json', import.meta.url),
);

/**
 * Minimum required fields for every model entry in the CLI providers.json
 * overlay. Providers.json uses `<id>: { id, name, description, ... }` shape.
 */
interface ProviderModelEntry {
  id: string;
  name: string;
  description: string;
  reasoning?: boolean;
  tool_call?: boolean;
  modalities?: { input: string[]; output: string[] };
  limit?: { context: number; output?: number };
}

/**
 * Minimum required fields for every provider in the CLI providers.json.
 */
interface ProviderEntry {
  id: string;
  name: string;
  doc: string;
  models?: Record<string, ProviderModelEntry>;
}

type ProvidersJson = Record<string, ProviderEntry>;

// ── Helpers ───────────────────────────────────────────────────────────

function loadCliProviders(): ProvidersJson {
  return JSON.parse(readFileSync(CLI_PROVIDERS_PATH, 'utf8'));
}

describe('providers.json hardening — schema validation', () => {
  // ────────────────────────────────────────────────────────────────
  // 1. STRUCTURAL VALIDATION
  // ────────────────────────────────────────────────────────────────

  it('CLI providers.json parses as a non-empty object', () => {
    const data = loadCliProviders();
    expect(data).toBeInstanceOf(Object);
    expect(Object.keys(data).length).toBeGreaterThan(0);
  });

  it('CLI providers.json — every provider has required top-level fields', () => {
    const data = loadCliProviders();
    for (const [id, provider] of Object.entries(data)) {
      if (id.startsWith('_')) continue; // skip magic keys (_removeProviders, _removeModels)
      expect(provider.id, `provider ${id}`).toBe(id);
      expect(provider.name, `provider ${id}`).toBeTruthy();
      expect(typeof provider.name, `provider ${id}`).toBe('string');
      expect(provider.doc, `provider ${id}`).toBeTruthy();
      expect(typeof provider.doc, `provider ${id}`).toBe('string');
    }
  });

  it('CLI providers.json — every model entry has required fields (id, name, description)', () => {
    const data = loadCliProviders();
    for (const [providerId, provider] of Object.entries(data)) {
      if (providerId.startsWith('_')) continue;
      if (!provider.models) continue;
      for (const [key, model] of Object.entries(provider.models)) {
        expect(model.id, `${providerId}.models.${key}.id`).toBe(key);
        expect(model.name, `${providerId}.models.${key}.name`).toBeTruthy();
        expect(typeof model.name, `${providerId}.models.${key}.name`).toBe('string');
        expect(model.description, `${providerId}.models.${key}.description`).toBeTruthy();
        expect(typeof model.description, `${providerId}.models.${key}.description`).toBe('string');
      }
    }
  });

  /**
   * Models whose limits models.dev already publishes under the SAME provider
   * id. This overlay is merged ON TOP of the catalog, so a `limit` declared
   * here wins — and a hand-transcribed copy only ever drifts below the real
   * ceiling. It did: deepseek-v4-pro shipped 65_536 against a real 384_000,
   * glm-5.2 shipped a 198_000 context against a real 1_000_000.
   *
   * For these the rule INVERTS — they must NOT declare a limit. The overlay's
   * job for them is the Personal-Edition allowlist plus the display copy.
   * Everything else is overlay-only (absent from models.dev) and still needs a
   * limit, or it falls through to the wire-family default.
   */
  const CATALOG_BACKED_LIMITS: Record<string, string[]> = {
    'alibaba-token-plan': [
      'qwen3.8-max-preview',
      'qwen3.7-max',
      'qwen3.7-plus',
      'qwen3.6-flash',
      'glm-5.2',
      'deepseek-v4-pro',
    ],
  };

  it('CLI providers.json — text models have limit.context unless models.dev owns them', () => {
    const data = loadCliProviders();
    for (const [providerId, provider] of Object.entries(data)) {
      if (providerId.startsWith('_')) continue;
      if (!provider.models) continue;
      const catalogBacked = CATALOG_BACKED_LIMITS[providerId] ?? [];
      for (const [key, model] of Object.entries(provider.models)) {
        // Image/video generation models legitimately omit limit
        const outputModality = model.modalities?.output?.[0];
        if (outputModality === 'image' || outputModality === 'video') continue;
        if (catalogBacked.includes(key)) {
          expect(
            model.limit,
            `${providerId}.models.${key} — models.dev publishes this model's limits; ` +
              `declaring them here overrides the catalog with a value that will drift`,
          ).toBeUndefined();
          continue;
        }
        // Overlay-only text models MUST have limit.context
        expect(model.limit, `${providerId}.models.${key} — text model missing limit`).toBeDefined();
        expect(model.limit!.context, `${providerId}.models.${key}.limit.context`).toBeGreaterThan(
          0,
        );
      }
    }
  });

  it('CLI providers.json — no empty description strings', () => {
    const data = loadCliProviders();
    for (const [providerId, provider] of Object.entries(data)) {
      if (!provider.models) continue;
      for (const [key, model] of Object.entries(provider.models)) {
        expect(
          model.description?.trim(),
          `${providerId}.models.${key}.description is empty`,
        ).toBeTruthy();
      }
    }
  });

  // ────────────────────────────────────────────────────────────────
  // 2. CROSS-SURFACE COVERAGE
  // ────────────────────────────────────────────────────────────────

  it('every curated CLI provider id exists in the canonical registry', () => {
    const data = loadCliProviders();
    for (const id of Object.keys(data)) {
      if (id.startsWith('_')) continue;
      expect(PROVIDER_DEFINITIONS[id], `provider ${id}`).toBeDefined();
    }
  });

  it('WebUI providers.json is loadable and has required provider fields', () => {
    const content = readFileSync(WEBUI_PROVIDERS_PATH, 'utf8');
    const providers: Array<Record<string, unknown>> = JSON.parse(content);
    expect(Array.isArray(providers)).toBe(true);
    expect(providers.length).toBeGreaterThan(0);
    for (const provider of providers) {
      expect(typeof provider.id).toBe('string');
      expect(typeof provider.name).toBe('string');
      expect(typeof provider.family).toBe('string');
      // The alibaba-token-plan provider must appear in both files
      if (provider.id === 'alibaba-token-plan') {
        expect(provider.family).toBe('openai-compatible');
      }
    }
  });

  it('alibaba-token-plan appears in both CLI and WebUI providers files', () => {
    const cli = loadCliProviders();
    expect(cli['alibaba-token-plan']).toBeDefined();

    const webui: Array<Record<string, unknown>> = JSON.parse(
      readFileSync(WEBUI_PROVIDERS_PATH, 'utf8'),
    );
    const webuiAli = webui.find((p) => p.id === 'alibaba-token-plan');
    expect(webuiAli).toBeDefined();
    expect(webuiAli!.family).toBe('openai-compatible');
  });

  // ────────────────────────────────────────────────────────────────
  // 3. REMOVAL SUPPORT (_removeProviders / _removeModels)
  // ────────────────────────────────────────────────────────────────

  it('CLI providers.json has a _removeProviders array', () => {
    // _removeProviders is at the top level but not a provider entry
    // We need to read the raw JSON to access it.
    //
    // The array may legitimately be EMPTY — that is the healthy steady state
    // for an override layer whose job is to add and fix, not to prune. The
    // assertion used to demand `length > 0`, which locked in a 20-entry
    // example payload that shipped by accident and deleted anthropic, google,
    // groq, openrouter and 16 others from every user's catalog. Shape only.
    const raw = JSON.parse(readFileSync(CLI_PROVIDERS_PATH, 'utf8')) as Record<string, unknown>;
    const removeProviders = raw['_removeProviders'];
    expect(Array.isArray(removeProviders)).toBe(true);
    for (const id of removeProviders as unknown[]) {
      expect(typeof id).toBe('string');
      expect(id).not.toBe('');
    }
  });

  it('_removeProviders never deletes a provider WrongStack ships a definition for', () => {
    // A provider in PROVIDER_DEFINITIONS is one the product actively offers
    // (auth catalog card, wire family, env vars). Deleting its catalog entry
    // strips its model list, so the launch picker shows the provider with zero
    // models and the user dead-ends at a bare "type a model id" prompt. That
    // is exactly the regression this guard exists to catch.
    const raw = JSON.parse(readFileSync(CLI_PROVIDERS_PATH, 'utf8')) as Record<string, unknown>;
    const removeProviders = (raw['_removeProviders'] ?? []) as string[];
    const shipped = new Set(Object.keys(PROVIDER_DEFINITIONS));
    const conflicts = removeProviders.filter((id) => shipped.has(id));
    expect(conflicts).toEqual([]);
  });

  it('CLI providers.json has a _removeModels object', () => {
    const raw = JSON.parse(readFileSync(CLI_PROVIDERS_PATH, 'utf8')) as Record<string, unknown>;
    const removeModels = raw['_removeModels'];
    expect(removeModels).toBeDefined();
    expect(typeof removeModels).toBe('object');
    expect(Object.keys(removeModels as Record<string, unknown>).length).toBeGreaterThan(0);
  });

  it('_removeProviders does not overlap with curated providers', () => {
    const raw = JSON.parse(readFileSync(CLI_PROVIDERS_PATH, 'utf8')) as Record<string, unknown>;
    const removeProviders = new Set(raw['_removeProviders'] as string[] | undefined);
    const curatedProviders = new Set(Object.keys(loadCliProviders()));
    // A provider in both _removeProviders AND the curated list would be
    // added by the merge and then immediately deleted — a no-op but confusing.
    for (const id of removeProviders) {
      expect(curatedProviders.has(id)).toBe(false);
    }
  });

  it('_removeModels targets only providers that exist in models.dev', () => {
    const raw = JSON.parse(readFileSync(CLI_PROVIDERS_PATH, 'utf8')) as Record<string, unknown>;
    const removeModels = raw['_removeModels'] as Record<string, string[]> | undefined;
    expect(removeModels).toBeDefined();
    for (const modelIds of Object.values(removeModels!)) {
      expect(Array.isArray(modelIds)).toBe(true);
      expect(modelIds.length).toBeGreaterThan(0);
      for (const modelId of modelIds) {
        expect(typeof modelId).toBe('string');
      }
    }
  });
});
