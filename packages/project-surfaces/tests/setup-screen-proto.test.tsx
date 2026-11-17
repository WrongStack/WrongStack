/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const sent: unknown[] = [];
const mockClient = {
  on: () => () => {},
  send: (msg: unknown) => {
    sent.push(msg);
  },
};

vi.mock('../src/setup/feed.js', () => ({
  useSetupHost: () => ({
    useClient: () => mockClient,
    useConnected: () => true,
    useCurrentModel: () => '',
    notify: { success: () => {}, error: () => {} },
    chooseModel: async () => ({ success: true }),
    popularSources: () => [],
  }),
}));

vi.mock('../src/setup/CustomProviderSection.js', () => ({
  CustomProviderSection: ({ onKeySaved }: { onKeySaved: (id: string) => void }) => (
    <div>
      <button type="button" data-testid="pick-openai" onClick={() => onKeySaved('openai')}>
        openai
      </button>
      <button
        type="button"
        data-testid="pick-constructor"
        onClick={() => onKeySaved('constructor')}
      >
        constructor
      </button>
    </div>
  ),
}));

const { SetupScreen } = await import('../src/setup/SetupScreen.js');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  sent.length = 0;
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

describe('SetupScreen catalogModels own-property lookup', () => {
  it('does not treat Object.prototype keys such as constructor as cached model arrays', async () => {
    await act(async () => {
      root!.render(<SetupScreen />);
    });

    const ctorBtn = container!.querySelector(
      '[data-testid="pick-constructor"]',
    ) as HTMLButtonElement;
    await act(async () => {
      ctorBtn.click();
    });

    expect(
      sent.some(
        (m) =>
          typeof m === 'object' &&
          m !== null &&
          (m as { type?: string; payload?: { providerId?: string } }).type === 'provider.models' &&
          (m as { payload?: { providerId?: string } }).payload?.providerId === 'constructor',
      ),
    ).toBe(true);
  });
});
