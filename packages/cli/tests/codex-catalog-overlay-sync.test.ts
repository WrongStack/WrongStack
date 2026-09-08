import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { CODEX_MODELS } from '@wrongstack/core/models';
import { describe, expect, it } from 'vitest';

/**
 * Drift guard: the curated overlay `packages/cli/data/providers.json` (synced
 * from raw GitHub at runtime) is the authoritative source for openai-codex
 * model metadata; `CODEX_MODELS` in core is the offline floor. The two MUST
 * agree on ids, names and descriptions, or the picker shows different copy
 * depending on whether the overlay was reachable. See `codex-catalog.ts`.
 */
const OVERLAY = JSON.parse(
  readFileSync(fileURLToPath(new URL('../data/providers.json', import.meta.url)), 'utf8'),
) as Record<
  string,
  {
    models?: Record<
      string,
      {
        id: string;
        name: string;
        description?: string;
        limit?: { context?: number; output?: number };
      }
    >;
  }
>;

describe('openai-codex overlay ↔ core floor parity', () => {
  it('providers.json declares a dedicated openai-codex provider', () => {
    expect(OVERLAY['openai-codex']).toBeDefined();
    expect(OVERLAY['openai-codex']?.models).toBeDefined();
  });

  it('overlay openai-codex models match the core CODEX_MODELS floor exactly', () => {
    const models = OVERLAY['openai-codex']?.models ?? {};
    const overlayList = Object.values(models).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
    }));
    const floorList = CODEX_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
    }));
    // Same set of ids/names/descriptions (order-independent).
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...overlayList].sort(byId)).toEqual([...floorList].sort(byId));
  });

  it('every openai-codex model carries a non-empty description', () => {
    const models = OVERLAY['openai-codex']?.models ?? {};
    for (const m of Object.values(models)) {
      expect(m.description, `${m.id} is missing a description`).toBeTruthy();
    }
  });

  it('declares each model’s real MAXIMUM window, per the live catalog', () => {
    // The ChatGPT `/codex/models` catalog publishes two windows per model and
    // they are not interchangeable: `context_window` is the DEFAULT (272,000
    // across the current lineup) and `max_context_window` is the largest the
    // model supports and the ceiling a configured client may ask for
    // (`configured.min(max_context_window)` in the official client). These are
    // the maximums, read off a live account.
    //
    // The overlay IS that configuration, so it declares the maximum: pinning
    // it to the default would throw away two thirds of the window gpt-6-astra
    // and the gpt-5.6 family actually have. The previous flat 1,050,000 was
    // wrong in the other direction — no codex model reaches it.
    //
    // `output` is left alone: the catalog publishes no output limit, and the
    // Codex wire omits `max_output_tokens` entirely because the ChatGPT
    // backend rejects it.
    const expected: Record<string, number> = {
      'gpt-6-astra': 872_000,
      'gpt-5.6-sol': 872_000,
      'gpt-5.6-terra': 872_000,
      'gpt-5.6-luna': 872_000,
      'gpt-5.5': 272_000,
      'gpt-5.4-mini': 272_000,
      'gpt-5.3-codex-spark': 128_000,
    };
    const models = OVERLAY['openai-codex']?.models ?? {};
    expect(Object.keys(models).sort()).toEqual(Object.keys(expected).sort());
    for (const [id, model] of Object.entries(models)) {
      expect(model.limit, id).toEqual({ context: expected[id], output: 128_000 });
    }
  });

  it('declares the documented GPT-6/GPT-5.6 wire reasoning efforts', () => {
    // Ultra is a product orchestration mode (max + automatic task delegation),
    // not a reasoning.effort value sent to the Responses backend.
    for (const id of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna']) {
      const model = OVERLAY['openai-codex']?.models?.[id] as
        | { reasoningConfig?: { effortLevels?: string[] } }
        | undefined;
      expect(model?.reasoningConfig?.effortLevels, id).toEqual([
        'low',
        'medium',
        'high',
        'xhigh',
        'max',
      ]);
    }
  });
});
