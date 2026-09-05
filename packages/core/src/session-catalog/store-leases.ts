import { randomBytes, randomUUID } from 'node:crypto';
import type { DatabaseSync } from 'node:sqlite';
import { isPidAlive } from '../utils/pid.js';
import type { ResumeReservation, SessionLeaseCredential } from './protocol.js';
import {
  SESSION_CATALOG_DEFAULT_LEASE_MS,
  SESSION_CATALOG_DEFAULT_RESERVATION_MS,
} from './protocol.js';
import type { SessionRegistryEntry } from './session-registry-types.js';
import {
  assertId,
  boundedMs,
  conflict,
  hashSecret,
  type LeaseRow,
  MAX_LEASE_MS,
  MAX_RESERVATION_MS,
  parseJson,
  type ReservationRow,
  secretMatches,
} from './store-schema.js';

export function reapExpiredCatalogEntries(db: DatabaseSync, now = Date.now()): void {
  db.prepare('DELETE FROM resume_reservations WHERE expires_at<=?').run(now);
  db.prepare('DELETE FROM maintenance_leases WHERE expires_at<=?').run(now);
  const rows = db
    .prepare('SELECT * FROM session_leases WHERE lease_expires_at<=?')
    .all(now) as unknown as LeaseRow[];
  for (const row of rows) {
    if (!isPidAlive(row.owner_pid)) {
      db.prepare('DELETE FROM session_leases WHERE session_id=? AND lease_id=?').run(
        row.session_id,
        row.lease_id,
      );
    } else if (row.status !== 'lost') {
      db.prepare("UPDATE session_leases SET status='lost' WHERE session_id=? AND lease_id=?").run(
        row.session_id,
        row.lease_id,
      );
    }
  }
}

export function maintenanceExists(db: DatabaseSync, sessionId: string): boolean {
  return Boolean(
    db
      .prepare('SELECT 1 AS yes FROM maintenance_leases WHERE session_id=? AND expires_at>?')
      .get(sessionId, Date.now()),
  );
}

export function getLeaseRow(db: DatabaseSync, sessionId: string): LeaseRow | undefined {
  return db.prepare('SELECT * FROM session_leases WHERE session_id=?').get(sessionId) as unknown as
    | LeaseRow
    | undefined;
}

export function foreignLiveLease(
  db: DatabaseSync,
  sessionId: string,
  callerPid = process.pid,
): boolean {
  const live = getLeaseRow(db, sessionId);
  return Boolean(live) && live!.owner_pid !== callerPid;
}

export function verifyLeaseCredential(
  db: DatabaseSync,
  credential: SessionLeaseCredential,
): LeaseRow {
  assertId(credential.sessionId);
  const row = getLeaseRow(db, credential.sessionId);
  if (
    !row ||
    row.lease_id !== credential.leaseId ||
    row.owner_instance_id !== credential.ownerInstanceId ||
    !secretMatches(credential.leaseSecret, row.lease_secret_hash)
  ) {
    throw conflict(`Session ${credential.sessionId} lease proof is invalid or no longer owned`);
  }
  return row;
}

export function createSessionLease(
  db: DatabaseSync,
  entry: SessionRegistryEntry,
  ownerInstanceId: string,
  leaseMs?: number,
): SessionLeaseCredential {
  assertId(entry.sessionId);
  if (!ownerInstanceId || ownerInstanceId.length > 256)
    throw new TypeError('Invalid owner instance id');
  if (!Number.isSafeInteger(entry.pid) || entry.pid <= 0) throw new TypeError('Invalid owner pid');
  const now = Date.now();
  const leaseId = randomUUID();
  const leaseSecret = randomBytes(32).toString('hex');
  const expiresAt = now + boundedMs(leaseMs, SESSION_CATALOG_DEFAULT_LEASE_MS, MAX_LEASE_MS);
  db.prepare(`INSERT INTO session_leases(
      session_id,lease_id,lease_secret_hash,owner_instance_id,owner_pid,owner_started_at,
      entry_json,agent_revision,status,last_heartbeat_at,lease_expires_at
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`).run(
    entry.sessionId,
    leaseId,
    hashSecret(leaseSecret),
    ownerInstanceId,
    entry.pid,
    entry.startedAt,
    JSON.stringify(entry),
    0,
    entry.status,
    now,
    expiresAt,
  );
  return { sessionId: entry.sessionId, leaseId, leaseSecret, ownerInstanceId, expiresAt };
}

