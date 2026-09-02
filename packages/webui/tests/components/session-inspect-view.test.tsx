/**
 * SessionInspectView — React error "fewer hooks than during the previous
 * render" regression guard.
 *
 * The component used to early-return on `loading` / `error` / empty / no
 * payload before declaring two `useMemo` hooks (`filteredEvents`,
 * `sortedTools`). The first render ran fewer hooks than the data-arrival
 * render, and React's minified error fired in production builds.
 *
 * This suite asserts the loading → payload transition:
 *   1. Mounts with `payload=null` (the hook-light path).
 *   2. Flips `loading=true` (still hook-light).
 *   3. Flips `loading=false, payload=<full>` — the same render path real
 *      WS traffic exercises when the server replies with `session.inspect`.
 *   4. Asserts no React error boundary tripped and the data header
 *      rendered with the payload fields, proving the hook count stayed
 *      stable across the transition.
 */
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ── Shared test seams (hoisted so `vi.mock` factories can reference them) ──
const seams = vi.hoisted(() => {
  const inspectState = {
    inspectSessionId: null as string | null,
    wsConnected: true,
    payload: null as Record<string, unknown> | null,
    loading: false,
    error: null as string | null,
  };

  const inspectStoreState = {
    payload: null as Record<string, unknown> | null,
    loading: false,
    error: null as string | null,
  };

  const inspectSessionMock = vi.fn();

  // Actions attached to the store's `getState()` object. The component
  // calls `useSessionInspectStore.getState().setLoading(true)` from inside
  // a mount effect, and `clearPayload` from inside an unmount cleanup.
  // Mutating the same references `getState()` returns keeps the mock
  // self-consistent without forcing the test to coordinate two copies.
  const storeActions = {
    setPayload: vi.fn((p: Record<string, unknown>) => {
      inspectStoreState.payload = p;
    }),
    setLoading: vi.fn((v: boolean) => {
      inspectStoreState.loading = v;
    }),
    setError: vi.fn((e: string) => {
      inspectStoreState.error = e;
    }),
    clear: vi.fn(() => {
      inspectStoreState.payload = null;
      inspectStoreState.loading = false;
      inspectStoreState.error = null;
    }),
  };

  return {
    inspectState,
    inspectStoreState,
    inspectSessionMock,
    storeActions,
  };
});

// `useUIStore` is a Zustand selector hook. The component reads four fields;
// the mock just resolves the selector against our shared container so
// mutating `seams.inspectState` triggers the next render.
vi.mock('@/stores/ui-store', () => ({
  useUIStore: (selector: (s: typeof seams.inspectState) => unknown) => selector(seams.inspectState),
}));

vi.mock('@/stores/config-store', () => ({
  useConfigStore: (selector: (s: { wsConnected: boolean }) => unknown) =>
    selector({ wsConnected: seams.inspectState.wsConnected }),
}));

vi.mock('@/stores/session-inspect-store', () => {
  // The store surface the component reads:
  //   - hook(selector)               → Zustand selector form
  //   - hook.getState()              → returns { ...state, ...actions }
  //   - module.ensureInspectHandlerInstalled() → no-op in tests
  // Action methods are attached to the same object `getState()` returns so
  // `getState().setLoading(true)` and `getState().clear()` resolve to the
  // shared spies on `seams.storeActions`.
  const hook = (selector?: (s: typeof seams.inspectStoreState) => unknown) =>
    selector
      ? selector(seams.inspectStoreState)
      : { ...seams.inspectStoreState, ...seams.storeActions };
  hook.getState = () => ({
    payload: seams.inspectStoreState.payload,
    loading: seams.inspectStoreState.loading,
    error: seams.inspectStoreState.error,
    setPayload: seams.storeActions.setPayload,
    setLoading: seams.storeActions.setLoading,
    setError: seams.storeActions.setError,
    clear: seams.storeActions.clear,
  });
  return {
    ensureInspectHandlerInstalled: () => {},
    useSessionInspectStore: hook,
  };
});

vi.mock('@/hooks/useWebSocket', () => ({
  useWebSocket: () => ({ inspectSession: seams.inspectSessionMock }),
}));

