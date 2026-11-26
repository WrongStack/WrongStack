import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ sendConfirm: vi.fn(), updatePrefs: vi.fn() }),
}));

import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { i18n } from '../../src/i18n';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useUIStore } from '../../src/stores/ui-store';

/**
 * An approval shows where the call writes, as the TUI prompt does (WRITES):
 * `patch` and `format` name their targets inside the input, so the files at
 * stake are not visible from the input preview alone.
 */
describe('ConfirmDialog write targets', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    act(() => {
      useLocalPrefs.getState().set({ yolo: false });
      useUIStore.getState().hideConfirm();
    });
  });
  afterEach(cleanup);

  it('lists the declared write targets, stripped of hidden text', () => {
    render(<ConfirmDialog />);
    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm_writes',
        toolName: 'patch',
        input: { diff: '--- a/src/a.ts\n+++ b/src/a.ts\n' },
        suggestedPattern: 'patch',
        riskTier: 'standard',
        writeTargets: ['src/a.ts', '.github/workflows/re‮lease.yml'],
      });
    });
    const block = screen.getByTestId('confirm-write-targets');
    expect(block.textContent).toContain('Writes to');
    expect(block.textContent).toContain('src/a.ts');
    expect(block.textContent).toContain('.github/workflows/release.yml');
    expect(block.textContent).not.toMatch(/‮/);
  });

  it('shows no block when the tool declares no targets', () => {
    render(<ConfirmDialog />);
    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm_plain',
        toolName: 'bash',
        input: { command: 'ls' },
        suggestedPattern: 'ls',
        riskTier: 'standard',
      });
    });
    expect(screen.queryByTestId('confirm-write-targets')).toBeNull();
  });
});
