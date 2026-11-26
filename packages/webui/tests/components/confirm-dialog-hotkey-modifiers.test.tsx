import { act, fireEvent, render } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendConfirm = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ sendConfirm, updatePrefs: vi.fn() }),
}));

import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { i18n } from '../../src/i18n';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useUIStore } from '../../src/stores/ui-store';

/**
 * The approval hotkeys are bare letters, as in the TUI prompt, which drops
 * every ctrl/meta chord before reading the key. A browser chord such as
 * Ctrl/Cmd+A (select-all, to copy the command shown) must not approve.
 */
describe('ConfirmDialog hotkeys ignore modifier chords', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    sendConfirm.mockClear();
    act(() => {
      useLocalPrefs.getState().set({ yolo: false });
      useUIStore.getState().hideConfirm();
    });
    render(<ConfirmDialog />);
    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm_chord',
        toolName: 'bash',
        input: { command: 'git push --force' },
        suggestedPattern: 'git push*',
        riskTier: 'standard',
      });
    });
  });

  it.each([
    ['Ctrl+A', { key: 'a', ctrlKey: true }],
    ['Cmd+A', { key: 'a', metaKey: true }],
    ['Ctrl+Y', { key: 'y', ctrlKey: true }],
    ['Cmd+D', { key: 'd', metaKey: true }],
    ['Alt+N', { key: 'n', altKey: true }],
  ])('%s answers nothing', (_label, init) => {
    act(() => {
      fireEvent.keyDown(window, init);
    });
    expect(sendConfirm).not.toHaveBeenCalled();
    expect(useUIStore.getState().showConfirmDialog).toBe(true);
  });

  it('a bare letter still answers', () => {
    act(() => {
      fireEvent.keyDown(window, { key: 'y' });
    });
    expect(sendConfirm).toHaveBeenCalledWith('confirm_chord', 'yes');
  });
});
