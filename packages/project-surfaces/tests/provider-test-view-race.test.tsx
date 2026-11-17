/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const listeners = new Map<string, Set<(msg: { type: string; payload: unknown }) => void>>();

const mockClient = {
  on: (event: string, fn: (msg: { type: string; payload: unknown }) => void) => {
    let set = listeners.get(event);
    if (!set) {
      set = new Set();
      listeners.set(event, set);
    }
    set.add(fn);
    return () => {
      set?.delete(fn);
    };
  },
  send: (msg: { type: string; payload?: Record<string, unknown> }) => {
    if (msg.type === 'provider.test.run' && msg.payload?.requestId) {
      const reqId = msg.payload.requestId as string;
      const modelIds = (msg.payload.modelIds as string[]) ?? ['gpt-4o'];
      for (const fn of listeners.get('provider.test.result') ?? []) {
        fn({
          type: 'provider.test.result',
          payload: {
            requestId: reqId,
            modelId: modelIds[0],
            status: 'ok',
            latencyMs: 12,
          },
        });
      }
      for (const fn of listeners.get('provider.test.complete') ?? []) {
        fn({
          type: 'provider.test.complete',
          payload: { requestId: reqId },
        });
      }
    }
  },
};

vi.mock('../src/providers/feed.js', () => ({
  useProviderHost: () => ({
    useClient: () => mockClient,
    useActiveModel: () => ({ provider: 'openai', model: 'gpt-4o' }),
    useModelPrefs: () => ({ disabledProviders: [], disabledModels: [], favoriteModels: [] }),
    setModelPrefs: () => {},
  }),
}));

const { ProviderTestView } = await import('../src/providers/ProviderTestView.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  listeners.clear();
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

describe('ProviderTestView requestId ref synchronization', () => {
  it('processes immediate provider.test.result and provider.test.complete frames', async () => {
    await act(async () => {
      root!.render(<ProviderTestView />);
    });

    await act(async () => {
      for (const fn of listeners.get('providers.saved') ?? []) {
        fn({
          type: 'providers.saved',
          payload: {
            providers: [{ id: 'openai', name: 'OpenAI', apiKeys: [{ id: 'k1', isActive: true }] }],
          },
        });
      }
    });

    const providerBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('openai'),
    );
    await act(async () => {
      providerBtn!.click();
    });
    const nextBtn = Array.from(container!.querySelectorAll('button')).at(-1);
    await act(async () => {
      nextBtn!.click();
    });

    await act(async () => {
      for (const fn of listeners.get('provider.models') ?? []) {
        fn({
          type: 'provider.models',
          payload: { provider: 'openai', models: [{ id: 'gpt-4o', name: 'GPT-4o' }] },
        });
      }
    });

    const runBtn = Array.from(container!.querySelectorAll('button')).find(
      (b) =>
        b.textContent?.includes('activity:providerTest.testModels') ||
        b.textContent?.toLowerCase().includes('testmodels'),
    );
    await act(async () => {
      runBtn!.click();
    });

    const stillRunning = Array.from(container!.querySelectorAll('button')).some(
      (b) =>
        b.textContent?.includes('activity:providerTest.stop') ||
        b.textContent?.toLowerCase().includes('stop'),
    );
    expect(stillRunning).toBe(false);
    expect(container!.textContent).toContain('gpt-4o');
  });
});
