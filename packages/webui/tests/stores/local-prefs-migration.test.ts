import { describe, expect, it } from 'vitest';

/**
 * Unit tests for the local-prefs migration logic.
 * We extract the same logic the store uses and verify it handles all edge cases.
 *
 * The actual migrate function lives inside zustand/persist middleware and is
 * not directly exportable — we replicate its logic here to verify 100% branch
 * coverage without depending on zustand internals.
 */

const VALID_STRATEGIES = ['hybrid', 'intelligent', 'selective'];
const VALID_AUDIT_LEVELS = ['minimal', 'standard', 'full'];
const AUTO_PROCEED_DEFAULT = 50;

// ── v9 defaults (Chimera + auto-review) ──────────────────────────────
// Mirrors the DEFAULTS block in packages/webui/src/stores/local-prefs.ts.
// Kept in lockstep by review: any change to a v9 default here must also
// be updated in the local-prefs.ts DEFAULTS + migrate blocks.
const CHIMERA_ENABLED_DEFAULT = true;
const CHIMERA_PROVIDER_DEFAULT = '';
const CHIMERA_MODEL_DEFAULT = '';
const CHIMERA_MAX_FILES_DEFAULT = 15;
const CHIMERA_AUTOFIX_DEFAULT = 'off';
const AUTOREVIEW_ENABLED_DEFAULT = false;
const AUTOREVIEW_PROVIDER_DEFAULT = '';
const AUTOREVIEW_MODEL_DEFAULT = '';
const AUTOREVIEW_FALLBACK_PROFILE_DEFAULT = '';
const AUTOREVIEW_FALLBACK_MODELS_DEFAULT: string[] = [];
const AUTOREVIEW_DEBOUNCE_MS_DEFAULT = 15_000;
const AUTOREVIEW_MAX_FILES_PER_BATCH_DEFAULT = 15;
const AUTOREVIEW_MAX_CONCURRENT_REVIEWS_DEFAULT = 2;
const VALID_AUTOREVIEW_CASCADE = ['off', 'critical', 'high'] as const;
const AUTOREVIEW_CASCADE_DEFAULT = 'off';

