import type { SessionSummary } from '../types/session.js';
import type { SessionAgentRecord } from './session-agents.js';
import type { SessionRegistryEntry } from './session-registry-types.js';

export const SESSION_CATALOG_PROTOCOL_VERSION = 1;
export const SESSION_CATALOG_MAX_FRAME_CHARS = 4 * 1024 * 1024;
export const SESSION_CATALOG_DEFAULT_LEASE_MS = 30_000;
export const SESSION_CATALOG_DEFAULT_RESERVATION_MS = 15_000;
export const SESSION_CATALOG_MAX_AGENTS = 128;

export interface SessionLeaseCredential {
  sessionId: string;
  leaseId: string;
  leaseSecret: string;
  ownerInstanceId: string;
  expiresAt: number;
}

export interface ResumeReservation {
  reservationId: string;
  targetSessionId: string;
  requesterInstanceId: string;
  expiresAt: number;
}

export interface MaintenanceLease {
  sessionId: string;
  operation: 'delete' | 'prune' | 'clear' | 'truncate' | 'rewind' | 'repair';
  holderId: string;
  leaseId: string;
  expiresAt: number;
}

export interface SessionCatalogServerInfo {
  protocolVersion: number;
  pid: number;
  projectDir: string;
  projectRoot: string;
  endpoint: string;
  databasePath: string;
  instanceId: string;
  startedAt: string;
}

export interface SessionCatalogHealth extends SessionCatalogServerInfo {
  checkedAt: number;
  uptimeMs: number;
  clients: number;
  activeRequests: number;
  catalogRows: number;
  damagedRows: number;
  liveLeases: number;
  reservations: number;
  maintenanceLeases: number;
  generation: number;
  lastReconciliation?: string | undefined;
  memory: { rss: number; heapUsed: number; heapTotal: number; external: number };
  handles: number;
}

export interface SessionCatalogMetadata extends SessionCatalogServerInfo {
  authToken: string;
}

export interface CatalogSessionRecord extends SessionSummary {
  transcriptRelativePath: string;
  summaryRelativePath: string;
  transcriptSize: number;
  transcriptMtimeMs: number;
  summaryRevision: number;
  indexedAt: string;
  damaged: boolean;
}

export interface SessionCatalogListArgs {
  limit?: number | undefined;
  search?: string | undefined;
  since?: string | undefined;
  until?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  minTokens?: number | undefined;
  titleContains?: string | undefined;
}

export type SessionCatalogEventKind =
  | 'session.claimed'
  | 'session.presence_changed'
  | 'session.closing'
  | 'session.released'
  | 'session.catalog_changed'
  | 'session.deleted'
  | 'session.rebuild_started'
  | 'session.rebuild_completed';

export interface SessionCatalogEvent {
  instanceId: string;
  sequence: number;
  kind: SessionCatalogEventKind;
  sessionId?: string | undefined;
  generation: number;
  at: string;
}

/**
 * NOTE: adding a field to any `args` below also requires adding it to
 * `OPERATION_KEYS` in `project-server.ts` — the daemon validates every
 * request against that allowlist and rejects unknown fields at runtime,
 * which TypeScript cannot catch.
 */
