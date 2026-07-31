/**
 * Tests for the HQ store (`src/store.ts`) — the React-based global store,
 * API helpers, and command/mailbox-send wrappers.
 *
 * @vitest-environment jsdom
 */
import type { HqAlertMessage, HqEventEnvelope, HqSnapshot } from '@wrongstack/core/hq';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { HQ_BROWSER_PEER_RESUME_CLIENT_ID } from '../src/lib/peer-resume-id.js';

// Mock the WS client module so store.ts doesn't try to create a real WS.
vi.mock('../src/lib/hq-ws-client.js', () => ({
  getHqClient: () => ({
    on: vi.fn(() => () => {}),
    onStateChange: vi.fn(() => () => {}),
    close: vi.fn(),
  }),
  HQ_BROWSER_PEER_RESUME_CLIENT_ID: '__hq_peer__',
}));

// ESM top-level await for the imports.
const storeModule = await import('../src/store.js');

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  storeModule.useHqStore.setState({
    snapshot: null,
    events: [],
    alerts: [],
    commandStatuses: [],
    activeView: 'cockpit',
    selectedSessionId: null,
    selectedAgentId: null,
    selectedClientId: null,
    connected: false,
    authRequired: false,
    resumeCursors: {},
    // Reset `needsSnapshotRefresh` so the loop-closure test (which arms
    // the flag to `true` and never restores it) does not leak the
    // armed state into later tests in the suite. Without this, the
    // `_setNeedsSnapshotRefresh sets and clears the flag` companion test
    // is order-dependent — it would start in the `true` state the
    // previous test left behind.
    needsSnapshotRefresh: false,
    peerRehydrate: null,
  });
});

function snapshot(generatedAt: string): HqSnapshot {
  return {
    generatedAt,
    clients: [],
    projects: [],
    sessions: [],
    fleets: [],
    mailboxes: [],
    totals: {
      activeProjects: 0,
      activeClients: 0,
      activeSessions: 0,
      activeSubagents: 0,
      unreadMailboxMessages: 0,
      incompleteMailboxMessages: 0,
      totalCostUsd: 0,
    },
  };
}

function event(id: string): HqEventEnvelope {
  return {
    id,
    type: 'fleet.event',
    schemaVersion: 1,
    timestamp: '2026-07-14T12:00:00.000Z',
    clientId: 'client-1',
    projectId: 'project-1',
    seq: 1,
    payload: {},
  };
}

describe('store state setters', () => {
  it('setActiveView updates the active view without throwing', () => {
    expect(() => storeModule.useHqStore.getState().setActiveView('fleet')).not.toThrow();
    expect(() => storeModule.useHqStore.getState().setActiveView('console')).not.toThrow();
  });

  it('selectSession stores session and optional agent', () => {
    expect(() =>
      storeModule.useHqStore.getState().selectSession('sess-1', 'agent-1'),
    ).not.toThrow();
    expect(() => storeModule.useHqStore.getState().selectSession('sess-2')).not.toThrow();
    expect(() => storeModule.useHqStore.getState().selectSession(null)).not.toThrow();
  });

  it('selectAgent stores session and agent together', () => {
    expect(() => storeModule.useHqStore.getState().selectAgent('sess-1', 'agent-99')).not.toThrow();
  });

  it('selectClient stores client id', () => {
    expect(() => storeModule.useHqStore.getState().selectClient('client-x')).not.toThrow();
    expect(() => storeModule.useHqStore.getState().selectClient(null)).not.toThrow();
  });

  it('markAuthRequired flips authRequired to true (idempotent)', () => {
    expect(() => storeModule.useHqStore.getState().markAuthRequired()).not.toThrow();
    expect(() => storeModule.useHqStore.getState().markAuthRequired()).not.toThrow();
  });
});

