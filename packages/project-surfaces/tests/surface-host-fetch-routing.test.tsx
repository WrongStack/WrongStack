/**
 * @vitest-environment jsdom
 *
 * Engine requests from shared surfaces go through the SurfaceHost (`host.fetch`).
 * On Desktop that is the only route to the engine (Tauri webview → project.http);
 * a raw `fetch('/api/…')` hits the webview origin, which serves no `/api`.
 */
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

import { act, type ReactNode } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@xyflow/react', async () => {
  const React = await import('react');
  const state = <T,>(init: T) => {
    const [v, set] = React.useState(init);
    return [v, set, () => {}] as const;
  };
  return {
    addEdge: (_c: unknown, e: unknown) => e,
    useReactFlow: () => ({ fitView: () => {} }),
    useNodesState: state,
    useEdgesState: state,
  };
});
vi.mock('@xyflow/react/dist/style.css', () => ({}));
vi.mock('../src/lib/i18n', () => ({
  useAppTranslation: () => ({ t: (k: string) => k }),
}));
vi.mock('../src/office/use-office-map-topology.js', () => ({
  useOfficeMapTopology: () => {},
}));
vi.mock('../src/office/feed', () => {
  const empty = new Map();
  const feed = {
    self: undefined,
    useVizEvents: () => [],
    useFleetAgents: () => empty,
    useAgentTranscripts: () => empty,
    useLeaderId: () => null,
    useLiveSessions: () => [],
    useMailboxMessages: () => [],
    useMailboxAgents: () => [],
  };
  return { useOfficeFeed: () => feed, EMPTY_TRANSCRIPT: [], WEBUI_SELF: { id: 'self' } };
});

import {
  type SurfaceHost,
  SurfaceHostProvider,
  setDefaultSurfaceHost,
  surfaceFetch,
} from '../src/host';
import { useKanbanRegistrySessionIds } from '../src/kanban/useKanbanRegistrySessionIds';
import { useOfficeMapCanvas } from '../src/office/use-office-map-canvas';

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });

function desktopLikeHost() {
  const calls: string[] = [];
  const host = {
    fetch: vi.fn(async (path: string, init?: RequestInit) => {
      calls.push(`${init?.method ?? 'GET'} ${path}`);
      if (path === '/api/sessions')
        return json([{ sessionId: 's-live' }, { sessionId: 's-other' }]);
      if (path === '/api/fleet/broadcast') return json({ delivered: 2, targets: 2 });
      return json({ error: 'unknown' }, 404);
    }),
  } as unknown as SurfaceHost;
  return { host, calls };
}

async function mount(node: ReactNode) {
  const el = document.createElement('div');
  document.body.appendChild(el);
  const root = createRoot(el);
  await act(async () => root.render(node));
  return root;
}
const flush = () =>
  act(async () => {
    for (let i = 0; i < 5; i++) await Promise.resolve();
  });

afterEach(() => vi.unstubAllGlobals());

describe('surface engine requests use the host fetch', () => {
  it('surfaceFetch reaches the active host', async () => {
    const { host, calls } = desktopLikeHost();
    setDefaultSurfaceHost(host);
    const res = await surfaceFetch('/api/sessions');
    expect(res.status).toBe(200);
    expect(calls).toEqual(['GET /api/sessions']);
  });

  it('kanban registry session ids come from host.fetch', async () => {
    const webview = vi.fn(async () => new Response('<!doctype html>', { status: 404 }));
    vi.stubGlobal('fetch', webview);
    const { host, calls } = desktopLikeHost();
    let seen: string[] = [];
    function Probe() {
      seen = useKanbanRegistrySessionIds();
      return null;
    }
    const root = await mount(
      <SurfaceHostProvider host={host}>
        <Probe />
      </SurfaceHostProvider>,
    );
    await flush();
    await act(async () => root.unmount());
    expect(calls).toEqual(['GET /api/sessions']);
    expect(webview).not.toHaveBeenCalled();
    expect(seen).toEqual(['s-live', 's-other']);
  });

  it('office broadcast posts through host.fetch', async () => {
    const webview = vi.fn(async () => new Response('<!doctype html>', { status: 404 }));
    vi.stubGlobal('fetch', webview);
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    const { host, calls } = desktopLikeHost();
    let api: ReturnType<typeof useOfficeMapCanvas> | undefined;
    function Probe() {
      api = useOfficeMapCanvas();
      return null;
    }
    const root = await mount(
      <SurfaceHostProvider host={host}>
        <Probe />
      </SurfaceHostProvider>,
    );
    await act(async () => api!.setBroadcastDraft('status check'));
    await act(async () => {
      await api!.sendBroadcast();
    });
    await flush();
    await act(async () => root.unmount());
    expect(calls).toContain('POST /api/fleet/broadcast');
    expect(api!.broadcastResult).toBe('Delivered to 2/2 session(s)');
  });
});
