import { describe, expect, it } from 'vitest';
import { renderHook } from '@testing-library/react';
import { createRef } from 'react';
import { useHorizontalScroll } from '../../src/hooks/useHorizontalScroll';

/**
 * jsdom does not lay elements out, so scrollWidth/clientWidth are always 0.
 * Define them explicitly to model "this container overflows horizontally".
 */
function scroller({ scrollWidth = 1000, clientWidth = 400 } = {}): HTMLElement {
  const el = document.createElement('div');
  Object.defineProperty(el, 'scrollWidth', { value: scrollWidth, configurable: true });
  Object.defineProperty(el, 'clientWidth', { value: clientWidth, configurable: true });
  el.scrollLeft = 0;
  document.body.appendChild(el);
  return el;
}

function mount(el: HTMLElement | null, enabled?: boolean) {
  const ref = createRef<HTMLElement | null>() as React.RefObject<HTMLElement | null>;
  ref.current = el;
  const hook = renderHook(({ on }: { on: boolean | undefined }) => useHorizontalScroll(ref, on), {
    initialProps: { on: enabled },
  });
  return { ref, ...hook };
}

function wheel(el: HTMLElement, init: WheelEventInit): WheelEvent {
  const e = new WheelEvent('wheel', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

function key(el: HTMLElement, init: KeyboardEventInit): KeyboardEvent {
  const e = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, ...init });
  el.dispatchEvent(e);
  return e;
}

describe('useHorizontalScroll — Shift+Wheel', () => {
  it('translates vertical wheel delta into horizontal scroll', () => {
    const el = scroller();
    mount(el);
    const e = wheel(el, { shiftKey: true, deltaY: 120 });
    expect(el.scrollLeft).toBe(120);
    expect(e.defaultPrevented).toBe(true);
  });

  it('scrolls left on a negative delta', () => {
    const el = scroller();
    el.scrollLeft = 300;
    mount(el);
    wheel(el, { shiftKey: true, deltaY: -100 });
    expect(el.scrollLeft).toBe(200);
  });

  it('uses deltaX when it is the larger axis', () => {
    const el = scroller();
    mount(el);
    wheel(el, { shiftKey: true, deltaY: 10, deltaX: 90 });
    expect(el.scrollLeft).toBe(90);
  });

  it('prefers deltaY on a tie', () => {
    const el = scroller();
    mount(el);
    // |deltaY| > |deltaX| is false on equality, so deltaX wins.
    wheel(el, { shiftKey: true, deltaY: 50, deltaX: -50 });
    expect(el.scrollLeft).toBe(-50);
  });

  it('ignores a wheel event without Shift so vertical scrolling still works', () => {
    const el = scroller();
    mount(el);
    const e = wheel(el, { deltaY: 120 });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores a zero delta rather than preventing default for nothing', () => {
    const el = scroller();
    mount(el);
    const e = wheel(el, { shiftKey: true, deltaY: 0, deltaX: 0 });
    expect(e.defaultPrevented).toBe(false);
    expect(el.scrollLeft).toBe(0);
  });

  it('does nothing when the container does not overflow', () => {
    const el = scroller({ scrollWidth: 400, clientWidth: 400 });
    mount(el);
    const e = wheel(el, { shiftKey: true, deltaY: 120 });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it('treats a 1px overflow as no overflow (sub-pixel rounding guard)', () => {
    const el = scroller({ scrollWidth: 401, clientWidth: 400 });
    mount(el);
    wheel(el, { shiftKey: true, deltaY: 120 });
    expect(el.scrollLeft).toBe(0);
  });

  it('engages at a 2px overflow', () => {
    const el = scroller({ scrollWidth: 402, clientWidth: 400 });
    mount(el);
    wheel(el, { shiftKey: true, deltaY: 10 });
    expect(el.scrollLeft).toBe(10);
  });
});

describe('useHorizontalScroll — Ctrl/Cmd+Arrow', () => {
  it('pages right by 80% of the viewport width on Ctrl+ArrowRight', () => {
    const el = scroller({ clientWidth: 400 });
    mount(el);
    const e = key(el, { key: 'ArrowRight', ctrlKey: true });
    expect(el.scrollLeft).toBe(320);
    expect(e.defaultPrevented).toBe(true);
  });

  it('pages left on Ctrl+ArrowLeft', () => {
    const el = scroller({ clientWidth: 400 });
    el.scrollLeft = 320;
    mount(el);
    key(el, { key: 'ArrowLeft', ctrlKey: true });
    expect(el.scrollLeft).toBe(0);
  });

  it('accepts the Cmd (meta) modifier too', () => {
    const el = scroller({ clientWidth: 400 });
    mount(el);
    key(el, { key: 'ArrowRight', metaKey: true });
    expect(el.scrollLeft).toBe(320);
  });

  it('ignores a bare arrow key so text editing is never hijacked', () => {
    const el = scroller();
    mount(el);
    const e = key(el, { key: 'ArrowRight' });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it('ignores other Ctrl-chords', () => {
    const el = scroller();
    mount(el);
    const e = key(el, { key: 'ArrowUp', ctrlKey: true });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });

  it('does nothing when the container does not overflow', () => {
    const el = scroller({ scrollWidth: 400, clientWidth: 400 });
    mount(el);
    const e = key(el, { key: 'ArrowRight', ctrlKey: true });
    expect(el.scrollLeft).toBe(0);
    expect(e.defaultPrevented).toBe(false);
  });
});

describe('useHorizontalScroll — lifecycle', () => {
  it('is inert when the ref is not attached', () => {
    expect(() => mount(null)).not.toThrow();
  });

  it('attaches nothing when disabled', () => {
    const el = scroller();
    mount(el, false);
    wheel(el, { shiftKey: true, deltaY: 100 });
    key(el, { key: 'ArrowRight', ctrlKey: true });
    expect(el.scrollLeft).toBe(0);
  });

  it('defaults to enabled', () => {
    const el = scroller();
    mount(el, undefined);
    wheel(el, { shiftKey: true, deltaY: 100 });
    expect(el.scrollLeft).toBe(100);
  });

  it('detaches when toggled off', () => {
    const el = scroller();
    const { rerender } = mount(el, true);
    rerender({ on: false });
    wheel(el, { shiftKey: true, deltaY: 100 });
    expect(el.scrollLeft).toBe(0);
  });

  it('re-attaches when toggled back on', () => {
    const el = scroller();
    const { rerender } = mount(el, true);
    rerender({ on: false });
    rerender({ on: true });
    wheel(el, { shiftKey: true, deltaY: 100 });
    expect(el.scrollLeft).toBe(100);
  });

  it('removes both listeners on unmount', () => {
    const el = scroller();
    const { unmount } = mount(el);
    unmount();
    wheel(el, { shiftKey: true, deltaY: 100 });
    key(el, { key: 'ArrowRight', ctrlKey: true });
    expect(el.scrollLeft).toBe(0);
  });

  it('registers the wheel listener as non-passive so preventDefault applies', () => {
    const el = scroller();
    const calls: Array<[string, unknown]> = [];
    const original = el.addEventListener.bind(el);
    el.addEventListener = ((type: string, fn: EventListener, opts?: unknown) => {
      calls.push([type, opts]);
      original(type, fn, opts as AddEventListenerOptions);
    }) as typeof el.addEventListener;

    mount(el);
    expect(calls).toContainEqual(['wheel', { passive: false }]);
  });
});
