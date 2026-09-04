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

  it('declares the 1M context and 128k output limits for EVERY codex model', () => {
    // The whole Codex lineup (astra, sol/terra/luna, 5.5, 5.4, mini, spark) is treated
    // as 1M-windowed — mirroring the published 1M-context configuration for
    // these models (gpt-6-astra included; OpenAI publishes no separate
    // window). The live /codex/models probe remains the runtime guard that
    // caps sessions to the window the backend actually enforces.
    const models = OVERLAY['openai-codex']?.models ?? {};
    for (const [id, model] of Object.entries(models)) {
      expect(model.limit, id).toEqual({ context: 1_050_000, output: 128_000 });
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