// SidePanel/SessionList pulls many helpers; mock it to inert strings so
// the test focuses on the hook-order invariant.
vi.mock('@/components/SidePanel/SessionList', () => ({
  formatCompactNumber: (n: number) => `N${n}`,
  formatRelative: () => 'just now',
  formatSessionDuration: () => 'PT0S',
}));

import { SessionInspectView } from '@/components/SessionInspectView';

const PAYLOAD = {
  id: 'sess-abc123def456',
  title: 'Test session',
  name: 'Demo session',
  model: 'gpt-test',
  provider: 'test-provider',
  startedAt: new Date('2026-08-04T00:00:00Z').toISOString(),
  endedAt: new Date('2026-08-04T00:05:00Z').toISOString(),
  tokenTotal: 1234,
  outcome: 'completed',
  messageCount: 7,
  iterationCount: 3,
  toolCallCount: 5,
  toolErrorCount: 0,
  fileChangeCount: 2,
  compactionCount: 1,
  toolBreakdown: { read: 2, write: 3 },
  events: [
    { ts: new Date().toISOString(), type: 'user_input', label: 'User prompt', detail: '' },
    {
      ts: new Date().toISOString(),
      type: 'tool_call_end',
      label: 'read tool',
      detail: '/tmp/a.ts',
    },
  ],
  fileEvents: [
    { operation: 'create', filePath: '/tmp/a.ts', toolName: 'write', ts: new Date().toISOString() },
  ],
  lastUserMessage: 'Hello world',
};

