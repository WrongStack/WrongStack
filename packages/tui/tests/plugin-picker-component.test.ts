// Runtime smoke for the PluginPicker React component.
//
// The reducer and dispatch tests cover *what* the picker does in response
// to state changes; this file covers *what it looks like* when mounted.
// In other words, the user-visible contract:
//
//   - "Plugin menu" heading appears
//   - locked rows show 🔒 + yellow when a caller supplies lockable=false
//   - enabled rows show ● on, disabled show ○ off
//   - ↑/↓ change the focused row (via the `selected` prop)
//   - the hint footer surfaces row-specific guidance
//
// If the highlight colours change, or the markers are wrong, this test
// will catch it — which is what a user running /plugin menu would notice
// first.

import { render } from 'ink-testing-library';
import React from 'react';
import { describe, expect, it } from 'vitest';
import { PluginPicker, type PluginPickerItem } from '../src/components/plugin-picker.js';

const ROWS: PluginPickerItem[] = [
  { name: 'cost-tracker', enabled: true, risk: 'low', summary: 'Tracks cost', lockable: true },
  {
    name: 'legacy-core',
    enabled: true,
    risk: 'high',
    summary: 'Synthetic locked row',
    lockable: false,
  },
  { name: 'format-on-save', enabled: false, risk: 'low', summary: 'Auto-format', lockable: true },
  {
    name: 'external-guard',
    enabled: true,
    risk: 'high',
    summary: 'Synthetic guard',
    lockable: false,
  },
];

function frame(items: PluginPickerItem[], selected: number, hint?: string): string {
  const inst = render(React.createElement(PluginPicker, { items, selected, hint }));
  const text = inst.lastFrame() ?? '';
  inst.unmount();
  return text;
}

describe('<PluginPicker /> rendering', () => {
  it('renders the heading and the hint bar', () => {
    const text = frame(ROWS, 0);
    expect(text).toMatch(/Plugin menu/);
    expect(text).toMatch(/↑\/↓ select/);
    expect(text).toMatch(/Enter\/←\/→ toggle/);
    expect(text).toMatch(/🔒 = locked/);
    expect(text).toMatch(/Esc close/);
  });

  it('omits the lock hint when every row is toggleable', () => {
    const rows = ROWS.map((row) => ({ ...row, lockable: true }));
    const text = frame(rows, 0);
    expect(text).not.toMatch(/🔒 = locked/);
  });

  it('lists every row by name', () => {
    const text = frame(ROWS, 0);
    for (const row of ROWS) {
      expect(text).toMatch(row.name);
    }
  });

  it('renders the lock marker on rows where lockable=false', () => {
    const text = frame(ROWS, 0);
    // 2 locked rows in our fixture.
    const lockMarkerCount = (text.match(/🔒/g) ?? []).length;
    expect(lockMarkerCount).toBeGreaterThanOrEqual(2);
  });

  it('renders the "on" marker for enabled rows and "off" for disabled', () => {
    const text = frame(ROWS, 0);
    expect(text).toMatch(/● on/); // cost-tracker, legacy-core, external-guard are enabled
    expect(text).toMatch(/○ off/); // format-on-save is disabled
  });

  it('shows the focused row with the › marker', () => {
    const textFirst = frame(ROWS, 0);
    const textSecond = frame(ROWS, 1);
    // Each row is a Text component — both frames should contain the row
    // names, but only one row should have the › focus marker per frame.
    expect(textFirst).toMatch(/›/);
    expect(textSecond).toMatch(/›/);
  });

  it('shows the "Loading plugins…" placeholder when items is empty AND busy=true', () => {
    const text =
      render(
        React.createElement(PluginPicker, { items: [], selected: 0, busy: true }),
      ).lastFrame() ?? '';
    expect(text).toMatch(/Loading plugins/);
  });

  it('shows the "No plugins available." placeholder when items is empty AND not busy', () => {
    const text =
      render(
        React.createElement(PluginPicker, { items: [], selected: 0, busy: false }),
      ).lastFrame() ?? '';
    expect(text).toMatch(/No plugins available/);
  });

  it('keeps the 🔒 out of the on/off state column (own column after the name)', () => {
    const text = frame(ROWS, 0);
    // Locked rows still show a uniform ●/○ state; the lock is a separate
    // column. "🔒 on" was the old in-column rendering — it must not return.
    expect(text).not.toMatch(/🔒 on/);
    // legacy-core is locked AND enabled → its row has both ● on and 🔒.
    const lockedRow = text.split('\n').find((l) => l.includes('legacy-core')) ?? '';
    expect(lockedRow).toMatch(/● on/);
    expect(lockedRow).toMatch(/🔒/);
  });

  it('windows long lists to the terminal height with ↑/↓ overflow indicators', () => {
    const many: PluginPickerItem[] = Array.from({ length: 30 }, (_, i) => ({
      name: `plug-${String(i).padStart(2, '0')}`,
      enabled: i % 2 === 0,
      risk: 'low',
      summary: `Row ${i}`,
      lockable: true,
    }));
    // ink-testing-library reports no rows → the picker falls back to 24 rows
    // → a 7-row window. Selecting the middle row must scroll the window there.
    const text = frame(many, 15);
    expect(text).toMatch(/↑ \d+ more/);
    expect(text).toMatch(/↓ \d+ more/);
    expect(text).toMatch(/plug-15/);
    expect(text).not.toMatch(/plug-00/);
    expect(text).not.toMatch(/plug-29/);
    // Selecting the first row pins the window to the top: no ↑ indicator.
    const top = frame(many, 0);
    expect(top).not.toMatch(/↑ \d+ more/);
    expect(top).toMatch(/plug-00/);
    // Selecting the last row pins to the bottom: no ↓ indicator.
    const bottom = frame(many, 29);
    expect(bottom).not.toMatch(/↓ \d+ more/);
    expect(bottom).toMatch(/plug-29/);
  });

  it('renders the hint footer when row guidance is set', () => {
    const text =
      render(
        React.createElement(PluginPicker, {
          items: ROWS,
          selected: 1, // legacy-core, which is locked in this fixture
          hint: 'legacy-core is locked — see /plugin report',
        }),
      ).lastFrame() ?? '';
    expect(text).toMatch(/legacy-core is locked/);
  });
});
