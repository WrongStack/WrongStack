/**
 * Focused unit tests for store.ts state-derivation logic — specifically the
 * pure functions that sit inside the zustand actions:
 *
 *   - `snapshotPatch` (via _onSnapshot / _hydrateSnapshot)
 *     - selected session disappears from the new snapshot → resets selection
 *     - selected session survives → keeps selection
 *     - selected agent leaves its session → resets only the agent
 *     - selected client disconnects → resets only the client
 *
 *   - event dedup (`_onEvent`)
 *     - same id never produces two entries
 *     - different ids accumulate
 *     - ring eviction keeps the latest MAX_EVENTS (boundary at exactly MAX)
 *
 *   - alert dedup (`_onAlert`)
 *     - identity is (timestamp, severity, message) — not reference equality
 *     - any single differing field produces a second row
 *
 *   - commandStatus upsert (`_onCommandStatus`)
 *     - new commandId → appended
 *     - existing commandId → in-place merge with patched fields
 *     - ring eviction keeps the latest MAX_COMMAND_STATUSES
 *
 * The goal is to pin the invariants these reducers depend on, so a future
 * refactor of store.ts gets a loud failure when the contract drifts.
 *
 * @vitest-environment jsdom
 */
import type {
  HqAlertMessage,
  HqClientRecord,
  HqCommandAuditEntry,
  HqEventEnvelope,
  HqSessionSnapshotPayload,
  HqSnapshot,
} from '@wrongstack/core/hq';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../src/lib/hq-ws-client.js', () => ({
  getHqClient: () => ({
    on: vi.fn(() => () => {}),
    onStateChange: vi.fn(() => () => {}),
    close: vi.fn(),
  }),
}));

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
  });
});

// ── Fixtures ───────────────────────────────────────────────────────────────

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

function liveSnapshot(
  sessionId: string,
  agentIds: readonly string[],
  generatedAt = '2026-07-14T12:00:00.000Z',
): HqSnapshot {
  const agents = agentIds.map((id) => ({
    id,
    name: `agent-${id}`,
    status: 'idle' as const,
    iterations: 0,
    toolCalls: 0,
    lastActivityAt: generatedAt,
  }));
  const session: HqSessionSnapshotPayload = {
    sessionId,
    clientKind: 'cli',
    machineId: 'machine-1',
    projectId: 'project-1',
    projectName: 'Project 1',
    projectRoot: '/tmp/project',
    status: 'active',
    startedAt: generatedAt,
    lastActivityAt: generatedAt,
    agentCount: agents.length,
    agents,
  };
  return { ...snapshot(generatedAt), liveSessions: [session] };
}

function snapshotWithClient(
  clientId: string,
  generatedAt = '2026-07-14T12:00:00.000Z',
): HqSnapshot {
  const client: HqClientRecord = {
    clientId,
    machineId: 'machine-1',
    kind: 'cli',
    connected: true,
    connectedAt: generatedAt,
    lastSeenAt: generatedAt,
    capabilities: [],
    projectId: 'project-1',
  };
  return { ...snapshot(generatedAt), clients: [client] };
}

function event(id: string, seq = 1): HqEventEnvelope {
  return {
    id,
    type: 'fleet.event',
    schemaVersion: 1,
    timestamp: '2026-07-14T12:00:00.000Z',
    clientId: 'client-1',
    projectId: 'project-1',
    seq,
    payload: {},
  };
}

function commandEntry(commandId: string, partial: Partial<HqCommandAuditEntry> = {}): HqCommandAuditEntry {
  return {
    commandId,
    type: 'steer',
    clientId: 'client-1',
    enqueuedBy: 'operator',
    enqueuedAt: '2026-07-14T12:00:00.000Z',
    status: 'queued',
    ...partial,
  };
}

// ── snapshotPatch: selection reconciliation ────────────────────────────────

