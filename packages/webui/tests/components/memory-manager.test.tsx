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

describe('MemoryManager', () => {
  it('loads the persisted relationship graph when a memory is selected', async () => {
    await loadManager();
    fireEvent.click(screen.getByText(memory.text));

    expect(sends).toContainEqual({
      type: 'memory.sage.graph',
      payload: { query: memory.id, maxDepth: 1, limit: 120 },
    });
    emit('memory.sage.graph', {
      query: memory.id,
      edges: [
        {
          id: 'edge-related',
          from: `mem:${memory.id}`,
          to: `mem:${secondMemory.id}`,
          relation: 'same_topic',
          weight: 0.82,
          evidence: ['tag:webui'],
          createdAt: '2026-07-19T00:00:00.000Z',
        },
      ],
      memories: [memory, secondMemory],
    });

    await waitFor(() => {
      expect(screen.getByTestId('memory-graph').getAttribute('data-edge-count')).toBe('1');
    });
  });

  it('loads SAGE records and filters the operator library', async () => {
    await loadManager();

    expect(screen.getByText(secondMemory.text)).toBeTruthy();
    expect(screen.getByText('2 visible')).toBeTruthy();

    fireEvent.change(screen.getByRole('textbox', { name: 'Search memories' }), {
      target: { value: 'singleton' },
    });

    expect(screen.getByText(memory.text)).toBeTruthy();
    expect(screen.queryByText(secondMemory.text)).toBeNull();
    expect(screen.getByText('1 of 2 memories')).toBeTruthy();
  });

  it('creates a fully described memory with scope, scores, anchors, and relationships', async () => {
    await loadManager();
    fireEvent.click(screen.getByRole('button', { name: 'New memory' }));
    const editor = await screen.findByRole('textbox', { name: 'Memory content' });

    fireEvent.change(editor, {
      target: { value: 'Use stable IDs for every durable relationship.' },
    });
    fireEvent.change(screen.getByLabelText('Scope'), { target: { value: 'user' } });
    fireEvent.change(screen.getByLabelText('Tags'), { target: { value: 'memory, identity' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add anchor' }));
    fireEvent.change(screen.getByLabelText('Anchor 1 value'), {
      target: { value: 'packages/sage/src/store.ts' },
    });
    fireEvent.change(screen.getByLabelText('Supersedes'), { target: { value: memory.id } });
    fireEvent.click(screen.getByRole('button', { name: 'Create memory' }));

    const request = sends.find((entry) => entry.type === 'memory.sage.remember');
    expect(request).toEqual({
      type: 'memory.sage.remember',
      payload: expect.objectContaining({
        text: 'Use stable IDs for every durable relationship.',
        scope: 'user',
        tags: ['memory', 'identity'],
        freshness: 1,
        anchors: [{ type: 'file', path: 'packages/sage/src/store.ts' }],
        supersedes: [memory.id],
      }),
    });
  });

  it('keeps the editor and draft visible when create fails', async () => {
    await loadManager();
    fireEvent.click(screen.getByRole('button', { name: 'New memory' }));
    const editor = await screen.findByRole('textbox', { name: 'Memory content' });
    fireEvent.change(editor, { target: { value: 'A draft that must survive.' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create memory' }));

    emit('memory.sage.remember', { error: 'Duplicate memory exists.' });

    expect(screen.getByRole('alert').textContent).toContain('Duplicate memory exists.');
    expect(
      (screen.getByRole('textbox', { name: 'Memory content' }) as HTMLTextAreaElement).value,
    ).toBe('A draft that must survive.');
  });

  it('uses an accessible confirmation dialog before deleting a record', async () => {
    await loadManager();
    fireEvent.click(screen.getByText(memory.text));
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));

    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByText('Delete this memory?')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Delete memory' }));

    expect(sends).toContainEqual({
      type: 'memory.sage.delete',
      payload: {
        id: memory.id,
        reason: 'Deleted from the WebUI Memory Manager.',
      },
    });

    emit('memory.sage.delete', { success: true, message: 'Deleted.' });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });
});
