import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FallbackModal } from '../../src/components/FallbackModal';
import { useFallbackStore } from '../../src/stores/fallback-store';

const { send, resolvePendingFallback } = vi.hoisted(() => ({
  send: vi.fn(),
  resolvePendingFallback: vi.fn(),
}));

vi.mock('../../src/lib/ws-client', () => ({
  getWSClient: () => ({
    send,
    withSession: (payload: Record<string, unknown>) => payload,
  }),
}));

vi.mock('../../src/stores/chat-lanes', () => ({ resolvePendingFallback }));

const pending = {
  requestId: 'fallback-1',
  from: { providerId: 'provider-a', model: 'broken-model' },
  status: 429,
  candidates: [{ providerId: 'provider-b', model: 'fallback-model' }],
  autoSwitchSeconds: 30,
  timestamp: 0,
};

describe('FallbackModal', () => {
  beforeEach(() => {
    useFallbackStore.getState().clear();
    send.mockClear();
    resolvePendingFallback.mockClear();
  });

  afterEach(cleanup);

  it('traps focus and returns it to the invoking control after Escape chooses auto-switch', async () => {
    const trigger = document.createElement('button');
    trigger.textContent = 'Change model';
    document.body.appendChild(trigger);
    trigger.focus();
    useFallbackStore.getState().setPending(pending);

    render(<FallbackModal />);
    await act(async () => {});

    const dialog = screen.getByRole('dialog');
    expect(dialog.contains(document.activeElement)).toBe(true);

    fireEvent.keyDown(dialog, { key: 'Escape' });
    await act(async () => {});

    expect(send).toHaveBeenCalledWith({
      type: 'model.fallback_choice',
      payload: { requestId: 'fallback-1', autoSwitch: true },
    });
    expect(resolvePendingFallback).toHaveBeenCalledWith('fallback-1');
    expect(document.activeElement).toBe(trigger);
  });
});
