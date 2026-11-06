import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SageEntry } from '../../src/types.js';

const handlers = new Map<string, Set<(message: { payload: unknown }) => void>>();
const sends: string[] = [];
const client = {
  on(type: string, handler: (message: { payload: unknown }) => void) {
    const set = handlers.get(type) ?? new Set();
    set.add(handler);
    handlers.set(type, set);
    return () => set.delete(handler);
  },
};
// Stable identity across renders — `loadPage`'s useCallback depends on these
// functions, and a fresh literal per render would re-trigger the list effect
// every render (maximum update depth).
const websocket = {
  client,
  listSageMemoriesPage: () => sends.push('listPage'),
  getSageGraph: () => sends.push('graph'),
  searchSageBreakdown: () => {},
};
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => websocket }));
vi.mock('@/hooks/useScrollPosition', () => ({ useScrollPosition: () => ({ current: null }) }));
vi.mock('@/lib/roster-ws', () => ({ sendRosterMessage: () => Promise.resolve({ roles: [] }) }));
vi.mock('@wrongstack/project-surfaces/sage/MemoryGraph', () => ({ MemoryGraph: () => <div /> }));
const enCatalog = await vi.hoisted(async () => {
  // browser-jsdom rewrites import.meta.url to an http URL, so the catalog is
  // read via a cwd-relative path (vitest runs with the package as cwd).
  const { readFileSync } = await import('node:fs');
  const raw = readFileSync('src/i18n/locales/en/activity.json', 'utf8');
  return JSON.parse(raw);
});
vi.mock('@/i18n', () => {
  // Catalog-backed: resolves real en values (the vector panel's t() keys are
  // not enumerable here — it gained useAppTranslation in the i18n port), so
  // assertions on translated chrome keep working as keys evolve.
  const resolve = (key: string): string => {
    if (!key.startsWith('activity:')) return key;
    let cur: unknown = enCatalog;
    for (const part of key.slice('activity:'.length).split('.')) {
      cur = (cur as Record<string, unknown>)?.[part];
    }
    return typeof cur === 'string' ? cur : key;
  };
  return {
    useAppTranslation: () => ({
      t: (key: string) =>
        ({
          'activity:memoryManager.tabVectorMemory': 'Vector memory',
        })[key] ?? resolve(key),
    }),
    displayDecimal: (value: number, digits: number) => value.toFixed(digits),
  };
});
vi.mock('@wrongstack/project-surfaces/lib/i18n', () => {
  // Catalog-backed: resolves real en values (the vector panel's t() keys are
  // not enumerable here — it gained useAppTranslation in the i18n port), so
  // assertions on translated chrome keep working as keys evolve.
  const resolve = (key: string): string => {
    if (!key.startsWith('activity:')) return key;
    let cur: unknown = enCatalog;
    for (const part of key.slice('activity:'.length).split('.')) {
      cur = (cur as Record<string, unknown>)?.[part];
    }
    return typeof cur === 'string' ? cur : key;
  };
  return {
    useAppTranslation: () => ({
      t: (key: string) =>
        ({
          'activity:memoryManager.tabVectorMemory': 'Vector memory',
        })[key] ?? resolve(key),
    }),
    displayDecimal: (value: number, digits: number) => value.toFixed(digits),
  };
});

import { SageTabs } from '../../src/components/MemoryManager/SageTabs.js';
import { useConfigStore } from '../../src/stores/config-store.js';

const memory: SageEntry = {
  id: 'sage-linked',
  revision: 1,
  text: 'Linked SAGE memory',
  scope: 'project',
  kind: 'fact',
  status: 'active',
  importance: 0.9,
  confidence: 0.9,
  freshness: 1,
  tags: [],
  anchors: [],
  createdAt: '2026-09-01T00:00:00.000Z',
  updatedAt: '2026-09-01T00:00:00.000Z',
};
function response(body: unknown) {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });
}

beforeEach(() => {
  handlers.clear();
  sends.length = 0;
  useConfigStore.setState({ wsConnected: true, wsStatus: { state: 'open' } });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('unified SAGE search across tabs', () => {
  it('opens a verified vector mirror outside the loaded library page by exact ID and returns to the vector results', async () => {
    const fetcher = vi.fn((input: string) => {
      if (input.includes('/api/vector-memory/status'))
        return Promise.resolve(
          response({
            enabled: true,
            modelId: 'Test embedding model',
            providerId: 'test',
            entries: 1,
            vectors: 1,
          }),
        );
      if (input.includes('/api/vector-memory/search'))
        return Promise.resolve(
          response({
            hits: [
              {
                id: 'vector-1',
                score: 0.82,
                text: 'Linked SAGE memory',
                tags: [],
                sage: { id: memory.id, status: 'verified' },
                kind: 'note',
                scope: 'project',
              },
            ],
            count: 1,
            nextCursor: 'next-vector-page',
          }),
        );
      if (input.includes('/api/memory/resolve/')) return Promise.resolve(response({ memory }));
      if (input.includes('/api/memory/search-page'))
        return Promise.resolve(
          response({
            hits: [],
            count: 0,
            totalCandidates: 0,
            nextCursor: null,
            rankingApplied: 'hybrid',
            matchChannel: 'fts',
          }),
        );
      throw new Error(`Unexpected request: ${input}`);
    });
    vi.stubGlobal('fetch', fetcher);
    render(<SageTabs defaultValue="vector" />);
    await screen.findByText('Test embedding model');
    fireEvent.change(screen.getByLabelText('Query'), { target: { value: 'linked' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    await screen.findByRole('button', { name: 'Open in SAGE' });
    fireEvent.click(screen.getByRole('button', { name: 'Open in SAGE' }));
    await waitFor(() => expect(sends).toContain('listPage'));
    await act(async () => {
      for (const handler of handlers.get('memory.sage.listPage') ?? [])
        handler({
          payload: {
            memories: [],
            statusCounts: { active: 1 },
            stats: { total: 1, byStatus: { active: 1 }, byKind: {}, edges: 0 },
            nextCursor: null,
          },
        });
    });
    await screen.findByText('Linked SAGE memory');
    expect(
      fetcher.mock.calls.some(([input]) =>
        String(input).endsWith('/api/memory/resolve/sage-linked'),
      ),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: /Back to vector results/i }));
    await screen.findByText('Test embedding model');
    expect((screen.getByLabelText('Query') as HTMLInputElement).value).toBe('linked');
    expect(screen.getByRole('button', { name: /0.820/ })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Load more' })).toBeTruthy();
  });
});
