/**
 * Pure reducers for the HQ fleet state.
 *
 * Every rule the dashboard depends on lives here as a plain function of
 * (state, message) -> patch, so the invariants can be tested without a store,
 * a socket or a React tree. `index.ts` is the only place that wires them into
 * zustand.
 */
import type {
  HqAlertMessage,
  HqCommandAuditEntry,
  HqEventEnvelope,
  HqSnapshot,
} from '@wrongstack/core/hq';
import {
  HQ_BROWSER_PEER_RESUME_CLIENT_ID,
  isHqPeerLostPayload,
  isHqPeerRehydratePayload,
} from '@wrongstack/core/hq/protocol';
import type { HqFleetState, HqPeerEnvelope, HqSelectionState } from './types.js';

/**
 * Ring-buffer ceilings. These are OOM guards, not tuning knobs: a broadcast
 * storm (a fleet-wide kanban resync, a crash loop emitting alerts) would
 * otherwise grow these arrays without bound in a dashboard left open for days.
 */
export const MAX_EVENTS = 500;
export const MAX_ALERTS = 100;
export const MAX_COMMAND_STATUSES = 200;

type FleetSlice = HqFleetState & HqSelectionState;

/**
 * Drop selections whose target vanished from the new snapshot, so no view
 * renders against an id the fleet no longer knows.
 */
export function reconcileSelection(
  state: FleetSlice,
  snapshot: HqSnapshot,
): Partial<HqSelectionState> {
  const liveSessions = snapshot.liveSessions ?? [];
  const selectedSession =
    state.selectedSessionId === null
      ? undefined
      : liveSessions.find((session) => session.sessionId === state.selectedSessionId);
  const agentStillExists =
    state.selectedAgentId === null ||
    selectedSession?.agents.some((agent) => agent.id === state.selectedAgentId) === true;
  const clientStillExists =
    state.selectedClientId === null ||
    snapshot.clients.some((client) => client.clientId === state.selectedClientId);

  return {
    ...(state.selectedSessionId !== null && selectedSession === undefined
      ? { selectedSessionId: null, selectedAgentId: null }
      : agentStillExists
        ? {}
        : { selectedAgentId: null }),
    ...(clientStillExists ? {} : { selectedClientId: null }),
  };
}

/**
 * Boot-time HTTP seed. A live WS frame can win the race against the boot
 * request, and that older response must never replace the newer snapshot.
 */
export function reduceHydrateSnapshot(
  state: FleetSlice,
  snapshot: HqSnapshot,
): Partial<FleetSlice> {
  if (state.snapshot !== null) return {};
  return { snapshot, ...reconcileSelection(state, snapshot) };
}

/**
 * Apply an authoritative snapshot (WS broadcast or `/api/snapshot` response).
 *
 * Stale-frame guard: a broadcast can arrive while a refresh fetch is in
 * flight; compare `generatedAt` and keep the newer one.
 *
 * `needsSnapshotRefresh` is deliberately NOT touched here. The server mints a
 * fresh `generatedAt` on every `buildSnapshot()` call, so any gate keyed on
 * "the snapshot got newer" is re-armed by the very response that satisfied it
 * — an infinite refresh loop. The contract is: `hq.resume_reject` sets the
 * flag exactly once per reconnect, and the wire subscriber consumes it once.
 *
 * Resume cursors also survive a routine broadcast, so a later reconnect can
 * still advertise a meaningful gap. Only `hq.resume_reject` resets them.
 */
export function reduceSnapshot(state: FleetSlice, snapshot: HqSnapshot): Partial<FleetSlice> {
  const current = state.snapshot;
  if (
    current !== null &&
    typeof current.generatedAt === 'string' &&
    typeof snapshot.generatedAt === 'string' &&
    Date.parse(snapshot.generatedAt) < Date.parse(current.generatedAt)
  ) {
    return {};
  }
  return { snapshot, connected: true, ...reconcileSelection(state, snapshot) };
}

