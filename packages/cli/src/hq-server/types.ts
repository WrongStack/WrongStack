/**
 * Shared types for the HQ server modules.
 *
 * @module hq-server/types
 */

import type {
  HqAlertRuleConfig,
  HqBrowserMessage,
  HqClientCapability,
  HqClientRecord,
  HqEventEnvelope,
  HqFleetSnapshotPayload,
  HqMailboxSnapshotPayload,
  HqMcpServerHealth,
  HqPersistence,
  HqProjectIdentity,
  HqProjectRecord,
  HqQueuedCommand,
  HqRedactionPolicy,
  HqSessionSnapshotPayload,
  HqToken,
  HqTranscriptEntry,
} from '@wrongstack/core/hq';
import type { WebSocket } from 'ws';

export type {
  HqBrowserMessage,
  HqClientCapability,
  HqClientRecord,
  HqEventEnvelope,
  HqFleetSnapshotPayload,
  HqMailboxSnapshotPayload,
  HqMcpServerHealth,
  HqPersistence,
  HqProjectIdentity,
  HqProjectRecord,
  HqQueuedCommand,
  HqRedactionPolicy,
  HqSessionSnapshotPayload,
  HqToken,
  HqTranscriptEntry,
};

// ── In-memory data structures ──────────────────────────────────────────────

export interface TrackedSessionSnapshot {
  payload: HqSessionSnapshotPayload;
  /** Epoch ms of the last `session.snapshot` refresh — freshness authority for the cleanup timer. */
  receivedAt: number;
}

export interface TrackedFleetSnapshot {
  payload: HqFleetSnapshotPayload;
  /** Owning session, when the publisher supplied one. */
  sessionId?: string;
  receivedAt: number;
}

export interface ConnectedClient {
  ws: WebSocket;
  clientId: string;
  projectId: string;
  project: HqProjectIdentity;
  kind: string;
  connectedAt: string;
  lastSeenAt: string;
  hostname?: string;
  pid?: number;
  version?: string;
  capabilities: readonly string[];
  /** Auth token used for this socket; absent only in explicit open mode. */
  authToken?: HqToken;
  /** Client-declared privacy policy; operator overrides are clamped dynamically. */
  declaredRedactionPolicy: HqRedactionPolicy;
  /** Highest accepted event sequence for replay/duplicate protection. */
  lastEventSeq: number;
  /** Per-client mailbox snapshots, keyed by projectId:mailboxId. */
  mailboxes: Map<string, HqMailboxSnapshotPayload>;
  /** Stable machine identifier — used for machine-level aggregation. */
  machineId?: string;
  /** Per-client session snapshots (the spine of the fleet tree). */
  sessions: Map<string, TrackedSessionSnapshot>;
  /** Per-client coordinator fleet snapshots, keyed by runId and owned by a session when known. */
  fleets: Map<string, TrackedFleetSnapshot>;
  /** Per-session MCP health snapshots, keyed by sessionId. */
  mcpSnapshots: Map<string, { servers: HqMcpServerHealth[]; receivedAt: number }>;
  /** Pending outbound commands (Phase 3 — control plane). */
  commandQueue: HqQueuedCommand[];
  /**
   * Whether this client is the project's leader (the client with
   * `control.receive` capability that other clients coordinate with).
   * Live tracking lives in `HqServer`; this field is the snapshot.
   * Used by the leader-deposed detector in `peer.rehydrate` emission.
   * Defaults to `false` for clients without `control.receive`.
   */
  isLeader: boolean;
}

export interface HqRouterMutableAuth {
  operatorPolicy: HqRedactionPolicy;
  operatorPolicyOverride: Partial<HqRedactionPolicy> | undefined;
  browserTokens: Set<string>;
  clientTokens: Set<string>;
  browserTokenObjs: Map<string, { id: string; capabilities?: string[]; expiresAt?: string }>;
  clientTokenObjs: Map<string, HqToken>;
  passwordHash?: string | undefined;
  cookieSecret?: string | undefined;
  alertRules: HqAlertRuleConfig | undefined;
  /**
   * WS-010: set when the live bind would become unauthenticated and
   * network-reachable. `assessHqExposure` runs at startup only, so revoking the
   * last credential on a running `wstack hq` (default bind 0.0.0.0) silently
   * dropped it into open mode — the kill switch acted as an unlock. When this
   * is true, routes keep demanding auth even though no credential remains, so
   * the surface fails closed instead of opening up.
   */
  requireAuthFloor?: boolean | undefined;
}

/**
 * Session record stored in the server-side `sessions` Map.
 *
 * - `kind: 'password'` — created by `/api/login`; full browser access.
 * - `kind: 'token'` — created by `/api/auth/bootstrap`; scoped to the
 *   originating browser token's ID and capabilities so revocation/expiry
 *   of that token invalidates the session too.
 */
export interface HqSessionEntry {
  readonly createdAt: number;
  readonly kind: 'password' | 'token';
  /** For token sessions: the browser-token ID this session was minted from. */
  readonly tokenId?: string | undefined;
  /** For token sessions: capabilities inherited from the source token. */
  readonly capabilities?: string[] | undefined;
}

// ── Transcript ring buffer ─────────────────────────────────────────────────

export interface TranscriptRing {
  entries: HqTranscriptEntry[];
  machineId?: string;
}

// ── Snapshot broadcaster ───────────────────────────────────────────────────

export interface HqSnapshotBroadcaster {
  currentSerialized(): string;
  broadcast(): void;
  close(): void;
}

// ── Project detail ─────────────────────────────────────────────────────────

export interface ProjectDetail {
  generatedAt: string;
  project: HqProjectRecord;
  clients: readonly HqClientRecord[];
  mailboxes: readonly HqMailboxSnapshotPayload[];
}
