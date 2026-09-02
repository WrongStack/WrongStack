/**
 * The HQ fold contract.
 *
 * These reducers carry rules that were each paid for by a production bug, and
 * none of them is obvious from the type signatures:
 *   - selection reconciliation drops ids the fleet no longer knows
 *   - a boot-time HTTP snapshot must never overwrite a live WS snapshot
 *   - a late broadcast must not replace a newer snapshot
 *   - `peer.*` envelopes carry a SERVER-minted seq and must not advance a
 *     publisher's gap-fill watermark
 *   - a publisher restart is a halving of seq, not any backward step
 *   - alerts dedup on content, command statuses UPSERT on commandId
 *   - all three ring buffers are bounded
 */
import { HQ_BROWSER_PEER_RESUME_CLIENT_ID } from '@wrongstack/core/hq/protocol';
import { describe, expect, it } from 'vitest';
import {
  MAX_ALERTS,
  MAX_COMMAND_STATUSES,
  MAX_EVENTS,
  reduceAlert,
  reduceCommandStatus,
  reduceEvent,
  reduceHydrateSnapshot,
  reduceSnapshot,
} from '../../src/data/store/reducers.js';
import {
  alert,
  commandEntry,
  event,
  fleetState,
  liveSnapshot,
  peerPayload,
  snapshot,
  snapshotWithClient,
  T0,
} from '../fixtures/hq.js';

describe('reduceHydrateSnapshot', () => {
  it('seeds the first snapshot', () => {
    const patch = reduceHydrateSnapshot(fleetState(), snapshot());
    expect(patch.snapshot).not.toBeUndefined();
  });

  it('never overwrites a snapshot the WebSocket already delivered', () => {
    // The boot HTTP request can lose the race against the first live frame;
    // applying the older response would visibly roll the dashboard backwards.
    const live = snapshot('2026-07-14T12:05:00.000Z');
    const patch = reduceHydrateSnapshot(fleetState({ snapshot: live }), snapshot(T0));
    expect(patch).toEqual({});
  });
});

describe('reduceSnapshot', () => {
  it('marks the surface connected when a snapshot lands', () => {
    const patch = reduceSnapshot(fleetState(), snapshot());
    expect(patch.connected).toBe(true);
  });

  it('drops a snapshot older than the one already rendered', () => {
    const state = fleetState({ snapshot: snapshot('2026-07-14T12:05:00.000Z') });
    expect(reduceSnapshot(state, snapshot(T0))).toEqual({});
  });

  it('never touches needsSnapshotRefresh', () => {
    // The server mints a fresh `generatedAt` per buildSnapshot(), so any gate
    // keyed on "the snapshot got newer" is re-armed by the very response that
    // satisfied it — that is an infinite refresh loop.
    const state = fleetState({ needsSnapshotRefresh: true });
    expect(reduceSnapshot(state, snapshot()).needsSnapshotRefresh).toBeUndefined();
  });

  it('preserves resume cursors across a routine broadcast', () => {
    const state = fleetState({ resumeCursors: { 'client-1': 42 } });
    expect(reduceSnapshot(state, snapshot()).resumeCursors).toBeUndefined();
  });

  it('clears a selected session that left liveSessions, and its agent with it', () => {
    const state = fleetState({
      snapshot: liveSnapshot('sess-1', ['agent-1']),
      selectedSessionId: 'sess-1',
      selectedAgentId: 'agent-1',
    });
    const patch = reduceSnapshot(state, snapshot('2026-07-14T12:01:00.000Z'));
    expect(patch.selectedSessionId).toBeNull();
    expect(patch.selectedAgentId).toBeNull();
  });

  it('keeps a selection whose session survives', () => {
    const state = fleetState({
      snapshot: liveSnapshot('sess-1', ['agent-1']),
      selectedSessionId: 'sess-1',
      selectedAgentId: 'agent-1',
    });
    const patch = reduceSnapshot(
      state,
      liveSnapshot('sess-1', ['agent-1'], '2026-07-14T12:01:00.000Z'),
    );
    expect(patch.selectedSessionId).toBeUndefined();
    expect(patch.selectedAgentId).toBeUndefined();
  });

  it('clears only the agent when the agent leaves a surviving session', () => {
    const state = fleetState({
      snapshot: liveSnapshot('sess-1', ['agent-1']),
      selectedSessionId: 'sess-1',
      selectedAgentId: 'agent-1',
    });
    const patch = reduceSnapshot(
      state,
      liveSnapshot('sess-1', ['agent-2'], '2026-07-14T12:01:00.000Z'),
    );
    expect(patch.selectedSessionId).toBeUndefined();
    expect(patch.selectedAgentId).toBeNull();
  });

  it('clears only the client when it disconnects', () => {
    const state = fleetState({
      snapshot: snapshotWithClient('client-9'),
      selectedClientId: 'client-9',
    });
    const patch = reduceSnapshot(state, snapshot('2026-07-14T12:01:00.000Z'));
    expect(patch.selectedClientId).toBeNull();
  });
});

describe('reduceEvent — ring buffer', () => {
  it('dedups on envelope id', () => {
    const state = fleetState({ events: [event('e1')] });
    expect(reduceEvent(state, event('e1')).events).toBeUndefined();
  });

  it('accumulates distinct ids', () => {
    const state = fleetState({ events: [event('e1')] });
    expect(reduceEvent(state, event('e2', { seq: 2 })).events).toHaveLength(2);
  });

  it(`evicts the oldest beyond ${MAX_EVENTS}`, () => {
    const events = Array.from({ length: MAX_EVENTS }, (_, index) =>
      event(`e${index}`, { seq: index + 1 }),
    );
    const patch = reduceEvent(fleetState({ events }), event('overflow', { seq: MAX_EVENTS + 1 }));
    expect(patch.events).toHaveLength(MAX_EVENTS);
    expect(patch.events?.[0]?.id).toBe('e1');
    expect(patch.events?.at(-1)?.id).toBe('overflow');
  });
});

