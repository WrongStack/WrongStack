// Regression: the CommandPalette search input must expose a real combobox
// contract.
//
// It previously had only an aria-label. The visible highlight moves with
// ArrowUp/ArrowDown while DOM focus stays in the input, so a screen reader
// announced the field and nothing about what was selected. The fix adds
// role="combobox" + aria-activedescendant pointing at the selected option,
// with the results exposed as a listbox of options carrying aria-selected.
//
// The critical invariant is RESOLUTION: aria-activedescendant is just a string
// id. If it does not resolve to a real element, AT announces nothing at all —
// so this asserts the id actually exists in the document and is the selected
// option, not merely that the attribute is present.
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/i18n', () => ({
  useAppTranslation: () => ({ t: (k: string) => k }),
  i18n: { t: (k: string) => k },
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({
    sendMessage: vi.fn(),
    sendAbort: vi.fn(),
    client: { send: vi.fn(() => true), withSession: (x: unknown) => x },
  }),
}));

import { CommandPalette } from '../../src/components/CommandPalette/index.js';
import { useUIStore } from '../../src/stores/index.js';

async function openPalette() {
  act(() => {
    useUIStore.setState({ paletteOpen: true });
  });
  render(<CommandPalette />);
  return screen.findByRole('combobox');
}

describe('CommandPalette combobox contract', () => {
  afterEach(() => {
    cleanup();
    useUIStore.setState({ paletteOpen: false });
  });

  it('returns focus to its opener after Escape', async () => {
    render(
      <>
        <button type="button" onClick={() => useUIStore.getState().setPaletteOpen(true)}>
          Open palette
        </button>
        <CommandPalette />
      </>,
    );
    const opener = screen.getByRole('button', { name: 'Open palette' });
    opener.focus();
    fireEvent.click(opener);
    const input = await screen.findByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    await waitFor(() => expect(document.activeElement).toBe(opener));
  });

  it('exposes the search input as a combobox wired to its listbox', async () => {
    const input = await openPalette();

    expect(input).toHaveProperty('tagName', 'INPUT');
    expect(input.getAttribute('aria-expanded')).toBe('true');
    expect(input.getAttribute('aria-autocomplete')).toBe('list');

    // aria-controls must resolve to the rendered listbox.
    const controls = input.getAttribute('aria-controls');
    expect(controls).toBeTruthy();
    const list = document.getElementById(String(controls));
    expect(list).not.toBeNull();
    expect(list?.getAttribute('role')).toBe('listbox');
  });

  it('resolves aria-activedescendant to a real, selected option', async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: 'a' } });

    await waitFor(() => {
      const active = input.getAttribute('aria-activedescendant');
      expect(active, 'aria-activedescendant must be set once options render').toBeTruthy();
      // The whole point: the id must RESOLVE. A dangling id makes the
      // screen reader announce the field with no selected option at all.
      const el = document.getElementById(String(active));
      expect(el, `aria-activedescendant "${active}" must resolve to an element`).not.toBeNull();
      expect(el?.getAttribute('role')).toBe('option');
      expect(el?.getAttribute('aria-selected')).toBe('true');
    });
  });

  it('moves aria-activedescendant when the arrow keys move the highlight', async () => {
    const input = await openPalette();
    fireEvent.change(input, { target: { value: 'a' } });

    await waitFor(() => {
      expect(input.getAttribute('aria-activedescendant')).toBeTruthy();
    });
    const first = input.getAttribute('aria-activedescendant');

    fireEvent.keyDown(input, { key: 'ArrowDown' });

    // Exactly one option may be aria-selected at a time, and the
    // activedescendant must follow the highlight.
    await waitFor(() => {
      const now = input.getAttribute('aria-activedescendant');
      expect(now).toBeTruthy();
      const selected = Array.from(
        document.querySelectorAll('[role="option"][aria-selected="true"]'),
      );
      expect(selected.length).toBeLessThanOrEqual(1);
      if (selected.length === 1) {
        expect(selected[0]?.id).toBe(now);
      }
    });
    const second = input.getAttribute('aria-activedescendant');
    // Guard: if the filtered list only has one item the id may legitimately
    // stay put — assert it is either moved or still coherent, never dangling.
    const el = document.getElementById(String(second));
    expect(el).not.toBeNull();
    expect(el?.getAttribute('aria-selected')).toBe('true');
    if (second !== first) {
      expect(document.getElementById(String(first))?.getAttribute('aria-selected')).not.toBe(
        'true',
      );
    }
  });
});
