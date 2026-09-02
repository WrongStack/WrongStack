import { act, fireEvent, render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const sendConfirm = vi.hoisted(() => vi.fn());
const updatePrefs = vi.hoisted(() => vi.fn());

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ sendConfirm, updatePrefs }),
}));

import { ConfirmDialog } from '../../src/components/ConfirmDialog';
import { useLocalPrefs } from '../../src/stores/local-prefs';
import { useUIStore } from '../../src/stores/ui-store';

describe('ConfirmDialog YOLO behavior', () => {
  beforeEach(() => {
    sendConfirm.mockClear();
    updatePrefs.mockClear();
    act(() => {
      useLocalPrefs.getState().set({ yolo: false });
      useUIStore.getState().hideConfirm();
    });
  });

  it('auto-approves an already-visible non-destructive prompt when YOLO turns on', async () => {
    render(<ConfirmDialog />);

    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm_1',
        toolName: 'batch_tool_use',
        input: { calls: [{ tool: 'grep', input: { pattern: 'x' } }] },
        suggestedPattern: 'batch_tool_use',
        riskTier: 'standard',
      });
    });

    expect(sendConfirm).not.toHaveBeenCalled();

    act(() => {
      useLocalPrefs.getState().set({ yolo: true });
    });

    await waitFor(() => {
      expect(sendConfirm).toHaveBeenCalledWith('confirm_1', 'yes');
    });
    expect(useUIStore.getState().showConfirmDialog).toBe(false);
  });

  it('auto-approves destructive prompts when YOLO turns on', async () => {
    render(<ConfirmDialog />);

    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm_2',
        toolName: 'bash',
        input: { command: 'rm -rf /' },
        suggestedPattern: 'rm -rf /',
        decisionSource: 'yolo_destructive',
        riskTier: 'destructive',
      });
      useLocalPrefs.getState().set({ yolo: true });
    });

    await waitFor(() => {
      expect(sendConfirm).toHaveBeenCalledWith('confirm_2', 'yes');
    });
    expect(useUIStore.getState().showConfirmDialog).toBe(false);
  });

  it('offers an "Enable YOLO" CTA when yolo is off; clicking it enables YOLO and auto-approves the prompt', async () => {
    const { getByTitle } = render(<ConfirmDialog />);

    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm_3',
        toolName: 'batch_tool_use',
        input: { calls: [{ tool: 'grep', input: { pattern: 'x' } }] },
        suggestedPattern: 'batch_tool_use',
        riskTier: 'standard',
      });
    });

    const cta = getByTitle(
      // WS-008: the copy now says "non-destructive" because that is what YOLO
      // actually does — destructive shell commands still prompt.
      'Enable YOLO mode (auto-approve this and future non-destructive calls)',
    );
    expect(cta).toBeTruthy();

    await act(async () => {
      fireEvent.click(cta);
    });

    // Pref flipped locally and pushed to the server.
    expect(useLocalPrefs.getState().yolo).toBe(true);
    expect(updatePrefs).toHaveBeenCalledWith({ yolo: true });
    // The now-live YOLO effect auto-approves the visible prompt.
    await waitFor(() => {
      expect(sendConfirm).toHaveBeenCalledWith('confirm_3', 'yes');
    });
  });
});