describe('reduceEvent — resume cursors', () => {
  it('advances the cursor for the publishing client', () => {
    const patch = reduceEvent(fleetState(), event('e1', { seq: 7 }));
    expect(patch.resumeCursors).toEqual({ 'client-1': 7 });
  });

  it('ignores a small backward step (replay / out-of-order frame)', () => {
    // 9 -> 8 keeps the watermark so the gap-fill path surfaces the missing
    // seqs, instead of re-delivering everything from 8.
    const state = fleetState({ resumeCursors: { 'client-1': 9 } });
    expect(reduceEvent(state, event('e1', { seq: 8 })).resumeCursors).toBeUndefined();
  });

  it('resets the cursor when a publisher restarts (seq halves or worse)', () => {
    const state = fleetState({ resumeCursors: { 'client-1': 40 } });
    expect(reduceEvent(state, event('e1', { seq: 3 })).resumeCursors).toEqual({ 'client-1': 3 });
  });

  it('never lets client.hello zero a real cursor', () => {
    const state = fleetState({ resumeCursors: { 'client-1': 40 } });
    const patch = reduceEvent(state, event('e1', { seq: 0, type: 'client.hello' }));
    expect(patch.resumeCursors).toBeUndefined();
  });

  it('routes peer envelopes to the synthetic peer key, never the publisher', () => {
    // peer.* carries the publisher's clientId but a SERVER-minted seq.
    // Advancing the publisher's watermark with it would permanently block
    // gap-fill for that publisher (the server filter is (clientId, seq) > cursor).
    const state = fleetState({ resumeCursors: { 'client-1': 500 } });
    const patch = reduceEvent(
      state,
      event('p1', {
        type: 'peer.rehydrate',
        seq: 2,
        payload: peerPayload(),
      }),
    );
    expect(patch.resumeCursors).toEqual({
      'client-1': 500,
      [HQ_BROWSER_PEER_RESUME_CLIENT_ID]: 2,
    });
  });
});

describe('reduceEvent — peer lifecycle banner', () => {
  it('surfaces peer.rehydrate with a local receivedAt stamp', () => {
    const patch = reduceEvent(
      fleetState(),
      event('p1', {
        type: 'peer.rehydrate',
        seq: 1,
        payload: peerPayload(),
      }),
    );
    expect(patch.peerEnvelope?.kind).toBe('peer.rehydrate');
    expect(typeof patch.peerEnvelope?.receivedAt).toBe('string');
  });

  it('records but does not surface an unrecognised peer payload', () => {
    const patch = reduceEvent(
      fleetState(),
      event('p1', { type: 'peer.lost', seq: 1, payload: { nope: true } }),
    );
    expect(patch.events).toHaveLength(1);
    expect(patch.peerEnvelope).toBeUndefined();
  });

  it('does not re-raise the banner for an envelope already in the ring', () => {
    const duplicate = event('p1', {
      type: 'peer.lost',
      seq: 1,
      payload: peerPayload(),
    });
    const patch = reduceEvent(fleetState({ events: [duplicate] }), duplicate);
    expect(patch.peerEnvelope).toBeUndefined();
  });
});

describe('reduceAlert', () => {
  it('dedups on (timestamp, severity, message) rather than reference', () => {
    const state = fleetState({ alerts: [alert()] });
    expect(reduceAlert(state, alert()).alerts).toBeUndefined();
  });

  it.each(['timestamp', 'severity', 'message'] as const)(
    'keeps an alert that differs only in %s',
    (field) => {
      const differing = {
        timestamp: '2026-07-14T13:00:00.000Z',
        severity: 'error',
        message: 'other',
      }[field];
      const state = fleetState({ alerts: [alert()] });
      expect(reduceAlert(state, alert({ [field]: differing })).alerts).toHaveLength(2);
    },
  );

  it(`is bounded at ${MAX_ALERTS}`, () => {
    const alerts = Array.from({ length: MAX_ALERTS }, (_, index) =>
      alert({ message: `alert-${index}` }),
    );
    const patch = reduceAlert(fleetState({ alerts }), alert({ message: 'overflow' }));
    expect(patch.alerts).toHaveLength(MAX_ALERTS);
    expect(patch.alerts?.at(-1)?.message).toBe('overflow');
  });
});

describe('reduceCommandStatus', () => {
  it('appends a command it has not seen', () => {
    expect(reduceCommandStatus(fleetState(), commandEntry('c1')).commandStatuses).toHaveLength(1);
  });

  it('upserts in place so one command is one audit row', () => {
    const state = fleetState({ commandStatuses: [commandEntry('c1')] });
    const patch = reduceCommandStatus(state, commandEntry('c1', { ackStatus: 'acked' }));
    expect(patch.commandStatuses).toHaveLength(1);
    expect(patch.commandStatuses?.[0]?.ackStatus).toBe('acked');
  });

  it(`is bounded at ${MAX_COMMAND_STATUSES}`, () => {
    const commandStatuses = Array.from({ length: MAX_COMMAND_STATUSES }, (_, index) =>
      commandEntry(`c${index}`),
    );
    const patch = reduceCommandStatus(fleetState({ commandStatuses }), commandEntry('overflow'));
    expect(patch.commandStatuses).toHaveLength(MAX_COMMAND_STATUSES);
    expect(patch.commandStatuses?.at(-1)?.commandId).toBe('overflow');
  });
});
