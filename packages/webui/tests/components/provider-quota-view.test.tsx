import { act, fireEvent, render, screen, within } from '@testing-library/react';
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

const { useConfigStore, useProviderQuotaStore } = await import('@/stores');
const { ProviderQuotaView } = await import('../../src/components/ProviderQuotaView.js');

const sent = (type: string) => sends.filter((m) => m.type === type);
const nowSec = () => Math.floor(Date.now() / 1000);

function savedProviders(providers: Array<Record<string, unknown>>) {
  act(() => {
    for (const handler of handlers.get('providers.saved') ?? []) {
      handler({ type: 'providers.saved', payload: { providers } });
    }
  });
}

/** Card titles in page order (the bold line of every card). */
function cardTitles(): string[] {
  return [...document.querySelectorAll('section .font-semibold.truncate')].map(
    (el) => el.textContent ?? '',
  );
}

function section(name: string): HTMLElement {
  return screen.getByRole('region', { name });
}

const SAVED = [
  { id: 'openai-codex', type: 'openai-codex', family: 'openai-codex' },
  {
    id: 'minimax-coding-plan',
    type: 'minimax-coding-plan',
    baseUrl: 'http://localhost:5173/proxy/api.minimax.io/anthropic/v1',
  },
  {
    id: 'zai-coding-plan',
    type: 'zai-coding-plan',
    baseUrl: 'https://api.z.ai/api/coding/paas/v4',
  },
  // Pay-as-you-go Z.AI never draws on the plan: no card.
  { id: 'zai', type: 'zai', baseUrl: 'https://api.z.ai/api/paas/v4' },
  { id: 'anthropic', type: 'anthropic', baseUrl: 'https://api.anthropic.com' },
];

const resetsAt = () => nowSec() + 3600;

function pool(
  meterId: string,
  label: string,
  usedPercent: number,
  extra: Record<string, unknown> = {},
) {
  return {
    providerId: 'omniroute',
    meterId,
    meterLabel: label,
    via: 'omniroute',
    windows: [{ id: 'w', label: 'weekly (7d)', usedPercent, resetsAt: resetsAt() }],
    capturedAt: Date.now(),
    ...extra,
  };
}

beforeEach(() => {
  handlers.clear();
  sends.length = 0;
  useConfigStore.setState({ wsConnected: true, provider: '', model: '' });
  useProviderQuotaStore.getState().clear();
});

