/**
 * HQ dashboard store — zustand-based global store, matching the pattern
 * used by the main @wrongstack/webui package. Holds the latest snapshot,
 * recent events, active alerts, and UI state.
 *
 * WS wiring moved to main.tsx; API helpers (fetchJson, postMailboxSend,
 * postCommand) remain as standalone exports that access store state via
 * useHqStore.getState().
 */
import {
  type HqAlertMessage,
  type HqCommandAuditEntry,
  type HqEventEnvelope,
  type HqPeerLostPayload,
  type HqPeerRehydratePayload,
  type HqSnapshot,
  isHqPeerLostPayload,
  isHqPeerRehydratePayload,
} from '@wrongstack/core/hq';
import { create } from 'zustand';
import { authorizedFetch } from './lib/auth.js';
import { HQ_BROWSER_PEER_RESUME_CLIENT_ID } from './lib/peer-resume-id.js';

export type ViewId =
  | 'cockpit'
  | 'fleet'
  | 'console'
  | 'mailbox'
  | 'kanban'
  | 'cost'
  | 'brain'
  | 'worktree'
  | 'trends'
  | 'alerts'
  | 'control'
  | 'settings';

/**
 * Most recent peer-lifecycle envelope the dashboard has seen. Either a
 * `peer.rehydrate` (the project lost its leader but has survivors) or a
 * `peer.lost` (the project lost its leader and has no survivors). The
 * `receivedAt` field is the local wall-clock at surface time — useful for
 * the disconnect banner that asks "is this stale?".
 */
export type PeerEnvelope =
  | { kind: 'peer.rehydrate'; payload: HqPeerRehydratePayload; receivedAt: string }
  | { kind: 'peer.lost'; payload: HqPeerLostPayload; receivedAt: string };

interface HqState {
  snapshot: HqSnapshot | null;
  events: HqEventEnvelope[];
  alerts: HqAlertMessage[];
  commandStatuses: HqCommandAuditEntry[];
  activeView: ViewId;
  selectedSessionId: string | null;
  selectedAgentId: string | null;
  selectedClientId: string | null;
  connected: boolean;
  authRequired: boolean;
  /** Highest HQ event sequence the browser has already applied, keyed by publisher/resume clientId. */
  resumeCursors: Readonly<Record<string, number>>;
  /** Set after `hq.resume_reject` or a truncated `hq.resume_gap` so the next
   * snapshot fetch happens exactly once per reconnect. */
  needsSnapshotRefresh: boolean;
  /** Most recent peer-lifecycle envelope; cleared by `_dismissPeerRehydrate`. */
  peerRehydrate: PeerEnvelope | null;
}

interface HqActions {
  setActiveView: (view: ViewId) => void;
  selectSession: (sessionId: string | null, agentId?: string | null) => void;
  selectAgent: (sessionId: string, agentId: string) => void;
  selectClient: (clientId: string | null) => void;
  markAuthRequired: () => void;
  /** Seed the first render from HTTP without claiming the WebSocket is live. */
  _hydrateSnapshot: (snapshot: HqSnapshot) => void;
  _onSnapshot: (snapshot: HqSnapshot) => void;
  _onEvent: (event: HqEventEnvelope) => void;
  _onAlert: (alert: HqAlertMessage) => void;
  _onCommandStatus: (command: HqCommandAuditEntry) => void;
  _setConnected: (connected: boolean) => void;
  /** Mark that the next snapshot fetch is required (set after a resume
   * reject / truncated gap). The fetch itself runs in `main.tsx`. */
  _setNeedsSnapshotRefresh: (needed: boolean) => void;
  /** Allow the user to dismiss the banner without affecting the events ring. */
  _dismissPeerRehydrate: () => void;
  /** Drop per-publisher resume cursors. Called by `main.tsx` after the
   * authoritative `/api/snapshot` refresh completes, so the next reconnect
   * starts a fresh gap-fill against the post-refresh state. */
  _resetResumeCursors: () => void;
}

const MAX_EVENTS = 500;
const MAX_ALERTS = 100;
const MAX_COMMAND_STATUSES = 200;

function snapshotPatch(state: HqState, snapshot: HqSnapshot): Partial<HqState> {
  const liveSessions = snapshot.liveSessions ?? [];
  const selectedSession =
    state.selectedSessionId === null
      ? undefined
      : liveSessions.find((session) => session.sessionId === state.selectedSessionId);
  const selectedAgentStillExists =
    state.selectedAgentId === null ||
    selectedSession?.agents.some((agent) => agent.id === state.selectedAgentId) === true;
  const selectedClientStillExists =
    state.selectedClientId === null ||
    snapshot.clients.some((client) => client.clientId === state.selectedClientId);

  return {
    snapshot,
    ...(state.selectedSessionId !== null && selectedSession === undefined
      ? { selectedSessionId: null, selectedAgentId: null }
      : !selectedAgentStillExists
        ? { selectedAgentId: null }
        : {}),
    ...(!selectedClientStillExists ? { selectedClientId: null } : {}),
  };
}