describe('live telemetry ingestion', () => {
  it('hydrates the first snapshot without reporting a WebSocket connection', () => {
    const state = storeModule.useHqStore.getState();
    state._hydrateSnapshot(snapshot('http'));

    expect(storeModule.useHqStore.getState().snapshot?.generatedAt).toBe('http');
    expect(storeModule.useHqStore.getState().connected).toBe(false);
  });

  it('does not let a late HTTP response replace a live WebSocket snapshot', () => {
    const state = storeModule.useHqStore.getState();
    state._onSnapshot(snapshot('live'));
    state._hydrateSnapshot(snapshot('stale-http'));

    expect(storeModule.useHqStore.getState().snapshot?.generatedAt).toBe('live');
    expect(storeModule.useHqStore.getState().connected).toBe(true);
  });

  it('deduplicates replayed event envelopes by id', () => {
    const state = storeModule.useHqStore.getState();
    state._onEvent(event('event-1'));
    state._onEvent({ ...event('event-1'), seq: 2 });

    expect(storeModule.useHqStore.getState().events).toHaveLength(1);
  });

  it('tracks resume cursors per publishing client as each client advances', () => {
    const state = storeModule.useHqStore.getState();
    state._onEvent({ ...event('event-1'), clientId: 'client-a', seq: 5 });
    state._onEvent({ ...event('event-2'), clientId: 'client-b', seq: 2 });
    state._onEvent({ ...event('event-3'), clientId: 'client-a', seq: 6 });

    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({
      'client-a': 6,
      'client-b': 2,
    });
  });

  it('preserves the cursor on a small backward seq (replay / out-of-order, not restart)', () => {
    // A backward jump by less than half the baseline is most likely a replay
    // or out-of-order frame, not a genuine restart. Preserving the cursor
    // prevents the gap-fill path from re-delivering every previously-seen
    // envelope (duplicate-delivery). A genuine restart resets the publisher
    // counter to 1, which the next test pins separately.
    const state = storeModule.useHqStore.getState();
    state._onEvent({ ...event('event-1'), clientId: 'client-a', seq: 9 });
    state._onEvent({ ...event('event-2'), clientId: 'client-a', seq: 8 });

    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({ 'client-a': 9 });
  });

  it('resets the per-client cursor when the publisher seq drops by half or more (genuine restart)', () => {
    // A large backward drop (`nextSeq <= previousSeq / 2`) is a restart
    // signal — the publisher reset its counter and the dashboard needs the
    // new baseline so future resume cursors advertise the right gap.
    const state = storeModule.useHqStore.getState();
    state._onEvent({ ...event('event-1'), clientId: 'client-a', seq: 10 });
    state._onEvent({ ...event('event-2'), clientId: 'client-a', seq: 3 });

    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({ 'client-a': 3 });
  });

  it('preserves the cursor on the half-baseline boundary (10 -> 6 is replay, not restart)', () => {
    // Boundary case for the half-drop heuristic: `previousSeq=10` and
    // `nextSeq=6` — `6 > 10/2 = 5`, so the predicate is false and the cursor
    // is preserved. This pins the strict `<=` boundary: a backward jump to
    // exactly half or below triggers restart; a backward jump to more than
    // half is treated as a replay/out-of-order frame.
    const state = storeModule.useHqStore.getState();
    state._onEvent({ ...event('event-1'), clientId: 'client-a', seq: 10 });
    state._onEvent({ ...event('event-2'), clientId: 'client-a', seq: 6 });

    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({ 'client-a': 10 });
  });

  it('does not regress the cursor when client.hello (seq=0) arrives for an already-known publisher', () => {
    const state = storeModule.useHqStore.getState();
    state._onEvent({ ...event('event-1'), clientId: 'client-a', seq: 6 });
    state._onEvent({
      ...event('event-hello'),
      clientId: 'client-a',
      seq: 0,
      type: 'client.hello',
    });

    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({ 'client-a': 6 });
  });

  it('keeps live resume cursors across routine hq.snapshot broadcasts', () => {
    const state = storeModule.useHqStore.getState();
    state._onEvent({ ...event('event-1'), clientId: 'client-a', seq: 9 });
    state._onEvent({ ...event('event-2'), clientId: HQ_BROWSER_PEER_RESUME_CLIENT_ID, seq: 3 });

    state._onSnapshot(snapshot('2026-07-31T12:00:00.000Z'));

    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({
      'client-a': 9,
      [HQ_BROWSER_PEER_RESUME_CLIENT_ID]: 3,
    });
  });

  it('never flips needsSnapshotRefresh on a snapshot broadcast (closes the /api/snapshot fetch loop)', () => {
    // Deterministic gate for the High-severity bug:
    // `_onSnapshot` must NOT touch `needsSnapshotRefresh` on any broadcast,
    // because the subscriber in main.tsx reacts by calling
    // `fetchJson('/api/snapshot')` and the HTTP response is itself an
    // `_onSnapshot`, which would otherwise re-arm the flag and trigger
    // another fetch. The refresh flag is owned exclusively by
    // `hq.resume_reject` (`main.tsx` sets it once per WS reconnect) and
    // is consumed exactly once by the `false → true` transition
    // subscriber.
    const state = storeModule.useHqStore.getState();
    state._onSnapshot(snapshot('2026-08-01T00:00:00.000Z'));
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(false);

    // Routine same-epoch broadcast — must stay false.
    state._onSnapshot(snapshot('2026-08-01T00:00:00.000Z'));
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(false);

    // Forward epoch jump (server restart, post-resume epoch advance) —
    // also must stay false. The WS broadcast is not a refresh trigger;
    // the server explicitly tells us when a refresh is required via
    // `hq.resume_reject`.
    state._onSnapshot(snapshot('2026-08-01T00:00:01.000Z'));
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(false);
  });

  it('_setNeedsSnapshotRefresh sets and clears the flag (the only legitimate trigger)', () => {
    // Companion to the loop-prevention test: `_setNeedsSnapshotRefresh`
    // is the *only* entry point that may arm the refresh. The subscriber
    // in main.tsx consumes the `false → true` transition exactly once.
    const state = storeModule.useHqStore.getState();
    state._setNeedsSnapshotRefresh(true);
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(true);
    state._setNeedsSnapshotRefresh(false);
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(false);
    // Idempotent setter: setting the same value is a no-op.
    state._setNeedsSnapshotRefresh(false);
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(false);
  });

  it('remains refresh-rearmable after a refresh-path snapshot application (no latch)', () => {
    // Production failure mode the prior tests did not cover: the HTTP
    // response to the `/api/snapshot` refresh is itself an `_onSnapshot`,
    // whose `generatedAt` is strictly newer than the broadcast that
    // triggered the refresh. The latch scenario this guards against:
    //   1. `hq.resume_reject` → flag false→true → subscriber fetches.
    //   2. Fetch resolves → `_onSnapshot(refresh)` applies a strictly-newer
    //      epoch. A previous iteration's `epochAdvanced` gate re-armed
    //      the flag here, latching it true forever and dead-ending every
    //      subsequent `resume_reject`.
    // The current contract (`_onSnapshot` must not touch the flag) means
    // the flag is cleared by `triggerRefresh` (main.tsx) before the fetch
    // and stays clear after the refresh response applies. A second
    // `hq.resume_reject` must still be able to re-arm it.
    const state = storeModule.useHqStore.getState();

    // Step 1: broadcast arms the gate (via the WS message handler).
    state._setNeedsSnapshotRefresh(true);
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(true);

    // Step 2: `triggerRefresh` clears the flag before fetching.
    state._setNeedsSnapshotRefresh(false);

    // Step 3: the HTTP refresh response arrives with a strictly-newer
    // epoch. The flag must stay clear — this is the regression case.
    state._onSnapshot(snapshot('2026-08-01T00:00:00.000Z'));
    state._onSnapshot(snapshot('2026-08-01T00:00:01.000Z'));
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(false);

    // Step 4: a later reconnect fires `hq.resume_reject` again. The flag
    // must still be armable — the recovery path cannot be permanently dead.
    state._setNeedsSnapshotRefresh(true);
    expect(storeModule.useHqStore.getState().needsSnapshotRefresh).toBe(true);
  });

  it('_resetResumeCursors clears cursors without touching the snapshot', () => {
    const state = storeModule.useHqStore.getState();
    state._onEvent({ ...event('event-1'), clientId: 'client-a', seq: 9 });
    state._onSnapshot(snapshot('2026-07-31T12:00:00.000Z'));

    state._resetResumeCursors();

    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({});
    expect(storeModule.useHqStore.getState().snapshot?.generatedAt).toBe(
      '2026-07-31T12:00:00.000Z',
    );
  });

  it('ignores a snapshot that is older than the currently held one', () => {
    storeModule.useHqStore.getState()._onSnapshot(snapshot('2026-07-31T12:00:00.000Z'));
    const fresh = storeModule.useHqStore.getState().snapshot;
    expect(fresh?.generatedAt).toBe('2026-07-31T12:00:00.000Z');

    storeModule.useHqStore.getState()._onSnapshot(snapshot('2026-07-31T11:00:00.000Z'));
    expect(storeModule.useHqStore.getState().snapshot?.generatedAt).toBe(
      '2026-07-31T12:00:00.000Z',
    );
  });

  it('does not promote a stale peer.* envelope into peerRehydrate after the live banner has been dismissed', () => {
    const state = storeModule.useHqStore.getState();
    const stalePeer = {
      ...event('peer-stale'),
      type: 'peer.rehydrate' as const,
      payload: {
        projectId: 'project-1',
        machineId: 'machine-1',
        leaderClientId: 'leader-1',
        previousLeaderHandle: 'leader-1',
        reason: 'graceful' as const,
        detectedAt: '2026-07-14T12:00:00.000Z',
      },
    };
    state._onEvent(stalePeer);
    state._dismissPeerRehydrate();
    // Gap-fill replay of the same envelope must not raise the banner.
    storeModule.useHqStore.getState()._onEvent(stalePeer);

    expect(storeModule.useHqStore.getState().peerRehydrate).toBeNull();
  });

  it('ignores malformed peer lifecycle payloads for the banner without advancing resume cursors', () => {
    const state = storeModule.useHqStore.getState();
    state._onEvent({
      ...event('peer-1'),
      type: 'peer.rehydrate',
      seq: 8,
      payload: { projectId: 'missing-required-fields' },
    });

    expect(storeModule.useHqStore.getState().peerRehydrate).toBeNull();
    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({});
  });

  it('surfaces valid peer lifecycle payloads into peerRehydrate', () => {
    const state = storeModule.useHqStore.getState();
    state._onEvent({
      ...event('peer-2'),
      type: 'peer.rehydrate',
      payload: {
        projectId: 'project-1',
        machineId: 'machine-1',
        leaderClientId: 'leader-1',
        previousLeaderHandle: 'leader-1',
        reason: 'graceful',
        detectedAt: '2026-07-14T12:00:00.000Z',
      },
    });

    expect(storeModule.useHqStore.getState().peerRehydrate).toEqual(
      expect.objectContaining({
        kind: 'peer.rehydrate',
        payload: expect.objectContaining({ leaderClientId: 'leader-1' }),
      }),
    );
    expect(storeModule.useHqStore.getState().resumeCursors).toEqual({
      __hq_peer__: 1,
    });
  });

  it('does not resurface duplicate peer lifecycle envelopes after dismissal', () => {
    const state = storeModule.useHqStore.getState();
    const peerEvent = {
      ...event('peer-3'),
      type: 'peer.rehydrate' as const,
      payload: {
        projectId: 'project-1',
        machineId: 'machine-1',
        leaderClientId: 'leader-1',
        previousLeaderHandle: 'leader-1',
        reason: 'graceful' as const,
        detectedAt: '2026-07-14T12:00:00.000Z',
      },
    };
    state._onEvent(peerEvent);
    state._dismissPeerRehydrate();
    storeModule.useHqStore.getState()._onEvent(peerEvent);

    expect(storeModule.useHqStore.getState().peerRehydrate).toBeNull();
  });

  it('bounds the live event ring to the latest 500 envelopes', () => {
    const state = storeModule.useHqStore.getState();
    for (let index = 0; index < 505; index++) state._onEvent(event(`event-${index}`));

    const events = storeModule.useHqStore.getState().events;
    expect(events).toHaveLength(500);
    expect(events[0]?.id).toBe('event-5');
    expect(events.at(-1)?.id).toBe('event-504');
  });

  it('deduplicates identical alert transition frames', () => {
    const alert: HqAlertMessage = {
      type: 'hq.alert',
      severity: 'warn',
      message: 'agent count exceeded',
      timestamp: '2026-07-14T12:00:00.000Z',
    };
    const state = storeModule.useHqStore.getState();
    state._onAlert(alert);
    state._onAlert({ ...alert });

    expect(storeModule.useHqStore.getState().alerts).toHaveLength(1);
  });

  it('folds queued, delivered and acked command lifecycle frames by command id', () => {
    const state = storeModule.useHqStore.getState();
    state._onCommandStatus({
      commandId: 'command-1',
      type: 'steer',
      clientId: 'client-1',
      enqueuedBy: 'operator',
      enqueuedAt: '2026-07-14T12:00:00.000Z',
      status: 'queued',
    });
    state._onCommandStatus({
      commandId: 'command-1',
      type: 'steer',
      clientId: 'client-1',
      enqueuedBy: 'operator',
      enqueuedAt: '2026-07-14T12:00:00.000Z',
      status: 'acked',
      ackStatus: 'completed',
    });

    expect(storeModule.useHqStore.getState().commandStatuses).toEqual([
      expect.objectContaining({
        commandId: 'command-1',
        status: 'acked',
        ackStatus: 'completed',
      }),
    ]);
  });
});

