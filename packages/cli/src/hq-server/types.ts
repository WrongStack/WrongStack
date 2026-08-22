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
  HqGovernanceSnapshotPayload,
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
  HqGovernanceSnapshotPayload,
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
  /** Latest read-only governance advisory accepted from this project's leader. */
  governanceSnapshot?: { payload: HqGovernanceSnapshotPayload; receivedAt: number };
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
  /** Base32-encoded TOTP secret for HQ 2FA (live-reloaded from auth.json). */
  totpSecret?: string | undefined;
  /** Pending TOTP secret (setup but not yet confirmed by enable). */
  totpPendingSecret?: string | undefined;
  /** SHA-256 hashes of single-use recovery codes (live-reloaded from auth.json). */
  totpRecoveryCodes?: string[] | undefined;
  /**
   * Highest TOTP time-step counter already spent on a successful login
   * (RFC 6238 §5.2 single-use). The ±1-step validation window keeps a code
   * arithmetically valid for ~90s, so without this a code captured in transit
   * — shoulder-surfed, read off a notification, replayed from a proxy log —
   * authenticates a second time. Deliberately process-local and NOT persisted
   * to auth.json: a code cannot outlive its own window, so a restart losing
   * the marker costs at most the tail of one step.
   */
  totpLastUsedCounter?: number | undefined;
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
  /**
   * Set when a password login passed but 2FA verification is still pending.
   * The session is valid but must NOT be treated as fully authenticated —
   * only `/api/login/verify` may consume it. Other routes should reject it.
   * Short-lived: `PENDING_2FA_TTL_MS` bounds it (5 min).
   */
  readonly pending2fa?: boolean | undefined;
  /**
   * Last time this session was used (epoch ms). Bumped on every authenticated
   * request to implement idle-timeout (sliding expiration). Sessions idle for
   * longer than `HQ_SESSION_IDLE_TIMEOUT_MS` are rejected and evicted.
   */
  lastSeenAt: number;
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

export interface HqRouterMailboxGateway {
  mailbox: import('@wrongstack/core/coordination').Mailbox;
  router: ReturnType<typeof import('@wrongstack/core/coordination').createMailboxHttpRouter>;
}