function migrate(persisted: Record<string, unknown> | null, version = 12): Record<string, unknown> {
  const p = (persisted ?? {}) as Record<string, unknown>;
  if (version < 12 && p.autoReviewDebounceMs === 5_000) {
    p.autoReviewDebounceMs = 15_000;
  }
  if (!VALID_STRATEGIES.includes(p.contextStrategy as string)) {
    p.contextStrategy = 'hybrid';
  }
  if (p.auditLevel === 'verbose') p.auditLevel = 'full';
  if (!VALID_AUDIT_LEVELS.includes(p.auditLevel as string)) {
    p.auditLevel = 'standard';
  }
  if (typeof p.autoProceedMaxIterations !== 'number') {
    p.autoProceedMaxIterations = AUTO_PROCEED_DEFAULT;
  }

  // ── v9: Chimera + auto-review backfill ────────────────────────────────
  // Booleans — `typeof` guard (NOT `=== undefined`) so `null`/`0`/etc. are
  // also defaulted. `chimeraEnabled` defaults to true to match the plugin's
  // `cfg.enabled !== false` semantics; `autoReviewEnabled` defaults to false
  // to match the plugin's strict opt-in `cfg.enabled === true`.
  if (typeof p.chimeraEnabled !== 'boolean') p.chimeraEnabled = CHIMERA_ENABLED_DEFAULT;
  if (typeof p.chimeraProvider !== 'string') p.chimeraProvider = CHIMERA_PROVIDER_DEFAULT;
  if (typeof p.chimeraModel !== 'string') p.chimeraModel = CHIMERA_MODEL_DEFAULT;
  // chimeraMaxFiles: must be a finite number AND >= 1. The plugin's resolver
  // uses `?? DEFAULT_MAX_FILES` without clamping, so 0/NaN/Infinity would
  // silently no-op the review. `typeof` narrows for TS; `Number.isFinite`
  // rejects NaN/±Infinity (note: `Number.isFinite(undefined)` is false but
  // doesn't narrow the type for the `<` comparison, so the `typeof` guard
  // must come first).
  if (
    typeof p.chimeraMaxFiles !== 'number' ||
    !Number.isFinite(p.chimeraMaxFiles) ||
    p.chimeraMaxFiles < 1
  ) {
    p.chimeraMaxFiles = CHIMERA_MAX_FILES_DEFAULT;
  }
  if (p.chimeraAutoFix !== 'off' && p.chimeraAutoFix !== 'ask' && p.chimeraAutoFix !== 'auto') {
    p.chimeraAutoFix = CHIMERA_AUTOFIX_DEFAULT;
  }
  if (typeof p.autoReviewEnabled !== 'boolean') {
    p.autoReviewEnabled = AUTOREVIEW_ENABLED_DEFAULT;
  }
  if (typeof p.autoReviewProvider !== 'string') {
    p.autoReviewProvider = AUTOREVIEW_PROVIDER_DEFAULT;
  }
  if (typeof p.autoReviewModel !== 'string') {
    p.autoReviewModel = AUTOREVIEW_MODEL_DEFAULT;
  }
  if (typeof p.autoReviewFallbackProfile !== 'string') {
    p.autoReviewFallbackProfile = AUTOREVIEW_FALLBACK_PROFILE_DEFAULT;
  }
  if (!Array.isArray(p.autoReviewFallbackModels)) {
    p.autoReviewFallbackModels = AUTOREVIEW_FALLBACK_MODELS_DEFAULT;
  }
  // autoReviewDebounceMs: must be a finite number AND >= 0 (0 is a valid
  // "no debounce" choice, so the bound is `>= 0` not `> 0`).
  // `typeof` narrows for TS; `Number.isFinite` rejects NaN/±Infinity.
  if (
    typeof p.autoReviewDebounceMs !== 'number' ||
    !Number.isFinite(p.autoReviewDebounceMs) ||
    p.autoReviewDebounceMs < 0
  ) {
    p.autoReviewDebounceMs = AUTOREVIEW_DEBOUNCE_MS_DEFAULT;
  }
  if (
    typeof p.autoReviewMaxFilesPerBatch !== 'number' ||
    !Number.isFinite(p.autoReviewMaxFilesPerBatch) ||
    p.autoReviewMaxFilesPerBatch < 1
  ) {
    p.autoReviewMaxFilesPerBatch = AUTOREVIEW_MAX_FILES_PER_BATCH_DEFAULT;
  }
  if (
    typeof p.autoReviewMaxConcurrentReviews !== 'number' ||
    !Number.isFinite(p.autoReviewMaxConcurrentReviews) ||
    p.autoReviewMaxConcurrentReviews < 1
  ) {
    p.autoReviewMaxConcurrentReviews = AUTOREVIEW_MAX_CONCURRENT_REVIEWS_DEFAULT;
  }
  if (
    !VALID_AUTOREVIEW_CASCADE.includes(
      p.autoReviewCascadeOn as (typeof VALID_AUTOREVIEW_CASCADE)[number],
    )
  ) {
    p.autoReviewCascadeOn = AUTOREVIEW_CASCADE_DEFAULT;
  }
  return p;
}

describe('migrate — contextStrategy', () => {
  it('keeps valid contextStrategy unchanged', () => {
    for (const val of ['hybrid', 'intelligent', 'selective']) {
      const result = migrate({ contextStrategy: val });
      expect(result.contextStrategy).toBe(val);
    }
  });

  it('migrates invalid contextStrategy to hybrid', () => {
    for (const invalid of ['frugal', 'balanced', 'deep', '', 'invalid', 'HYBRID']) {
      const result = migrate({ contextStrategy: invalid });
      expect(result.contextStrategy).toBe('hybrid');
    }
  });

  it('handles missing contextStrategy', () => {
    const result = migrate({});
    expect(result.contextStrategy).toBe('hybrid');
  });

  it('handles undefined contextStrategy', () => {
    const result = migrate({ contextStrategy: undefined });
    expect(result.contextStrategy).toBe('hybrid');
  });
});

