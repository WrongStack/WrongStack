import type { createHqPersistence, HqCommandAuditLog, HqEventEnvelope } from '@wrongstack/hq';
import type { WebSocket } from '../ws-runtime.js';
import type { LoginAttemptStore } from './login-attempt-store.js';
import type { ConnectedClient, HqSessionEntry } from './types.js';
import * as HqServerWs from './ws.js';

const HQ_SESSION_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const HQ_SESSION_IDLE_TIMEOUT_MS = 30 * 60_000;
const PENDING_2FA_TTL_MS = 5 * 60_000;
export const HQ_SESSION_CLEANUP_INTERVAL_MS = 60_000;

/**
 * Expire browser sessions (absolute max age, idle timeout, abandoned 2FA) and
 * forget login-attempt counters older than 15 minutes.
 */
export function sweepHqBrowserSessions(
  sessions: Map<string, HqSessionEntry>,
  loginAttempts: LoginAttemptStore,
  socketCredentials: { closeSessionSockets(sessionId: string, reason: string): void },
): void {
  const now = Date.now();
  const maxAgeCutoff = now - HQ_SESSION_MAX_AGE_MS;
  const idleCutoff = now - HQ_SESSION_IDLE_TIMEOUT_MS;
  const pending2faCutoff = now - PENDING_2FA_TTL_MS;
  for (const [id, session] of sessions) {
    if (session.createdAt < maxAgeCutoff) {
      sessions.delete(id);
      // Max age is absolute, unlike the idle cutoff below: a socket still
      // streaming on a session that has outlived it must go too.
      socketCredentials.closeSessionSockets(id, 'Browser session expired');
      continue;
    }
    if (session.pending2fa) {
      if (session.createdAt < pending2faCutoff) sessions.delete(id);
      continue;
    }
    if (session.lastSeenAt < idleCutoff) {
      sessions.delete(id);
    }
  }
  for (const [ip, entry] of loginAttempts.entries()) {
    if (now - entry.lastAttempt > 15 * 60_000) loginAttempts.delete(ip);
  }
}

export interface StaleHqClientSweep {
  clients: Map<WebSocket, ConnectedClient>;
  browsers: Set<WebSocket>;
  auditLog: HqCommandAuditLog;
  eventLog: HqEventEnvelope[];
  persistence: ReturnType<typeof createHqPersistence>;
  clientTtlMs: number;
  sessionSnapshotTtlMs: number;
}

/**
 * Drop clients that stopped heartbeating, expire their stale session
 * snapshots (and the fleets bound to them), and reap session-summary clients
 * that have held no session past the TTL. Returns whether anything changed.
 */
export function sweepStaleHqClients({
  clients,
  browsers,
  auditLog,
  eventLog,
  persistence,
  clientTtlMs,
  sessionSnapshotTtlMs,
}: StaleHqClientSweep): boolean {
  const cutoff = Date.now() - clientTtlMs;
  const sessionCutoff = Date.now() - sessionSnapshotTtlMs;
  let changed = false;
  for (const [ws, client] of clients.entries()) {
    if (new Date(client.lastSeenAt).getTime() < cutoff) {
      const lostClient = client;
      ws.terminate();
      clients.delete(ws);
      HqServerWs.failUndeliveredCommands(lostClient, browsers, auditLog);
      HqServerWs.detectLeaderLoss(lostClient, clients, browsers, 'heartbeat-timeout', {
        eventLog,
        persistence,
      });
      changed = true;
      continue;
    }
    const expiredSessions = new Set<string>();
    for (const [sessionId, tracked] of client.sessions.entries()) {
      if (tracked.receivedAt < sessionCutoff) {
        client.sessions.delete(sessionId);
        client.mcpSnapshots.delete(sessionId);
        expiredSessions.add(sessionId);
        changed = true;
      }
    }
    for (const [runId, fleet] of client.fleets) {
      if (fleet.sessionId !== undefined && expiredSessions.has(fleet.sessionId)) {
        client.fleets.delete(runId);
        changed = true;
      }
    }
    if (
      client.capabilities.includes('session.summary') &&
      client.sessions.size === 0 &&
      Date.now() - Date.parse(client.connectedAt) > sessionSnapshotTtlMs
    ) {
      const lostClient = client;
      ws.terminate();
      clients.delete(ws);
      HqServerWs.failUndeliveredCommands(lostClient, browsers, auditLog);
      // This is a server-side session-summary TTL reap, NOT a missed
      // heartbeat: the branch above already returned for a genuinely
      // stale `lastSeenAt`, so this client is still heartbeating — it is
      // dropped because it has held zero session snapshots past the TTL.
      // Labeling it 'heartbeat-timeout' (the literal this branch used to
      // pass) made every peer.rehydrate/peer.lost banner claim a heartbeat
      // failure that never happened. 'crash' is the closest truthful
      // existing reason for an abrupt, non-graceful server-side loss.
      HqServerWs.detectLeaderLoss(lostClient, clients, browsers, 'crash', {
        eventLog,
        persistence,
      });
      changed = true;
    }
  }
  return changed;
}