export interface SessionCatalogOperations {
  ping: { args: Record<string, never>; result: SessionCatalogHealth };
  claim_new: {
    args: { entry: SessionRegistryEntry; ownerInstanceId: string; leaseMs?: number };
    result: SessionLeaseCredential;
  };
  reconnect_lease: {
    args: SessionLeaseCredential;
    result: SessionLeaseCredential;
  };
  reserve_resume: {
    args: {
      targetSessionId: string;
      requesterInstanceId: string;
      currentSessionId?: string;
      reservationMs?: number;
    };
    result: ResumeReservation;
  };
  activate_reservation: {
    args: { reservation: ResumeReservation; entry: SessionRegistryEntry; leaseMs?: number };
    result: SessionLeaseCredential;
  };
  /**
   * Extend a reservation that is still being worked on.
   *
   * A resume reserves ownership BEFORE it can know how long the transcript
   * takes to open, and the default window is 15s. Hydrating a large journal
   * (load + summary + file-observation validation + opening the append
   * handle, all of which can also wait on this daemon) routinely outruns it,
   * and `activate_reservation` then fails with "reservation expired" after
   * the expensive work is already done. Renewal keeps the reservation alive
   * for exactly as long as the caller is demonstrably still hydrating.
   */
  renew_reservation: {
    args: { reservationId: string; requesterInstanceId: string; reservationMs?: number };
    result: ResumeReservation;
  };
  cancel_reservation: {
    args: { reservationId: string; requesterInstanceId: string };
    result: void;
  };
  heartbeat: {
    args: { credential: SessionLeaseCredential; status?: SessionRegistryEntry['status'] };
    result: SessionLeaseCredential;
  };
  publish_agents: {
    args: {
      credential: SessionLeaseCredential;
      revision: number;
      agents: SessionRegistryEntry['agents'];
    };
    result: { accepted: boolean; revision: number };
  };
  mark_closing: { args: { credential: SessionLeaseCredential }; result: void };
  release: { args: { credential: SessionLeaseCredential }; result: void };
  list_live: { args: Record<string, never>; result: SessionRegistryEntry[] };
  get_live: { args: { sessionId: string }; result: SessionRegistryEntry | null };
  subscribe: { args: { cursor?: number }; result: { instanceId: string; sequence: number } };
  unsubscribe: { args: Record<string, never>; result: void };
  upsert_summary: {
    args: {
      summary: SessionSummary;
      transcriptRelativePath?: string;
      summaryRelativePath?: string;
    };
    result: CatalogSessionRecord;
  };
  list_catalog: { args: SessionCatalogListArgs; result: CatalogSessionRecord[] };
  resolve_id: { args: { query: string }; result: string };
  get_summary: { args: { sessionId: string }; result: CatalogSessionRecord | null };
  /**
   * Agent roster of one session, derived from its journal. Read-only: there
   * is no write op, because the rows are a projection of the transcript and
   * a writer would create a second authority that can disagree with it.
   */
  list_session_agents: { args: { sessionId: string }; result: SessionAgentRecord[] };
  rename: { args: { sessionId: string; name: string }; result: CatalogSessionRecord };
  acquire_maintenance: {
    args: {
      sessionId: string;
      operation: MaintenanceLease['operation'];
      holderId: string;
      leaseMs?: number;
      /** Caller's OS pid. The server runs in the detached catalog daemon, so
       *  it cannot use its own `process.pid` to recognise the session owner. */
      holderPid?: number;
    };
    result: MaintenanceLease;
  };
  release_maintenance: { args: { lease: MaintenanceLease }; result: void };
  delete: { args: { sessionId: string; lease: MaintenanceLease }; result: void };
  prune: { args: { maxAgeDays: number; holderId: string }; result: number };
  rebuild_catalog: { args: Record<string, never>; result: { indexed: number; damaged: number } };
}

export type SessionCatalogOperationName = keyof SessionCatalogOperations;

export type SessionCatalogClientMessage =
  | {
      type: 'request';
      id: number;
      op: SessionCatalogOperationName;
      args: unknown;
      authToken?: string;
    }
  | { type: 'shutdown'; id: number; reason?: string; authToken?: string };

export type SessionCatalogServerMessage =
  | ({ type: 'hello' } & SessionCatalogServerInfo)
  | { type: 'event'; event: SessionCatalogEvent }
  | { type: 'response'; id: number; ok: true; result: unknown }
  | { type: 'response'; id: number; ok: false; error: string; errorName?: string };

export function encodeSessionCatalogMessage(message: object): string {
  return `${JSON.stringify(message)}\n`;
}