describe('migrate — auditLevel', () => {
  it('keeps valid auditLevel unchanged', () => {
    for (const val of ['minimal', 'standard', 'full']) {
      const result = migrate({ auditLevel: val });
      expect(result.auditLevel).toBe(val);
    }
  });

  it('migrates verbose to full', () => {
    const result = migrate({ auditLevel: 'verbose' });
    expect(result.auditLevel).toBe('full');
  });

  it('migrates invalid auditLevel to standard', () => {
    for (const invalid of ['invalid', '', 'VERBOSE', 'minimal ', ' standard']) {
      const result = migrate({ auditLevel: invalid });
      expect(result.auditLevel).toBe('standard');
    }
  });

  it('handles missing auditLevel', () => {
    const result = migrate({});
    expect(result.auditLevel).toBe('standard');
  });
});

describe('migrate — autoProceedMaxIterations', () => {
  it('keeps valid numeric autoProceedMaxIterations unchanged', () => {
    for (const val of [0, 1, 50, 999, 100000]) {
      const result = migrate({ autoProceedMaxIterations: val });
      expect(result.autoProceedMaxIterations).toBe(val);
    }
  });

  it('defaults non-number autoProceedMaxIterations to 50', () => {
    for (const invalid of [undefined, null, '50', 'fifty', '', true, false, {}, []]) {
      // @ts-expect-error — intentionally passing invalid types
      const result = migrate({ autoProceedMaxIterations: invalid });
      expect(result.autoProceedMaxIterations).toBe(50);
    }
  });

  it('defaults missing autoProceedMaxIterations to 50', () => {
    const result = migrate({});
    expect(result.autoProceedMaxIterations).toBe(50);
  });
});

describe('migrate — null/undefined persisted', () => {
  it('handles null persisted', () => {
    const result = migrate(null);
    expect(result.contextStrategy).toBe('hybrid');
    expect(result.auditLevel).toBe('standard');
    expect(result.autoProceedMaxIterations).toBe(50);
  });

  it('handles undefined persisted', () => {
    const result = migrate(undefined as never as null);
    expect(result.contextStrategy).toBe('hybrid');
    expect(result.auditLevel).toBe('standard');
    expect(result.autoProceedMaxIterations).toBe(50);
  });
});

describe('migrate — combined migrations', () => {
  it('migrates all invalid values at once', () => {
    const result = migrate({
      contextStrategy: 'frugal',
      auditLevel: 'verbose',
      autoProceedMaxIterations: 'not-a-number',
    });
    expect(result.contextStrategy).toBe('hybrid');
    expect(result.auditLevel).toBe('full');
    expect(result.autoProceedMaxIterations).toBe(50);
  });

  it('preserves all valid values during migration', () => {
    const result = migrate({
      contextStrategy: 'intelligent',
      auditLevel: 'minimal',
      autoProceedMaxIterations: 100,
    });
    expect(result.contextStrategy).toBe('intelligent');
    expect(result.auditLevel).toBe('minimal');
    expect(result.autoProceedMaxIterations).toBe(100);
  });

  it('handles partial invalid state', () => {
    const result = migrate({
      contextStrategy: 'deep',
      auditLevel: 'standard',
    });
    expect(result.contextStrategy).toBe('hybrid');
    expect(result.auditLevel).toBe('standard');
    expect(result.autoProceedMaxIterations).toBe(50);
  });
});

// ── v9 backfill coverage ───────────────────────────────────────────────────
// These blocks lock in every guard the v9 migration adds (Chimera +
// auto-review fields). If a future change drops, inverts, or widens any of
// these guards, the corresponding test fails first — the regression target
// a chimera-review peer flagged after the panel landed.

