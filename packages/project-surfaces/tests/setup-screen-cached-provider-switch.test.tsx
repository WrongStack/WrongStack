/**
 * @vitest-environment jsdom
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

type Handler = (msg: { type: string; payload: unknown }) => void;

const handlers = new Map<string, Set<Handler>>();
const sent: unknown[] = [];
const chooseModel = vi.fn(async () => ({ success: true }));

const mockClient = {
  on: (type: string, fn: Handler) => {
    const set = handlers.get(type) ?? new Set<Handler>();
    set.add(fn);
    handlers.set(type, set);
    return () => set.delete(fn);
  },
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
    chooseModel,
    popularSources: () => [],
  }),
}));

vi.mock('../src/setup/CustomProviderSection.js', () => ({
  CustomProviderSection: ({ onKeySaved }: { onKeySaved: (id: string) => void }) => (
    <div>
      <button type="button" data-testid="pick-anthropic" onClick={() => onKeySaved('anthropic')}>
        anthropic
      </button>
      <button type="button" data-testid="pick-openai" onClick={() => onKeySaved('openai')}>
        openai
      </button>
    </div>
  ),
}));

const { SetupScreen } = await import('../src/setup/SetupScreen.js');

async function emit(type: string, payload: unknown) {
  await act(async () => {
    for (const fn of handlers.get(type) ?? []) {
      fn({ type, payload });
    }
  });
}

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  sent.length = 0;
  handlers.clear();
  chooseModel.mockClear();
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

describe('SetupScreen cached provider switch while another model list is in flight', () => {
  it('clears isLoadingModels and selects single cached model when switching back to a cached provider', async () => {
    await act(async () => {
      root!.render(<SetupScreen />);
    });
    await emit('provider.catalog', {
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          family: 'anthropic',
          envVars: [],
          modelCount: 1,
          hasApiKey: false,
        },
        {
          id: 'openai',
          name: 'OpenAI',
          family: 'openai',
          envVars: [],
          modelCount: 1,
          hasApiKey: false,
        },
      ],
    });

    const pickAnthropic = container!.querySelector(
      '[data-testid="pick-anthropic"]',
    ) as HTMLButtonElement;
    const pickOpenAi = container!.querySelector('[data-testid="pick-openai"]') as HTMLButtonElement;

    // 1. Load and cache Anthropic models
    await act(async () => {
      pickAnthropic.click();
    });
    await emit('provider.models', {
      provider: 'anthropic',
      models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', capabilities: [] }],
    });
    expect(container!.textContent).toContain('Claude Sonnet 4.5');

    // 2. Switch to uncached OpenAI (leaves provider.models in flight -> isLoadingModels = true)
    await act(async () => {
      pickOpenAi.click();
    });

    // 3. Switch back to already-cached Anthropic before OpenAI replies, then deliver OpenAI's late frame
    await act(async () => {
      pickAnthropic.click();
    });
    await emit('provider.catalog', {
      providers: [
        {
          id: 'anthropic',
          name: 'Anthropic',
          family: 'anthropic',
          envVars: [],
          modelCount: 1,
          hasApiKey: false,
        },
        {
          id: 'openai',
          name: 'OpenAI',
          family: 'openai',
          envVars: [],
          modelCount: 1,
          hasApiKey: false,
        },
      ],
    });
    await emit('provider.models', {
      provider: 'openai',
      models: [{ id: 'gpt-5', name: 'GPT-5', capabilities: [] }],
    });

    expect(container!.querySelector('.animate-spin')).toBeNull();
    expect(container!.textContent).toContain('Claude Sonnet 4.5');

    const startBtn = Array.from(container!.querySelectorAll('button')).find((b) =>
      b.textContent?.includes('screen.start.startSession'),
    ) as HTMLButtonElement;
    expect(startBtn).toBeDefined();
    await act(async () => {
      startBtn.click();
    });
    expect(chooseModel).toHaveBeenCalledWith('anthropic', 'claude-sonnet-4-5', true);
  });
});