describe('snapshotPatch — selected session reconciliation', () => {
  it('keeps selectedSessionId when the session survives the new snapshot', () => {
    const store = storeModule.useHqStore.getState();
    store._onSnapshot(liveSnapshot('sess-1', ['agent-1']));
    store.selectSession('sess-1', 'agent-1');

    // Push a new snapshot that still includes sess-1 (different timestamp).
    store._onSnapshot(liveSnapshot('sess-1', ['agent-1'], '2026-07-14T12:01:00.000Z'));

    const state = storeModule.useHqStore.getState();
    expect(state.selectedSessionId).toBe('sess-1');
    expect(state.selectedAgentId).toBe('agent-1');
  });

  it('clears selectedSessionId when the session is no longer in liveSessions', () => {
    const store = storeModule.useHqStore.getState();
    store._onSnapshot(liveSnapshot('sess-1', ['agent-1']));
    store.selectSession('sess-1', 'agent-1');

    // New snapshot — session sess-1 has ended.
    store._onSnapshot(liveSnapshot('sess-2', ['agent-2']));

    const state = storeModule.useHqStore.getState();
    expect(state.selectedSessionId).toBeNull();
    // Agent selection is also cleared because the session is gone.
    expect(state.selectedAgentId).toBeNull();
  });
});

describe('snapshotPatch — selected agent reconciliation', () => {
  it('clears selectedAgentId when the agent leaves a still-present session', () => {
    const store = storeModule.useHqStore.getState();
    store._onSnapshot(liveSnapshot('sess-1', ['agent-1', 'agent-2']));
    store.selectAgent('sess-1', 'agent-2');

    // New snapshot — same session, but agent-2 has exited.
    store._onSnapshot(liveSnapshot('sess-1', ['agent-1']));

    const state = storeModule.useHqStore.getState();
    expect(state.selectedSessionId).toBe('sess-1');
    expect(state.selectedAgentId).toBeNull();
  });

  it('keeps selectedAgentId when the agent remains in its session', () => {
    const store = storeModule.useHqStore.getState();
    store._onSnapshot(liveSnapshot('sess-1', ['agent-1', 'agent-2']));
    store.selectAgent('sess-1', 'agent-2');

    store._onSnapshot(liveSnapshot('sess-1', ['agent-1', 'agent-2'], '2026-07-14T12:01:00.000Z'));

    const state = storeModule.useHqStore.getState();
    expect(state.selectedSessionId).toBe('sess-1');
    expect(state.selectedAgentId).toBe('agent-2');
  });
});

describe('snapshotPatch — selected client reconciliation', () => {
  it('clears selectedClientId when the client disappears from the snapshot', () => {
    const store = storeModule.useHqStore.getState();
    store._onSnapshot(snapshotWithClient('client-1'));
    store.selectClient('client-1');

    // New snapshot — client-1 disconnected.
    store._onSnapshot(snapshot('2026-07-14T12:01:00.000Z'));

    expect(storeModule.useHqStore.getState().selectedClientId).toBeNull();
  });

  it('keeps selectedClientId when the client remains connected', () => {
    const store = storeModule.useHqStore.getState();
    store._onSnapshot(snapshotWithClient('client-1'));
    store.selectClient('client-1');

    store._onSnapshot(snapshotWithClient('client-1', '2026-07-14T12:01:00.000Z'));

    expect(storeModule.useHqStore.getState().selectedClientId).toBe('client-1');
  });
});

// ── _hydrateSnapshot race ──────────────────────────────────────────────────

describe('_hydrateSnapshot — HTTP vs WebSocket race', () => {
  it('applies the HTTP snapshot when state.snapshot is still null', () => {
    const store = storeModule.useHqStore.getState();
    store._hydrateSnapshot(snapshot('http'));

    expect(storeModule.useHqStore.getState().snapshot?.generatedAt).toBe('http');
    // Hydration never reports the WebSocket as live.
    expect(storeModule.useHqStore.getState().connected).toBe(false);
  });

  it('drops the HTTP snapshot when the WebSocket frame already landed', () => {
    const store = storeModule.useHqStore.getState();
    store._onSnapshot(snapshot('live'));
    store._hydrateSnapshot(snapshot('late-http'));

    expect(storeModule.useHqStore.getState().snapshot?.generatedAt).toBe('live');
    expect(storeModule.useHqStore.getState().connected).toBe(true);
  });
});

// ── _onEvent deduplication & ring ──────────────────────────────────────────