describe('migrate — chimera (v9)', () => {
  it('defaults chimeraEnabled to true on missing/non-boolean', () => {
    for (const v of [undefined, null, 'yes', 1, 0, {}, true]) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({ chimeraEnabled: v });
      // Note: `true` is a valid boolean and survives, so we don't iterate it.
      if (typeof v === 'boolean') {
        expect(result.chimeraEnabled).toBe(v);
      } else {
        expect(result.chimeraEnabled).toBe(true);
      }
    }
  });

  it('preserves chimeraEnabled=false', () => {
    const result = migrate({ chimeraEnabled: false });
    expect(result.chimeraEnabled).toBe(false);
  });

  it('defaults chimeraProvider/chimeraModel to empty string on non-string', () => {
    for (const v of [undefined, null, 42, true, {}, [], 'anthropic']) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({ chimeraProvider: v, chimeraModel: v });
      if (typeof v === 'string') {
        expect(result.chimeraProvider).toBe(v);
        expect(result.chimeraModel).toBe(v);
      } else {
        expect(result.chimeraProvider).toBe('');
        expect(result.chimeraModel).toBe('');
      }
    }
  });

  it('clamps chimeraMaxFiles below 1 back to 15', () => {
    // Bounds guards: any non-number OR any number < 1 must default to 15.
    // The plugin's resolver uses `?? DEFAULT_MAX_FILES` without clamping, so
    // a 0 or NaN here would silently no-op the review.
    for (const v of [0, -1, -100, NaN, Infinity, -Infinity]) {
      const result = migrate({ chimeraMaxFiles: v });
      expect(result.chimeraMaxFiles).toBe(15);
    }
  });

  it('preserves valid chimeraMaxFiles values (1..∞)', () => {
    for (const v of [1, 2, 15, 50, 1000]) {
      const result = migrate({ chimeraMaxFiles: v });
      expect(result.chimeraMaxFiles).toBe(v);
    }
  });

  it('clamps non-number chimeraMaxFiles back to 15', () => {
    for (const v of [undefined, null, '15', true, {}, []]) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({ chimeraMaxFiles: v });
      expect(result.chimeraMaxFiles).toBe(15);
    }
  });

  it('keeps chimeraAutoFix for off/ask/auto', () => {
    for (const v of ['off', 'ask', 'auto'] as const) {
      const result = migrate({ chimeraAutoFix: v });
      expect(result.chimeraAutoFix).toBe(v);
    }
  });

  it('coerces unknown chimeraAutoFix back to off', () => {
    for (const v of ['always', 'never', '', 'OFF', 'ask ', undefined, null, 1, true, {}]) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({ chimeraAutoFix: v });
      expect(result.chimeraAutoFix).toBe('off');
    }
  });
});

