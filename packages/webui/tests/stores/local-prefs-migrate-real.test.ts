import { describe, expect, it } from 'vitest';
import { useLocalPrefs } from '../../src/stores/local-prefs';

/**
 * Exercises the **real** `migrate` implementation from the zustand persist
 * options, rather than a hand-copied replica.
 *
 * `local-prefs-migration.test.ts` mirrors the same logic locally, which
 * documents intent but cannot catch drift: the replica keeps passing after
 * the store changes. These tests reach the live function through
 * `store.persist.getOptions()`, so a rule removed from `local-prefs.ts`
 * fails here.
 */
type Migrate = (persisted: unknown, version: number) => Record<string, unknown>;

function migrate(persisted: unknown, version = 1): Record<string, unknown> {
  const fn = useLocalPrefs.persist.getOptions().migrate as Migrate | undefined;
  if (!fn) throw new Error('local-prefs persist options expose no migrate()');
  return fn(persisted, version);
}

describe('local-prefs migrate() — persist option (real implementation)', () => {
  it('is wired into the persist middleware at the current version', () => {
    const opts = useLocalPrefs.persist.getOptions();
    expect(opts.name).toBe('wrongstack-local-prefs');
    expect(opts.version).toBe(16);
    expect(typeof opts.migrate).toBe('function');
  });

  it('produces a fully-populated pref set from null (fresh install)', () => {
    const p = migrate(null);
    expect(p.contextStrategy).toBe('hybrid');
    expect(p.auditLevel).toBe('standard');
    expect(p.fleetChatVerbosity).toBe('off');
    expect(p.autoProceedMaxIterations).toBe(50);
  });

  it('produces the same defaults from an empty object', () => {
    expect(migrate({})).toMatchObject({
      contextStrategy: 'hybrid',
      auditLevel: 'standard',
      fleetChatVerbosity: 'off',
    });
  });

  // ── v10: streamFleet → fleetChatVerbosity ────────────────────────────────

  it('maps legacy streamFleet:true to fleetChatVerbosity "full"', () => {
    const p = migrate({ streamFleet: true });
    expect(p.fleetChatVerbosity).toBe('full');
    expect(p).not.toHaveProperty('streamFleet');
  });

  it('maps legacy streamFleet:false to "off"', () => {
    const p = migrate({ streamFleet: false });
    expect(p.fleetChatVerbosity).toBe('off');
    expect(p).not.toHaveProperty('streamFleet');
  });

  it('defaults to "off" when streamFleet is absent or a non-boolean', () => {
    expect(migrate({}).fleetChatVerbosity).toBe('off');
    expect(migrate({ streamFleet: 'yes' }).fleetChatVerbosity).toBe('off');
  });

  it('preserves an already-migrated fleetChatVerbosity', () => {
    expect(migrate({ fleetChatVerbosity: 'full' }).fleetChatVerbosity).toBe('full');
  });

  it('rejects a non-member fleetChatVerbosity value', () => {
    expect(migrate({ fleetChatVerbosity: 'compact' }).fleetChatVerbosity).toBe('off');
  });

  // ── contextStrategy / auditLevel ─────────────────────────────────────────

  it.each(['hybrid', 'intelligent', 'selective'])('keeps valid contextStrategy %s', (v) => {
    expect(migrate({ contextStrategy: v }).contextStrategy).toBe(v);
  });

  it.each(['frugal', 'balanced', 'deep', 'archival', '', null, 7])(
    'remaps invalid contextStrategy %p to hybrid',
    (v) => {
      expect(migrate({ contextStrategy: v }).contextStrategy).toBe('hybrid');
    },
  );

  it('remaps the v1-only auditLevel "verbose" to "full"', () => {
    expect(migrate({ auditLevel: 'verbose' }).auditLevel).toBe('full');
  });

  it.each(['minimal', 'standard', 'full'])('keeps valid auditLevel %s', (v) => {
    expect(migrate({ auditLevel: v }).auditLevel).toBe(v);
  });

  it('remaps an unknown auditLevel to standard', () => {
    expect(migrate({ auditLevel: 'chatty' }).auditLevel).toBe('standard');
  });

  // ── numeric / collection backfills ───────────────────────────────────────

  it('backfills autoProceedMaxIterations when it is not a number', () => {
    expect(migrate({ autoProceedMaxIterations: '10' }).autoProceedMaxIterations).toBe(50);
    expect(migrate({ autoProceedMaxIterations: 7 }).autoProceedMaxIterations).toBe(7);
    // 0 is a legitimate "unlimited" choice and must survive.
    expect(migrate({ autoProceedMaxIterations: 0 }).autoProceedMaxIterations).toBe(0);
  });

  it.each([undefined, null, 'x', 42, [] as unknown])(
    'resets a non-record fallbackProfiles (%p) to {}',
    (v) => {
      expect(migrate({ fallbackProfiles: v }).fallbackProfiles).toEqual({});
    },
  );

  it('keeps a well-formed fallbackProfiles record', () => {
    const profiles = { fast: ['a', 'b'] };
    expect(migrate({ fallbackProfiles: profiles }).fallbackProfiles).toEqual(profiles);
  });

  it('resets non-array list prefs to []', () => {
    const p = migrate({
      favoriteModels: 'a,b',
      modelAvailabilitySchedule: {},
      autoReviewFallbackModels: 'x',
    });
    expect(p.favoriteModels).toEqual([]);
    expect(p.modelAvailabilitySchedule).toEqual([]);
    expect(p.autoReviewFallbackModels).toEqual([]);
  });

  it('keeps well-formed list prefs', () => {
    const p = migrate({ favoriteModels: ['opus'], autoReviewFallbackModels: ['sonnet'] });
    expect(p.favoriteModels).toEqual(['opus']);
    expect(p.autoReviewFallbackModels).toEqual(['sonnet']);
  });

  it.each([undefined, 'x', 1, [] as unknown])('resets a non-record modelMatrix (%p) to {}', (v) => {
    expect(migrate({ modelMatrix: v }).modelMatrix).toEqual({});
  });

  it('backfills favoriteModelsOnly to false unless it is a real boolean', () => {
    expect(migrate({}).favoriteModelsOnly).toBe(false);
    expect(migrate({ favoriteModelsOnly: 'true' }).favoriteModelsOnly).toBe(false);
    expect(migrate({ favoriteModelsOnly: true }).favoriteModelsOnly).toBe(true);
  });

  // ── uiLocale ─────────────────────────────────────────────────────────────

  it('backfills a missing or blank uiLocale with a detected locale string', () => {
    expect(typeof migrate({}).uiLocale).toBe('string');
    expect(migrate({}).uiLocale).not.toBe('');
    expect(typeof migrate({ uiLocale: '' }).uiLocale).toBe('string');
    expect(migrate({ uiLocale: '' }).uiLocale).not.toBe('');
    expect(typeof migrate({ uiLocale: 42 }).uiLocale).toBe('string');
  });

  it('keeps an explicitly persisted uiLocale', () => {
    expect(migrate({ uiLocale: 'tr' }).uiLocale).toBe('tr');
  });

  // ── v8: safety & system prefs ────────────────────────────────────────────

  it('backfills breaker prefs', () => {
    expect(migrate({}).breakerEnabled).toBe(false);
    expect(migrate({ breakerEnabled: true }).breakerEnabled).toBe(true);
    expect(migrate({ breakerEnabled: 1 }).breakerEnabled).toBe(false);
    expect(migrate({}).breakerAutoKillResetMs).toBe(60_000);
    expect(migrate({ breakerAutoKillResetMs: 5_000 }).breakerAutoKillResetMs).toBe(5_000);
    expect(migrate({ breakerAutoKillResetMs: '5s' }).breakerAutoKillResetMs).toBe(60_000);
  });

  it('constrains fsAccess to the two-member enum', () => {
    expect(migrate({}).fsAccess).toBe('unrestricted');
    expect(migrate({ fsAccess: 'project' }).fsAccess).toBe('project');
    expect(migrate({ fsAccess: 'unrestricted' }).fsAccess).toBe('unrestricted');
    expect(migrate({ fsAccess: 'anywhere' }).fsAccess).toBe('unrestricted');
  });

  it('backfills debugStream', () => {
    expect(migrate({}).debugStream).toBe(false);
    expect(migrate({ debugStream: true }).debugStream).toBe(true);
  });

  // ── v9: Chimera ──────────────────────────────────────────────────────────

  it("defaults chimeraEnabled to true (matches the plugin's enabled !== false)", () => {
    expect(migrate({}).chimeraEnabled).toBe(true);
    expect(migrate({ chimeraEnabled: false }).chimeraEnabled).toBe(false);
    expect(migrate({ chimeraEnabled: 'yes' }).chimeraEnabled).toBe(true);
  });

  it('defaults chimera provider/model to empty strings', () => {
    expect(migrate({}).chimeraProvider).toBe('');
    expect(migrate({}).chimeraModel).toBe('');
    expect(migrate({ chimeraProvider: 'openai', chimeraModel: 'gpt' })).toMatchObject({
      chimeraProvider: 'openai',
      chimeraModel: 'gpt',
    });
  });

  it.each(['off', 'ask', 'auto'])('keeps valid chimeraAutoFix %s', (v) => {
    expect(migrate({ chimeraAutoFix: v }).chimeraAutoFix).toBe(v);
  });

  it.each(['always', '', undefined, true])('rejects invalid chimeraAutoFix %p', (v) => {
    expect(migrate({ chimeraAutoFix: v }).chimeraAutoFix).toBe('off');
  });

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY, '15', undefined])(
    'rejects chimeraMaxFiles %p — an unclamped 0/NaN would silently no-op the review',
    (v) => {
      expect(migrate({ chimeraMaxFiles: v }).chimeraMaxFiles).toBe(15);
    },
  );

  it('keeps a chimeraMaxFiles >= 1', () => {
    expect(migrate({ chimeraMaxFiles: 1 }).chimeraMaxFiles).toBe(1);
    expect(migrate({ chimeraMaxFiles: 200 }).chimeraMaxFiles).toBe(200);
  });

  // ── v9: auto-review ──────────────────────────────────────────────────────

  it('defaults autoReviewEnabled to false (strict opt-in)', () => {
    expect(migrate({}).autoReviewEnabled).toBe(false);
    expect(migrate({ autoReviewEnabled: true }).autoReviewEnabled).toBe(true);
  });

  it('defaults auto-review string prefs to empty strings', () => {
    const p = migrate({});
    expect(p.autoReviewProvider).toBe('');
    expect(p.autoReviewModel).toBe('');
    expect(p.autoReviewFallbackProfile).toBe('');
  });

  it('keeps persisted auto-review string prefs', () => {
    expect(
      migrate({
        autoReviewProvider: 'anthropic',
        autoReviewModel: 'opus',
        autoReviewFallbackProfile: 'cheap',
      }),
    ).toMatchObject({
      autoReviewProvider: 'anthropic',
      autoReviewModel: 'opus',
      autoReviewFallbackProfile: 'cheap',
    });
  });

  it('accepts autoReviewDebounceMs of 0 — "no debounce" is a valid choice', () => {
    expect(migrate({ autoReviewDebounceMs: 0 }).autoReviewDebounceMs).toBe(0);
  });

  it('migrates the pre-v12 5000ms default once and preserves a current explicit 5000ms', () => {
    expect(migrate({ autoReviewDebounceMs: 5_000 }, 11).autoReviewDebounceMs).toBe(15_000);
    expect(migrate({ autoReviewDebounceMs: 5_000 }, 12).autoReviewDebounceMs).toBe(5_000);
  });

  it.each([-1, Number.NaN, Number.POSITIVE_INFINITY, '5000', undefined])(
    'rejects autoReviewDebounceMs %p',
    (v) => {
      expect(migrate({ autoReviewDebounceMs: v }).autoReviewDebounceMs).toBe(15_000);
    },
  );

  it.each([0, -3, Number.NaN, 'x', undefined])(
    'rejects autoReviewMaxFilesPerBatch %p (must be >= 1)',
    (v) => {
      expect(migrate({ autoReviewMaxFilesPerBatch: v }).autoReviewMaxFilesPerBatch).toBe(15);
    },
  );

  it.each([0, -1, Number.NaN, 'two', undefined])(
    'rejects autoReviewMaxConcurrentReviews %p (must be >= 1)',
    (v) => {
      expect(migrate({ autoReviewMaxConcurrentReviews: v }).autoReviewMaxConcurrentReviews).toBe(2);
    },
  );

  it('keeps valid auto-review numeric prefs', () => {
    expect(
      migrate({
        autoReviewDebounceMs: 1200,
        autoReviewMaxFilesPerBatch: 3,
        autoReviewMaxConcurrentReviews: 8,
      }),
    ).toMatchObject({
      autoReviewDebounceMs: 1200,
      autoReviewMaxFilesPerBatch: 3,
      autoReviewMaxConcurrentReviews: 8,
    });
  });

  it.each(['off', 'critical', 'high'])('keeps valid autoReviewCascadeOn %s', (v) => {
    expect(migrate({ autoReviewCascadeOn: v }).autoReviewCascadeOn).toBe(v);
  });

  it.each(['medium', '', undefined, 1])('rejects invalid autoReviewCascadeOn %p', (v) => {
    expect(migrate({ autoReviewCascadeOn: v }).autoReviewCascadeOn).toBe('off');
  });

  // ── v11: display / access flags ──────────────────────────────────────────

  it('backfills the v11 boolean flags with their documented defaults', () => {
    const p = migrate({});
    expect(p.showModelReasoning).toBe(true);
    expect(p.showAgentSwarmPanel).toBe('bottom');
    expect(p.allowOutsideProjectRoot).toBe(true);
  });

  it('preserves explicitly-set v11 flags', () => {
    expect(
      migrate({
        showModelReasoning: false,
        showAgentSwarmPanel: 'sidebar',
        allowOutsideProjectRoot: false,
      }),
    ).toMatchObject({
      showModelReasoning: false,
      showAgentSwarmPanel: 'sidebar',
      allowOutsideProjectRoot: false,
    });
  });

  it('coerces legacy boolean showAgentSwarmPanel to the tri-state enum (v14)', () => {
    expect(migrate({ showAgentSwarmPanel: true }).showAgentSwarmPanel).toBe('bottom');
    expect(migrate({ showAgentSwarmPanel: false }).showAgentSwarmPanel).toBe('off');
  });

  it('coerces non-boolean v11 flags back to their defaults', () => {
    const p = migrate({
      showModelReasoning: 'true',
      showAgentSwarmPanel: 1,
      allowOutsideProjectRoot: null,
    });
    expect(p.showModelReasoning).toBe(true);
    expect(p.showAgentSwarmPanel).toBe('bottom');
    expect(p.allowOutsideProjectRoot).toBe(true);
  });

  // ── v15: auto-collapse input display toggle ───────────────────────────

  it('backfills autoCollapseInput to false (opt-in, default off)', () => {
    expect(migrate({}).autoCollapseInput).toBe(false);
    expect(migrate(null).autoCollapseInput).toBe(false);
  });

  it('coerces non-boolean autoCollapseInput back to false', () => {
    for (const v of ['true', 1, null, undefined, {}]) {
      expect(migrate({ autoCollapseInput: v }).autoCollapseInput).toBe(false);
    }
  });

  it('preserves an explicitly persisted autoCollapseInput boolean', () => {
    expect(migrate({ autoCollapseInput: true }).autoCollapseInput).toBe(true);
    expect(migrate({ autoCollapseInput: false }).autoCollapseInput).toBe(false);
  });

  // ── v16: WrongProxy / WrongTrace toggles ──────────────────────────────

  it('backfills wrongProxyEnabled to false and wrongProxyUrl to the daemon default', () => {
    expect(migrate({}).wrongProxyEnabled).toBe(false);
    expect(migrate({}).wrongProxyUrl).toBe('http://localhost:3444');
    expect(migrate(null).wrongProxyEnabled).toBe(false);
    expect(migrate(null).wrongProxyUrl).toBe('http://localhost:3444');
  });

  it('coerces non-boolean wrongProxyEnabled back to false', () => {
    for (const v of ['true', 'yes', 1, 0, null, undefined, {}]) {
      expect(migrate({ wrongProxyEnabled: v }).wrongProxyEnabled).toBe(false);
    }
  });

  it('coerces non-string or blank wrongProxyUrl back to the default', () => {
    for (const v of [123, true, null, undefined, {}, '   ']) {
      expect(migrate({ wrongProxyUrl: v }).wrongProxyUrl).toBe('http://localhost:3444');
    }
  });

  it('preserves explicitly persisted v16 values', () => {
    const p = migrate({ wrongProxyEnabled: true, wrongProxyUrl: 'http://127.0.0.1:9111' });
    expect(p.wrongProxyEnabled).toBe(true);
    expect(p.wrongProxyUrl).toBe('http://127.0.0.1:9111');
  });

  it('backfills v16 fields even when the persisted store is older than v16', () => {
    // The v16 guards are not gated by `version < 16` — a v15 store that
    // pre-dates the fields must still get the defaults.
    const p = migrate({ autoCollapseInput: true }, 15);
    expect(p.wrongProxyEnabled).toBe(false);
    expect(p.wrongProxyUrl).toBe('http://localhost:3444');
  });

  // ── unknown keys ─────────────────────────────────────────────────────────

  it('passes unrelated persisted keys through untouched', () => {
    expect(migrate({ someFutureKey: 'keep me' }).someFutureKey).toBe('keep me');
  });
});
