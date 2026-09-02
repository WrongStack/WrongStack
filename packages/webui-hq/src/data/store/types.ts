import type {
  HqAlertMessage,
  HqCommandAuditEntry,
  HqEventEnvelope,
  HqPeerLostPayload,
  HqPeerRehydratePayload,
  HqSnapshot,
} from '@wrongstack/core/hq';

/** The twelve HQ surfaces. The router, the nav and the palette all key on this. */
export type HqViewId =
  | 'cockpit'
  | 'fleet'
  | 'console'
  | 'mailbox'
  | 'kanban'
  | 'alerts'
  | 'cost'
  | 'trends'
  | 'brain'
  | 'worktree'
  | 'control'
  | 'settings';

/**
 * The most recent peer-lifecycle envelope the dashboard has seen: either a
 * `peer.rehydrate` (the project lost its leader but has survivors) or a
 * `peer.lost` (no survivors). `receivedAt` is local wall-clock at surface
 * time, which is what lets the banner answer "is this stale?".
 */
export type HqPeerEnvelope =
  | { kind: 'peer.rehydrate'; payload: HqPeerRehydratePayload; receivedAt: string }
  | { kind: 'peer.lost'; payload: HqPeerLostPayload; receivedAt: string };

/** Everything the transport and the API layer write into. */
export interface HqFleetState {
  snapshot: HqSnapshot | null;
  events: HqEventEnvelope[];
  alerts: HqAlertMessage[];
  commandStatuses: HqCommandAuditEntry[];
  /** Highest HQ event sequence already applied, keyed by publisher clientId. */
  resumeCursors: Readonly<Record<string, number>>;
  /**
   * Set after `hq.resume_reject` so exactly one authoritative `/api/snapshot`
   * fetch happens per reconnect. Consumed by the subscriber in `wire.ts`.
   */
  needsSnapshotRefresh: boolean;
  peerEnvelope: HqPeerEnvelope | null;
  connected: boolean;
  authRequired: boolean;
}

/** Operator-selected context, shared across views. */
export interface HqSelectionState {
  selectedSessionId: string | null;
  selectedAgentId: string | null;
  selectedClientId: string | null;
}

/** Purely local shell state. */
export interface HqUiState {
  activeView: HqViewId;
}

export type HqState = HqFleetState & HqSelectionState & HqUiState;

export interface HqActions {
  setActiveView: (view: HqViewId) => void;
  selectSession: (sessionId: string | null, agentId?: string | null) => void;
  selectAgent: (sessionId: string, agentId: string) => void;
  selectClient: (clientId: string | null) => void;
  markAuthRequired: () => void;
  dismissPeerEnvelope: () => void;

  /** Seed the first render from HTTP without claiming the WebSocket is live. */
  hydrateSnapshot: (snapshot: HqSnapshot) => void;
  applySnapshot: (snapshot: HqSnapshot) => void;
  applyEvent: (event: HqEventEnvelope) => void;
  applyAlert: (alert: HqAlertMessage) => void;
  applyCommandStatus: (command: HqCommandAuditEntry) => void;
  setConnected: (connected: boolean) => void;
  setNeedsSnapshotRefresh: (needed: boolean) => void;
  /**
   * Drop per-publisher resume cursors so the next reconnect's gap-fill starts
   * from the post-refresh state. Called on `hq.resume_reject` only.
   */
  resetResumeCursors: () => void;
}

export type HqStore = HqState & HqActions;
