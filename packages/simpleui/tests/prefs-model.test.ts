import { describe, expect, it } from 'vitest';
import { DEFAULT_PREFS, parsePrefs, type SimplePrefs } from '../src/lib/prefs-model.js';

const seeded: SimplePrefs = {
  ...DEFAULT_PREFS,
  autonomy: 'auto',
  yolo: true,
  enhanceEnabled: true,
  showModelReasoning: true,
  chime: true,
  confirmExit: true,
};

describe('parsePrefs', () => {
  it('reads a full server snapshot', () => {
    expect(
      parsePrefs({
        autonomy: 'suggest',
        yolo: true,
        enhanceEnabled: true,
        chime: true,
        confirmExit: false,
      }),
    ).toEqual({
      ...DEFAULT_PREFS,
      autonomy: 'suggest',
      yolo: true,
      enhanceEnabled: true,
      showModelReasoning: true,
      chime: true,
      confirmExit: false,
    });
  });

  it('merges a partial snapshot onto the previous value', () => {
    // autonomy.switch broadcasts prefs.updated with only { autonomy } — the
    // other keys must survive rather than snapping back to defaults.
    expect(parsePrefs({ autonomy: 'off' }, seeded)).toEqual({ ...seeded, autonomy: 'off' });
  });

  it('ignores unknown keys from the wider PREF_KEYS snapshot', () => {
    expect(parsePrefs({ hqToken: 'secret', maxIterations: 40 }, seeded)).toEqual(seeded);
  });

  it('holds the previous autonomy for live-only modes it cannot render', () => {
    // `eternal` has no SimpleUI control; reporting it as `off` would
    // misrepresent the running mode.
    expect(parsePrefs({ autonomy: 'eternal' }, seeded).autonomy).toBe('auto');
  });

  it('falls back to the previous value for malformed types', () => {
    expect(parsePrefs({ yolo: 'yes', chime: 1 }, seeded)).toEqual(seeded);
  });

  it('returns the previous prefs for a non-object payload', () => {
    expect(parsePrefs(null, seeded)).toEqual(seeded);
    expect(parsePrefs('nope', seeded)).toEqual(seeded);
    expect(parsePrefs(undefined)).toEqual(DEFAULT_PREFS);
  });
});
