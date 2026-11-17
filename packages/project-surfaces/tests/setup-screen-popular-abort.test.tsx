/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mockClient = {
  on: () => () => {},
  send: () => {},
};
const notifyError = vi.fn();
let sourcesList = ['https://example.test/popular1.json'];

vi.mock('../src/setup/feed.js', () => ({
  useSetupHost: () => ({
    useClient: () => mockClient,
    useConnected: () => false,
    useCurrentModel: () => '',
    notify: { success: vi.fn(), error: notifyError },
    chooseModel: async () => ({ success: true }),
    popularSources: () => sourcesList,
  }),
}));

import * as popularMod from '../src/setup/popular-providers.js';
import { SetupScreen } from '../src/setup/SetupScreen.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  notifyError.mockReset();
  sourcesList = ['https://example.test/popular1.json'];
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(async () => {
  vi.restoreAllMocks();
  if (root) {
    await act(async () => {
      root!.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
});

describe('SetupScreen popular providers abort guard', () => {
  it('keeps isLoadingPopular active while a newer request runs and suppresses abort toast errors', async () => {
    let callCount = 0;
    let resolveSecond!: (val: popularMod.PopularProvider[]) => void;

    vi.spyOn(popularMod, 'loadPopularProviders').mockImplementation((_src, signal) => {
      callCount += 1;
      if (callCount === 1) {
        return new Promise((_res, rej) => {
          signal.addEventListener('abort', () => {
            queueMicrotask(() => rej(new DOMException('Aborted', 'AbortError')));
          });
        });
      }
      return new Promise((res) => {
        resolveSecond = res;
      });
    });

    await act(async () => {
      root!.render(<SetupScreen />);
    });

    const refreshBtn = Array.from(container!.querySelectorAll('button')).find(
      (b) =>
        b.textContent?.toLowerCase().includes('refresh') ||
        b.getAttribute('aria-label')?.toLowerCase().includes('refresh') ||
        b.getAttribute('title')?.toLowerCase().includes('refresh'),
    )!;
    expect(refreshBtn.disabled).toBe(true);

    sourcesList = ['https://example.test/popular1.json', 'https://example.test/popular2.json'];
    await act(async () => {
      root!.render(<SetupScreen />);
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(refreshBtn.disabled).toBe(true);
    expect(notifyError).not.toHaveBeenCalled();

    await act(async () => {
      resolveSecond([{ id: 'p-test', name: 'Test Provider', description: 'Test', envVars: [] }]);
    });
    expect(refreshBtn.disabled).toBe(false);
  });
});
