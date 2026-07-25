import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
// Import directly from source to avoid esbuild tree-shaking dropping the
// brand-new export from the @wrongstack/core dist bundle. Once
// ALIBABA_TOKEN_PLAN_MODELS has at least one consumer inside the core
// package itself, this can switch back to `from '@wrongstack/core'`.
import { ALIBABA_TOKEN_PLAN_MODELS } from '@wrongstack/core/models';

/**
 * Drift guard: the curated overlay `packages/cli/data/providers.json` (synced
 * from the Alibaba Cloud official documentation at runtime) is the authoritative
 * source for Alibaba Token Plan model metadata; `ALIBABA_TOKEN_PLAN_MODELS` in
 * core is the offline floor. The two MUST agree on ids, names and descriptions,
 * or the picker shows different copy depending on whether the overlay was
 * reachable. See `alibaba-token-plan-catalog.ts`.
 *
 * Cross-check: the official Personal Edition model table is at:
 * https://www.alibabacloud.com/help/en/model-studio/token-plan-personal-overview
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

describe('alibaba-token-plan overlay ↔ core floor parity', () => {
  it('providers.json declares a dedicated alibaba-token-plan provider', () => {
    expect(OVERLAY['alibaba-token-plan']).toBeDefined();
    expect(OVERLAY['alibaba-token-plan']?.models).toBeDefined();
  });

  it('overlay alibaba-token-plan models match the core ALIBABA_TOKEN_PLAN_MODELS floor exactly', () => {
    const models = OVERLAY['alibaba-token-plan']?.models ?? {};
    const overlayList = Object.values(models).map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
    }));
    const floorList = ALIBABA_TOKEN_PLAN_MODELS.map((m) => ({
      id: m.id,
      name: m.name,
      description: m.description,
    }));
    // Same set of ids/names/descriptions (order-independent).
    const byId = (a: { id: string }, b: { id: string }) => a.id.localeCompare(b.id);
    expect([...overlayList].sort(byId)).toEqual([...floorList].sort(byId));
  });

  it('every alibaba-token-plan model carries a non-empty description', () => {
    const models = OVERLAY['alibaba-token-plan']?.models ?? {};
    for (const m of Object.values(models)) {
      expect(m.description, `${m.id} is missing a description`).toBeTruthy();
    }
  });

  it('declares the documented Qwen context and output limits', () => {
    const models = OVERLAY['alibaba-token-plan']?.models ?? {};
    for (const id of ['qwen3.7-max', 'qwen3.7-plus', 'qwen3.6-flash']) {
      expect(models[id]?.limit, id).toEqual({ context: 1_000_000, output: 65_536 });
    }
  });

  it('declares the GLM-5.2 198K context window', () => {
    const models = OVERLAY['alibaba-token-plan']?.models ?? {};
    expect(models['glm-5.2']?.limit).toEqual({ context: 198_000, output: 65_536 });
  });

  it('declares the DeepSeek V4 Pro 1M context window', () => {
    const models = OVERLAY['alibaba-token-plan']?.models ?? {};
    expect(models['deepseek-v4-pro']?.limit).toEqual({ context: 1_000_000, output: 65_536 });
  });

  it('rejects models that are NOT in the Personal Edition (safety net)', () => {
    const models = OVERLAY['alibaba-token-plan']?.models ?? {};
    const modelIds = Object.keys(models);

    // These models must NEVER appear in the Personal Edition allowlist
    const FORBIDDEN: string[] = [
      'deepseek-v4-flash',
      'deepseek-v3.2',
      'qwen3.6-plus',
      'qwen-image-2.0',
      'qwen-image-2.0-pro',
      'kimi-k2.7-code',
      'kimi-k2.6',
      'kimi-k2.5',
      'glm-5.1',
      'glm-5',
      'MiniMax-M2.5',
      'qwen3-max',
      'qwen3-coder-plus',
      'qwen3-coder-flash',
      'qwen-long',
      'qwen3-math-plus',
    ];
    for (const forbidden of FORBIDDEN) {
      expect(modelIds).not.toContain(forbidden);
    }
  });
});
