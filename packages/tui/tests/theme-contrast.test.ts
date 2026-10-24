import { THEME_PRESET_IDS } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { themePresets } from '../src/theme-presets.js';
import { contrastRatio, relativeLuminance } from '../src/theme-utils.js';

/**
 * Contrast floors for the shipped palette set.
 *
 * These are NOT aspirational numbers — they were measured across all 64
 * presets before being written down, and each is set at (or just under) the
 * real floor of the catalogue so the test catches a REGRESSION in a palette,
 * not a stylistic disagreement with it.
 *
 * Measured distribution (n = 64 for every pair):
 *
 *   textPrimary  on surface      min 7.22  (one-dark)        median 11.86
 *   textSecondary on surface     min 5.12  (everforest)      median  8.42
 *   textMuted    on surface      min 3.03  (rose-pine-moon) median  4.19
 *   success      on diffAddBg    min 2.48  (rose-pine)      median  6.64
 *   error        on diffDelBg    min 3.00  (sandstone)      median  4.52
 *
 * `success on diffAddBg` is now held to the full 3.0. `rose-pine` used to be a
 * documented exception at 2.4: its green was pine `#31748f`, dark enough that
 * no add-wash still reading as a tinted row could clear 3:1. That is the
 * recorded "dark marker on a near-black base" trap, and the fix belongs in the
 * MARKER, not the wash — `success` is now `#3e8fb0` (the pine-teal
 * `rose-pine-moon` already ships in that family), measuring 3.55:1 on the same
 * `#1f3538` wash, with the comment-on-wash ratio and wash luminance unchanged.
 * `textMuted` is held to 3.0 instead of the 4.5 body-text rule because it is
 * a deliberately de-emphasised token, not body copy.
 */
const FLOORS = {
  'textPrimary on surface': 4.5,
  'textSecondary on surface': 4.5,
  'textMuted on surface': 3.0,
  'success on diffAddBg': 3.0,
  'error on diffDelBg': 3.0,
} as const;

describe('theme preset contrast', () => {
  const presets = Object.entries(themePresets);

  it('covers every canonical preset id', () => {
    expect(Object.keys(themePresets).sort()).toEqual([...THEME_PRESET_IDS].sort());
  });

  it.each(presets)('%s keeps body and secondary text AA-legible on surface', (_id, preset) => {
    expect(contrastRatio(preset.textPrimary, preset.surface)).toBeGreaterThanOrEqual(
      FLOORS['textPrimary on surface'],
    );
    expect(contrastRatio(preset.textSecondary, preset.surface)).toBeGreaterThanOrEqual(
      FLOORS['textSecondary on surface'],
    );
  });

  it.each(presets)('%s keeps muted text and diff markers above their floors', (_id, preset) => {
    expect(contrastRatio(preset.textMuted, preset.surface)).toBeGreaterThanOrEqual(
      FLOORS['textMuted on surface'],
    );
    expect(contrastRatio(preset.success, preset.diffAddBg)).toBeGreaterThanOrEqual(
      FLOORS['success on diffAddBg'],
    );
    expect(contrastRatio(preset.error, preset.diffDelBg)).toBeGreaterThanOrEqual(
      FLOORS['error on diffDelBg'],
    );
  });

  /**
   * Guards the coupling trap recorded for these palettes: `textSecondary`
   * feeds `syntax.commentOnWash`, so raising it to win a contrast assertion
   * can push it brighter than `textPrimary` and invert the emphasis
   * hierarchy. Ordering is asserted directly so a future contrast "fix"
   * cannot quietly trade one for the other.
   */
  it.each(presets)('%s orders text tokens primary > secondary > muted', (_id, preset) => {
    const p = relativeLuminance(preset.textPrimary);
    const s = relativeLuminance(preset.textSecondary);
    const m = relativeLuminance(preset.textMuted);
    expect(p, 'textPrimary luminance').not.toBeNull();
    expect(s, 'textSecondary luminance').not.toBeNull();
    expect(m, 'textMuted luminance').not.toBeNull();
    expect(p!).toBeGreaterThan(s!);
    expect(s!).toBeGreaterThan(m!);
  });

  it('reports 1:1 for unparseable colours rather than a passing score', () => {
    expect(contrastRatio('not-a-colour', '#181825')).toBe(1);
    expect(contrastRatio('#181825', '')).toBe(1);
  });

  it('is order-independent and symmetric', () => {
    expect(contrastRatio('#ffffff', '#000000')).toBe(contrastRatio('#000000', '#ffffff'));
    expect(contrastRatio('#ffffff', '#000000')).toBe(21);
  });
});
