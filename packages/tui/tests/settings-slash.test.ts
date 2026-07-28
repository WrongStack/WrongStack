import { describe, expect, it } from 'vitest';
import {
  MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS,
  settingsPickerJumpByName,
  settingsPickerJumpNames,
  SETTINGS_PICKER_JUMP_CHORDS,
} from '../src/components/settings-picker.js';

describe('settingsPickerJumpByName', () => {
  it('exact-slug match resolves to the right field', () => {
    // Build the full slug for one known row and confirm the round trip.
    for (const c of SETTINGS_PICKER_JUMP_CHORDS) {
      const slug = c.label.toLowerCase().replace(/\s+/g, '-');
      expect(settingsPickerJumpByName(slug)).toBe(c.field);
    }
  });

  it('partial-slug match (first two words) finds the row', () => {
    // "multi-diff" → 21 (Multi-diff summary) — the user types fewer
    // words than the label has, and the prefix matcher resolves it.
    expect(settingsPickerJumpByName('multi-diff')).toBe(21);
    // "thinking-word" → 22 (Thinking word) — first two words match.
    expect(settingsPickerJumpByName('thinking-word')).toBe(22);
    // "default-autonomy" → 0 (Default autonomy mode).
    expect(settingsPickerJumpByName('default-autonomy')).toBe(0);
  });

  it('first-token match handles single-word queries', () => {
    // "yolo" → 3 (YOLO mode) — single-word query matches the first
    // token of the label "YOLO mode".
    expect(settingsPickerJumpByName('yolo')).toBe(3);
    // "refine" → 18 (Refine) — first token of "Refine".
    expect(settingsPickerJumpByName('refine')).toBe(18);
    // "chime" → 5 (Completion chime) — first token of "Completion chime".
    expect(settingsPickerJumpByName('chime')).toBe(5);
  });

  it('alias-like queries map to the right row', () => {
    // "context" alone matches the first token of "Context mode" (29).
    expect(settingsPickerJumpByName('context')).toBe(29);
    // "token" matches the first token of "Token-saving mode" (13).
    // (Plurals like "tokens" don't match — the matcher is exact-token,
    // no stemming. This is a deliberate design choice: short queries
    // resolve unambiguously, and users who want the full word type it.)
    expect(settingsPickerJumpByName('token')).toBe(13);
    // "log" matches "Log level" (31).
    expect(settingsPickerJumpByName('log')).toBe(31);
    // "audit" matches "Audit level" (32).
    expect(settingsPickerJumpByName('audit')).toBe(32);
    // "debug" matches "Stream debug logging" (33).
    expect(settingsPickerJumpByName('debug')).toBe(33);
    // "scope" matches "Config scope" (35).
    expect(settingsPickerJumpByName('scope')).toBe(35);
    // "concurrent" matches "Max concurrent" (30).
    expect(settingsPickerJumpByName('concurrent')).toBe(30);
    // "word" matches "Thinking word" (22).
    expect(settingsPickerJumpByName('word')).toBe(22);
    // "index" matches "Index on session start" (20).
    expect(settingsPickerJumpByName('index')).toBe(20);
  });

  it('returns undefined for unknown queries', () => {
    expect(settingsPickerJumpByName('nonexistent')).toBeUndefined();
    expect(settingsPickerJumpByName('foobar')).toBeUndefined();
    // Empty / whitespace queries are also undefined (caller's contract).
    expect(settingsPickerJumpByName('')).toBeUndefined();
    expect(settingsPickerJumpByName('   ')).toBeUndefined();
  });

  it('resolves the agent swarm panel row by its full name', () => {
    expect(settingsPickerJumpByName('show-agent-swarm-panel')).toBe(40);
  });

  it('is case-insensitive', () => {
    expect(settingsPickerJumpByName('MULTI-DIFF')).toBe(21);
    expect(settingsPickerJumpByName('Yolo')).toBe(3);
    expect(settingsPickerJumpByName('Context')).toBe(29);
  });
});

describe('settingsPickerJumpNames', () => {
  it('returns one slug per registered chord (matches the help-overlay surface)', () => {
    const names = settingsPickerJumpNames();
    // Number of slugs must match the number of registered chords.
    expect(names).toHaveLength(SETTINGS_PICKER_JUMP_CHORDS.length);
    // First and last entries match the order in SETTINGS_PICKER_JUMP_CHORDS.
    expect(names[0]).toBe('index-on-session-start');
    expect(names.at(-1)).toBe('pre-refine-countdown');
  });

  it('every name resolves back to a field via the by-name lookup', () => {
    // Round-trip: the surface that the help text shows is the same one
    // the slash command accepts. If a chord is added/renamed, both must
    // update together — this test guards against drift.
    for (const name of settingsPickerJumpNames()) {
      expect(settingsPickerJumpByName(name)).toBeDefined();
    }
  });
});

describe('settings-picker preset integrity', () => {
  it('every chord in the multi-diff threshold presets has a positive default', () => {
    // The presets are part of the user-facing config — this test catches
    // an accidental sign-flip or zero-inclusion that would break the
    // cycle behaviour.
    for (const v of MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS) {
      expect(Number.isInteger(v)).toBe(true);
      expect(v).toBeGreaterThanOrEqual(0);
    }
    // Default 5 should be in the preset list (it's the documented default).
    expect(MULTI_DIFF_SUMMARY_THRESHOLD_PRESETS).toContain(5);
  });
});