function sameAlert(left: HqAlertMessage, right: HqAlertMessage): boolean {
  return (
    left.timestamp === right.timestamp &&
    left.severity === right.severity &&
    left.message === right.message
  );
}

export const useHqStore = create<HqState & HqActions>()((set) => ({
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
  needsSnapshotRefresh: false,
  peerRehydrate: null,

  setActiveView: (view) => set({ activeView: view }),

  selectSession: (sessionId, agentId = null) =>
    set({ selectedSessionId: sessionId, selectedAgentId: agentId }),

  selectAgent: (sessionId, agentId) =>
    set({ selectedSessionId: sessionId, selectedAgentId: agentId }),

  selectClient: (clientId) => set({ selectedClientId: clientId }),

  markAuthRequired: () => set((s) => (s.authRequired ? {} : { authRequired: true })),

  _hydrateSnapshot: (snapshot) =>
    set((state) =>
      // A live frame may win the race against the boot-time HTTP request.
      // Never let that older response replace the WebSocket snapshot.
      state.snapshot === null ? snapshotPatch(state, snapshot) : {},
    ),

  _onSnapshot: (snapshot) =>
    set((state) => {
      // Guard against a stale snapshot arriving after a newer one (e.g. a
      // broadcast arrives while the reconnect-refresh fetch is in flight).
      const current = state.snapshot;
      if (
        current !== null &&
        typeof current.generatedAt === 'string' &&
        typeof snapshot.generatedAt === 'string' &&
        Date.parse(snapshot.generatedAt) < Date.parse(current.generatedAt)
      ) {
        return {};
      }
      // Routine broadcasts keep the live resume cursors so a subsequent
      // reconnect can still advertise a meaningful gap to the server. The
      // authoritative refresh path (post `hq.resume_reject`) explicitly
      // calls `_resetResumeCursors()` after applying the snapshot.
      //
      // `needsSnapshotRefresh` is NOT touched here. The HQ server mints
      // `generatedAt = new Date().toISOString()` at every `buildSnapshot()`
      // call, so the HTTP response to the `/api/snapshot` refresh is
      // always strictly newer than the WS broadcast that triggered the
      // refresh. A previous iteration tried to gate on a "strict epoch
      // advance" (incomingTs > currentTs), but that condition is true on
      // every refresh response — the gate stayed open and the loop
      // persisted. The right contract: `needsSnapshotRefresh` is set
      // exactly once per WS reconnect by `hq.resume_reject`, and the
      // subscriber in `main.tsx` consumes it exactly once. `_onSnapshot`
      // only updates the rendered snapshot.
      return {
        ...snapshotPatch(state, snapshot),
        connected: true,
      };
    }),

  /** Drop per-publisher resume cursors. Called by `main.tsx` after the
   * authoritative `/api/snapshot` refresh completes, so the next reconnect
   * starts a fresh gap-fill against the post-refresh state. */
  _resetResumeCursors: () => set({ resumeCursors: {} }),

  _onEvent: (event) =>
    set((state) => {
      // Push the envelope into the events ring buffer (existing behavior).
      // `peer.*` envelopes are server-generated lifecycle notices; the
      // browser already tracks them under a synthetic resume key
      // (`HQ_BROWSER_PEER_RESUME_CLIENT_ID` == `__hq_peer__`) so advancing
      // the cursor under that key never collides with a real publisher.
      const alreadySeen = state.events.some((candidate) => candidate.id === event.id);
      const eventPatch = alreadySeen ? {} : { events: [...state.events, event].slice(-MAX_EVENTS) };
      // `peer.*` envelopes carry a publisher `clientId` but a server-minted
      // `seq` (from `peerEventSeq` in packages/cli/src/hq-server/ws.ts) that
      // does NOT reflect the publisher's own seq. Advancing `resumeCursors`
      // for that clientId would poison the gap-fill watermark — a later
      // `client.resume { clientId, lastSeqSeen }` could never gap-fill the
      // publisher's real envelopes (server filter: `(clientId, seq) > cursor`).
      // So peer envelopes must skip the cursor advance entirely.
      const isPeerEnvelope = event.type === 'peer.rehydrate' || event.type === 'peer.lost';
      const resumePatch = isPeerEnvelope
        ? (_resumeKey: string): Pick<HqState, 'resumeCursors'> | {} => ({})
        : (resumeKey: string): Pick<HqState, 'resumeCursors'> | {} => {
        const previousSeq = state.resumeCursors[resumeKey] ?? 0;
        const nextSeq = event.seq;
        // Skip the restart heuristic for `client.hello` (seq=0) and any
        // server-minted envelope that lands at seq=0 — those aren't
        // publisher events and must not zero a real cursor.
        //
        // Restart signal: a publisher genuinely restarted when its seq
        // reset to a small value while we have a meaningful baseline
        // (`nextSeq <= previousSeq / 2`). A backward jump by a small
        // amount (e.g. 9 → 8) is most likely a replay or out-of-order
        // frame — preserve the cursor so the gap-fill path surfaces the
        // missing seqs without causing duplicate-delivery.
        const publisherRestarted =
          previousSeq > 0 &&
          nextSeq > 0 &&
          nextSeq <= previousSeq / 2 &&
          event.type !== 'client.hello';
        return nextSeq > previousSeq || publisherRestarted
          ? { resumeCursors: { ...state.resumeCursors, [resumeKey]: nextSeq } }
          : {};
      };
      // Surface peer-lifecycle envelopes into the dedicated `peerRehydrate`
      // field so views can subscribe without scanning the events ring.
      if (event.type === 'peer.rehydrate') {
        if (!isHqPeerRehydratePayload(event.payload)) return eventPatch;
        const peerRehydrate: PeerEnvelope = {
          kind: 'peer.rehydrate',
          payload: event.payload,
          receivedAt: new Date().toISOString(),
        };
        return {
          ...eventPatch,
          ...resumePatch(HQ_BROWSER_PEER_RESUME_CLIENT_ID),
          ...(alreadySeen ? {} : { peerRehydrate }),
        };
      }
      if (event.type === 'peer.lost') {
        if (!isHqPeerLostPayload(event.payload)) return eventPatch;
        const peerRehydrate: PeerEnvelope = {
          kind: 'peer.lost',
          payload: event.payload,
          receivedAt: new Date().toISOString(),
        };
        return {
          ...eventPatch,
          ...resumePatch(HQ_BROWSER_PEER_RESUME_CLIENT_ID),
          ...(alreadySeen ? {} : { peerRehydrate }),
        };
      }
      return { ...eventPatch, ...resumePatch(event.clientId) };
    }),

  _onAlert: (alert) =>
    set((state) =>
      state.alerts.some((candidate) => sameAlert(candidate, alert))
        ? {}
        : { alerts: [...state.alerts, alert].slice(-MAX_ALERTS) },
    ),

  _onCommandStatus: (command) =>
    set((state) => {
      const existing = state.commandStatuses.findIndex(
        (candidate) => candidate.commandId === command.commandId,
      );
      if (existing < 0) {
        return {
          commandStatuses: [...state.commandStatuses, command].slice(-MAX_COMMAND_STATUSES),
        };
      }
      const next = [...state.commandStatuses];
      next[existing] = command;
      return { commandStatuses: next };
    }),

  _setConnected: (connected) => set({ connected }),

  _setNeedsSnapshotRefresh: (needed) =>
    set((state) => (state.needsSnapshotRefresh === needed ? {} : { needsSnapshotRefresh: needed })),

  _dismissPeerRehydrate: () => set({ peerRehydrate: null }),
}));

