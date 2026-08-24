import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { handlers, send, retryProviderModel, clearProviderStatus, wsClient } = vi.hoisted(() => {
  const handlers = new Map<string, (message: unknown) => void>();
  // One stable client instance for the whole module: the component's
  // subscription effect keys on [client], so a per-render client object would
  // tear the effect down on every state change.
  const send = vi.fn();
  const retryProviderModel = vi.fn();
  const clearProviderStatus = vi.fn();
  const wsClient = {
    send,
    retryProviderModel,
    clearProviderStatus,
    on: (type: string, handler: (message: unknown) => void) => {
      handlers.set(type, handler);
      return () => handlers.delete(type);
    },
  };
  return { handlers, send, retryProviderModel, clearProviderStatus, wsClient };
});

// Faithful to the real hook: useWebSocket() returns an action bag exposing the
// client under `.client` — it is NOT the client itself (useWebSocket.ts
// return literal). ProviderHealthSection must use `ws.client`; the previous
// code cast the bag itself and crashed the Settings Connection tab with
// "TypeError: client.on is not a function" on mount.
vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ client: wsClient, updatePrefs: vi.fn() }),
}));

import { ProviderHealthSection } from '@/components/SettingsPanel/ProviderHealthSection';
import { useProviderStatusStore } from '@/stores/provider-status-store';

afterEach(() => {
  cleanup();
  handlers.clear();
  send.mockReset();
  retryProviderModel.mockReset();
  clearProviderStatus.mockReset();
  act(() => {
    useProviderStatusStore.getState().clear();
  });
});

describe('ProviderHealthSection', () => {
  it('mounts without crashing and subscribes on the inner WS client', () => {
    render(<ProviderHealthSection />);
    // Regression: the old cast of the useWebSocket() action bag threw
    // "client.on is not a function" inside the mount effect, before any of
    // these subscriptions were registered.
    expect(handlers.has('provider.status_changed')).toBe(true);
    expect(handlers.has('provider.status.snapshot')).toBe(true);
    expect(handlers.has('provider.status.result')).toBe(true);
    // Initial snapshot request goes through the inner client's send().
    expect(send).toHaveBeenCalledWith({ type: 'provider.status.get' });
  });

  it('renders a blocked entry pushed via provider.status_changed', () => {
    render(<ProviderHealthSection />);
    act(() => {
      handlers.get('provider.status_changed')?.({
        providerId: 'anthropic',
        model: 'claude-test',
        state: 'blocked',
        lastErrorStatus: 429,
        totalFailures: 3,
      });
    });
    expect(screen.getByText('anthropic')).toBeTruthy();
    expect(screen.getByText('claude-test')).toBeTruthy();
  });

  it('hydrates entries from a provider.status.snapshot push', () => {
    render(<ProviderHealthSection />);
    act(() => {
      handlers.get('provider.status.snapshot')?.({
        entries: [
          {
            providerId: 'openai',
            model: 'gpt-test',
            state: 'degraded',
            reason: '',
            updatedAt: Date.now(),
          },
        ],
      });
    });
    expect(screen.getByText('openai')).toBeTruthy();
    expect(screen.getByText('gpt-test')).toBeTruthy();
  });

  it('routes retry/clear buttons through the inner client domain methods', () => {
    render(<ProviderHealthSection />);
    act(() => {
      handlers.get('provider.status_changed')?.({
        providerId: 'anthropic',
        model: 'claude-test',
        state: 'blocked',
      });
    });
    // Expand the model row (click bubbles to the row header button).
    fireEvent.click(screen.getByText('claude-test'));
    // Without an i18next instance, t() returns the key itself.
    fireEvent.click(screen.getByText('connection.providerHealth.retryNow'));
    expect(retryProviderModel).toHaveBeenCalledWith('anthropic', 'claude-test');
    fireEvent.click(screen.getByText('connection.providerHealth.clear'));
    expect(clearProviderStatus).toHaveBeenCalledWith('anthropic', 'claude-test');
  });
});
