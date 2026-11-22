/**
 * A memory-library page reply answers one request. The server echoes that
 * request's id; a late reply to an earlier request (another tab, filter or
 * search) must not replace the page the current request will bring.
 */
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import type { SageEntry, SageStats } from '../../src/types.js';

const handlers = new Map<string, Set<(message: { type: string; payload: unknown }) => void>>();
const sends: Array<{ type: string; payload?: unknown; requestId?: string }> = [];

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
  listSageMemoriesPage: (params: unknown, options?: { requestId?: string }) =>
    sends.push({
      type: 'memory.sage.listPage',
      payload: params,
      ...(options?.requestId ? { requestId: options.requestId } : {}),
    }),
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

const pageRequests = () => sends.filter((entry) => entry.type === 'memory.sage.listPage');

beforeEach(() => {
  sends.length = 0;
  handlers.clear();
  useConfigStore.setState({ wsConnected: true, wsStatus: { state: 'open' } });
  vi.restoreAllMocks();
});

it('ignores a late reply to an earlier page request', async () => {
  render(<MemoryManager />);
  await waitFor(() => expect(pageRequests()).toHaveLength(1));
  const [first] = pageRequests();
  const stamp = (request: (typeof sends)[number] | undefined) =>
    request?.requestId ? { requestId: request.requestId } : {};
  emit('memory.sage.listPage', {
    ...stamp(first),
    memories: [baseEntry],
    nextCursor: null,
    statusCounts: { active: 1 },
    stats,
  });
  await screen.findByText(baseEntry.text);
  fireEvent.click(screen.getByRole('tab', { name: /Deleted/i }));
  await waitFor(() =>
    expect((pageRequests().at(-1)?.payload as { statuses?: string[] })?.statuses).toEqual([
      'deleted',
    ]),
  );
  const current = pageRequests().at(-1);
  // A reply that belongs to the earlier request arrives after the Deleted request went out.
  emit('memory.sage.listPage', {
    ...stamp(first),
    memories: [staleEntry],
    nextCursor: null,
    statusCounts: { stale: 1 },
  });
  expect(screen.queryByText(staleEntry.text)).toBeNull();
  emit('memory.sage.listPage', {
    ...stamp(current),
    memories: [deletedEntry],
    nextCursor: null,
    statusCounts: { deleted: 1 },
  });
  await screen.findByText(deletedEntry.text);
  expect(screen.queryByText(staleEntry.text)).toBeNull();
});
