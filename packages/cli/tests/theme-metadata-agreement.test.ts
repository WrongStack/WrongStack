import { THEME_PRESET_IDS, THEME_PRESET_META } from '@wrongstack/contracts/types';
import { describe, expect, it } from 'vitest';
import { cliThemePickerOptions } from '../src/slash-commands/theme.js';

describe('theme display metadata is a single source of truth', () => {
  it('exposes one metadata row per canonical preset id', () => {
    expect(Object.keys(THEME_PRESET_META).sort()).toEqual([...THEME_PRESET_IDS].sort());
  });

  it('CLI picker rows match the shared THEME_PRESET_META record in order, name and description', () => {
    expect(cliThemePickerOptions.length).toBe(THEME_PRESET_IDS.length);
    for (const [i, id] of THEME_PRESET_IDS.entries()) {
      const row = cliThemePickerOptions[i]!;
      expect(row.id).toBe(id);
      // The TUI picker derives its own rows from the same record, so if these
      // ever diverge from it, the CLI and TUI `/theme` surfaces show different
      // text for the same preset. Both read THEME_PRESET_META, so a mismatch
      // here means someone re-introduced a local copy.
      expect(row.name).toBe(THEME_PRESET_META[id].name);
      expect(row.desc).toBe(THEME_PRESET_META[id].description);
    }
  });

  it('every preset has a non-empty name, description and family (no undefined picker cells)', () => {
    for (const id of THEME_PRESET_IDS) {
      const meta = THEME_PRESET_META[id];
      expect(meta.name, `${id} name`).toBeTruthy();
      expect(meta.description, `${id} description`).toBeTruthy();
      expect(meta.family, `${id} family`).toBeTruthy();
      expect(meta.name, `${id} name is not undefined`).not.toBe('undefined');
    }
  });
});
