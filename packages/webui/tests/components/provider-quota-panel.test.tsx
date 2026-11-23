/**
 * The side-panel quota section shows only what the running work draws on —
 * the providers of the open sessions and running subagents, and of a gateway
 * pool only the accounts behind the routed model — and links to the Plan
 * Quota page for the rest. Classification itself is pinned by the page tests
 * (`provider-quota-view.test.tsx`), which share the same model.
 */
import { act, fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

type Message = { type: string; payload?: unknown };
type Handler = (message: Message) => void;

const handlers = new Map<string, Set<Handler>>();
const sends: Message[] = [];
const client = {
  isConnected: true,
  on(type: string, handler: Handler) {
    const registered = handlers.get(type) ?? new Set();
    registered.add(handler);
    handlers.set(type, registered);
    return () => registered.delete(handler);
  },
  send(message: Message) {
    sends.push(message);
  },
};

vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => ({ client }) }));

const { useConfigStore, useFleetStore, useLocalPrefs, useProviderQuotaStore, useUIStore } =
  await import('@/stores');
const { ProviderQuotaPanel } = await import('../../src/components/SidePanel/ProviderQuotaPanel.js');

const sent = (type: string) => sends.filter((m) => m.type === type);
const nowSec = () => Math.floor(Date.now() / 1000);

function savedProviders(providers: Array<Record<string, unknown>>) {
  act(() => {
    for (const handler of handlers.get('providers.saved') ?? []) {
      handler({ type: 'providers.saved', payload: { providers } });
    }
  });
}

const SAVED = [
  { id: 'openai-codex', type: 'openai-codex', family: 'openai-codex' },
  { id: 'minimax-coding-plan', type: 'minimax-coding-plan' },
  {
    id: 'zai-coding-plan',
    type: 'zai-coding-plan',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  },
  { id: 'omniroute', type: 'omniroute', baseUrl: 'http://localhost:20128/v1' },
];

function reading(providerId: string, usedPercent: number) {
  return {
    providerId,
    meterId: 'default',
    windows: [{ id: 'primary', usedPercent, windowMinutes: 300, resetsAt: nowSec() + 3600 }],
    capturedAt: Date.now(),
  };
}

function pool(meterId: string, label: string, usedPercent: number) {
  return {
    providerId: 'omniroute',
    meterId,
    meterLabel: label,
    via: 'omniroute',
    windows: [{ id: 'w', label: 'weekly (7d)', usedPercent, resetsAt: nowSec() + 3600 }],
    capturedAt: Date.now(),
  };
}

function useModel(provider: string, model: string) {
  act(() => {
    useConfigStore.setState({ provider, model });
  });
}

beforeEach(() => {
  handlers.clear();
  sends.length = 0;
  useConfigStore.setState({ wsConnected: true, provider: '', model: '' });
  useProviderQuotaStore.getState().clear();
  useFleetStore.setState({ agents: new Map() });
  useUIStore.setState({ currentView: 'chat' });
  // The empty-state explanation and its refresh button are full chrome;
  // calm chrome drops the whole section until a provider reports quota.
  useLocalPrefs.setState({ chromeLevel: 'full' });
});