export function executeClaimNew(
  db: DatabaseSync,
  entry: SessionRegistryEntry,
  ownerInstanceId: string,
  bumpGeneration: () => number,
  leaseMs?: number,
): SessionLeaseCredential {
  reapExpiredCatalogEntries(db);
  const existing = getLeaseRow(db, entry.sessionId);
  if (existing) {
    throw conflict(
      `Session ${entry.sessionId} is already open in another running wstack (pid ${existing.owner_pid}).`,
    );
  }
  if (maintenanceExists(db, entry.sessionId)) {
    throw conflict(`Session ${entry.sessionId} is under maintenance`);
  }
  const reserved = db
    .prepare('SELECT 1 AS yes FROM resume_reservations WHERE target_session_id=? AND expires_at>?')
    .get(entry.sessionId, Date.now());
  if (reserved) throw conflict(`Session ${entry.sessionId} is reserved for resume`);
  const credential = createSessionLease(db, entry, ownerInstanceId, leaseMs);
  bumpGeneration();
  return credential;
}

export function executeReconnectLease(
  db: DatabaseSync,
  credential: SessionLeaseCredential,
): SessionLeaseCredential {
  const row = verifyLeaseCredential(db, credential);
  if (row.owner_pid !== process.pid && !isPidAlive(row.owner_pid)) {
    throw conflict(`Session ${credential.sessionId} owner process is no longer alive`);
  }
  const expiresAt = Date.now() + SESSION_CATALOG_DEFAULT_LEASE_MS;
  db.prepare(
    'UPDATE session_leases SET lease_expires_at=?,last_heartbeat_at=?,status=? WHERE session_id=? AND lease_id=?',
  ).run(
    expiresAt,
    Date.now(),
    row.status === 'lost' ? 'idle' : row.status,
    row.session_id,
    row.lease_id,
  );
  return { ...credential, expiresAt };
}

export function executeReserveResume(
  db: DatabaseSync,
  targetSessionId: string,
  requesterInstanceId: string,
  sessionExistsOnDisk: (sessionId: string) => boolean,
  bumpGeneration: () => number,
  currentSessionId?: string,
  reservationMs?: number,
): ResumeReservation {
  assertId(targetSessionId);
  reapExpiredCatalogEntries(db);
  const live = getLeaseRow(db, targetSessionId);
  if (live) {
    throw conflict(
      `Session ${targetSessionId} is already open in another running wstack (pid ${live.owner_pid}).`,
    );
  }
  if (maintenanceExists(db, targetSessionId)) {
    throw conflict(`Session ${targetSessionId} is under maintenance`);
  }
  const catalog = db
    .prepare('SELECT 1 AS yes FROM sessions WHERE session_id=?')
    .get(targetSessionId);
  if (!catalog && !sessionExistsOnDisk(targetSessionId)) {
    throw new Error(`Session not found: ${targetSessionId}`);
  }
  const reservationId = randomUUID();
  const now = Date.now();
  const expiresAt =
    now + boundedMs(reservationMs, SESSION_CATALOG_DEFAULT_RESERVATION_MS, MAX_RESERVATION_MS);
  try {
    db.prepare(
      'INSERT INTO resume_reservations(reservation_id,target_session_id,requester_instance_id,current_session_id,created_at,expires_at) VALUES (?,?,?,?,?,?)',
    ).run(
      reservationId,
      targetSessionId,
      requesterInstanceId,
      currentSessionId ?? null,
      now,
      expiresAt,
    );
  } catch {
    throw conflict(`Session ${targetSessionId} is already reserved for resume`);
  }
  bumpGeneration();
  return { reservationId, targetSessionId, requesterInstanceId, expiresAt };
}

export function executeActivateReservation(
  db: DatabaseSync,
  reservation: ResumeReservation,
  entry: SessionRegistryEntry,
  bumpGeneration: () => number,
  leaseMs?: number,
): SessionLeaseCredential {
  reapExpiredCatalogEntries(db);
  const row = db
    .prepare('SELECT * FROM resume_reservations WHERE reservation_id=?')
    .get(reservation.reservationId) as unknown as ReservationRow | undefined;
  if (
    !row ||
    row.target_session_id !== reservation.targetSessionId ||
    row.requester_instance_id !== reservation.requesterInstanceId ||
    row.expires_at <= Date.now()
  ) {
    throw conflict('Resume reservation expired or is not owned by this requester');
  }
  if (entry.sessionId !== row.target_session_id) {
    throw new TypeError('Reservation target and session entry differ');
  }
  if (getLeaseRow(db, entry.sessionId) || maintenanceExists(db, entry.sessionId)) {
    throw conflict(`Session ${entry.sessionId} can no longer be activated`);
  }
  const credential = createSessionLease(db, entry, reservation.requesterInstanceId, leaseMs);
  db.prepare('DELETE FROM resume_reservations WHERE reservation_id=?').run(row.reservation_id);
  bumpGeneration();
  return credential;
}

