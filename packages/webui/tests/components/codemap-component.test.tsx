import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

class ResizeObserverPolyfill {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
vi.stubGlobal('ResizeObserver', ResizeObserverPolyfill);

if (typeof globalThis.DOMMatrix === 'undefined') {
  vi.stubGlobal(
    'DOMMatrix',
    class {
      multiply(): unknown {
        return this;
      }
    },
  );
}

const { CodeMap } = await import('../../src/components/CodeMap');
const { useCodemapActivityStore } = await import('../../src/stores/codemap-activity-store');

const agentFile = '/workspace/packages/core/src/agent.ts';
const toolFile = '/workspace/packages/core/src/tool.ts';

const mockPackageGraph = {
  nodes: [
    {
      id: 'pkg:core',
      label: '@wrongstack/core',
      kind: 'package',
      package: '@wrongstack/core',
      symbolCount: 120,
      fileCount: 30,
    },
    {
      id: 'pkg:cli',
      label: '@wrongstack/cli',
      kind: 'package',
      package: '@wrongstack/cli',
      symbolCount: 80,
      fileCount: 20,
    },
  ],
  edges: [{ source: 'pkg:cli', target: 'pkg:core', weight: 5, refType: 'import' }],
};

const mockFileGraph = {
  nodes: [
    {
      id: `file:${agentFile}`,
      label: 'agent.ts',
      kind: 'file',
      package: '@wrongstack/core',
      file: agentFile,
      symbolCount: 15,
      lang: 'ts',
    },
    {
      id: `file:${toolFile}`,
      label: 'tool.ts',
      kind: 'file',
      package: '@wrongstack/core',
      file: toolFile,
      symbolCount: 8,
      lang: 'ts',
    },
  ],
  edges: [{ source: `file:${agentFile}`, target: `file:${toolFile}`, weight: 3, refType: 'call' }],
};

const mockSymbolGraph = {
  nodes: [
    {
      id: 'sym:1',
      label: 'runAgent',
      kind: 'symbol',
      package: '@wrongstack/core',
      file: agentFile,
      symbolId: 1,
      symbolKind: 'function',
      line: 12,
      signature: 'function runAgent(): void',
    },
    {
      id: 'sym:2',
      label: 'readTool',
      kind: 'symbol',
      package: '@wrongstack/core',
      file: toolFile,
      symbolId: 2,
      symbolKind: 'function',
      line: 4,
      signature: 'function readTool(): void',
      external: true,
    },
  ],
  edges: [{ source: 'sym:1', target: 'sym:2', weight: 2, refType: 'call' }],
};

const mockFetch = vi.fn();
vi.stubGlobal('fetch', mockFetch);

function mockAllGraphs(): void {
  mockFetch.mockImplementation(async (input: string | URL) => {
    const url = typeof input === 'string' ? input : input.toString();
    const data = url.includes('/api/codemap/packages')
      ? mockPackageGraph
      : url.includes('/api/codemap/files')
        ? mockFileGraph
        : url.includes('/api/codemap/symbols')
          ? mockSymbolGraph
          : undefined;
    if (!data)
      return {
        ok: false,
        status: 404,
        statusText: 'Not Found',
        json: async () => ({ error: 'not found' }),
      } as Response;
    return { ok: true, statusText: 'OK', json: async () => data } as Response;
  });
}

async function openCoreFileMap(): Promise<void> {
  await waitFor(() => expect(graphNode('@wrongstack/core')).toBeDefined());
  const open = graphNode('@wrongstack/core')
    .closest('.react-flow__node')
    ?.querySelector('button[aria-label="Open @wrongstack/core map"]');
  expect(open).toBeTruthy();
  fireEvent.click(open!);
  await waitFor(() => expect(graphNode('agent.ts')).toBeDefined());
}

function graphNode(label: string): HTMLElement {
  const text = screen.getAllByText(label).find((element) => element.closest('.react-flow__node'));
  const node = text?.closest('button');
  if (!(node instanceof HTMLElement)) throw new Error(`Graph node not found: ${label}`);
  return node;
}

describe('CodeMap component', () => {
  beforeEach(() => {
    mockFetch.mockReset();
    useCodemapActivityStore.getState().clear();
  });

  afterEach(() => cleanup());

  it('renders the persistent atlas shell and package graph', async () => {
    mockAllGraphs();
    render(<CodeMap />);

    await waitFor(() => {
      expect(screen.getByText('Code Atlas')).toBeDefined();
      expect(screen.getByText('Code tree')).toBeDefined();
      expect(screen.getByText('Relation inspector')).toBeDefined();
      expect(graphNode('@wrongstack/core')).toBeDefined();
    });
  });

  it('shows a loading state while the graph request is pending', () => {
    mockFetch.mockReturnValue(new Promise(() => {}));
    render(<CodeMap />);
    expect(screen.getByText('Mapping relationships')).toBeDefined();
  });

  it('shows index guidance when the backend reports an unavailable map', async () => {
    mockFetch.mockResolvedValue({
      ok: false,
      status: 503,
      statusText: 'Service Unavailable',
      json: async () => ({ error: 'CodeMap index unavailable' }),
    } as Response);
    render(<CodeMap />);

    await waitFor(() => expect(screen.getByText('CodeMap index unavailable')).toBeDefined());
    expect(screen.getByText(/codebase-index/)).toBeDefined();
  });

  it('shows an auth error instead of index guidance when credentials are rejected', async () => {
    // A 401 is NOT a missing index — the view must say so instead of
    // telling the operator to run codebase-index.
    mockFetch.mockResolvedValue({
      ok: false,
      status: 401,
      statusText: 'Unauthorized',
      json: async () => ({ error: 'Unauthorized' }),
    } as Response);
    render(<CodeMap />);

    await waitFor(() => expect(screen.getByText(/Authentication required/)).toBeDefined());
    expect(screen.queryByText(/codebase-index/)).toBeNull();
  });

  it('focuses a node on click and renders its incoming/outgoing relation tree', async () => {
    mockAllGraphs();
    render(<CodeMap />);
    await waitFor(() => expect(graphNode('@wrongstack/core')).toBeDefined());
    const core = graphNode('@wrongstack/core');

    fireEvent.click(core);

    await waitFor(() => {
      expect(screen.getByText('Who depends on this')).toBeDefined();
      expect(screen.getByText('What this depends on')).toBeDefined();
      expect(
        screen.getByRole('button', { name: /Expand relation @wrongstack\/cli/ }),
      ).toBeDefined();
    });
    // A focus click must not replace the architecture with a file list.
    expect(graphNode('@wrongstack/cli')).toBeDefined();
  });

  it('opens a package explicitly while keeping the code tree visible', async () => {
    mockAllGraphs();
    render(<CodeMap />);

    await openCoreFileMap();

    expect(screen.getByText('Code tree')).toBeDefined();
    expect(graphNode('tool.ts')).toBeDefined();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDefined();
  });

  it('navigates back from file graph to the cached package graph', async () => {
    mockAllGraphs();
    render(<CodeMap />);
    await openCoreFileMap();

    fireEvent.click(screen.getByRole('button', { name: 'Back' }));

    await waitFor(() => expect(graphNode('@wrongstack/core')).toBeDefined());
    expect(
      mockFetch.mock.calls.filter(([url]) => String(url).includes('/api/codemap/packages')),
    ).toHaveLength(1);
  });

  it('switches to relationship-orbit layout without losing the selected node', async () => {
    mockAllGraphs();
    render(<CodeMap />);
    await waitFor(() => expect(graphNode('@wrongstack/core')).toBeDefined());
    const core = graphNode('@wrongstack/core');
    fireEvent.click(core);

    fireEvent.click(screen.getByRole('button', { name: 'Relations' }));

    expect(screen.getByText('Who depends on this')).toBeDefined();
    expect(graphNode('@wrongstack/core')).toBeDefined();
  });

  it('opens and closes file activity from a Shift+click', async () => {
    mockAllGraphs();
    render(<CodeMap />);
    await openCoreFileMap();

    fireEvent.click(graphNode('agent.ts'), { shiftKey: true });
    await waitFor(() => expect(screen.getByText(agentFile)).toBeDefined());

    fireEvent.click(screen.getByRole('button', { name: 'Close activity' }));
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Close activity' })).toBeNull(),
    );
  });

  it('shows recorded activity details in the file drawer', async () => {
    mockAllGraphs();
    render(<CodeMap />);
    await openCoreFileMap();
    act(() =>
      useCodemapActivityStore.getState().recordActivity({
        filePath: agentFile,
        type: 'edit',
        timestamp: Date.now(),
        toolName: 'edit',
        summary: 'Updated agent routing',
        agent: 'test-agent',
        status: 'completed',
        durationMs: 37,
        watcherConfirmed: true,
        change: { added: 2, removed: 1, before: 'old route', after: 'new route' },
      }),
    );

    fireEvent.click(graphNode('agent.ts'), { shiftKey: true });

    await waitFor(() => {
      expect(screen.getAllByText('edit').length).toBeGreaterThan(0);
      expect(screen.getByText('via edit')).toBeDefined();
      expect(screen.getAllByText('test-agent').length).toBeGreaterThan(0);
      expect(screen.getAllByText('+2').length).toBeGreaterThan(0);
      expect(screen.getAllByText('−1').length).toBeGreaterThan(0);
      expect(screen.getByText('fs verified')).toBeDefined();
    });
  });

  it('shows a live agent on the mapped node and resolves its current function', async () => {
    mockAllGraphs();
    render(<CodeMap />);
    await waitFor(() => expect(graphNode('@wrongstack/core')).toBeDefined());

    act(() =>
      useCodemapActivityStore.getState().startActivities([
        {
          id: 'live-tool:0',
          toolUseId: 'live-tool',
          filePath: agentFile,
          type: 'read',
          toolName: 'read',
          summary: 'read current implementation',
          timestamp: Date.now(),
          status: 'active',
          source: 'tool',
          sessionId: 'session-live',
          agentId: 'agent-live',
          agentName: 'IMPLEMENTER',
          line: 14,
          attribution: 'exact',
        },
      ]),
    );

    await waitFor(() => {
      expect(screen.getByText('Live agent operations')).toBeDefined();
      expect(screen.getAllByText('IMPLEMENTER').length).toBeGreaterThan(0);
      expect(screen.getAllByText('runAgent').length).toBeGreaterThan(0);
      expect(screen.getAllByText('LIVE').length).toBeGreaterThan(0);
    });

    expect(screen.getByLabelText('Filter CodeMap by agent and session')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Follow' }));
    await waitFor(() => expect(screen.getAllByText('src/agent.ts').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByRole('button', { name: 'Live' }));
    expect(screen.getByRole('button', { name: 'Resume' })).toBeDefined();

    act(() =>
      useCodemapActivityStore.getState().finishTool('live-tool', {
        ok: true,
        durationMs: 50,
      }),
    );
    expect(screen.getByText('Live agent operations')).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(screen.queryByText('Live agent operations')).toBeNull());
  });

  it('draws an animated temporal trail between files touched by the same agent', async () => {
    mockAllGraphs();
    render(<CodeMap />);
    await openCoreFileMap();

    act(() => {
      const store = useCodemapActivityStore.getState();
      store.recordActivity({
        filePath: agentFile,
        type: 'read',
        toolName: 'read',
        summary: 'inspect agent',
        timestamp: 100,
        status: 'completed',
        sessionId: 'trail-session',
        agentId: 'trail-agent',
        agentName: 'TRAILER',
      });
      store.recordActivity({
        filePath: toolFile,
        type: 'edit',
        toolName: 'edit',
        summary: 'update tool',
        timestamp: 200,
        status: 'completed',
        sessionId: 'trail-session',
        agentId: 'trail-agent',
        agentName: 'TRAILER',
      });
    });

    await waitFor(() =>
      expect(screen.getByTestId('agent-trail-count').textContent).toContain('×1'),
    );
  });
});
