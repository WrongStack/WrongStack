import { describe, expect, it } from 'vitest';
import { PREF_KEYS } from '../src/server/pref-helpers.js';
import {
  VALIDATED_PREF_KEYS,
  validatePrefsUpdatePayload,
} from '../src/server/ws-payload-preferences.js';

/**
 * The two halves of "the server accepts this preference".
 *
 * `PREF_KEYS` (pref-helpers.ts) is the read/persist side: the keys
 * `prefSnapshot()` reports and `persistPrefsToConfig()` knows how to write.
 * `VALIDATED_PREF_KEYS` (ws-payload-preferences.ts) is the write side: the keys
 * `validatePreferenceValue()` will accept off the wire.
 *
 * They were maintained by hand with no cross-check, and drifted. `modelTiers`
 * was in PREF_KEYS with a ready persist branch (pref-helpers.ts) but in no
 * validator set, so every WebUI Model Tiers edit was rejected whole with
 * "unknown preference key: modelTiers" — the local store updated, the panel
 * re-rendered, and the config file never changed.
 *
 * This test is the enforcement that was missing. See
 * docs/audit/webui-full-review-2026-09-03.md B-01.
 */
describe('preference key allowlists — validator ↔ persist parity', () => {
  /**
   * Keys the browser never sends: the server derives them and reports them
   * through `prefs.get` / `prefs.updated` only. `handlePrefsUpdate` destructures
   * `subagentsPolicyLocked` out before persisting, and `tgConfigured` is
   * computed from whether a Telegram token exists. Accepting either on the wire
   * would let a client assert a state it does not own, so they are deliberately
   * read-only rather than a drift to fix.
   *
   * Adding a key here is a claim that the browser must never write it. Anything
   * a settings panel edits belongs in the validator instead.
   */
  const READ_ONLY_PREF_KEYS = new Set(['subagentsPolicyLocked', 'tgConfigured']);

  it('validates every persistable preference key the browser may write', () => {
    const unvalidated = PREF_KEYS.filter(
      (key) => !VALIDATED_PREF_KEYS.has(key) && !READ_ONLY_PREF_KEYS.has(key),
    );
    expect(unvalidated).toEqual([]);
  });

  it('keeps the read-only keys genuinely unwritable', () => {
    for (const key of READ_ONLY_PREF_KEYS) {
      expect(VALIDATED_PREF_KEYS.has(key)).toBe(false);
      expect(validatePrefsUpdatePayload({ [key]: true })).toMatchObject({ ok: false });
    }
  });

  /**
   * Keys the wire accepts but `prefs.get` deliberately never reports back.
   *
   *  - `hqToken` is a secret: it is written through to `Config.hq.token` and
   *    must not travel back to a browser, so it cannot be in PREF_KEYS.
   *  - `allowOutsideProjectRoot` is the client-side INVERSE mirror of
   *    `fsAccess`. The settings panel writes `fsAccess`; this key is accepted
   *    for compatibility and stripped by `DISPLAY_ONLY_KEYS` before persist,
   *    so the canonical value round-trips as `fsAccess` alone.
   *
   * Anything else that appears here is a validator accepting a key no part of
   * the server can report — a write that vanishes on reload.
   */
  const WRITE_ONLY_PREF_KEYS = new Set(['hqToken', 'allowOutsideProjectRoot']);

  it('reports back every key it accepts, except the documented write-only ones', () => {
    const reported = new Set<string>(PREF_KEYS);
    const orphaned = [...VALIDATED_PREF_KEYS].filter(
      (key) => !reported.has(key) && !WRITE_ONLY_PREF_KEYS.has(key),
    );
    expect(orphaned).toEqual([]);
  });
});
