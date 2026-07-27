/**
 * Additional coverage for brain-runtime.ts — validation branches in
 * mergePatch() that throw on invalid patch inputs. Exercises the error
 * paths through apply() with persist:false.
 */
import { describe, expect, it, vi } from 'vitest';
import { createBrainRuntime } from '../../src/execution/brain-runtime.js';
import type { BrainRuntimeOptions } from '../../src/execution/brain-runtime.js';
import type { BrainConfig } from '../../src/types/config.js';
import type { Provider } from '../../src/types/provider.js';

function fakeProvider(text: string): Provider {
  return {
    id: 'fake',
    capabilities: {},
    stream: vi.fn(),
    complete: vi.fn(async () => ({ content: [{ type: 'text', text }] })),
  } as never as Provider;
}

function baseOpts(
  initialConfig: BrainConfig | undefined,
  over: Partial<BrainRuntimeOptions> = {},
): BrainRuntimeOptions {
  return {
    initialConfig,
    defaultProviderId: 'session-prov',
    sessionProvider: () => fakeProvider('session says: Continue.'),
    sessionModel: () => 'session-model',
    resolveProvider: () => fakeProvider('pool says: Continue.'),
    ...over,
  };
}

function rt(config?: BrainConfig) {
  return createBrainRuntime(baseOpts(config));
}

