/** @vitest-environment jsdom */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import type { HqSnapshot } from '@wrongstack/core/hq';
import { act, createElement } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock the network fetch so the mount-effect doesn't race the assertions.
// The real zustand store is used so snapshot-driven rendering is exercised
// the same way production renders it.
const fetchJsonMock = vi.hoisted(() => vi.fn());
vi.mock('../src/store.js', async (importOriginal) => {
  const actual = (await importOriginal()) as Record<string, unknown>;
  return { ...actual, fetchJson: fetchJsonMock };
});

import { CockpitView } from '../src/views/cockpit.js';
import { useHqStore } from '../src/store.js';

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  fetchJsonMock.mockReset();
  fetchJsonMock.mockImplementation((url: string) =>
    Promise.resolve(
      url === '/api/system/health'
        ? {
            status: 'healthy',
            uptime: { serverTime: '2026-07-24T00:00:00.000Z', eventLogSize: 0 },
            stores: { events: 'ok', timeseries: 'ok', kanban: 'ok' },
            connections: { total: 0, active: 0, stale: 0 },
          }
        : { active: [], history: [] },
    ),
  );
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
    // Drain the microtask queue so the mount-effect fetch resolves.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  });
}

/**
 * Build a minimal snapshot whose `totals.tokenStats` field is populated.
 * The Cockpit only reads `snapshot.totals.tokenStats`, `snapshot.totals.totalCostUsd`,
 * `snapshot.clients`, `snapshot.projects`, `snapshot.machines`, and
 * `snapshot.liveSessions` — the rest can stay empty.
 */
function snapshotWithTokenStats(
  tokenStats: HqSnapshot['totals']['tokenStats'],
): HqSnapshot {
  return {
    clients: [],
    projects: [],
    machines: [],
    liveSessions: [],
    totals: {
      activeSessions: 0,
      activeAgents: 0,
      totalCostUsd: 0,
      tokenStats,
    },
  } as unknown as HqSnapshot;
}

/** Find the Auth Tokens KPA card by its title, then collect its stat labels. */
function findTokenStatsLabels(): string[] {
  const cards = container?.querySelectorAll<HTMLDivElement>('div.hq-cockpit-section') ?? [];
  for (const card of cards) {
    const titleEl = card.querySelector('.hq-cockpit-section-title');
    if (titleEl?.textContent === 'Auth Tokens') {
      return Array.from(card.querySelectorAll<HTMLSpanElement>('.hq-stat-label')).map(
        (el) => el.textContent ?? '',
      );
    }
  }
  return [];
}

/** Return the `.hq-stat` blocks inside the Auth Tokens card as label/value pairs. */
function findTokenStatsEntries(): { label: string; value: string; accent: string }[] {
  const cards = container?.querySelectorAll<HTMLDivElement>('div.hq-cockpit-section') ?? [];
  for (const card of cards) {
    const titleEl = card.querySelector('.hq-cockpit-section-title');
    if (titleEl?.textContent !== 'Auth Tokens') continue;
    return Array.from(card.querySelectorAll<HTMLDivElement>('.hq-stat')).map((stat) => ({
      label: stat.querySelector('.hq-stat-label')?.textContent ?? '',
      value: stat.querySelector('.hq-stat-num')?.textContent ?? '',
      accent: stat.className,
    }));
  }
  return [];
}