describe('_onEvent — id-based dedup and ring eviction', () => {
  it('drops a second frame with the same id (different seq is ignored)', () => {
    const store = storeModule.useHqStore.getState();
    store._onEvent(event('event-1', 1));
    store._onEvent(event('event-1', 2)); // same id, different seq

    expect(storeModule.useHqStore.getState().events).toHaveLength(1);
    // Original entry survives (no overwrite from the duplicate).
    expect(storeModule.useHqStore.getState().events[0]?.seq).toBe(1);
  });

  it('keeps both events when ids differ', () => {
    const store = storeModule.useHqStore.getState();
    store._onEvent(event('event-1'));
    store._onEvent(event('event-2'));

    expect(storeModule.useHqStore.getState().events.map((e) => e.id)).toEqual([
      'event-1',
      'event-2',
    ]);
  });

  it('bounds the live event ring to exactly MAX_EVENTS (500) and evicts oldest-first', () => {
    const store = storeModule.useHqStore.getState();
    // Push 505 distinct events — the ring caps at 500.
    for (let index = 0; index < 505; index++) store._onEvent(event(`event-${index}`));

    const events = storeModule.useHqStore.getState().events;
    expect(events).toHaveLength(500);
    // Oldest five were evicted; index 5 is now the head.
    expect(events[0]?.id).toBe('event-5');
    expect(events.at(-1)?.id).toBe('event-504');
  });

  it('does not evict when the ring is exactly at the cap', () => {
    const store = storeModule.useHqStore.getState();
    for (let index = 0; index < 500; index++) store._onEvent(event(`event-${index}`));

    const events = storeModule.useHqStore.getState().events;
    expect(events).toHaveLength(500);
    expect(events[0]?.id).toBe('event-0');
    expect(events.at(-1)?.id).toBe('event-499');
  });
});

// ── _onAlert deduplication ─────────────────────────────────────────────────

describe('_onAlert — (timestamp, severity, message) identity', () => {
  const base: HqAlertMessage = {
    type: 'hq.alert',
    severity: 'warn',
    message: 'agent count exceeded',
    timestamp: '2026-07-14T12:00:00.000Z',
  };

  it('deduplicates an identical (timestamp, severity, message) frame even across distinct object identities', () => {
    const store = storeModule.useHqStore.getState();
    store._onAlert({ ...base });
    store._onAlert({ ...base }); // fresh object, same fields

    expect(storeModule.useHqStore.getState().alerts).toHaveLength(1);
  });

  it('keeps both alerts when severity differs', () => {
    const store = storeModule.useHqStore.getState();
    store._onAlert({ ...base });
    store._onAlert({ ...base, severity: 'error' });

    expect(storeModule.useHqStore.getState().alerts).toHaveLength(2);
  });

  it('keeps both alerts when message differs', () => {
    const store = storeModule.useHqStore.getState();
    store._onAlert({ ...base });
    store._onAlert({ ...base, message: 'cost threshold exceeded' });

    expect(storeModule.useHqStore.getState().alerts).toHaveLength(2);
  });

  it('keeps both alerts when timestamp differs (the same rule firing twice)', () => {
    const store = storeModule.useHqStore.getState();
    store._onAlert({ ...base });
    store._onAlert({ ...base, timestamp: '2026-07-14T12:00:05.000Z' });

    expect(storeModule.useHqStore.getState().alerts).toHaveLength(2);
  });

  it('bounds the alert ring to 100 entries (eviction by slice)', () => {
    const store = storeModule.useHqStore.getState();
    for (let index = 0; index < 105; index++) {
      store._onAlert({
        ...base,
        timestamp: `2026-07-14T12:00:${String(index).padStart(2, '0')}.000Z`,
      });
    }

    const alerts = storeModule.useHqStore.getState().alerts;
    expect(alerts).toHaveLength(100);
    // First five were evicted; index 5 is now the head.
    expect(alerts[0]?.timestamp).toBe('2026-07-14T12:00:05.000Z');
  });
});

// ── _onCommandStatus upsert ────────────────────────────────────────────────