describe('brain-runtime apply() validation', () => {
  // ── mode ───────────────────────────────────────────────────────────────

  it('rejects invalid mode', () => {
    const r = rt();
    expect(() => r.apply({ mode: 'turbo' as never }, { persist: false })).toThrow('Invalid mode');
  });

  it('accepts valid modes', () => {
    const r = rt();
    expect(() => r.apply({ mode: 'headless' }, { persist: false })).not.toThrow();
    expect(() => r.apply({ mode: 'interactive' }, { persist: false })).not.toThrow();
  });

  // ── maxAutoRisk ────────────────────────────────────────────────────────

  it('rejects invalid maxAutoRisk', () => {
    const r = rt();
    expect(() => r.apply({ maxAutoRisk: 'extreme' as never }, { persist: false })).toThrow('Invalid maxAutoRisk');
  });

  // ── strategy ───────────────────────────────────────────────────────────

  it('rejects invalid strategy', () => {
    const r = rt();
    expect(() => r.apply({ strategy: 'random' as never }, { persist: false })).toThrow('Invalid strategy');
  });

  it('accepts valid strategies', () => {
    const r = rt();
    expect(() => r.apply({ strategy: 'fallback' }, { persist: false })).not.toThrow();
    expect(() => r.apply({ strategy: 'round-robin' }, { persist: false })).not.toThrow();
  });

  it('clears strategy with null', () => {
    const r = rt();
    expect(() => r.apply({ strategy: null }, { persist: false })).not.toThrow();
  });

  // ── humanTimeoutMs ─────────────────────────────────────────────────────

  it('rejects non-positive humanTimeoutMs', () => {
    const r = rt();
    expect(() => r.apply({ humanTimeoutMs: -1 }, { persist: false })).toThrow('Invalid humanTimeoutMs');
    expect(() => r.apply({ humanTimeoutMs: 0 }, { persist: false })).toThrow('Invalid humanTimeoutMs');
  });

  it('clears humanTimeoutMs with null', () => {
    const r = rt();
    expect(() => r.apply({ humanTimeoutMs: null }, { persist: false })).not.toThrow();
  });

  // ── decisionTimeoutMs ──────────────────────────────────────────────────

  it('rejects non-positive decisionTimeoutMs', () => {
    const r = rt();
    expect(() => r.apply({ decisionTimeoutMs: 0 }, { persist: false })).toThrow('Invalid decisionTimeoutMs');
  });

  // ── heuristics ─────────────────────────────────────────────────────────

  it('rejects non-boolean heuristics values', () => {
    const r = rt();
    expect(() =>
      r.apply({ heuristics: { lowRiskAutoAnswer: 'yes' as never } }, { persist: false }),
    ).toThrow('Invalid heuristics');
  });

  it('accepts valid heuristics', () => {
    const r = rt();
    expect(() =>
      r.apply({ heuristics: { lowRiskAutoAnswer: true, deadlockSkip: false } }, { persist: false }),
    ).not.toThrow();
  });

  it('clears heuristics with null', () => {
    const r = rt();
    expect(() => r.apply({ heuristics: null }, { persist: false })).not.toThrow();
  });

  it('rejects non-array blockedResolvedMarkers', () => {
    const r = rt();
    expect(() =>
      r.apply({ heuristics: { blockedResolvedMarkers: 'not-array' as never } }, { persist: false }),
    ).toThrow('Invalid heuristics.blockedResolvedMarkers');
  });

  // ── rules ──────────────────────────────────────────────────────────────

  it('rejects non-array rules', () => {
    const r = rt();
    expect(() => r.apply({ rules: 'not-array' as never }, { persist: false })).toThrow('Invalid rules');
  });

  it('rejects rules that fail compilation', () => {
    const r = rt();
    expect(() =>
      r.apply({ rules: [{ pattern: '', action: 'allow' } as never] }, { persist: false }),
    ).toThrow();
  });

  it('clears rules with null', () => {
    const r = rt();
    expect(() => r.apply({ rules: null }, { persist: false })).not.toThrow();
  });

  // ── council ────────────────────────────────────────────────────────────

  it('rejects invalid council minRisk', () => {
    const r = rt();
    expect(() =>
      r.apply({ council: { minRisk: 'low' as never } }, { persist: false }),
    ).toThrow('Invalid council minRisk');
  });

  it('rejects invalid council quorum', () => {
    const r = rt();
    expect(() =>
      r.apply({ council: { quorum: 1.5 } }, { persist: false }),
    ).toThrow('Invalid council quorum');
    expect(() =>
      r.apply({ council: { quorum: 0 } }, { persist: false }),
    ).toThrow('Invalid council quorum');
  });

  it('rejects invalid council approval', () => {
    const r = rt();
    expect(() =>
      r.apply({ council: { approval: -0.1 } }, { persist: false }),
    ).toThrow('Invalid council approval');
  });

  it('rejects invalid council integer fields', () => {
    const r = rt();
    expect(() =>
      r.apply({ council: { perCallTimeoutMs: -1 } }, { persist: false }),
    ).toThrow('Invalid council');
    expect(() =>
      r.apply({ council: { maxConcurrency: 0 } }, { persist: false }),
    ).toThrow('Invalid council');
    expect(() =>
      r.apply({ council: { judgeMaxTokens: 1.5 } }, { persist: false }),
    ).toThrow('Invalid council');
  });

  it('rejects invalid council distinctness', () => {
    const r = rt();
    expect(() =>
      r.apply({ council: { distinctness: 'cosmic' as never } }, { persist: false }),
    ).toThrow('Invalid council.distinctness');
  });

  it('rejects non-array council seats', () => {
    const r = rt();
    expect(() =>
      r.apply({ council: { seats: 'not-array' as never } }, { persist: false }),
    ).toThrow('Invalid council.seats');
  });

  it('rejects council seats without persona', () => {
    const r = rt();
    expect(() =>
      r.apply({ council: { seats: [{ persona: '' }] } }, { persist: false }),
    ).toThrow('Invalid council.seats');
  });

  it('clears council with null', () => {
    const r = rt();
    expect(() => r.apply({ council: null }, { persist: false })).not.toThrow();
  });

  // ── terminalPolicy ─────────────────────────────────────────────────────

  it('rejects invalid terminalPolicy', () => {
    const r = rt();
    expect(() =>
      r.apply({ terminalPolicy: 'yolo' as never }, { persist: false }),
    ).toThrow('Invalid terminalPolicy');
  });

  // ── decisionLogMaxEntries ──────────────────────────────────────────────

  it('rejects non-positive decisionLogMaxEntries', () => {
    const r = rt();
    expect(() =>
      r.apply({ decisionLogMaxEntries: 0 }, { persist: false }),
    ).toThrow('Invalid decisionLogMaxEntries');
    expect(() =>
      r.apply({ decisionLogMaxEntries: 1.5 }, { persist: false }),
    ).toThrow('Invalid decisionLogMaxEntries');
  });

  // ── cache ──────────────────────────────────────────────────────────────

  it('rejects non-boolean cache.enabled', () => {
    const r = rt();
    expect(() =>
      r.apply({ cache: { enabled: 'yes' as never } }, { persist: false }),
    ).toThrow('Invalid cache.enabled');
  });

  it('rejects invalid cache.ttlMs', () => {
    const r = rt();
    expect(() =>
      r.apply({ cache: { ttlMs: 0 } }, { persist: false }),
    ).toThrow('Invalid cache.ttlMs');
  });

  it('rejects invalid cache.maxEntries', () => {
    const r = rt();
    expect(() =>
      r.apply({ cache: { maxEntries: -1 } }, { persist: false }),
    ).toThrow('Invalid cache.maxEntries');
  });

  it('clears cache with null', () => {
    const r = rt();
    expect(() => r.apply({ cache: null }, { persist: false })).not.toThrow();
  });

  // ── llm ────────────────────────────────────────────────────────────────

  it('rejects invalid llm.maxTokens', () => {
    const r = rt();
    expect(() =>
      r.apply({ llm: { maxTokens: 0 } }, { persist: false }),
    ).toThrow('Invalid llm.maxTokens');
  });

  it('rejects non-boolean llm.rejectUncertain', () => {
    const r = rt();
    expect(() =>
      r.apply({ llm: { rejectUncertain: 'yes' as never } }, { persist: false }),
    ).toThrow('Invalid llm.rejectUncertain');
  });

  it('rejects invalid llm.denyIsTerminal', () => {
    const r = rt();
    expect(() =>
      r.apply({ llm: { denyIsTerminal: 'sometimes' as never } }, { persist: false }),
    ).toThrow('Invalid llm.denyIsTerminal');
  });

  it('rejects invalid llm.minConfidence', () => {
    const r = rt();
    expect(() =>
      r.apply({ llm: { minConfidence: 1.5 } }, { persist: false }),
    ).toThrow('Invalid llm.minConfidence');
    expect(() =>
      r.apply({ llm: { minConfidence: -0.1 } }, { persist: false }),
    ).toThrow('Invalid llm.minConfidence');
  });

  it('clears llm with null', () => {
    const r = rt();
    expect(() => r.apply({ llm: null }, { persist: false })).not.toThrow();
  });

  // ── trace ──────────────────────────────────────────────────────────────

  it('rejects non-boolean trace.enabled', () => {
    const r = rt();
    expect(() =>
      r.apply({ trace: { enabled: 'yes' as never } }, { persist: false }),
    ).toThrow('Invalid trace.enabled');
  });

  it('rejects invalid trace.content', () => {
    const r = rt();
    expect(() =>
      r.apply({ trace: { content: 'verbose' as never } }, { persist: false }),
    ).toThrow('Invalid trace.content');
  });

  it('rejects invalid trace.maxOpenRecords', () => {
    const r = rt();
    expect(() =>
      r.apply({ trace: { maxOpenRecords: 0 } }, { persist: false }),
    ).toThrow('Invalid trace.maxOpenRecords');
  });

  it('clears trace with null', () => {
    const r = rt();
    expect(() => r.apply({ trace: null }, { persist: false })).not.toThrow();
  });

  // ── ledger ─────────────────────────────────────────────────────────────

  it('rejects invalid ledger.autoDenyAfterFailures', () => {
    const r = rt();
    expect(() =>
      r.apply({ ledger: { autoDenyAfterFailures: -1 } }, { persist: false }),
    ).toThrow('Invalid autoDenyAfterFailures');
  });

  it('clears ledger with null', () => {
    const r = rt();
    expect(() => r.apply({ ledger: null }, { persist: false })).not.toThrow();
  });

  // ── models ─────────────────────────────────────────────────────────────

  it('clears models with null', () => {
    const r = rt();
    expect(() => r.apply({ models: null }, { persist: false })).not.toThrow();
  });

  it('rejects invalid model refs', () => {
    const r = rt();
    expect(() =>
      r.apply({ models: [{ model: '' }] }, { persist: false }),
    ).toThrow('Invalid model ref');
  });

  // ── monitor ────────────────────────────────────────────────────────────

  it('clears monitor with null', () => {
    const r = rt();
    expect(() => r.apply({ monitor: null }, { persist: false })).not.toThrow();
  });

  it('accepts monitor patch', () => {
    const r = rt();
    expect(() =>
      r.apply({ monitor: { stallMs: 30000 } }, { persist: false }),
    ).not.toThrow();
  });
});

describe('brain-runtime defaults', () => {
  it('uses interactive mode when no config is provided', () => {
    const r = createBrainRuntime(baseOpts(undefined));
    const snap = r.getSnapshot();
    // Without resolveBrainConfigDefaults (called by the host), the bare
    // runtime defaults to interactive mode.
    expect(snap.mode).toBe('interactive');
    expect(snap.maxAutoRisk).toBeDefined();
  });
});
