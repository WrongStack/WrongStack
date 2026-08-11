/**
 * Regression test for "Edit button does nothing" — clicking the Edit button
 * on the MemoryDetail panel must open the MemoryEditor prefilled with the
 * selected memory's content. The Edit button passes `memory.id` (not the
 * closure-captured `selectedMemory`) so the editor resolves the target
 * record directly from the `memories` list and never sees a stale selection.
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
  rememberSage: (payload: unknown) => sends.push({ type: 'memory.sage.remember', payload }),
  updateSage: (id: string, patch: unknown) =>
    sends.push({ type: 'memory.sage.update', payload: { id, ...(patch as object) } }),
  deleteSage: (id: string, reason?: string) =>
    sends.push({ type: 'memory.sage.delete', payload: { id, reason } }),
};

// Stub `agent-roster.list` (used by MemoryEditor on mount) so the editor
// doesn't try to talk to a real backend during the test.
vi.mock('@/lib/roster-ws', () => ({
  sendRosterMessage: () => Promise.resolve({ roles: [] }),
}));

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => websocket,
}));

vi.mock('@/hooks/useScrollPosition', () => ({
  useScrollPosition: () => ({ current: null }),
}));

vi.mock('@/components/MemoryManager/MemoryGraph', () => ({
  MemoryGraph: ({ graphEdges }: { graphEdges: unknown[] }) => (
    <div data-testid="memory-graph" data-edge-count={graphEdges.length} />
  ),
}));

import { MemoryManager } from '../../src/components/MemoryManager/index.js';
import { useConfigStore } from '../../src/stores/config-store.js';

const memory: SageEntry = {
  id: 'mem_architecture',
  revision: 3,
  scope: 'project',
  kind: 'decision',
  status: 'active',
  text: 'The WebUI uses a singleton WebSocket client for all server events.',
  importance: 0.9,
  confidence: 0.85,
  freshness: 0.95,
  tags: ['webui', 'architecture'],
  anchors: [{ type: 'file', path: 'packages/webui/src/lib/ws-client.ts' }],
  createdAt: '2026-07-15T08:00:00.000Z',
  updatedAt: '2026-07-16T08:00:00.000Z',
};

const secondMemory: SageEntry = {
  ...memory,
  id: 'mem_testing',
  revision: 1,
  kind: 'workflow',
  text: 'Run focused WebUI tests before the package typecheck.',
  tags: ['testing'],
};

const stats: SageStats = {
  total: 2,
  byStatus: { active: 2 },
  byKind: { decision: 1, workflow: 1 },
  edges: 1,
};

function emit(type: string, payload: unknown) {
  act(() => {
    for (const handler of handlers.get(type) ?? []) handler({ type, payload });
  });
}

async function loadManager() {
  render(<MemoryManager />);
  expect(sends).toContainEqual(expect.objectContaining({ type: 'memory.sage.listPage' }));
  emit('memory.sage.listPage', {
    memories: [memory, secondMemory],
    nextCursor: null,
    statusCounts: { active: 2 },
    stats,
  });
  await screen.findByText(memory.text);
}

beforeEach(() => {
  sends.length = 0;
  handlers.clear();
  useConfigStore.setState({ wsConnected: true, wsStatus: { state: 'open' } });
  vi.restoreAllMocks();
});

describe('MemoryManager — Edit button', () => {
  it('opens the editor prefilled with the selected memory when Edit is clicked', async () => {
    await loadManager();
    fireEvent.click(screen.getByText(memory.text));

    // MemoryDetail should be visible with the Edit button.
    const editButton = await screen.findByRole('button', { name: 'Edit' });
    fireEvent.click(editButton);

    // The MemoryEditor should now be mounted with a prefilled textbox.
    await waitFor(() => {
      expect(screen.getByRole('textbox', { name: 'Memory content' })).toBeTruthy();
    });
    const editor = screen.getByRole('textbox', { name: 'Memory content' }) as HTMLTextAreaElement;
    expect(editor.value).toBe(memory.text);

    // Save Changes button should be visible (edit mode).
    expect(screen.getByRole('button', { name: 'Save changes' })).toBeTruthy();
  });
});
