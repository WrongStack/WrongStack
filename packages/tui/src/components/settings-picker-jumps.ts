export type SettingsPickerJumpMod = 'ctrl' | 'alt' | 'alt-shift';

export interface SettingsPickerJumpChord {
  /** The modifier that, combined with the letter, triggers the jump. */
  mod: SettingsPickerJumpMod;
  /** The lowercase letter that triggers the jump. */
  letter: string;
  /** Target row index. Must match the picker's actual field order. */
  field: number;
  /** Short label for the help overlay and any debug surfaces. */
  label: string;
}

export const SETTINGS_PICKER_JUMP_CHORDS: ReadonlyArray<SettingsPickerJumpChord> = Object.freeze([
  { mod: 'ctrl', letter: 'i', field: 20, label: 'Index on session start' },
  { mod: 'ctrl', letter: 'm', field: 21, label: 'Multi-diff summary' },
  { mod: 'ctrl', letter: 'w', field: 22, label: 'Thinking word' },
  { mod: 'ctrl', letter: 'r', field: 17, label: 'Refine preview countdown' },
  { mod: 'ctrl', letter: 'e', field: 18, label: 'Refine' },
  { mod: 'ctrl', letter: 'n', field: 23, label: 'Reasoning mode' },
  { mod: 'ctrl', letter: 'l', field: 30, label: 'Max concurrent' },
  { mod: 'ctrl', letter: 'd', field: 34, label: 'Statusline' },
  { mod: 'alt', letter: 'a', field: 0, label: 'Default autonomy mode' },
  { mod: 'alt', letter: 'y', field: 3, label: 'YOLO mode' },
  { mod: 'alt', letter: 'c', field: 5, label: 'Completion chime' },
  { mod: 'alt', letter: 's', field: 6, label: 'Confirm before exit' },
  { mod: 'alt', letter: 't', field: 13, label: 'Token-saving mode' },
  { mod: 'alt', letter: 'x', field: 29, label: 'Context mode' },
  { mod: 'alt-shift', letter: 'l', field: 31, label: 'Log level' },
  { mod: 'alt-shift', letter: 'a', field: 32, label: 'Audit level' },
  { mod: 'alt-shift', letter: 'b', field: 33, label: 'Stream debug logging' },
  { mod: 'alt-shift', letter: 'g', field: 35, label: 'Config scope' },
  { mod: 'alt', letter: 'n', field: 36, label: 'Animation' },
  { mod: 'alt', letter: 'p', field: 40, label: 'Show agent swarm panel' },
  { mod: 'alt', letter: 'r', field: 41, label: 'Pre-refine countdown' },
  { mod: 'alt-shift', letter: 's', field: 43, label: 'Show SAGE Memory Inject' },
  { mod: 'alt-shift', letter: 't', field: 44, label: 'SAGE Memory Inject threshold' },
]);

export function settingsPickerJumpField(
  mod: SettingsPickerJumpMod,
  letter: string,
): number | undefined {
  const lower = letter.toLowerCase();
  const chord = SETTINGS_PICKER_JUMP_CHORDS.find((c) => c.mod === mod && c.letter === lower);
  return chord?.field;
}

function settingsPickerSlug(label: string): string {
  return label.toLowerCase().replace(/\s+/g, '-');
}

export function settingsPickerJumpByName(name: string): number | undefined {
  const query = settingsPickerSlug(name);
  if (!query) return undefined;

  const exact = SETTINGS_PICKER_JUMP_CHORDS.find((c) => settingsPickerSlug(c.label) === query);
  if (exact) return exact.field;

  const queryTokens = query.split('-');
  for (const c of SETTINGS_PICKER_JUMP_CHORDS) {
    const labelTokens = settingsPickerSlug(c.label).split('-');
    if (queryTokens.every((t, i) => labelTokens[i] === t)) {
      return c.field;
    }
  }

  for (const c of SETTINGS_PICKER_JUMP_CHORDS) {
    const labelTokens = settingsPickerSlug(c.label).split('-');
    if (labelTokens.some((t) => t === query || t.startsWith(`${query}-`))) {
      return c.field;
    }
  }

  return undefined;
}

export function settingsPickerJumpNames(): string[] {
  return SETTINGS_PICKER_JUMP_CHORDS.map((c) => settingsPickerSlug(c.label));
}
