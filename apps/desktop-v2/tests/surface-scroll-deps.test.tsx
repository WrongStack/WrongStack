/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { useSurfaceScroll } from '../src/surface-scroll.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  (globalThis as unknown as { MutationObserver: unknown }).MutationObserver = class {
    observe() {}
    disconnect() {}
  };
  (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = class {
    observe() {}
    disconnect() {}
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('useSurfaceScroll dependency array', () => {
  it('does not tear down or re-attach listeners on unrelated re-renders, but re-binds when key changes', async () => {
    let addCount = 0;
    let removeCount = 0;
    const wrapped = new WeakSet<HTMLElement>();

    function Box({ scope, itemKey, tick }: { scope: string; itemKey: string; tick: number }) {
      const ref = useSurfaceScroll<HTMLDivElement>(scope, itemKey, true);
      return (
        <div
          ref={(el) => {
            if (el && !wrapped.has(el)) {
              wrapped.add(el);
              const origAdd = el.addEventListener.bind(el);
              const origRemove = el.removeEventListener.bind(el);
              el.addEventListener = ((...args: Parameters<typeof el.addEventListener>) => {
                addCount++;
                return origAdd(...args);
              }) as typeof el.addEventListener;
              el.removeEventListener = ((...args: Parameters<typeof el.removeEventListener>) => {
                removeCount++;
                return origRemove(...args);
              }) as typeof el.removeEventListener;
            }
            ref.current = el;
          }}
        >
          {tick}
        </div>
      );
    }

    await act(async () => {
      root!.render(<Box scope="scope-a" itemKey="key-1" tick={1} />);
    });
    expect(addCount).toBe(4);
    expect(removeCount).toBe(0);

    await act(async () => {
      root!.render(<Box scope="scope-a" itemKey="key-1" tick={2} />);
    });
    expect(addCount).toBe(4);
    expect(removeCount).toBe(0);

    await act(async () => {
      root!.render(<Box scope="scope-a" itemKey="key-2" tick={2} />);
    });
    expect(removeCount).toBe(4);
    expect(addCount).toBe(8);
  });
});
