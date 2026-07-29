import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderHook } from '@testing-library/react';

const showPanel = vi.fn();
vi.mock('@/components/activity-bar/nav', () => ({ showPanel }));

const { useUIStore, useSessionStore, useChatStore, useConfigStore } = await import(
  '../../src/stores'
);
const { useF5Resilience } = await import('../../src/hooks/useF5Resilience');

/** Point window.location.pathname at `path` for one test. */
function setPath(path: string) {
  Object.defineProperty(window, 'location', {
    value: { ...window.location, pathname: path },
    writable: true,
    configurable: true,
  });
}

type PersistApi = { flush?: () => void };

const PERSISTED_STORES = [useSessionStore, useChatStore, useUIStore, useConfigStore];

/** Attach a fake `flush()` to each persist API and return the spies. */
function withFlush(impl: () => void = () => undefined) {
  return PERSISTED_STORES.map((s) => {
    const spy = vi.fn(impl);
    (s.persist as unknown as PersistApi).flush = spy;
    return spy;
  });
}

function removeFlush() {
  for (const s of PERSISTED_STORES) {
    delete (s.persist as unknown as PersistApi).flush;
  }
}

describe('useF5Resilience — persist flush', () => {
  beforeEach(() => {
    showPanel.mockReset();
    setPath('/');
    useUIStore.setState({ currentView: 'chat' } as never);
    removeFlush();
  });

  afterEach(() => {
    removeFlush();
    vi.restoreAllMocks();
  });

  it('skips stores whose persist API has no flush() — the zustand 5 shape', () => {
    // zustand 5's persist API exposes setOptions/clearStorage/rehydrate/
    // hasHydrated/getOptions but NOT flush, so with the shipped middleware
    // this loop is a no-op. The `typeof === 'function'` guard is what keeps
    // that from throwing on every page teardown.
    expect((useUIStore.persist as unknown as PersistApi).flush).toBeUndefined();
    renderHook(() => useF5Resilience());
    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
  });

  it('flushes every persisted store on pagehide when flush() is available', () => {
    const spies = withFlush();
    renderHook(() => useF5Resilience());
    window.dispatchEvent(new Event('pagehide'));
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('flushes on beforeunload as well', () => {
    const spies = withFlush();
    renderHook(() => useF5Resilience());
    window.dispatchEvent(new Event('beforeunload'));
    for (const spy of spies) expect(spy).toHaveBeenCalledTimes(1);
  });

  it('swallows a throwing flush — teardown is best-effort', () => {
    withFlush(() => {
      throw new Error('storage full');
    });
    renderHook(() => useF5Resilience());
    expect(() => window.dispatchEvent(new Event('pagehide'))).not.toThrow();
  });

  it('stops at the first throwing store — the try/catch wraps the whole loop', () => {
    const spies = withFlush();
    spies[0].mockImplementation(() => {
      throw new Error('storage full');
    });
    renderHook(() => useF5Resilience());
    window.dispatchEvent(new Event('pagehide'));
    expect(spies[0]).toHaveBeenCalled();
    expect(spies[3]).not.toHaveBeenCalled();
  });

  it('detaches both listeners on unmount', () => {
    const spies = withFlush();
    const { unmount } = renderHook(() => useF5Resilience());
    unmount();
    window.dispatchEvent(new Event('pagehide'));
    window.dispatchEvent(new Event('beforeunload'));
    for (const spy of spies) expect(spy).not.toHaveBeenCalled();
  });
});

describe('useF5Resilience — view fallback', () => {
  beforeEach(() => {
    showPanel.mockReset();
    setPath('/');
  });

  it.each(['debug', 'analytics', 'design-gallery', 'setup'])(
    'redirects the exotic persisted view %s to chat',
    (view) => {
      useUIStore.setState({ currentView: view } as never);
      renderHook(() => useF5Resilience());
      expect(showPanel).toHaveBeenCalledWith('chat');
    },
  );

  it.each(['chat', 'kanban', 'files', 'terminal'])('leaves the ordinary view %s alone', (view) => {
    useUIStore.setState({ currentView: view } as never);
    renderHook(() => useF5Resilience());
    expect(showPanel).not.toHaveBeenCalled();
  });

  it.each(['/debug', '/analytics', '/refresh-debug'])(
    'does not redirect when the user navigated to %s directly',
    (path) => {
      setPath(path);
      useUIStore.setState({ currentView: 'debug' } as never);
      renderHook(() => useF5Resilience());
      expect(showPanel).not.toHaveBeenCalled();
    },
  );

  it('still redirects from an unrelated path', () => {
    setPath('/some/other/route');
    useUIStore.setState({ currentView: 'analytics' } as never);
    renderHook(() => useF5Resilience());
    expect(showPanel).toHaveBeenCalledWith('chat');
  });

  it('only evaluates the fallback once per mount', () => {
    useUIStore.setState({ currentView: 'debug' } as never);
    const { rerender } = renderHook(() => useF5Resilience());
    rerender();
    rerender();
    expect(showPanel).toHaveBeenCalledTimes(1);
  });
});