/**
 * Advance the gap-fill watermark for one publisher.
 *
 * Restart heuristic: a publisher genuinely restarted when its seq resets to a
 * small value while we hold a meaningful baseline (`next <= previous / 2`). A
 * small backward step (9 -> 8) is far more likely a replay or an out-of-order
 * frame — keeping the cursor there lets the gap-fill path surface the missing
 * seqs instead of causing duplicate delivery. `client.hello` (seq 0) and any
 * server-minted envelope landing at seq 0 are excluded: they are not publisher
 * events and must never zero a real cursor.
 */
function advanceCursor(
  cursors: Readonly<Record<string, number>>,
  key: string,
  event: HqEventEnvelope,
): Partial<HqFleetState> {
  const previousSeq = cursors[key] ?? 0;
  const nextSeq = event.seq;
  const publisherRestarted =
    previousSeq > 0 && nextSeq > 0 && nextSeq <= previousSeq / 2 && event.type !== 'client.hello';
  if (nextSeq > previousSeq || publisherRestarted) {
    return { resumeCursors: { ...cursors, [key]: nextSeq } };
  }
  return {};
}

function peerEnvelopeFor(event: HqEventEnvelope): HqPeerEnvelope | null {
  const receivedAt = new Date().toISOString();
  if (event.type === 'peer.rehydrate' && isHqPeerRehydratePayload(event.payload)) {
    return { kind: 'peer.rehydrate', payload: event.payload, receivedAt };
  }
  if (event.type === 'peer.lost' && isHqPeerLostPayload(event.payload)) {
    return { kind: 'peer.lost', payload: event.payload, receivedAt };
  }
  return null;
}

/**
 * Fold one event envelope into the ring buffer and the resume cursors.
 *
 * Peer-lifecycle envelopes (`peer.rehydrate` / `peer.lost`) are special: they
 * carry a publisher `clientId` but a SERVER-minted `seq` that does not reflect
 * that publisher's own sequence. Advancing the publisher's cursor with it
 * would poison the watermark — the server's gap-fill filter is
 * `(clientId, seq) > cursor`, so the publisher's real envelopes could never be
 * replayed again. They advance the synthetic `__hq_peer__` key instead, which
 * cannot collide with a real publisher.
 */
export function reduceEvent(state: FleetSlice, event: HqEventEnvelope): Partial<FleetSlice> {
  const alreadySeen = state.events.some((candidate) => candidate.id === event.id);
  const eventPatch = alreadySeen ? {} : { events: [...state.events, event].slice(-MAX_EVENTS) };

  const peerEnvelope = peerEnvelopeFor(event);
  if (event.type === 'peer.rehydrate' || event.type === 'peer.lost') {
    // An unrecognised payload shape is recorded in the ring but never surfaced
    // as a banner and never moves a cursor.
    if (peerEnvelope === null) return eventPatch;
    return {
      ...eventPatch,
      ...advanceCursor(state.resumeCursors, HQ_BROWSER_PEER_RESUME_CLIENT_ID, event),
      ...(alreadySeen ? {} : { peerEnvelope }),
    };
  }

  return { ...eventPatch, ...advanceCursor(state.resumeCursors, event.clientId, event) };
}

/** Two alerts are the same notice when time, severity and text all match. */
export function isSameAlert(left: HqAlertMessage, right: HqAlertMessage): boolean {
  return (
    left.timestamp === right.timestamp &&
    left.severity === right.severity &&
    left.message === right.message
  );
}

export function reduceAlert(state: FleetSlice, alert: HqAlertMessage): Partial<FleetSlice> {
  if (state.alerts.some((candidate) => isSameAlert(candidate, alert))) return {};
  return { alerts: [...state.alerts, alert].slice(-MAX_ALERTS) };
}

/**
 * Command statuses are an UPSERT keyed on `commandId`, not an append: one
 * command walks queued -> delivered -> acked, and the audit rail must show one
 * row moving rather than three rows stacking.
 */
export function reduceCommandStatus(
  state: FleetSlice,
  command: HqCommandAuditEntry,
): Partial<FleetSlice> {
  const index = state.commandStatuses.findIndex(
    (candidate) => candidate.commandId === command.commandId,
  );
  if (index < 0) {
    return {
      commandStatuses: [...state.commandStatuses, command].slice(-MAX_COMMAND_STATUSES),
    };
  }
  const next = [...state.commandStatuses];
  next[index] = command;
  return { commandStatuses: next };
}
