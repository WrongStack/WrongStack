import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';

// ── Mocks ────────────────────────────────────────────────────────────────
// We track how many times a handler for a given type is installed so the
// test can assert that a `wsUrl` change re-installs handlers (the bug) vs.
// leaves the socket silently deaf.

const installSpy = vi.hoisted(() => vi.fn());
const connectSpy = vi.hoisted(() => vi.fn(() => Promise.resolve()));
const onStatusSpy = vi.hoisted(() => vi.fn(() => () => {}));
const getPrefsSpy = vi.hoisted(() => vi.fn());

function makeFakeClient() {
  // Each on() records an install; returns an off() that's a no-op here.
  return {
    on: installSpy.mockImplementation(() => () => {}),
    onStatus: onStatusSpy,
    connect: connectSpy,
    getPrefs: getPrefsSpy,
  };
}

vi.mock('@/lib/ws-client', () => ({
  getWSClient: () => makeFakeClient(),
}));

vi.mock('@/lib/favicon', () => ({
  installFaviconVisibilityReset: vi.fn(),
}));

// The real WS_HANDLERS map is large and pulls many store dependencies; for
// this test we only care about *whether* the install loop ran, not what it
// registered. Replace it with a tiny map so installSpy fires a known number
// of times per install.
vi.mock('@/hooks/ws-handlers', async () => {
  return {
    WS_HANDLERS: {
      'session.start': () => {},
      'text_delta': () => {},
      'run.done': () => {},
    },
  };
});

// ── SUT ───────────────────────────────────────────────────────────────────
// Imported AFTER mocks are registered.
import { useWebSocketBootstrap } from '../../src/hooks/useWebSocket';
import { useConfigStore } from '../../src/stores/config-store';

describe('useWebSocketBootstrap — handler re-install on wsUrl change', () => {
  beforeEach(() => {
    installSpy.mockClear();
    connectSpy.mockClear();
    onStatusSpy.mockClear();
    getPrefsSpy.mockClear();
    useConfigStore.getState().setConfig({ wsUrl: 'ws://127.0.0.1:3457' });
    useConfigStore.getState().setConfig({ autoConnect: true });
  });

  it('installs handlers on mount', async () => {
    renderHook(() => useWebSocketBootstrap());
    // 3 handlers in the mocked WS_HANDLERS map → 3 on() calls on mount.
    expect(installSpy).toHaveBeenCalledTimes(3);
  });

  it('re-installs handlers when wsUrl changes (regression: silent stall)', async () => {
    const { rerender } = renderHook(() => useWebSocketBootstrap());

    // Initial mount installed once.
    expect(installSpy).toHaveBeenCalledTimes(3);

    // Simulate the user / config layer changing the WS URL. Before the fix,
    // the `installed` ref was already true, so the effect re-ran (tearing
    // the old handlers down via cleanup) but never re-registered — leaving
    // the socket deaf to every server message until a page reload.
    act(() => {
      useConfigStore.getState().setConfig({ wsUrl: 'ws://127.0.0.1:9999' });
    });

    // Re-render so React flushes the effect with the new deps.
    rerender();

    // After the fix: handlers must be re-installed. We expect another full
    // install cycle (3 more on() calls), i.e. at least 6 total — the exact
    // count also includes the intervening cleanup-driven re-install.
    expect(installSpy.mock.calls.length).toBeGreaterThanOrEqual(6);
  });
});