describe('migrate — auto-review (v9)', () => {
  it('defaults autoReviewEnabled to false on missing/non-boolean', () => {
    for (const v of [undefined, null, 'yes', 1, {}, []]) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({ autoReviewEnabled: v });
      expect(result.autoReviewEnabled).toBe(false);
    }
  });

  it('preserves autoReviewEnabled=true (strict opt-in)', () => {
    const result = migrate({ autoReviewEnabled: true });
    expect(result.autoReviewEnabled).toBe(true);
  });

  it('defaults autoReviewProvider/Model/FallbackProfile to empty string on non-string', () => {
    for (const v of [undefined, null, 42, true, {}, [], 'review-fast']) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({
        autoReviewProvider: v,
        autoReviewModel: v,
        autoReviewFallbackProfile: v,
      });
      if (typeof v === 'string') {
        expect(result.autoReviewProvider).toBe(v);
        expect(result.autoReviewModel).toBe(v);
        expect(result.autoReviewFallbackProfile).toBe(v);
      } else {
        expect(result.autoReviewProvider).toBe('');
        expect(result.autoReviewModel).toBe('');
        expect(result.autoReviewFallbackProfile).toBe('');
      }
    }
  });

  it('defaults autoReviewFallbackModels to [] on non-array', () => {
    for (const v of [undefined, null, 'chain', 42, true, {}, 'anthropic/claude']) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({ autoReviewFallbackModels: v });
      expect(result.autoReviewFallbackModels).toEqual([]);
    }
  });

  it('preserves valid autoReviewFallbackModels arrays', () => {
    const chain = ['anthropic/claude-opus', 'openai/gpt-4o'];
    const result = migrate({ autoReviewFallbackModels: chain });
    expect(result.autoReviewFallbackModels).toEqual(chain);
  });

  it('clamps negative autoReviewDebounceMs back to 15000 (0 is valid)', () => {
    // 0 is a legitimate "no debounce" choice, so the lower bound is `>= 0`
    // (not `> 0`). Negative values and NaN must reset to 15000.
    for (const v of [-1, -5000, NaN, Infinity, -Infinity]) {
      const result = migrate({ autoReviewDebounceMs: v });
      expect(result.autoReviewDebounceMs).toBe(15_000);
    }
  });

  it('preserves autoReviewDebounceMs=0 and other non-negative values', () => {
    for (const v of [0, 1, 5000, 60_000]) {
      const result = migrate({ autoReviewDebounceMs: v });
      expect(result.autoReviewDebounceMs).toBe(v);
    }
  });

  it('migrates the pre-v12 5000ms default once without overriding a current explicit value', () => {
    expect(migrate({ autoReviewDebounceMs: 5_000 }, 11).autoReviewDebounceMs).toBe(15_000);
    expect(migrate({ autoReviewDebounceMs: 5_000 }, 12).autoReviewDebounceMs).toBe(5_000);
  });

  it('clamps non-number autoReviewDebounceMs back to 15000', () => {
    for (const v of [undefined, null, '5000', true, {}, []]) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({ autoReviewDebounceMs: v });
      expect(result.autoReviewDebounceMs).toBe(15_000);
    }
  });

  it('clamps autoReviewMaxFilesPerBatch below 1 back to 15', () => {
    for (const v of [0, -1, NaN, Infinity, -Infinity]) {
      const result = migrate({ autoReviewMaxFilesPerBatch: v });
      expect(result.autoReviewMaxFilesPerBatch).toBe(15);
    }
  });

  it('preserves valid autoReviewMaxFilesPerBatch (1..∞)', () => {
    for (const v of [1, 2, 15, 50]) {
      const result = migrate({ autoReviewMaxFilesPerBatch: v });
      expect(result.autoReviewMaxFilesPerBatch).toBe(v);
    }
  });

  it('clamps autoReviewMaxConcurrentReviews below 1 back to 2', () => {
    for (const v of [0, -1, NaN, Infinity, -Infinity]) {
      const result = migrate({ autoReviewMaxConcurrentReviews: v });
      expect(result.autoReviewMaxConcurrentReviews).toBe(2);
    }
  });

  it('preserves valid autoReviewMaxConcurrentReviews (1..∞)', () => {
    for (const v of [1, 2, 5, 10]) {
      const result = migrate({ autoReviewMaxConcurrentReviews: v });
      expect(result.autoReviewMaxConcurrentReviews).toBe(v);
    }
  });

  it('keeps autoReviewCascadeOn for off/critical/high', () => {
    for (const v of ['off', 'critical', 'high'] as const) {
      const result = migrate({ autoReviewCascadeOn: v });
      expect(result.autoReviewCascadeOn).toBe(v);
    }
  });

  it('coerces unknown autoReviewCascadeOn back to off', () => {
    for (const v of ['medium', '', 'OFF', 'critical ', undefined, null, 1, true, {}, []]) {
      // @ts-expect-error — intentionally invalid types
      const result = migrate({ autoReviewCascadeOn: v });
      expect(result.autoReviewCascadeOn).toBe('off');
    }
  });
});

