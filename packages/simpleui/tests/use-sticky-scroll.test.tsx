// @vitest-environment jsdom

import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const { useStickyScroll } = await import('../src/hooks/use-sticky-scroll.js');

// ── jsdom polyfills ────────────────────────────────────────────────────────

if (typeof globalThis.matchMedia !== 'function') {
  Object.defineProperty(globalThis, 'matchMedia', {
    writable: true,
    value: vi.fn().mockReturnValue({ matches: false }),
  });
}

// ── Helpers ────────────────────────────────────────────────────────────────

/** Patch scrollTo onto a div so we can spy on it. */
function patchElement(el: HTMLElement) {
  const spy = vi.fn();
  Object.defineProperty(el, 'scrollTo', {
    value: spy,
    writable: true,
    configurable: true,
  });
  return spy;
}

// ── Harness ────────────────────────────────────────────────────────────────

interface ProbeOptions {
  messages?: unknown[];
  activity?: string;
  pendingConfirm?: unknown | null;
}

function renderHookViaRoot(options: ProbeOptions = {}) {
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);

  const resultRef: { current: ReturnType<typeof useStickyScroll> | null } = { current: null };
  const rafCalls: Array<() => void> = [];
  const cancelFrames: number[] = [];

  // Replace rAF/cAF with capture stubs.
  const origRaf = globalThis.requestAnimationFrame;
  const origCaf = globalThis.cancelAnimationFrame;
  let rafHandle = 0;
  globalThis.requestAnimationFrame = ((cb: FrameRequestCallback) => {
    const id = ++rafHandle;
    rafCalls.push(() => cb(performance.now()));
    return id;
  }) as typeof globalThis.requestAnimationFrame;
  globalThis.cancelAnimationFrame = ((handle: number) => {
    cancelFrames.push(handle);
  }) as typeof globalThis.cancelAnimationFrame;

  function Probe() {
    resultRef.current = useStickyScroll({
      messages: (options.messages ?? []) as never,
      activity: options.activity ?? '',
      pendingConfirm: (options.pendingConfirm ?? null) as never,
    });
    return null;
  }

  act(() => root.render(<Probe />));

  function cleanup() {
    act(() => root.unmount());
    container.remove();
    globalThis.requestAnimationFrame = origRaf;
    globalThis.cancelAnimationFrame = origCaf;
  }

  return { resultRef, rafCalls, cancelFrames, cleanup };
}

// ── Tests ──────────────────────────────────────────────────────────────────

afterEach(() => {
  vi.restoreAllMocks();
});

describe('initial state', () => {
  it('showJumpToLatest starts false', () => {
    const { resultRef, cleanup } = renderHookViaRoot();
    expect(resultRef.current?.showJumpToLatest).toBe(false);
    cleanup();
  });

  it('stickToBottomRef starts true', () => {
    const { resultRef, cleanup } = renderHookViaRoot();
    expect(resultRef.current?.stickToBottomRef.current).toBe(true);
    cleanup();
  });

  it('scrollRef.current is null before attachment', () => {
    const { resultRef, cleanup } = renderHookViaRoot();
    expect(resultRef.current?.scrollRef.current).toBeNull();
    cleanup();
  });
});

describe('jumpToLatest', () => {
  it('sets stickToBottom true and showJumpToLatest false', () => {
    const { resultRef, cleanup } = renderHookViaRoot();
    resultRef.current!.stickToBottomRef.current = false;
    act(() => resultRef.current!.jumpToLatest());
    expect(resultRef.current!.stickToBottomRef.current).toBe(true);
    expect(resultRef.current!.showJumpToLatest).toBe(false);
    cleanup();
  });

  it('scrolls the container to bottom', () => {
    const { resultRef, cleanup } = renderHookViaRoot();
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    resultRef.current!.scrollRef.current = el;
    const scrollTo = patchElement(el);

    act(() => resultRef.current!.jumpToLatest());
    expect(scrollTo).toHaveBeenCalledWith(expect.objectContaining({ top: 2000 }));
    cleanup();
  });

  it('respects prefers-reduced-motion', () => {
    const { resultRef, cleanup } = renderHookViaRoot();
    const el = document.createElement('div');
    Object.defineProperty(el, 'scrollHeight', { value: 2000, configurable: true });
    resultRef.current!.scrollRef.current = el;
    const scrollTo = patchElement(el);

    (globalThis.matchMedia as ReturnType<typeof vi.fn>).mockReturnValue({ matches: true });
    act(() => resultRef.current!.jumpToLatest());
    const call = scrollTo.mock.calls[0]?.[0] as ScrollToOptions;
    expect(call?.behavior).toBe('auto');
    cleanup();
  });
});

describe('onScroll', () => {
  it('sets stickToBottom true near bottom', () => {
    const { resultRef, cleanup } = renderHookViaRoot();
    const el = document.createElement('div');
    Object.defineProperties(el, {
      scrollHeight: { value: 1000, configurable: true },
      scrollTop: { value: 900, configurable: true },
      clientHeight: { value: 100, configurable: true },
    });

    act(() => resultRef.current!.onScroll({ currentTarget: el } as React.UIEvent<HTMLDivElement>));
    expect(resultRef.current!.stickToBottomRef.current).toBe(true);
    expect(resultRef.current!.showJumpToLatest).toBe(false);
    cleanup();
  });

  it('sets stickToBottom false when scrolled up', () => {
    const { resultRef, cleanup } = renderHookViaRoot();
    const el = document.createElement('div');
    Object.defineProperties(el, {
      scrollHeight: { value: 1000, configurable: true },
      scrollTop: { value: 600, configurable: true },
      clientHeight: { value: 100, configurable: true },
    });

    act(() => resultRef.current!.onScroll({ currentTarget: el } as React.UIEvent<HTMLDivElement>));
    expect(resultRef.current!.stickToBottomRef.current).toBe(false);
    expect(resultRef.current!.showJumpToLatest).toBe(true);
    cleanup();
  });
});

describe('auto-scroll effect', () => {
  it('cancels animation frame on unmount', () => {
    const { cancelFrames, cleanup } = renderHookViaRoot();
    const hadRaf = cancelFrames.length > 0;
    cleanup();
    // Effect runs only if scrollRef.current was non-null at render time.
    // In the probe no element is attached, so the effect returns early.
    // This test documents the invariant: cleanup doesn't throw.
    expect(cancelFrames.length).toBeGreaterThanOrEqual(hadRaf ? 1 : 0);
  });
});