describe('fetchJson', () => {
  it('returns parsed JSON on success', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response(JSON.stringify({ data: 'ok' }), { status: 200 })),
    );
    const result = await storeModule.fetchJson<{ data: string }>('/api/test');
    expect(result).toEqual({ data: 'ok' });
  });

  it('throws on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(storeModule.fetchJson('/api/test')).rejects.toThrow(
      'Network error fetching /api/test',
    );
  });

  it('throws on 401 and calls markAuthRequired', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
        ),
    );
    await expect(storeModule.fetchJson('/api/protected')).rejects.toThrow(
      '401 Unauthorized fetching /api/protected — browser token required',
    );
  });

  it('throws on non-ok status', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('Not Found', { status: 404, statusText: 'Not Found' })),
    );
    await expect(storeModule.fetchJson('/api/missing')).rejects.toThrow('404 Not Found');
  });

  it('throws on invalid JSON response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not-json', { status: 200, statusText: 'OK' })),
    );
    await expect(storeModule.fetchJson('/api/bad-json')).rejects.toThrow(
      'Invalid JSON response from /api/bad-json: 200',
    );
  });
});

describe('postMailboxSend', () => {
  it('sends a mailbox message and returns the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(
            JSON.stringify({ delivered: true, messageId: 'm-1', to: '*', type: 'steer' }),
            { status: 200 },
          ),
        ),
    );
    const result = await storeModule.postMailboxSend({ type: 'steer', body: 'hello', to: '*' });
    expect(result.delivered).toBe(true);
    expect(result.messageId).toBe('m-1');
  });

  it('throws on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(storeModule.postMailboxSend({ type: 'btw', body: 'hi' })).rejects.toThrow(
      'Network error sending mailbox message',
    );
  });

  it('throws on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
        ),
    );
    await expect(storeModule.postMailboxSend({ type: 'queue', body: 'x' })).rejects.toThrow(
      '401 Unauthorized — browser token required',
    );
  });

  it('throws with server error body on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'rate limited' }), {
          status: 429,
          statusText: 'Too Many Requests',
        }),
      ),
    );
    await expect(storeModule.postMailboxSend({ type: 'steer', body: 'hello' })).rejects.toThrow(
      'rate limited',
    );
  });

  it('throws with status text when error body is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(new Response('', { status: 500, statusText: 'Internal Server Error' })),
    );
    await expect(storeModule.postMailboxSend({ type: 'steer', body: 'hello' })).rejects.toThrow(
      'Internal Server Error',
    );
  });

  it('throws on invalid JSON in successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not-json', { status: 200, statusText: 'OK' })),
    );
    await expect(storeModule.postMailboxSend({ type: 'steer', body: 'hello' })).rejects.toThrow(
      'Invalid JSON response from mailbox-send API',
    );
  });
});

