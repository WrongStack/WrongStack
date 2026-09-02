// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FallbackPendingInfo, FallbackModal } from '../src/fallback-modal.js';
import type { ServerMessage } from '../src/types.js';

const roots: Root[] = [];

function info(overrides: Partial<FallbackPendingInfo> = {}): FallbackPendingInfo {
  return {
    requestId: 'req-1',
    from: { providerId: 'openai', model: 'gpt-4o' },
    status: 429,
    candidates: [
      { providerId: 'anthropic', model: 'claude-opus-4.8' },
      { providerId: 'moonshot', model: 'kimi-k3' },
    ],
    autoSwitchSeconds: 2,
    ...overrides,
  };
}

function socketHarness() {
  const sent: Array<{ type: string; payload?: Record<string, unknown> }> = [];
  return {
    sent,
    socket: {
      send: (type: string, payload?: Record<string, unknown>) => void sent.push({ type, payload }),
    },
  };
}

beforeEach(() => {
  document.body.replaceChildren();
  vi.useFakeTimers();
});

afterEach(() => {
  for (const root of roots.splice(0)) act(() => root.unmount());
  document.body.replaceChildren();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

function renderModal(options: { info?: FallbackPendingInfo | null; onClose?: () => void } = {}): {
  container: HTMLElement;
  sent: Array<{ type: string; payload?: Record<string, unknown> }>;
  onClose: () => void;
} {
  const { socket, sent } = socketHarness();
  const onClose = options.onClose ?? vi.fn();
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  act(() =>
    root.render(
      <FallbackModal
        info={options.info === undefined ? info() : options.info}
        socketRef={{ current: socket }}
        onClose={onClose}
      />,
    ),
  );
  return { container, sent, onClose };
}

describe('FallbackModal', () => {
  it('renders nothing without pending info', () => {
    const { container } = renderModal({ info: null });
    expect(container.querySelector('.fallback-modal')).toBeNull();
  });

  it('shows the failed model, status and candidates with the countdown', () => {
    const { container } = renderModal();
    const modal = container.querySelector('.fallback-modal');
    expect(modal).not.toBeNull();
    expect(container.textContent).toContain('openai/gpt-4o');
    expect(container.textContent).toContain('429');
    expect(container.textContent).toContain('claude-opus-4.8');
    expect(container.textContent).toContain('kimi-k3');
    expect(container.textContent).toContain('2s');
  });

  it('marks the first candidate as selected', () => {
    const { container } = renderModal();
    const items = container.querySelectorAll('.fallback-modal-item');
    expect(items[0]?.classList.contains('selected')).toBe(true);
    expect(items[1]?.classList.contains('selected')).toBe(false);
  });

  it('sends the picked candidate and closes on click', () => {
    const { container, sent, onClose } = renderModal();
    const items = container.querySelectorAll<HTMLButtonElement>('.fallback-modal-item');
    act(() => items[1]?.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(sent).toEqual([
      {
        type: 'model.fallback_choice',
        payload: { requestId: 'req-1', providerId: 'moonshot', model: 'kimi-k3' },
      },
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('auto-picks the highlighted candidate when the countdown expires', () => {
    const { sent, onClose } = renderModal();
    act(() => {
      vi.advanceTimersByTime(2000);
    });
    expect(sent).toHaveLength(1);
    expect(sent[0]?.payload).toEqual({
      requestId: 'req-1',
      providerId: 'anthropic',
      model: 'claude-opus-4.8',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('Escape sends a null choice (auto fallback)', () => {
    const { sent, onClose } = renderModal();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
    });
    expect(sent).toEqual([
      { type: 'model.fallback_choice', payload: { requestId: 'req-1', autoSwitch: true } },
    ]);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('ArrowDown + Enter selects the next candidate', () => {
    const { sent, onClose } = renderModal();
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown' }));
    });
    act(() => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
    });
    expect(sent[0]?.payload).toEqual({
      requestId: 'req-1',
      providerId: 'moonshot',
      model: 'kimi-k3',
    });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('does not auto-resolve before the countdown has started', () => {
    // Regression guard: with remaining initialized to 0 the mount commit
    // fired the auto-resolve effect immediately and closed the modal.
    const { sent, onClose } = renderModal();
    expect(sent).toEqual([]);
    expect(onClose).not.toHaveBeenCalled();
    expect(document.querySelector('.fallback-modal')).not.toBeNull();
  });
});

describe('projectFallbackPending', async () => {
  const { projectFallbackPending } = await import('../src/fallback-modal.js');
  const frame = (payload: unknown): ServerMessage =>
    ({ type: 'provider.fallback_pending', payload }) as ServerMessage;

  it('projects a valid fallback_pending frame', () => {
    const projected = projectFallbackPending(
      frame({
        requestId: 'r1',
        from: { providerId: 'a', model: 'm' },
        status: 500,
        candidates: [{ providerId: 'b', model: 'n' }],
        autoSwitchSeconds: 5,
      }),
    );
    expect(projected?.requestId).toBe('r1');
    expect(projected?.autoSwitchSeconds).toBe(5);
  });

  it('returns null for malformed payloads', () => {
    expect(projectFallbackPending(frame({}))).toBeNull();
    expect(projectFallbackPending(frame('nope'))).toBeNull();
  });
});