describe('Cockpit — Auth Tokens (tokenStats) KPA card', () => {
  it('renders the browser/client/total/expired/expiring-soon stats when tokenStats is present', async () => {
    useHqStore.setState({
      snapshot: snapshotWithTokenStats({
        browserTotal: 3,
        clientTotal: 2,
        expired: 1,
        expiringSoon: 4,
      }),
    });
    await mountCockpit();

    const labels = findTokenStatsLabels();
    expect(labels).toEqual(['browser', 'client', 'total', 'expired', 'expiring soon']);
  });

  it('sums browser + client into the total stat', async () => {
    useHqStore.setState({
      snapshot: snapshotWithTokenStats({
        browserTotal: 7,
        clientTotal: 5,
        expired: 0,
        expiringSoon: 0,
      }),
    });
    await mountCockpit();

    const entries = new Map(findTokenStatsEntries().map((e) => [e.label, e.value]));
    expect(entries.get('browser')).toBe('7');
    expect(entries.get('client')).toBe('5');
    expect(entries.get('total')).toBe('12');
  });

  it('accents the expired stat with the error tone when > 0', async () => {
    useHqStore.setState({
      snapshot: snapshotWithTokenStats({
        browserTotal: 2,
        clientTotal: 2,
        expired: 3,
        expiringSoon: 0,
      }),
    });
    await mountCockpit();

    const expired = findTokenStatsEntries().find((e) => e.label === 'expired');
    expect(expired).toBeDefined();
    expect(expired?.value).toBe('3');
    expect(expired?.accent).toContain('error');
  });

  it('accents the expiring-soon stat with the warn tone when > 0', async () => {
    useHqStore.setState({
      snapshot: snapshotWithTokenStats({
        browserTotal: 1,
        clientTotal: 1,
        expired: 0,
        expiringSoon: 2,
      }),
    });
    await mountCockpit();

    const soon = findTokenStatsEntries().find((e) => e.label === 'expiring soon');
    expect(soon).toBeDefined();
    expect(soon?.value).toBe('2');
    expect(soon?.accent).toContain('warn');
  });

  it('leaves the expired/expiring-soon stats unaccented when zero', async () => {
    useHqStore.setState({
      snapshot: snapshotWithTokenStats({
        browserTotal: 1,
        clientTotal: 1,
        expired: 0,
        expiringSoon: 0,
      }),
    });
    await mountCockpit();

    const entries = new Map(findTokenStatsEntries().map((e) => [e.label, e.accent]));
    expect(entries.get('expired')).toBe('hq-stat');
    expect(entries.get('expiring soon')).toBe('hq-stat');
  });

  it('renders the unavailable placeholder when the HQ version omits tokenStats', async () => {
    useHqStore.setState({
      // tokenStats intentionally undefined — older HQ versions don't populate it.
      snapshot: snapshotWithTokenStats(undefined),
    });
    await mountCockpit();

    // The placeholder lives inside the Auth Tokens card body.
    const cards = container?.querySelectorAll<HTMLDivElement>('div.hq-cockpit-section') ?? [];
    const tokenCard = Array.from(cards).find(
      (card) => card.querySelector('.hq-cockpit-section-title')?.textContent === 'Auth Tokens',
    );
    expect(tokenCard).toBeDefined();
    expect(tokenCard?.textContent).toContain('Token expiry stats unavailable');
  });

  it('propagates tokenStats end-to-end through _onSnapshot (WS path) and re-renders on update', async () => {
    // Start with no snapshot at all — the card body hasn't rendered yet.
    useHqStore.setState({ snapshot: null });
    await mountCockpit();

    // The Cockpit reads `totals?.tokenStats` defensively; with no snapshot,
    // the Auth Tokens card renders the unavailable placeholder.
    const cardsBefore = container?.querySelectorAll<HTMLDivElement>('div.hq-cockpit-section') ?? [];
    const tokenCardBefore = Array.from(cardsBefore).find(
      (card) => card.querySelector('.hq-cockpit-section-title')?.textContent === 'Auth Tokens',
    );
    expect(tokenCardBefore?.textContent).toContain('Token expiry stats unavailable');

    // Drive the store through the WS snapshot path — the same path the live
    // hq-ws-client uses. `_onSnapshot` applies `snapshotPatch` and flips
    // `connected` to true, exercising the producer→store→consumer loop.
    act(() => {
      useHqStore.getState()._onSnapshot(
        snapshotWithTokenStats({
          browserTotal: 4,
          clientTotal: 3,
          expired: 2,
          expiringSoon: 1,
        }),
      );
    });

    const entries = new Map(
      findTokenStatsEntries().map((e) => [e.label, e.value]),
    );
    expect(entries.get('browser')).toBe('4');
    expect(entries.get('client')).toBe('3');
    expect(entries.get('total')).toBe('7');
    expect(entries.get('expired')).toBe('2');
    expect(entries.get('expiring soon')).toBe('1');

    // A second snapshot with different counts must overwrite the first —
    // the store does not merge tokenStats fields.
    act(() => {
      useHqStore.getState()._onSnapshot(
        snapshotWithTokenStats({
          browserTotal: 1,
          clientTotal: 0,
          expired: 0,
          expiringSoon: 5,
        }),
      );
    });

    const entriesAfter = new Map(
      findTokenStatsEntries().map((e) => [e.label, e.value]),
    );
    expect(entriesAfter.get('browser')).toBe('1');
    expect(entriesAfter.get('client')).toBe('0');
    expect(entriesAfter.get('total')).toBe('1');
    expect(entriesAfter.get('expired')).toBe('0');
    expect(entriesAfter.get('expiring soon')).toBe('5');

    // And a snapshot without tokenStats must flip the card back to the
    // unavailable placeholder — the store does not preserve the prior
    // tokenStats when the field is absent on the new snapshot.
    act(() => {
      useHqStore.getState()._onSnapshot(snapshotWithTokenStats(undefined));
    });

    const cardsAfter = container?.querySelectorAll<HTMLDivElement>('div.hq-cockpit-section') ?? [];
    const tokenCardAfter = Array.from(cardsAfter).find(
      (card) => card.querySelector('.hq-cockpit-section-title')?.textContent === 'Auth Tokens',
    );
    expect(tokenCardAfter?.textContent).toContain('Token expiry stats unavailable');
  });
});
