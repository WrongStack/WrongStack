/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
const notifyError = vi.fn();
let activeListeners = 0;

vi.mock('../src/setup/feed.js', () => ({
  useSetupHost: () => ({
    useClient: () => ({
      on: () => {
        activeListeners += 1;
        return () => {
          activeListeners -= 1;
        };
      },
      send: (msg: unknown) => sent.push(msg),
    }),
    useConnected: () => true,
    useCurrentModel: () => '',
    notify: { success: vi.fn(), error: notifyError },
    chooseModel: async () => ({ success: true }),
    popularSources: () => [],
  }),
}));

import { ProviderKeyCard } from '../src/setup/ProviderKeyCard.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  sent.length = 0;
  notifyError.mockReset();
  activeListeners = 0;
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

describe('ProviderKeyCard save concurrency and unmount abort', () => {
  it('blocks duplicate rapid saves, aborts cleanly on unmount without toast.error, and removes listener', async () => {
    const popular = {
      id: 'openai',
      name: 'OpenAI',
      family: 'openai',
      description: 'OpenAI API',
      envVars: ['OPENAI_API_KEY'],
    } as never;

    await act(async () => {
      root!.render(
        <ProviderKeyCard
          popular={popular}
          catalogProvider={undefined}
          savedProvider={undefined}
          onKeySaved={() => {}}
        />,
      );
    });

    const input = container!.querySelector('input') as HTMLInputElement;
    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'sk-test-123');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });

    await act(async () => {
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    });
    expect(sent.filter((m) => (m as { type?: string }).type === 'provider.add')).toHaveLength(1);

    await act(async () => {
      root!.unmount();
      root = null;
    });
    await new Promise((r) => setTimeout(r, 15));

    expect(activeListeners).toBe(0);
    expect(notifyError).not.toHaveBeenCalled();
  });
});
