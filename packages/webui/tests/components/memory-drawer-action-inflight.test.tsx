/**
 * Regression test for the WebUI file drawer's in-flight action state.
 *
 * The drawer keeps a per-memory pending state so an action's buttons stay
 * disabled while the parent runs. The parent wired those actions to
 * `state.sendWithAck(...)`, which was fire-and-forget (it returned `void`),
 * so the drawer's `await handler(...)` resolved on the next microtask and
 * the pending state was dropped while the store had not answered yet. The
 * button was enabled again and the operator could submit the same
 * destructive action twice.
 *
 * `useSendWithAck` now returns a promise that settles with the operation.
 *
 * See: packages/webui/src/components/MemoryManager/useSendWithAck.ts
 *       packages/webui/src/components/MemoryManager/index.tsx
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
  on: client.on,
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
  findMemoriesForFile: (payload: unknown) => sends.push({ type: 'memory.sage.forFile', payload }),
};

vi.mock('@/lib/roster-ws', () => ({
  sendRosterMessage: () => Promise.resolve({ roles: [] }),
}));
vi.mock('@/hooks/useWebSocket', () => ({ useWebSocket: () => websocket }));
vi.mock('@/hooks/useScrollPosition', () => ({ useScrollPosition: () => ({ current: null }) }));
vi.mock('@wrongstack/project-surfaces/sage/MemoryGraph', () => ({
  MemoryGraph: ({ graphEdges }: { graphEdges: unknown[] }) => (
    <div data-testid="memory-graph" data-edge-count={graphEdges.length} />
  ),
}));
// The file drawer reads through the singleton client (`useMemoryForFile` calls
// `getWSClient()` directly), so the mock client has to be handed out here too.
vi.mock('@/lib/ws-client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/ws-client')>();
  return { ...actual, getWSClient: () => websocket };
});

import { MemoryManager } from '../../src/components/MemoryManager/index.js';
import { useConfigStore } from '../../src/stores/config-store.js';

const FILE_PATH = 'packages/webui/src/lib/ws-client.ts';

const anchoredMemory: SageEntry = {
  id: 'mem_anchored',
  revision: 3,
  scope: 'project',
  kind: 'decision',
  status: 'active',
  text: 'The WebUI uses a singleton WebSocket client for all server events.',
  importance: 0.9,
  confidence: 0.85,
  freshness: 0.95,
  tags: ['webui'],
  anchors: [{ type: 'file', path: FILE_PATH }],
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-16T08:00:00.000Z',
};

const reviewedMemory: SageEntry = {
  ...anchoredMemory,
  id: 'mem_reviewed',
  text: 'A memory that hygiene flagged for deletion.',
};

const stats: SageStats = {
  total: 1,
  byStatus: { active: 1 },
  byKind: { decision: 1 },
  edges: 0,
};

function emit(type: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(type) ?? []) handler({ type, payload });
  });
}

function resolveRequests() {
  return sends.filter((entry) => entry.type === 'memory.sage.candidateResolve');
}

function lastRequestId() {
  const requests = resolveRequests();
  const payload = requests[requests.length - 1]?.payload as { requestId?: string } | undefined;
  return payload?.requestId;
}

async function openDrawer() {
  render(<MemoryManager />);
  await waitFor(() =>
    expect(sends.some((entry) => entry.type === 'memory.sage.listPage')).toBe(true),
  );
  emit('memory.sage.listPage', {
    memories: [anchoredMemory],
    nextCursor: null,
    statusCounts: { active: 1 },
    stats,
  });
  await screen.findByText(anchoredMemory.text);
  // The drawer lives in the detail pane, so a memory has to be selected.
  fireEvent.click(screen.getByText(anchoredMemory.text));
  await waitFor(() => expect(screen.getByTestId('memory-drawer-file-select')).toBeTruthy());

  fireEvent.change(screen.getByTestId('memory-drawer-file-select'), {
    target: { value: FILE_PATH },
  });
  await waitFor(() =>
    expect(sends.some((entry) => entry.type === 'memory.sage.forFile')).toBe(true),
  );

  emit('memory.sage.forFile', {
    response: {
      filePath: FILE_PATH,
      primaryMatches: [
        {
          memory: reviewedMemory,
          matchedVia: 'anchor_file',
          matchStrength: 0.9,
          pendingReview: {
            candidateId: 'cand_1',
            suggestedAction: 'delete',
            reason: 'never used',
            ageDays: 30,
          },
        },
      ],
      symbolMatches: [],
      relatedMatches: [],
      totalCount: 1,
      activeCount: 1,
      supersededCount: 0,
      reviewPendingCount: 1,
    },
  });
}

function acceptButton() {
  return screen.getByRole('button', { name: /Accept Deletion/i }) as HTMLButtonElement;
}

beforeEach(() => {
  sends.length = 0;
  handlers.clear();
  useConfigStore.setState({ wsConnected: true, wsStatus: { state: 'open' } });
  vi.restoreAllMocks();
});

describe('MemoryManager · file drawer action in-flight state', () => {
  it('keeps the action button disabled until the acknowledgement arrives', async () => {
    await openDrawer();
    const accept = await screen.findByRole('button', { name: /Accept Deletion/i });

    fireEvent.click(accept);
    await act(async () => {
      await Promise.resolve();
    });

    expect(acceptButton().disabled).toBe(true);
    expect(resolveRequests()).toHaveLength(1);

    // The store answers -> the action is over and the button is released.
    emit('memory.sage.candidateResolve', {
      candidate: { id: 'cand_1', status: 'accepted' },
      resolvedAction: 'accept',
      requestId: lastRequestId(),
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(acceptButton().disabled).toBe(false);
  });

  it('does not submit the action twice while it is pending', async () => {
    await openDrawer();
    const accept = await screen.findByRole('button', { name: /Accept Deletion/i });

    fireEvent.click(accept);
    await act(async () => {
      await Promise.resolve();
    });
    fireEvent.click(acceptButton());
    await act(async () => {
      await Promise.resolve();
    });

    expect(resolveRequests()).toHaveLength(1);
  });
});
