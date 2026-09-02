import { describe, expect, it } from 'vitest';
import { F_KEY_ENTRIES } from '../src/components/f-key-picker.js';
import { helpSections } from '../src/components/help-overlay.js';

const flat = () => helpSections().flatMap((s) => s.entries.map((e) => e.keys));

describe('helpSections', () => {
  it('always groups the areas in order', () => {
    const titles = helpSections().map((s) => s.title);
    expect(titles).toEqual([
      'Navigation',
      'Monitors',
      'Editing',
      'Commands',
      'Settings',
      'Tool Colors',
    ]);
  });

  it('always lists the monitor + help keys', () => {
    const keys = flat();
    // Monitor chords are listed with terminal-safe alternatives first.
    expect(keys).toContain('F2 or Ctrl+F');
    expect(keys).toContain('F3 or Ctrl+G');
    expect(keys).toContain('F4 or /worktree');
    expect(keys).toContain('?');
    expect(keys).toContain('/help');
    expect(keys).toContain('Ctrl+S or /settings');
    expect(keys).toContain('/settings');
    expect(keys).toContain('/settings-get');
  });

  it('documents the /settings inline syntax variants', () => {
    const settingsEntry = helpSections()
      .find((s) => s.title === 'Commands')
      ?.entries.find((e) => e.keys === '/settings');
    expect(settingsEntry?.desc).toContain('<chord> <value>');
    expect(settingsEntry?.desc).toContain('reset');
  });

  it('lists every F-key panel entry advertised by the F-key picker', () => {
    const keys = flat();
    for (const entry of F_KEY_ENTRIES) {
      // Picker-only entries (key 0) use helpKeys (e.g. '/connections') instead of Fn.
      const keyLabel = entry.key > 0 ? `F${entry.key}` : entry.helpKeys;
      expect(keys.some((key) => key.includes(keyLabel))).toBe(true);
    }
  });

  it('keeps F5 and F12 labels aligned with their implemented panels', () => {
    const f5 = F_KEY_ENTRIES.find((entry) => entry.key === 5);
    const f12 = F_KEY_ENTRIES.find((entry) => entry.key === 12);
    expect(f5).toMatchObject({ label: 'Plan panel', action: 'togglePlanPanel' });
    expect(f12).toMatchObject({ label: 'Kanban board panel', action: 'toggleKanbanPanel' });

    const monitorEntries =
      helpSections().find((section) => section.title === 'Monitors')?.entries ?? [];
    expect(monitorEntries).toContainEqual({
      keys: 'F5 or /plan',
      desc: 'plan panel (F5 may be host refresh/run)',
    });
    expect(monitorEntries).toContainEqual({
      keys: 'F12 or Ctrl+Y',
      desc: 'kanban board panel (also /kanban)',
    });
  });

  it('never produces an empty section', () => {
    for (const sec of helpSections()) {
      expect(sec.entries.length).toBeGreaterThan(0);
    }
  });

  describe('Settings section surfaces picker-only knobs', () => {
    const settings = () => helpSections().find((s) => s.title === 'Settings');
    const keys = () => settings()?.entries.map((e) => e.keys) ?? [];

    it('surfaces the multi-diff summary threshold as a picker-only knob', () => {
      expect(keys()).toContain('Multi-diff summary');
      const entry = settings()?.entries.find((e) => e.keys === 'Multi-diff summary');
      expect(entry?.desc).toContain('0 = off');
      expect(entry?.desc).toContain('default 5');
      // Surfacing the Ctrl+M jump in the overlay so the keyboard shortcut
      // doesn't stay hidden from anyone reading the help text.
      expect(entry?.desc).toContain('Ctrl+M');
    });

    it('surfaces the Ctrl+<letter> jump chords advertised by the picker', () => {
      // Every chord registered in settings-picker.tsx should be discoverable
      // from `?` — the overlay stays in sync with the keyboard handler.
      const descriptions = (settings()?.entries ?? []).map((e) => e.desc);
      for (const chord of [
        'Ctrl+I',
        'Ctrl+W',
        'Ctrl+R',
        'Ctrl+E',
        'Ctrl+N',
        'Ctrl+L',
        'Ctrl+D',
        'Alt+A',
        'Alt+Y',
        'Alt+C',
        'Alt+S',
        'Alt+T',
        'Alt+X',
        'Alt+Shift+L',
        'Alt+Shift+A',
        'Alt+Shift+B',
        'Alt+Shift+G',
      ]) {
        expect(descriptions.some((d) => d.includes(chord))).toBe(true);
      }
    });

    it('lists a small set of representative picker-only settings without bloating the overlay', () => {
      // The section is allowed to grow as new chords are added, but should
      // stay bounded so the overlay remains readable in narrow terminals.
      expect(keys().length).toBeGreaterThanOrEqual(1);
      expect(keys().length).toBeLessThanOrEqual(20);
    });
  });
});
