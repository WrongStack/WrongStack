/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AcpRuntime } from '../src/components/acp-runtime.js';
import { initialState } from '../src/lib/session.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
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
  vi.useRealTimers();
});

describe('AcpRuntime request cleanup', () => {
  it('cleans up pending subscribe listeners and timeout timers on unmount and model switch', async () => {
    let activeListeners = 0;
    const send = vi.fn(() => true);
    const subscribe = () => {
      activeListeners++;
      return () => {
        activeListeners--;
      };
    };

    const s1 = { ...initialState(), provider: 'acp', model: 'm1' };
    await act(async () => {
      root!.render(<AcpRuntime state={s1} send={send} subscribe={subscribe} />);
    });
    const details = container!.querySelector('details')!;
    await act(async () => {
      details.open = true;
      details.dispatchEvent(new Event('toggle', { bubbles: true }));
    });
    expect(activeListeners).toBe(1);

    await act(async () => {
      root!.unmount();
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    root = null;

    expect(activeListeners).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
  });
});