describe('SessionInspectView — loading → payload transition', () => {
  beforeEach(() => {
    seams.inspectState.inspectSessionId = null;
    seams.inspectState.payload = null;
    seams.inspectState.loading = false;
    seams.inspectState.error = null;
    seams.inspectStoreState.payload = null;
    seams.inspectStoreState.loading = false;
    seams.inspectStoreState.error = null;
    seams.inspectSessionMock.mockReset();
    seams.storeActions.setPayload.mockClear();
    seams.storeActions.setLoading.mockClear();
    seams.storeActions.setError.mockClear();
    seams.storeActions.clear.mockClear();
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('does not throw across the loading → payload transition', async () => {
    // Phase 1: empty state — no session selected.
    const { rerender } = render(<SessionInspectView />);
    expect(screen.getByText(/No session selected/i)).toBeTruthy();

    // Phase 2: loading — component flips loading=true and dispatches
    // inspectSession over the WS.
    seams.inspectState.inspectSessionId = 'sess-abc123def456';
    seams.inspectState.loading = true;
    seams.inspectStoreState.loading = true;
    rerender(<SessionInspectView />);

    expect(screen.getByText(/Loading session inspection/i)).toBeTruthy();
    expect(seams.inspectSessionMock).toHaveBeenCalledWith('sess-abc123def456');

    // Phase 3: server replied, payload arrives, loading clears. This is
    // the transition that used to throw the React error because the
    // first render (loading) ran fewer hooks than this one (data). If
    // the hook order were still wrong, React would have logged an
    // uncaught error and rerender() would re-throw it before reaching
    // the assertions below.
    seams.inspectState.loading = false;
    seams.inspectStoreState.loading = false;
    seams.inspectStoreState.payload = PAYLOAD;
    seams.inspectState.payload = PAYLOAD;
    rerender(<SessionInspectView />);

    await waitFor(() => {
      expect(screen.getByText('Demo session')).toBeTruthy();
    });

    // Spot-check payload-driven fields to prove we're on the data render
    // path and not still on loading/empty.
    expect(screen.getByText(/test-provider\/gpt-test/)).toBeTruthy();
    expect(screen.getByText(/N1234/)).toBeTruthy(); // formatCompactNumber(1234)
    expect(screen.getByText(/Completed/i)).toBeTruthy();
    expect(screen.getByText('User prompt')).toBeTruthy();
    expect(screen.getByText('read tool')).toBeTruthy();
    // /tmp/a.ts appears twice — once as an event `detail`, once as a file
    // path. Both render paths matter; assert there are at least two.
    expect(screen.getAllByText('/tmp/a.ts').length).toBeGreaterThanOrEqual(2);
  });

  it('handles the payload → empty transition without throwing', () => {
    seams.inspectState.inspectSessionId = 'sess-abc123def456';
    seams.inspectState.payload = PAYLOAD;
    seams.inspectStoreState.payload = PAYLOAD;
    const { rerender } = render(<SessionInspectView />);
    expect(screen.getByText('Demo session')).toBeTruthy();

    // Clear back to no-session-selected. This exercises the reverse
    // transition (data → empty), which also crosses hook paths if
    // hooks were conditional. After clearing, the component's mount
    // effect chain re-runs: the cleanup useEffect calls `clear()`,
    // resetting `loading` to false, and the inspectId useEffect early
    // returns (no inspectSession dispatch). The DOM ends up on the
    // "No session selected" empty state.
    seams.inspectState.inspectSessionId = null;
    seams.inspectState.payload = null;
    seams.inspectStoreState.payload = null;
    seams.inspectStoreState.loading = false;
    rerender(<SessionInspectView />);

    expect(screen.getByText(/No session selected/i)).toBeTruthy();
  });

  it('does not throw across the error → payload transition', () => {
    // Mount with a session selected and an error populated — the
    // error-state branch (renders AlertTriangle + the error message).
    seams.inspectState.inspectSessionId = 'sess-abc123def456';
    seams.inspectStoreState.error = 'Session not found in archive';
    const { rerender } = render(<SessionInspectView />);
    expect(screen.getByText(/Session not found in archive/)).toBeTruthy();

    // Server eventually returns a payload after the transient error.
    // Crossing the error → data render path also used to throw because
    // the original useMemo hooks lived after these branches. Reaching
    // the data-path assertions below proves the hook count is stable.
    seams.inspectStoreState.error = null;
    seams.inspectStoreState.loading = false;
    seams.inspectStoreState.payload = PAYLOAD;
    seams.inspectState.payload = PAYLOAD;
    rerender(<SessionInspectView />);

    expect(screen.getByText('Demo session')).toBeTruthy();
    // The error-state AlertTriangle copy must be gone.
    expect(screen.queryByText(/Session not found in archive/)).toBeNull();
  });

  it('renders only matching events when the filter input has a value', async () => {
    // Land on the data render path directly. The component's mount effect
    // calls `setLoading(true)` whenever `inspectSessionId` is set; for the
    // filter test we already have a payload so we don't want the UI to
    // bounce through the loading screen. Make `setLoading` a no-op so
    // `loading` stays false and the data path stays mounted.
    seams.storeActions.setLoading.mockImplementation(() => {});

    seams.inspectState.inspectSessionId = 'sess-abc123def456';
    seams.inspectState.payload = PAYLOAD;
    seams.inspectStoreState.payload = PAYLOAD;
    seams.inspectStoreState.loading = false;
    const { rerender } = render(<SessionInspectView />);

    // Sanity: with no filter, both seeded events render.
    expect(screen.getByText('User prompt')).toBeTruthy();
    expect(screen.getByText('read tool')).toBeTruthy();

    // Type into the search box — the input is labelled "Filter events…".
    const filterInput = screen.getByPlaceholderText(/Filter events/i);
    fireEvent.change(filterInput, { target: { value: 'user' } });

    // The component filters by event `label` or `type` (case-insensitive).
    // "user" matches `user_input` (type) and would also match a label
    // containing "user"; here only the User prompt row qualifies, the
    // read tool row should drop out.
    await waitFor(() => {
      expect(screen.getByText('User prompt')).toBeTruthy();
      expect(screen.queryByText('read tool')).toBeNull();
    });

    // The count badge updates: `${filteredEvents.length} / ${payload.events.length}`.
    expect(screen.getByText('1 / 2')).toBeTruthy();

    // Clear the filter — both events come back without re-mounting
    // (proves the useMemo recompute didn't blow up the hook tree).
    fireEvent.change(filterInput, { target: { value: '' } });
    rerender(<SessionInspectView />);
    await waitFor(() => {
      expect(screen.getByText('User prompt')).toBeTruthy();
      expect(screen.getByText('read tool')).toBeTruthy();
      expect(screen.getByText('2 / 2')).toBeTruthy();
    });
  });
});