describe('_onCommandStatus — upsert by commandId', () => {
  it('appends when commandId is new', () => {
    const store = storeModule.useHqStore.getState();
    store._onCommandStatus(commandEntry('cmd-1'));
    store._onCommandStatus(commandEntry('cmd-2'));

    const statuses = storeModule.useHqStore.getState().commandStatuses;
    expect(statuses.map((s) => s.commandId)).toEqual(['cmd-1', 'cmd-2']);
  });

  it('merges patched fields in-place for an existing commandId', () => {
    const store = storeModule.useHqStore.getState();
    store._onCommandStatus(commandEntry('cmd-1', { status: 'queued' }));
    store._onCommandStatus(
      commandEntry('cmd-1', { status: 'delivered' }),
    );
    store._onCommandStatus(
      commandEntry('cmd-1', { status: 'acked', ackStatus: 'completed', ackedAt: '2026-07-14T12:01:00.000Z' }),
    );

    const statuses = storeModule.useHqStore.getState().commandStatuses;
    expect(statuses).toHaveLength(1);
    expect(statuses[0]).toEqual(
      expect.objectContaining({
        commandId: 'cmd-1',
        status: 'acked',
        ackStatus: 'completed',
        ackedAt: '2026-07-14T12:01:00.000Z',
      }),
    );
  });

  it('preserves original order: updates do not move the entry to the tail', () => {
    const store = storeModule.useHqStore.getState();
    store._onCommandStatus(commandEntry('cmd-1'));
    store._onCommandStatus(commandEntry('cmd-2'));
    // Update cmd-1 after cmd-2 was enqueued — order must stay [cmd-1, cmd-2].
    store._onCommandStatus(commandEntry('cmd-1', { status: 'acked' }));

    expect(
      storeModule.useHqStore.getState().commandStatuses.map((s) => s.commandId),
    ).toEqual(['cmd-1', 'cmd-2']);
  });

  it('bounds the command status ring to 200 entries', () => {
    const store = storeModule.useHqStore.getState();
    for (let index = 0; index < 205; index++) {
      store._onCommandStatus(commandEntry(`cmd-${index}`));
    }

    const statuses = storeModule.useHqStore.getState().commandStatuses;
    expect(statuses).toHaveLength(200);
    expect(statuses[0]?.commandId).toBe('cmd-5');
    expect(statuses.at(-1)?.commandId).toBe('cmd-204');
  });

  it('upsert against an evicted commandId re-appends as a new entry', () => {
    const store = storeModule.useHqStore.getState();
    store._onCommandStatus(commandEntry('cmd-old'));
    // Push enough new commands to evict cmd-old from the 200-entry ring.
    for (let index = 0; index < 200; index++) {
      store._onCommandStatus(commandEntry(`cmd-new-${index}`));
    }
    // cmd-old is gone; updating it should produce a fresh tail entry.
    store._onCommandStatus(commandEntry('cmd-old', { status: 'acked' }));

    const statuses = storeModule.useHqStore.getState().commandStatuses;
    expect(statuses.at(-1)?.commandId).toBe('cmd-old');
    expect(statuses.at(-1)?.status).toBe('acked');
  });
});

// ── _setConnected ──────────────────────────────────────────────────────────

describe('_setConnected', () => {
  it('flips the connected flag to true', () => {
    storeModule.useHqStore.getState()._setConnected(true);
    expect(storeModule.useHqStore.getState().connected).toBe(true);
  });

  it('flips the connected flag back to false', () => {
    const store = storeModule.useHqStore.getState();
    store._setConnected(true);
    store._setConnected(false);
    expect(storeModule.useHqStore.getState().connected).toBe(false);
  });
});

// ── markAuthRequired idempotency ───────────────────────────────────────────

describe('markAuthRequired — idempotent flip', () => {
  it('only transitions false → true once (no churn)', () => {
    const store = storeModule.useHqStore.getState();
    const before = storeModule.useHqStore.getState().authRequired;
    store.markAuthRequired();
    const afterFirst = storeModule.useHqStore.getState().authRequired;
    store.markAuthRequired();
    const afterSecond = storeModule.useHqStore.getState().authRequired;

    expect(before).toBe(false);
    expect(afterFirst).toBe(true);
    expect(afterSecond).toBe(true);
  });
});