export function executeRenewReservation(
  db: DatabaseSync,
  reservationId: string,
  requesterInstanceId: string,
  reservationMs?: number,
): ResumeReservation {
  const row = db
    .prepare('SELECT * FROM resume_reservations WHERE reservation_id=?')
    .get(reservationId) as unknown as ReservationRow | undefined;
  if (!row || row.requester_instance_id !== requesterInstanceId) {
    throw conflict('Resume reservation is not owned by this requester');
  }
  if (row.expires_at <= Date.now()) throw conflict('Resume reservation expired');
  const expiresAt =
    Date.now() +
    boundedMs(reservationMs, SESSION_CATALOG_DEFAULT_RESERVATION_MS, MAX_RESERVATION_MS);
  db.prepare('UPDATE resume_reservations SET expires_at=? WHERE reservation_id=?').run(
    expiresAt,
    reservationId,
  );
  return {
    reservationId,
    targetSessionId: row.target_session_id,
    requesterInstanceId,
    expiresAt,
  };
}

export function executeHeartbeat(
  db: DatabaseSync,
  credential: SessionLeaseCredential,
  status?: SessionRegistryEntry['status'],
): SessionLeaseCredential {
  const row = verifyLeaseCredential(db, credential);
  const expiresAt = Date.now() + SESSION_CATALOG_DEFAULT_LEASE_MS;
  const nextStatus =
    status ?? (row.status === 'closing' ? 'closing' : row.status === 'lost' ? 'idle' : row.status);
  const entry = parseJson<SessionRegistryEntry>(row.entry_json);
  entry.status = nextStatus;
  entry.lastHeartbeatAt = new Date().toISOString();
  db.prepare(
    'UPDATE session_leases SET status=?,entry_json=?,last_heartbeat_at=?,lease_expires_at=? WHERE session_id=? AND lease_id=?',
  ).run(nextStatus, JSON.stringify(entry), Date.now(), expiresAt, row.session_id, row.lease_id);
  return { ...credential, expiresAt };
}

export function executePublishAgents(
  db: DatabaseSync,
  credential: SessionLeaseCredential,
  revision: number,
  boundedAgents: SessionRegistryEntry['agents'],
  bumpGeneration: () => number,
): { accepted: boolean; revision: number } {
  const row = verifyLeaseCredential(db, credential);
  if (revision <= row.agent_revision) return { accepted: false, revision: row.agent_revision };
  const entry = parseJson<SessionRegistryEntry>(row.entry_json);
  entry.agents = boundedAgents;
  entry.agentCount = boundedAgents.length;
  entry.status = boundedAgents.some((agent) => agent.status !== 'idle') ? 'active' : 'idle';
  entry.lastHeartbeatAt = new Date().toISOString();
  db.prepare(
    'UPDATE session_leases SET entry_json=?,agent_revision=?,status=?,last_heartbeat_at=? WHERE session_id=? AND lease_id=?',
  ).run(JSON.stringify(entry), revision, entry.status, Date.now(), row.session_id, row.lease_id);
  bumpGeneration();
  return { accepted: true, revision };
}

export function executeMarkClosing(
  db: DatabaseSync,
  credential: SessionLeaseCredential,
  bumpGeneration: () => number,
): void {
  const row = verifyLeaseCredential(db, credential);
  const entry = parseJson<SessionRegistryEntry>(row.entry_json);
  entry.status = 'closing';
  entry.lastHeartbeatAt = new Date().toISOString();
  db.prepare(
    "UPDATE session_leases SET status='closing',entry_json=?,last_heartbeat_at=? WHERE session_id=? AND lease_id=?",
  ).run(JSON.stringify(entry), Date.now(), row.session_id, row.lease_id);
  bumpGeneration();
}

export function executeReleaseLease(
  db: DatabaseSync,
  credential: SessionLeaseCredential,
  bumpGeneration: () => number,
): void {
  const row = verifyLeaseCredential(db, credential);
  db.prepare('DELETE FROM session_leases WHERE session_id=? AND lease_id=?').run(
    row.session_id,
    row.lease_id,
  );
  bumpGeneration();
}

export function queryLiveLeases(db: DatabaseSync): SessionRegistryEntry[] {
  reapExpiredCatalogEntries(db);
  return (
    db
      .prepare(
        'SELECT entry_json,status,last_heartbeat_at FROM session_leases ORDER BY last_heartbeat_at DESC',
      )
      .all() as unknown as Array<{
      entry_json: string;
      status: SessionRegistryEntry['status'];
      last_heartbeat_at: number;
    }>
  ).map((row) => ({
    ...parseJson<SessionRegistryEntry>(row.entry_json),
    status: row.status,
    lastHeartbeatAt: new Date(row.last_heartbeat_at).toISOString(),
  }));
}
