import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
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

  it('keeps destructive prompts visible when YOLO turns on', async () => {
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

    await Promise.resolve();
    expect(sendConfirm).not.toHaveBeenCalled();
    expect(useUIStore.getState().showConfirmDialog).toBe(true);
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

  it('keeps long arguments inside viewport-bounded scroll regions and shows the Brain deadline', () => {
    render(<ConfirmDialog />);

    act(() => {
      useUIStore.getState().showConfirm({
        id: 'confirm-layout',
        toolName: 'exec',
        input: { command: 'node', args: Array.from({ length: 200 }, (_, i) => `arg-${i}`) },
        suggestedPattern: 'node *',
        riskTier: 'destructive',
        deadlineAt: Date.now() + 120_000,
      });
    });

    expect(screen.getByRole('dialog').className).toContain('max-h-[calc(100dvh-1rem)]');
    expect(screen.getByRole('dialog').className).toContain('!p-0');
    expect(screen.getByTestId('confirm-scroll-region').className).toContain('overflow-y-auto');
    expect(screen.getByTestId('confirm-args-preview').className).toContain('overflow-auto');
    expect(screen.getByText(/Brain takes over in/)).toBeTruthy();
  });
});
