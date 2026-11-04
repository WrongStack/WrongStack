/**
 * Regression test for in-flight SAGE mutations in the WebUI Memory Manager.
 *
 * The list-reload effect used to share its teardown with the filter-driven
 * reload, so every status/kind/search change tore down the in-flight
 * mutation as well: the reply was never handled, the editor stayed disabled
 * forever, and a memory the server had already saved looked like a failed
 * save.
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

const savedEntry: SageEntry = {
  ...baseEntry,
  id: 'mem_saved',
  revision: 1,
  text: 'A memory the server accepted while the operator changed a filter.',
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

function lastListPageRequest() {
  const listSends = sends.filter((entry) => entry.type === 'memory.sage.listPage');
  return listSends[listSends.length - 1]?.payload as
    | { statuses?: string[]; query?: string }
    | undefined;
}

async function renderManager() {
  const utils = render(<MemoryManager />);
  await waitFor(() => expect(lastListPageRequest()).toBeTruthy());
  emit('memory.sage.listPage', {
    memories: [baseEntry],
    nextCursor: null,
    statusCounts: { active: 1 },
    stats,
  });
  await screen.findByText(baseEntry.text);
  return utils;
}

async function submitMemory() {
  fireEvent.click(screen.getByRole('button', { name: 'New memory' }));
  const editor = await screen.findByRole('textbox', { name: 'Memory content' });
  fireEvent.change(editor, { target: { value: savedEntry.text } });
  fireEvent.click(screen.getByRole('button', { name: 'Create memory' }));
  expect(sends).toContainEqual(expect.objectContaining({ type: 'memory.sage.remember' }));
  await waitFor(() => {
    const button = screen.getByRole('button', {
      name: /Create memory|Saving/i,
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });
}

/** The mutation settled when the editor left its busy state. */
function mutationSettled() {
  const button = screen.queryByRole('button', {
    name: /Create memory|Saving/i,
  }) as HTMLButtonElement | null;
  if (!button) return true; // the editor closed on success
  return !button.disabled;
}

beforeEach(() => {
  sends.length = 0;
  handlers.clear();
  useConfigStore.setState({ wsConnected: true, wsStatus: { state: 'open' } });
  vi.restoreAllMocks();
});

describe('MemoryManager · in-flight mutations', () => {
  it('settles an accepted create whose reply arrives after a filter change', async () => {
    await renderManager();
    await submitMemory();

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'stale' } });
    await waitFor(() => expect(lastListPageRequest()?.statuses).toEqual(['stale']));

    emit('memory.sage.remember', { memory: savedEntry });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mutationSettled()).toBe(true);
  });

  it('settles a rejected create whose reply arrives after a filter change', async () => {
    await renderManager();
    await submitMemory();

    fireEvent.change(screen.getByLabelText('Filter by status'), { target: { value: 'stale' } });
    await waitFor(() => expect(lastListPageRequest()?.statuses).toEqual(['stale']));

    emit('memory.sage.remember', { error: 'Duplicate memory exists.' });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mutationSettled()).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('Duplicate memory exists.');
  });

  it('settles an accepted create whose reply arrives after a search reload', async () => {
    await renderManager();
    await submitMemory();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search memories' }), {
      target: { value: 'singleton' },
    });
    await waitFor(() => expect(lastListPageRequest()?.query).toBe('singleton'));

    emit('memory.sage.remember', { memory: savedEntry });
    await act(async () => {
      await Promise.resolve();
    });

    expect(mutationSettled()).toBe(true);
  });

  it('does not throw when the view unmounts while a create is in flight', async () => {
    const { unmount } = await renderManager();
    await submitMemory();

    unmount();
    expect(() => emit('memory.sage.remember', { memory: savedEntry })).not.toThrow();
  });
});