describe('Plan Quota page', () => {
  it('shows WrongForge windows and remaining allowance without a saved API key', () => {
    render(<ProviderQuotaView />);
    savedProviders([{ id: 'wrongforge', type: 'wrongforge' }]);
    act(() => {
      useProviderQuotaStore.getState().apply([
        {
          providerId: 'wrongforge',
          meterId: 'default',
          windows: [
            { id: 'primary', usedPercent: 18, windowMinutes: 300, resetsAt: resetsAt() },
            { id: 'secondary', usedPercent: 0, windowMinutes: 10080, resetsAt: resetsAt() },
          ],
          capturedAt: Date.now(),
        },
      ]);
    });
    expect(cardTitles()).toEqual(['WrongForge']);
    expect(
      screen.getAllByRole('progressbar').map((bar) => bar.getAttribute('aria-valuenow')),
    ).toEqual(['18', '0']);
    expect(screen.getByText(/82% left/)).toBeTruthy();
  });
  it('asks for the saved providers, replays readings and refreshes account quota on open', () => {
    render(<ProviderQuotaView />);
    expect(sent('providers.saved')).toHaveLength(1);
    expect(sent('provider.quota.get')).toHaveLength(1);
    expect(sent('provider.quota.refresh')).toHaveLength(1);
  });

  it('refreshes on demand', () => {
    render(<ProviderQuotaView />);
    act(() => {
      useProviderQuotaStore.getState().applyRefreshes([]);
    });
    fireEvent.click(screen.getByRole('button', { name: /Refresh quota/ }));
    expect(sent('provider.quota.refresh')).toHaveLength(2);
  });

  it('explains when no quota-readable provider is configured', () => {
    render(<ProviderQuotaView />);
    savedProviders([{ id: 'anthropic', type: 'anthropic' }]);
    expect(
      screen.getByText(/^No provider with a readable plan quota is configured \(ChatGPT\/Codex/),
    ).toBeTruthy();
  });

  it('gives every Codex / MiniMax / Z.AI Coding Plan provider a card, and no other', () => {
    render(<ProviderQuotaView />);
    savedProviders(SAVED);
    expect(cardTitles()).toEqual(['ChatGPT / Codex', 'MiniMax', 'Z.AI']);
    // Codex is read on demand like the others — no turn needed first.
    expect(screen.getAllByText('Reading…')).toHaveLength(3);
  });

  it('renders windows with usage, remaining, reset and its clock, plus the MCP note', () => {
    render(<ProviderQuotaView />);
    savedProviders(SAVED);
    act(() => {
      useProviderQuotaStore.getState().apply([
        {
          providerId: 'zai-coding-plan',
          meterId: 'default',
          planLabel: 'coding max',
          windows: [{ id: 'primary', usedPercent: 92, windowMinutes: 300, resetsAt: resetsAt() }],
          capturedAt: Date.now(),
        },
        {
          providerId: 'zai-coding-plan',
          meterId: 'mcp-tools',
          windows: [],
          note: '197/4000 calls this month',
          capturedAt: Date.now(),
        },
      ]);
    });
    expect(screen.getByText('coding max')).toBeTruthy();
    expect(screen.getByText('5h')).toBeTruthy();
    expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('92');
    expect(screen.getByText(/8% left/)).toBeTruthy();
    expect(screen.getByText(/resets in (59m|1h)/)).toBeTruthy();
    expect(screen.getByText('197/4000 calls this month')).toBeTruthy();
  });

  it('says so when an account read failed', () => {
    render(<ProviderQuotaView />);
    savedProviders(SAVED);
    act(() => {
      useProviderQuotaStore
        .getState()
        .applyRefreshes([{ providerId: 'minimax-coding-plan', vendor: 'minimax', ok: false }]);
    });
    expect(screen.getByText('Could not read the quota — check the key or plan.')).toBeTruthy();
  });

  it('gives Kimi Code and OpenRouter cards, catalog or proxied, and Moonshot a balance card', () => {
    render(<ProviderQuotaView />);
    savedProviders([
      { id: 'kimi-for-coding', type: 'kimi-for-coding' },
      {
        id: 'kimi-intl',
        type: 'openai-compatible',
        baseUrl: 'http://localhost:3444/proxy/api.kimi.ai/coding/v1',
      },
      { id: 'kimi-code-plan-global', type: 'kimi-code-plan-global' },
      // Moonshot's pay-as-you-go API has a prepaid balance, not a plan.
      { id: 'moonshot', type: 'moonshotai', baseUrl: 'https://api.moonshot.ai/v1' },
      { id: 'openrouter', type: 'openrouter' },
    ]);
    expect(within(section('Subscription plans')).getAllByText(/Kimi Code|OpenRouter/)).toHaveLength(
      4,
    );
    expect(screen.getByText('kimi-intl')).toBeTruthy();
    expect(within(section('Prepaid balances')).getByText('Moonshot')).toBeTruthy();
  });

  it('folds OpenCode keys that read the same account into one card', () => {
    render(<ProviderQuotaView />);
    savedProviders([
      { id: 'opencode', type: 'opencode' },
      { id: 'opencode-go', type: 'opencode-go' },
      { id: 'opencode-go-ws', type: 'openai-compatible', baseUrl: 'https://opencode.ai/zen/go/v1' },
    ]);
    expect(screen.getAllByText('Reading…')).toHaveLength(3);
    const reset = resetsAt();
    const reading = (providerId: string, usedPercent = 12) => ({
      providerId,
      meterId: 'default',
      meterLabel: 'OpenCode Go',
      windows: [{ id: 'primary', usedPercent, windowMinutes: 300, resetsAt: reset }],
      capturedAt: Date.now(),
    });
    act(() => {
      useProviderQuotaStore
        .getState()
        .apply([reading('opencode'), reading('opencode-go'), reading('opencode-go-ws')]);
    });
    expect(cardTitles()).toEqual(['OpenCode Go']);
    expect(screen.getByText('opencode, opencode-go, opencode-go-ws')).toBeTruthy();
    expect(screen.getAllByRole('progressbar')).toHaveLength(1);

    act(() => {
      useProviderQuotaStore.getState().apply([reading('opencode-go-ws', 40)]);
    });
    // A different reading is a different account: its own card again.
    expect(screen.getAllByRole('progressbar')).toHaveLength(2);
  });

  it('drops an OpenCode key whose read failed with nothing to show (no Go plan)', () => {
    render(<ProviderQuotaView />);
    savedProviders([
      { id: 'opencode', type: 'opencode' },
      { id: 'openrouter', type: 'openrouter' },
    ]);
    act(() => {
      useProviderQuotaStore.getState().applyRefreshes([
        { providerId: 'opencode', vendor: 'opencode', ok: false },
        { providerId: 'openrouter', vendor: 'openrouter', ok: false },
      ]);
    });
    expect(screen.queryByText(/OpenCode Go/)).toBeNull();
    expect(screen.getByText('Could not read the quota — check the key or plan.')).toBeTruthy();
  });

  it('gives every OmniRoute pool account its own card, most consumed first', () => {
    render(<ProviderQuotaView />);
    // The gateway itself is saved without a quota vendor: its read needs a
    // token the browser never sees, so its cards come from its readings.
    savedProviders([{ id: 'omniroute', type: 'omniroute', baseUrl: 'http://localhost:20128/v1' }]);
    expect(cardTitles()).toEqual([]);
    act(() => {
      useProviderQuotaStore.getState().apply([
        pool('omniroute:claude:c1', 'Claude · work', 60, { planLabel: 'max' }),
        pool('omniroute:github:c2', 'Copilot', 100, {
          planLabel: 'Copilot Free',
          reachedWindowId: 'w',
        }),
        pool('omniroute:antigravity:c3', 'Antigravity · a1', 5),
      ]);
    });
    const poolSection = section('OmniRoute pool');
    expect(cardTitles()).toEqual(['Copilot', 'Claude · work', 'Antigravity · a1']);
    expect(within(poolSection).getByText('Copilot Free')).toBeTruthy();
    expect(within(poolSection).getByText('max')).toBeTruthy();
    expect(within(poolSection).getAllByText('OmniRoute')).toHaveLength(3);
    expect(within(poolSection).getByText('limit reached')).toBeTruthy();
  });

  it('shows prepaid balances, and titles a configured endpoint by its id', () => {
    render(<ProviderQuotaView />);
    savedProviders([
      { id: 'deepseek', type: 'deepseek' },
      { id: 'my-relay', type: 'openai-compatible', baseUrl: 'https://relay.example.com/v1' },
    ]);
    act(() => {
      useProviderQuotaStore.getState().apply([
        {
          providerId: 'deepseek',
          meterId: 'balance',
          meterLabel: 'DeepSeek',
          windows: [],
          credits: { hasCredits: true, unlimited: false, balance: '$12.40' },
          capturedAt: Date.now(),
        },
        {
          providerId: 'my-relay',
          meterId: 'default',
          windows: [{ id: 'primary', label: 'daily', usedPercent: 25 }],
          capturedAt: Date.now(),
        },
      ]);
      useProviderQuotaStore
        .getState()
        .applyRefreshes([{ providerId: 'my-relay', vendor: 'custom', ok: true }]);
    });
    expect(within(section('Prepaid balances')).getByText('DeepSeek')).toBeTruthy();
    expect(screen.getByText('$12.40')).toBeTruthy();
    expect(within(section('Subscription plans')).getByText('my-relay')).toBeTruthy();
    expect(screen.getByText('daily')).toBeTruthy();
  });

  it('lifts what the session runs on to the top and marks it', () => {
    useConfigStore.setState({ provider: 'omniroute', model: 'no-think/cc/claude-sonnet-5-5' });
    render(<ProviderQuotaView />);
    savedProviders(SAVED);
    act(() => {
      useProviderQuotaStore
        .getState()
        .apply([
          pool('omniroute:claude:c1', 'Claude · work', 60),
          pool('omniroute:github:c2', 'Copilot', 30),
        ]);
    });
    const inUse = section('In use now');
    expect(within(inUse).getByText('Claude · work')).toBeTruthy();
    expect(within(inUse).getByText('In use')).toBeTruthy();
    // Each entry lives in exactly one section.
    expect(within(section('OmniRoute pool')).queryByText('Claude · work')).toBeNull();
    expect(within(section('OmniRoute pool')).getByText('Copilot')).toBeTruthy();
  });

  it('summarises accounts, warnings, cut-offs and the next relief', () => {
    render(<ProviderQuotaView />);
    act(() => {
      useProviderQuotaStore
        .getState()
        .apply([
          pool('omniroute:claude:c1', 'Claude · work', 75),
          pool('omniroute:github:c2', 'Copilot', 100, { reachedWindowId: 'w' }),
          pool('omniroute:codex:c3', 'Codex', 10),
        ]);
    });
    const tile = (label: string) => screen.getByText(label).parentElement?.parentElement;
    expect(tile('Accounts')?.textContent).toContain('3');
    expect(tile('Above 70%')?.textContent).toContain('1');
    expect(tile('Above 90% or cut off')?.textContent).toContain('1');
    expect(tile('Next relief')?.textContent).toMatch(/(59m|1h)/);
  });

  it('filters by name and by nearness to the limit', () => {
    render(<ProviderQuotaView />);
    act(() => {
      useProviderQuotaStore
        .getState()
        .apply([
          pool('omniroute:claude:c1', 'Claude · work', 75),
          pool('omniroute:codex:c3', 'Codex', 10),
        ]);
    });
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'codex' } });
    expect(cardTitles()).toEqual(['Codex']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Near limit only' }));
    expect(cardTitles()).toEqual(['Claude · work']);
    fireEvent.change(screen.getByRole('searchbox'), { target: { value: 'nothing-like-this' } });
    expect(screen.getByText('Nothing matches the filter.')).toBeTruthy();
  });
});
