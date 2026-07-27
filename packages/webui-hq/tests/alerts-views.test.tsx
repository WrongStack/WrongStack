/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqAlert } from '@wrongstack/core/hq';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useHqStore } from '../src/store';
import { AlertsView } from '../src/views/alerts';

const jsonResponse = (body: unknown): Response =>
  ({ ok: true, status: 200, json: async () => body }) as Response;

let root: Root | null = null;
let container: HTMLDivElement | null = null;

function mount() {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(createElement(AlertsView));
  });
}

async function flushPromises() {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

afterEach(() => {
  if (root) {
    act(() => {
      root?.unmount();
    });
  }
  container?.remove();
  root = null;
  container = null;
  vi.restoreAllMocks();
  useHqStore.setState(useHqStore.getInitialState());
});

describe('AlertsView', () => {
  beforeEach(() => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(jsonResponse({ active: [], history: [] }));
    useHqStore.setState({ alerts: [] });
  });

  it('renders the quiet empty state when no alerts are active', async () => {
    mount();
    await flushPromises();

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/alerts', expect.any(Object));
    expect(container?.textContent).toContain('Fleet quiet');
    expect(container?.textContent).toContain('No active alert rules are firing');
    expect(container?.textContent).toContain('No historical alerts.');
  });

  it('renders active, live, and historical alert branches', async () => {
    const active: HqAlert[] = [
      {
        id: 'active-1',
        ruleId: 'cost.spike',
        severity: 'error',
        message: 'Cost spike detected',
        firstFiredAt: 1_700_000_000_000,
        lastFiredAt: 1_700_000_001_000,
      },
    ];
    const history: HqAlert[] = [
      {
        id: 'history-1',
        ruleId: 'session.stale',
        severity: 'warn',
        message: 'Session went stale',
        firstFiredAt: 1_700_000_002_000,
        lastFiredAt: 1_700_000_003_000,
      },
    ];

    vi.mocked(globalThis.fetch).mockResolvedValueOnce(jsonResponse({ active, history }));
    useHqStore.setState({
      alerts: [
        {
          type: 'hq.alert',
          severity: 'error',
          message: 'Live fleet failure',
          timestamp: new Date(1_700_000_005_000).toISOString(),
        },
      ],
    });

    mount();
    await flushPromises();

    expect(globalThis.fetch).toHaveBeenCalledWith('/api/alerts', expect.any(Object));
    expect(container?.textContent).toContain('Fleet requires review');
    expect(container?.textContent).toContain('Active Alerts (1)');
    expect(container?.textContent).toContain('Cost spike detected');
    expect(container?.textContent).toContain('Live fleet failure');
    expect(container?.textContent).toContain('Session went stale');
  });
});
