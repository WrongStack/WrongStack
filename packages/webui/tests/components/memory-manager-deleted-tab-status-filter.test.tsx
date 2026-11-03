/**
 * Regression test for the WebUI Memory Manager "Deleted" tab.
 *
 * The Deleted tab pins the server-side status filter to `deleted`. The
 * client-side filter used to apply the separate status dropdown on top of
 * that pin, so a leftover status filter (e.g. "stale") hid every deleted
 * record while the tab label still advertised the deleted count.
 *
 * See: packages/webui/src/components/MemoryManager/useMemoryManagerState.ts
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SageEntry, SageStats } from '../../src/types.js';

const handlers = new Map<string, Set<(message: { type: string; payload: unknown }) => void>>();
const sends: Array<{ type: string; payload?: unknown }> = [];

const client = {
  on(type: string, handler: (message: { type: string; payload: unknown }) => void) {
    const registered = handlers.get(type) ?? new Set();
    registered.add(handler);
    handlers.set(type, registered);
    return () => registered.delete(handler);
  },
};

const websocket = {
  client,
  listSageMemories: () => sends.push({ type: 'memory.sage.list' }),
  listSageMemoriesPage: (params: unknown, _options: unknown) =>
    sends.push({ type: 'memory.sage.listPage', payload: params }),
  getSageGraph: (query: string, params: unknown) =>
    sends.push({ type: 'memory.sage.graph', payload: { query, ...(params as object) } }),
  searchSageBreakdown: (params: unknown) =>
    sends.push({ type: 'memory.sage.searchBreakdown', payload: params }),
  rememberSage: (payload: unknown) => sends.push({ type: 'memory.sage.remember', payload }),
  updateSage: (id: string, patch: unknown) =>
    sends.push({ type: 'memory.sage.update', payload: { id, ...(patch as object) } }),
  deleteSage: (id: string, reason?: string) =>
    sends.push({ type: 'memory.sage.delete', payload: { id, reason } }),
  recoverSage: (payload: unknown) => sends.push({ type: 'memory.sage.recover', payload }),
  listMemoryCandidates: (payload: unknown) =>
    sends.push({ type: 'memory.sage.listCandidates', payload }),
  resolveMemoryCandidate: (payload: unknown) =>
    sends.push({ type: 'memory.sage.candidateResolve', payload }),
  sageDoctor: (payload: unknown) => sends.push({ type: 'memory.sage.doctor', payload }),
};

vi.mock('@/lib/roster-ws', () => ({
  sendRosterMessage: () => Promise.resolve({ roles: [] }),
}));
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => websocket }));
vi.mock('@/hooks/useScrollPosition', () => ({ useScrollPosition: () => ({ current: null }) }));
// The real MemoryGraph pulls in @xyflow/react, which needs a ResizeObserver
// that jsdom does not provide.
vi.mock('@wrongstack/project-surfaces/sage/MemoryGraph', () => ({
  MemoryGraph: ({ graphEdges }: { graphEdges: unknown[] }) => (
    <div data-testid="memory-graph" data-edge-count={graphEdges.length} />
  ),
}));

import { MemoryManager } from '../../src/components/MemoryManager/index.js';
import { useConfigStore } from '../../src/stores/config-store.js';

const baseEntry: SageEntry = {
  id: 'mem_active',
  revision: 3,
  scope: 'project',
  kind: 'decision',
  status: 'active',
  text: 'The WebUI uses a singleton WebSocket client for all server events.',
  importance: 0.9,
  confidence: 0.85,
  freshness: 0.95,
  tags: ['webui'],
  anchors: [{ type: 'file', path: 'packages/webui/src/lib/ws-client.ts' }],
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-16T08:00:00.000Z',
};

const staleEntry: SageEntry = {
  ...baseEntry,
  id: 'mem_stale',
  revision: 1,
  status: 'stale',
  text: 'A stale note that was verified against an older revision.',
};

const deletedEntry: SageEntry = {
  ...baseEntry,
  id: 'mem_deleted',
  revision: 2,
  status: 'deleted',
  text: 'A soft-deleted memory that the operator wants to inspect.',
};

const stats: SageStats = {
  total: 3,
  byStatus: { active: 1, stale: 1, deleted: 1 },
  byKind: { decision: 3 },
  edges: 0,
};

function emit(type: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(type) ?? []) handler({ type, payload });
  });
}

function lastListPageRequest() {
  const listSends = sends.filter((entry) => entry.type === 'memory.sage.listPage');
  return listSends[listSends.length - 1]?.payload as { statuses?: string[] } | undefined;
}

async function renderManager() {
  render(<MemoryManager />);
  await waitFor(() => expect(lastListPageRequest()).toBeTruthy());
  emit('memory.sage.listPage', {
    memories: [baseEntry],
    nextCursor: null,
    statusCounts: { active: 1 },
    stats,
  });
  await screen.findByText(baseEntry.text);
}

beforeEach(() => {
  sends.length = 0;
  handlers.clear();
  useConfigStore.setState({ wsConnected: true, wsStatus: { state: 'open' } });
  vi.restoreAllMocks();
});

describe('MemoryManager · Deleted tab', () => {
  it('lists the deleted records the server returned even with a status filter active', async () => {
    await renderManager();

    // Narrow the Active tab to one status.
    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'stale' } });
    await waitFor(() => expect(lastListPageRequest()?.statuses).toEqual(['stale']));
    emit('memory.sage.listPage', {
      memories: [staleEntry],
      nextCursor: null,
      statusCounts: { stale: 1 },
    });
    await screen.findByText(staleEntry.text);

    // The Deleted tab pins the server-side status to `deleted`.
    fireEvent.click(screen.getByRole('tab', { name: /Deleted/i }));
    await waitFor(() => expect(lastListPageRequest()?.statuses).toEqual(['deleted']));
    emit('memory.sage.listPage', {
      memories: [deletedEntry],
      nextCursor: null,
      statusCounts: { deleted: 1 },
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(screen.queryByText(deletedEntry.text)).not.toBeNull();
  });

  it('still honours the status dropdown on the Active tab', async () => {
    await renderManager();

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'stale' } });
    await waitFor(() => expect(lastListPageRequest()?.statuses).toEqual(['stale']));
    emit('memory.sage.listPage', {
      memories: [staleEntry],
      nextCursor: null,
      statusCounts: { stale: 1 },
    });
    await screen.findByText(staleEntry.text);

    expect(screen.queryByText(staleEntry.text)).not.toBeNull();
    expect(screen.queryByText(baseEntry.text)).toBeNull();
  });
});