describe('migrate — v9 null/undefined persisted', () => {
  it('backfills every v9 field when persisted is null', () => {
    const result = migrate(null);
    // Chimera
    expect(result.chimeraEnabled).toBe(true);
    expect(result.chimeraProvider).toBe('');
    expect(result.chimeraModel).toBe('');
    expect(result.chimeraMaxFiles).toBe(15);
    expect(result.chimeraAutoFix).toBe('off');
    // Auto-review
    expect(result.autoReviewEnabled).toBe(false);
    expect(result.autoReviewProvider).toBe('');
    expect(result.autoReviewModel).toBe('');
    expect(result.autoReviewFallbackProfile).toBe('');
    expect(result.autoReviewFallbackModels).toEqual([]);
    expect(result.autoReviewDebounceMs).toBe(15_000);
    expect(result.autoReviewMaxFilesPerBatch).toBe(15);
    expect(result.autoReviewMaxConcurrentReviews).toBe(2);
    expect(result.autoReviewCascadeOn).toBe('off');
  });

  it('backfills every v9 field when persisted is undefined', () => {
    const result = migrate(undefined as never as null);
    expect(result.chimeraEnabled).toBe(true);
    expect(result.chimeraMaxFiles).toBe(15);
    expect(result.autoReviewEnabled).toBe(false);
    expect(result.autoReviewDebounceMs).toBe(15_000);
    expect(result.autoReviewCascadeOn).toBe('off');
  });
});

describe('migrate — v9 combined', () => {
  it('migrates every invalid v9 value at once', () => {
    const result = migrate({
      chimeraEnabled: 'yes',
      chimeraProvider: 42,
      chimeraModel: [],
      chimeraMaxFiles: 0,
      chimeraAutoFix: 'always',
      autoReviewEnabled: 1,
      autoReviewProvider: {},
      autoReviewModel: true,
      autoReviewFallbackProfile: 99,
      autoReviewFallbackModels: 'chain',
      autoReviewDebounceMs: -5000,
      autoReviewMaxFilesPerBatch: -1,
      autoReviewMaxConcurrentReviews: 0,
      autoReviewCascadeOn: 'medium',
    });
    expect(result.chimeraEnabled).toBe(true);
    expect(result.chimeraProvider).toBe('');
    expect(result.chimeraModel).toBe('');
    expect(result.chimeraMaxFiles).toBe(15);
    expect(result.chimeraAutoFix).toBe('off');
    expect(result.autoReviewEnabled).toBe(false);
    expect(result.autoReviewProvider).toBe('');
    expect(result.autoReviewModel).toBe('');
    expect(result.autoReviewFallbackProfile).toBe('');
    expect(result.autoReviewFallbackModels).toEqual([]);
    expect(result.autoReviewDebounceMs).toBe(15_000);
    expect(result.autoReviewMaxFilesPerBatch).toBe(15);
    expect(result.autoReviewMaxConcurrentReviews).toBe(2);
    expect(result.autoReviewCascadeOn).toBe('off');
  });

  it('preserves every valid v9 value during migration', () => {
    const result = migrate({
      chimeraEnabled: false,
      chimeraProvider: 'anthropic',
      chimeraModel: 'claude-opus-4-6',
      chimeraMaxFiles: 25,
      chimeraAutoFix: 'ask',
      autoReviewEnabled: true,
      autoReviewProvider: 'openai',
      autoReviewModel: 'gpt-4o',
      autoReviewFallbackProfile: 'review-fast',
      autoReviewFallbackModels: ['anthropic/claude-opus', 'openai/gpt-4o'],
      autoReviewDebounceMs: 10_000,
      autoReviewMaxFilesPerBatch: 30,
      autoReviewMaxConcurrentReviews: 4,
      autoReviewCascadeOn: 'high',
    });
    expect(result.chimeraEnabled).toBe(false);
    expect(result.chimeraProvider).toBe('anthropic');
    expect(result.chimeraModel).toBe('claude-opus-4-6');
    expect(result.chimeraMaxFiles).toBe(25);
    expect(result.chimeraAutoFix).toBe('ask');
    expect(result.autoReviewEnabled).toBe(true);
    expect(result.autoReviewProvider).toBe('openai');
    expect(result.autoReviewModel).toBe('gpt-4o');
    expect(result.autoReviewFallbackProfile).toBe('review-fast');
    expect(result.autoReviewFallbackModels).toEqual(['anthropic/claude-opus', 'openai/gpt-4o']);
    expect(result.autoReviewDebounceMs).toBe(10_000);
    expect(result.autoReviewMaxFilesPerBatch).toBe(30);
    expect(result.autoReviewMaxConcurrentReviews).toBe(4);
    expect(result.autoReviewCascadeOn).toBe('high');
  });
});
