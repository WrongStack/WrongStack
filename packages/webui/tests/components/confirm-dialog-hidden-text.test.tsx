import { act, cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ sendConfirm: vi.fn(), updatePrefs: vi.fn() }),
}));

import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { i18n } from '../../src/i18n';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useUIStore } from '../../src/stores/ui-store';

/**
 * Bidi overrides reorder the command a user is approving (Trojan Source) and
 * Tag characters carry text nobody sees. The TUI dialog drops both; the WebUI
 * printed them raw in the command, args, JSON, diff and trust-pattern views.
 */
const HIDDEN = /[\p{Bidi_Control}\p{Default_Ignorable_Code_Point}]/u;
const TAG = String.fromCodePoint(0xe0041);

function shown(toolName: string, input: Record<string, unknown>, suggestedPattern = ''): string {
  render(<ConfirmDialog />);
  act(() => {
    useUIStore.getState().showConfirm({
      id: 'c1',
      toolName,
      input,
      suggestedPattern,
      riskTier: 'standard',
    } as never);
  });
  return document.body.textContent ?? '';
}

describe('ConfirmDialog hidden text', () => {
  beforeEach(async () => {
    await i18n.changeLanguage('en');
    act(() => {
      useLocalPrefs.getState().set({ yolo: false });
      useUIStore.getState().hideConfirm();
    });
  });
  afterEach(() => {
    act(() => useUIStore.getState().hideConfirm());
    cleanup();
  });

  it('drops bidi overrides and invisible text from a command and its trust pattern', () => {
    const text = shown('bash', { command: `cat notes‮txt.hs${TAG}` }, 'bash:cat notes‮*');
    expect(text).toContain('cat notestxt.hs');
    expect(text).not.toMatch(HIDDEN);
  });

  it('drops them from args, JSON and edit diffs too', () => {
    expect(shown('exec', { command: 'node', args: ['-e', `x⁦y${TAG}`] })).not.toMatch(HIDDEN);
    expect(shown('custom', { note: `a‮b​` })).not.toMatch(HIDDEN);
    const edit = shown('edit', { path: 'a.ts', old_string: 'x = 1', new_string: `x = 2 ‮${TAG}` });
    expect(edit).toContain('x = 2');
    expect(edit).not.toMatch(HIDDEN);
  });
});
