// @vitest-environment jsdom
//
// Hook-level coverage for `useSidebarWrongProxy`'s health-body parsing.
// The WrongProxy daemon's `/api/health` body carries WrongTrace IPC
// metadata (`socket_path`, `version`) — see `WrongTraceHealth` in
// `@wrongstack/wrongtrace`. The hook must capture both on 2xx, tolerate
// a non-JSON body without failing the probe, and leave the IPC fields
// undefined on any transport failure (down state).

import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useSidebarWrongProxy } from '../src/hooks/use-sidebar-panel-data.js';

// The hook module statically imports `@wrongstack/tools` (for the
// ProcessList twin's getProcessRegistry), whose real module chain pulls
// the native tree-sitter parser — that fails to load under jsdom
// ("The URL must be of scheme file"). Mock the surface the module-level
// import needs, following the same convention as
// connections-health.test.ts / kill-ps-slash.test.ts. The dynamic
// `@wrongstack/kanban` import inside useSidebarKanban never runs here.
vi.mock('@wrongstack/tools', () => ({
  getProcessRegistry: vi.fn(() => ({ processes: [] })),
}));

const URL_UNDER_TEST = 'http://localhost:3444';

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

/** Fetch stub resolving with a real `Response` — `json()` keeps true
 *  rejection semantics, which the non-JSON-tolerance case depends on. */
function stubFetchWith(body: string, status = 200): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(
      async () => new Response(body, { status, headers: { 'content-type': 'application/json' } }),
    ),
  );
}

/** Fetch stub that rejects like a dead daemon (ECONNREFUSED-style). */
function stubFetchRefusing(message = 'ECONNREFUSED'): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      throw new Error(message);
    }),
  );
}

describe('useSidebarWrongProxy health-body parsing', () => {
  it('captures socket_path and version from a 2xx JSON health body', async () => {
    stubFetchWith(
      JSON.stringify({ ok: true, socket_path: '\\\\.\\pipe\\wrongtrace', version: '0.3.3' }),
    );
    const { result } = renderHook(() => useSidebarWrongProxy(URL_UNDER_TEST, true));

    await waitFor(() => expect(result.current?.status).toBe('ok'));
    expect(result.current).toMatchObject({
      url: URL_UNDER_TEST,
      status: 'ok',
      socketPath: '\\\\.\\pipe\\wrongtrace',
      version: '0.3.3',
    });
    // The probe hits the canonical health endpoint shared with the
    // runtime probe in packages/cli/src/wiring/proxy-probe.ts.
    expect(fetch).toHaveBeenCalledWith(
      `${URL_UNDER_TEST}/api/health`,
      expect.objectContaining({ method: 'GET' }),
    );
  });

  it('tolerates a non-JSON 2xx body — stays ok with IPC fields undefined', async () => {
    stubFetchWith('gateway overheating (plain text)', 200);
    const { result } = renderHook(() => useSidebarWrongProxy(URL_UNDER_TEST, true));

    await waitFor(() => expect(result.current?.status).toBe('ok'));
    // Body parsing is decorative: reachability is what matters.
    expect(result.current?.socketPath).toBeUndefined();
    expect(result.current?.version).toBeUndefined();
    expect(result.current?.detail).toBeUndefined();
  });

  it('leaves IPC fields undefined when the daemon is unreachable', async () => {
    stubFetchRefusing();
    const { result } = renderHook(() => useSidebarWrongProxy(URL_UNDER_TEST, true));

    await waitFor(() => expect(result.current?.status).toBe('down'));
    expect(result.current).toMatchObject({ status: 'down', detail: 'ECONNREFUSED' });
    expect(result.current?.socketPath).toBeUndefined();
    expect(result.current?.version).toBeUndefined();
  });

  it('ignores empty-string socket_path/version fields', async () => {
    stubFetchWith(JSON.stringify({ ok: true, socket_path: '', version: '' }));
    const { result } = renderHook(() => useSidebarWrongProxy(URL_UNDER_TEST, true));

    await waitFor(() => expect(result.current?.status).toBe('ok'));
    // Empty strings are treated as absent so the sidebar omits the
    // IPC rows rather than rendering valueless labels.
    expect(result.current?.socketPath).toBeUndefined();
    expect(result.current?.version).toBeUndefined();
  });
});
