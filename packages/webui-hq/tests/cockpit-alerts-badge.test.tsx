/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock ONLY the network fetch so we control the /api/alerts response. The
// real zustand store is used so the badge-reactivity contract is exercised
// the same way production renders it.
const fetchJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../src/store.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchJson: fetchJsonMock };
});

import type { HqAlert } from '@wrongstack/core/hq';
import { useHqStore } from '../src/store.js';
import { CockpitView } from '../src/views/cockpit.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

const SYSTEM_HEALTH = {
  status: 'healthy',
  uptime: { serverTime: '2026-07-24T00:00:00.000Z', eventLogSize: 0 },
  stores: { events: 'ok', timeseries: 'ok', kanban: 'ok' },
  connections: { total: 0, active: 0, stale: 0 },
};

beforeEach(() => {
  fetchJsonMock.mockReset();
  fetchJsonMock.mockImplementation((url: string) =>
    Promise.resolve(url === '/api/system/health' ? SYSTEM_HEALTH : { active: [], history: [] }),
  );
  // Reset the store between tests so apiActive hydration starts clean.
  useHqStore.setState({
    snapshot: null,
    alerts: [],
    selectedClientId: null,
    connected: true,
  });
});

afterEach(() => {
  if (root) act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  vi.useRealTimers();
});

function mountCockpit(): Promise<void> {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  return act(async () => {
    root?.render(createElement(CockpitView));
    // Drain the microtask queue a few times so the mount-effect fetch
    // resolves and React commits the post-fetch render.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

function respondToAlerts(payload: { active: HqAlert[]; history: HqAlert[] }): void {
  fetchJsonMock.mockImplementation((url: string) =>
    Promise.resolve(url === '/api/system/health' ? SYSTEM_HEALTH : payload),
  );
}

function rejectAlerts(err: unknown): void {
  fetchJsonMock.mockImplementation((url: string) =>
    url === '/api/system/health' ? Promise.resolve(SYSTEM_HEALTH) : Promise.reject(err),
  );
}

/**
 * Find the badge by its text content. The badge and the error pill share
 * the `.hq-pill.error` class; we disambiguate by checking the text matches
 * the `N active alerts` pattern vs. an error message.
 */
function findActiveAlertsBadge(): HTMLSpanElement | null {
  const pills = container?.querySelectorAll<HTMLSpanElement>('span.hq-pill.error') ?? [];
  for (const pill of pills) {
    if (/^\d+ active alerts$/.test(pill.textContent ?? '')) return pill;
  }
  return null;
}

function findErrorPill(): HTMLSpanElement | null {
  const pills = container?.querySelectorAll<HTMLSpanElement>('span.hq-pill.error') ?? [];
  for (const pill of pills) {
    if (!/^\d+ active alerts$/.test(pill.textContent ?? '')) return pill;
  }
  return null;
}

function makeAlert(overrides: Partial<HqAlert> & Pick<HqAlert, 'id'>): HqAlert {
  const now = Date.now();
  return {
    ruleId: 'test-rule',
    severity: 'error',
    message: 'test alert',
    firstFiredAt: now,
    lastFiredAt: now,
    ...overrides,
  };
}

describe('Cockpit — apiActive alerts badge', () => {
  it('does NOT render the badge when /api/alerts returns zero active alerts', async () => {
    respondToAlerts({ active: [], history: [] });
    await mountCockpit();

    expect(findActiveAlertsBadge()).toBeNull();
  });

  it('renders the badge with the count when /api/alerts returns active alerts', async () => {
    respondToAlerts({
      active: [
        makeAlert({ id: 'a1', ruleId: 'cost-threshold', message: 'cost exceeded' }),
        makeAlert({ id: 'a2', ruleId: 'token-expired-present', message: '1 expired token' }),
      ],
      history: [],
    });
    await mountCockpit();

    const badge = findActiveAlertsBadge();
    expect(badge).not.toBeNull();
    expect(badge?.textContent).toBe('2 active alerts');
    expect(container?.querySelector('.hq-cockpit-hero')?.getAttribute('data-tone')).toBe(
      'attention',
    );
    expect(container?.textContent).toContain('Attention needed');
  });

  it('renders a nominal operational picture when no attention signals exist', async () => {
    respondToAlerts({ active: [], history: [] });
    await mountCockpit();

    expect(container?.querySelector('.hq-cockpit-hero')?.getAttribute('data-tone')).toBe('nominal');
    expect(container?.textContent).toContain('Systems nominal');
    expect(container?.textContent).toContain('Operational picture');
  });

  it('renders the error pill when /api/alerts rejects (network failure path)', async () => {
    rejectAlerts(new Error('network unreachable'));
    await mountCockpit();

    // The error pill shares the .hq-pill.error class with the active badge;
    // assert the message is the network error, NOT a count.
    expect(findActiveAlertsBadge()).toBeNull();
    const errorPill = findErrorPill();
    expect(errorPill).not.toBeNull();
    expect(errorPill?.textContent).toContain('network unreachable');
  });

  it('counts only active alerts, ignoring history entries', async () => {
    const now = Date.now();
    respondToAlerts({
      active: [makeAlert({ id: 'a1', ruleId: 'stale-machine' })],
      history: [
        // 5 history entries must NOT inflate the badge count.
        makeAlert({
          id: 'h1',
          ruleId: 'cost-threshold',
          message: 'old cost',
          firstFiredAt: now - 1000,
          lastFiredAt: now - 500,
        }),
        makeAlert({
          id: 'h2',
          ruleId: 'cost-threshold',
          message: 'old cost 2',
          firstFiredAt: now - 2000,
          lastFiredAt: now - 1500,
        }),
      ],
    });
    await mountCockpit();

    const badge = findActiveAlertsBadge();
    expect(badge?.textContent).toBe('1 active alerts');
  });
});
