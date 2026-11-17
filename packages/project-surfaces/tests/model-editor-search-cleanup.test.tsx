/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let activeListeners = 0;
let listeners: Array<(msg: unknown) => void> = [];

const mockClient = {
  on: (_event: string, fn: (msg: unknown) => void) => {
    activeListeners++;
    listeners.push(fn);
    return () => {
      activeListeners--;
      listeners = listeners.filter((l) => l !== fn);
    };
  },
  send: () => {},
};

vi.mock('../src/setup/feed.js', () => ({
  useSetupHost: () => ({
    useClient: () => mockClient,
  }),
}));

const { ModelEditor } = await import('../src/setup/ModelEditor.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  vi.useFakeTimers();
  activeListeners = 0;
  listeners = [];
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

describe('ModelEditor search listener cleanup', () => {
  it('detaches search_result listener on reply and on unmount', async () => {
    await act(async () => {
      root!.render(<ModelEditor models={[]} onChange={() => {}} />);
    });
    await act(async () => {
      (container!.querySelector('button') as HTMLButtonElement).click();
    });

    const input = container!.querySelector('input') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;

    await act(async () => {
      setter.call(input, 'gpt');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(activeListeners).toBe(1);

    await act(async () => {
      for (const fn of [...listeners]) {
        fn({ payload: { query: 'gpt', matches: [{ id: 'gpt-5', name: 'GPT-5' }] } });
      }
    });
    expect(activeListeners).toBe(0);

    await act(async () => {
      setter.call(input, 'claude');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(250);
    });
    expect(activeListeners).toBe(1);

    await act(async () => {
      root!.unmount();
    });
    root = null;
    expect(activeListeners).toBe(0);
  });
});