// ── API helpers ──────────────────────────────────────────────────────

export interface MailboxSendInput {
  projectId?: string | undefined;
  sessionId?: string | undefined;
  type:
    | 'note'
    | 'ask'
    | 'assign'
    | 'steer'
    | 'btw'
    | 'queue'
    | 'broadcast'
    | 'status'
    | 'result'
    | 'review';
  to?: string | undefined;
  subject?: string | undefined;
  body: string;
  priority?: 'high' | 'normal' | 'low' | undefined;
  audience?: 'all' | 'leaders' | undefined;
}

export interface MailboxSendResult {
  delivered: boolean;
  messageId?: string;
  to: string;
  type: string;
  audience?: 'all' | 'leaders' | undefined;
}

export async function fetchJson<T>(path: string): Promise<T> {
  let res: Response;
  try {
    res = await authorizedFetch(path);
  } catch {
    throw new Error(`Network error fetching ${path}`);
  }
  if (res.status === 401) {
    useHqStore.getState().markAuthRequired();
    throw new Error(`401 Unauthorized fetching ${path} — browser token required`);
  }
  if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
  try {
    return (await res.json()) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${path}: ${res.status}`);
  }
}

export async function postMailboxSend(input: MailboxSendInput): Promise<MailboxSendResult> {
  let res: Response;
  try {
    res = await authorizedFetch('/api/mailbox-send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    });
  } catch {
    throw new Error('Network error sending mailbox message');
  }
  if (res.status === 401) {
    useHqStore.getState().markAuthRequired();
    throw new Error('401 Unauthorized — browser token required');
  }
  if (!res.ok) {
    const body = (await res.json().catch(() => null)) as { error?: unknown } | null;
    const msg =
      typeof body?.error === 'string' ? body.error : res.statusText || `HTTP ${res.status}`;
    throw new Error(msg);
  }
  try {
    return (await res.json()) as MailboxSendResult;
  } catch {
    throw new Error('Invalid JSON response from mailbox-send API');
  }
}

export async function postCommand(
  clientId: string,
  type: string,
  payload: unknown,
): Promise<{ commandId: string; queued: boolean }> {
  let res: Response;
  try {
    res = await authorizedFetch('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ clientId, type, payload }),
    });
  } catch {
    throw new Error('Network error sending command');
  }
  if (res.status === 401) {
    useHqStore.getState().markAuthRequired();
    throw new Error('401 Unauthorized — browser token required');
  }
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    const msg = body?.error ?? (res.statusText || `HTTP ${res.status}`);
    throw new Error(msg);
  }
  try {
    return (await res.json()) as { commandId: string; queued: boolean };
  } catch {
    throw new Error('Invalid JSON response from command API');
  }
}