describe('ProviderQuotaPanel (side panel)', () => {
  it('renders real ChatGPT app and plan percentages as separate meters', () => {
    useModel('openai-chatgpt', 'gpt-6.1-sol');
    render(<ProviderQuotaPanel />);
    savedProviders([{ id: 'openai-chatgpt', type: 'openai-chatgpt', family: 'openai' }]);
    act(() =>
      useProviderQuotaStore.getState().apply([
        { ...reading('openai-chatgpt', 16), meterId: 'chatgpt-plan', meterLabel: 'Plan limits' },
        { ...reading('openai-chatgpt', 14), meterId: 'chatgpt-app', meterLabel: 'App limit' },
      ]),
    );
    expect(screen.getByText('Plan limits')).toBeTruthy();
    expect(screen.getByText('App limit')).toBeTruthy();
    expect(screen.getByText('16%')).toBeTruthy();
    expect(screen.getByText('14%')).toBeTruthy();
    expect(screen.queryByText(/sign in to OpenAI Codex with the same/)).toBeNull();
    expect(screen.queryByRole('link', { name: 'Open ChatGPT Usage' })).toBeNull();
  });
  it('shows ChatGPT Usage instead of an endless reading state for direct ChatGPT', () => {
    useModel('openai-chatgpt', 'gpt-6.1-sol');
    render(<ProviderQuotaPanel />);
    savedProviders([{ id: 'openai-chatgpt', type: 'openai-chatgpt', family: 'openai' }]);
    expect(screen.getByText(/sign in to OpenAI Codex with the same ChatGPT account/)).toBeTruthy();
    expect(screen.getByRole('link', { name: 'Open ChatGPT Usage' }).getAttribute('href')).toBe(
      'https://chatgpt.com/settings/usage',
    );
  });
  it('asks for the saved providers, replays readings and refreshes account quota on open', () => {
    render(<ProviderQuotaPanel />);
    expect(sent('providers.saved')).toHaveLength(1);
    expect(sent('provider.quota.get')).toHaveLength(1);
    expect(sent('provider.quota.refresh')).toHaveLength(1);
  });

  it('refreshes on demand', () => {
    render(<ProviderQuotaPanel />);
    act(() => {
      useProviderQuotaStore.getState().applyRefreshes([]);
    });
    fireEvent.click(screen.getByRole('button', { name: 'Refresh quota' }));
    expect(sent('provider.quota.refresh')).toHaveLength(2);
  });

  it('explains when no quota-readable provider is configured', () => {
    render(<ProviderQuotaPanel />);
    savedProviders([{ id: 'anthropic', type: 'anthropic' }]);
    expect(
      screen.getByText(/^No provider with a readable plan quota is configured \(ChatGPT\/Codex/),
    ).toBeTruthy();
  });

  it('calm chrome hides the section while no quota-readable provider is configured', () => {
    useLocalPrefs.setState({ chromeLevel: 'calm' });
    const { container } = render(<ProviderQuotaPanel />);
    savedProviders([{ id: 'anthropic', type: 'anthropic' }]);
    expect(container.textContent).toBe('');
  });

  it('shows only the provider the session runs on, and links to the rest', () => {
    useModel('zai-coding-plan', 'glm-5.2');
    render(<ProviderQuotaPanel />);
    savedProviders(SAVED);
    act(() => {
      useProviderQuotaStore
        .getState()
        .apply([reading('zai-coding-plan', 42), reading('minimax-coding-plan', 80)]);
    });
    expect(screen.getByText('Z.AI')).toBeTruthy();
    expect(screen.queryByText('MiniMax')).toBeNull();
    expect(screen.queryByText('ChatGPT / Codex')).toBeNull();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    const all = screen.getByRole('button', { name: /All plan quotas \(3\)/ });
    fireEvent.click(all);
    expect(useUIStore.getState().currentView).toBe('provider-quota');
  });

  it('adds what a running subagent draws on', () => {
    useModel('zai-coding-plan', 'glm-5.2');
    act(() => {
      useFleetStore.setState({
        agents: new Map([
          [
            'a1',
            {
              id: 'a1',
              name: 'Ada',
              status: 'running',
              provider: 'minimax-coding-plan',
              model: 'MiniMax-M3',
              iteration: 0,
            } as never,
          ],
          [
            'a2',
            {
              id: 'a2',
              name: 'Bo',
              status: 'completed',
              provider: 'openai-codex',
              model: 'gpt-5.5',
              iteration: 0,
            } as never,
          ],
        ]),
      });
    });
    render(<ProviderQuotaPanel />);
    savedProviders(SAVED);
    expect(screen.getByText('Z.AI')).toBeTruthy();
    expect(screen.getByText('MiniMax')).toBeTruthy();
    // A finished subagent no longer draws on anything.
    expect(screen.queryByText('ChatGPT / Codex')).toBeNull();
  });

  it('says so when the providers in use report no plan quota', () => {
    useModel('anthropic', 'claude-sonnet-5-5');
    render(<ProviderQuotaPanel />);
    savedProviders(SAVED);
    expect(screen.getByText('The providers in use report no plan quota.')).toBeTruthy();
    expect(screen.getByRole('button', { name: /All plan quotas/ })).toBeTruthy();
  });

  it('keeps only the gateway pool accounts behind the routed model', () => {
    useModel('omniroute', 'cc/claude-sonnet-5-5');
    render(<ProviderQuotaPanel />);
    savedProviders(SAVED);
    act(() => {
      useProviderQuotaStore
        .getState()
        .apply([
          pool('omniroute:claude:c1', 'Claude · work', 60),
          pool('omniroute:github:c2', 'Copilot', 100),
          pool('omniroute:antigravity:c3', 'Antigravity · a1', 5),
        ]);
    });
    expect(screen.getByText('OmniRoute')).toBeTruthy();
    expect(screen.getByText('Claude · work')).toBeTruthy();
    expect(screen.queryByText('Copilot')).toBeNull();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);
    expect(screen.getByText('+2 more in the pool — see Plan Quota.')).toBeTruthy();
  });

  it('shows no pool account for a combo, and says why', () => {
    useModel('omniroute', 'auto/best-coding');
    render(<ProviderQuotaPanel />);
    savedProviders(SAVED);
    act(() => {
      useProviderQuotaStore
        .getState()
        .apply([
          pool('omniroute:claude:c1', 'Claude · work', 60),
          pool('omniroute:github:c2', 'Copilot', 100),
        ]);
    });
    expect(screen.queryAllByRole('progressbar')).toHaveLength(0);
    expect(
      screen.getByText(
        'No pool account matches this model (2 in the pool); a combo picks one per request.',
      ),
    ).toBeTruthy();
  });

  it('says so when the account read of the provider in use failed', () => {
    useModel('minimax-coding-plan', 'MiniMax-M3');
    render(<ProviderQuotaPanel />);
    savedProviders(SAVED);
    act(() => {
      useProviderQuotaStore
        .getState()
        .applyRefreshes([{ providerId: 'minimax-coding-plan', vendor: 'minimax', ok: false }]);
    });
    expect(screen.getByText('Could not read the quota — check the key or plan.')).toBeTruthy();
  });
});