describe('postCommand', () => {
  it('sends a command and returns the result', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response(JSON.stringify({ commandId: 'cmd-1', queued: true }), { status: 200 }),
        ),
    );
    const result = await storeModule.postCommand('client-1', 'abort', { target: 'leader' });
    expect(result.commandId).toBe('cmd-1');
    expect(result.queued).toBe(true);
  });

  it('throws on network error', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('network')));
    await expect(storeModule.postCommand('c1', 'run', {})).rejects.toThrow(
      'Network error sending command',
    );
  });

  it('throws on 401', async () => {
    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValue(
          new Response('Unauthorized', { status: 401, statusText: 'Unauthorized' }),
        ),
    );
    await expect(storeModule.postCommand('c1', 'run', {})).rejects.toThrow(
      '401 Unauthorized — browser token required',
    );
  });

  it('throws with server error on non-ok response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ error: 'invalid client' }), {
          status: 400,
          statusText: 'Bad Request',
        }),
      ),
    );
    await expect(storeModule.postCommand('c1', 'run', {})).rejects.toThrow('invalid client');
  });

  it('throws with status text when error body is missing', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('', { status: 409, statusText: 'Conflict' })),
    );
    await expect(storeModule.postCommand('c1', 'run', {})).rejects.toThrow('Conflict');
  });

  it('throws on invalid JSON in successful response', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('not-json', { status: 200, statusText: 'OK' })),
    );
    await expect(storeModule.postCommand('c1', 'run', {})).rejects.toThrow(
      'Invalid JSON response from command API',
    );
  });
});
