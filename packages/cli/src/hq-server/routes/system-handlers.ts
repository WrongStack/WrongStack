/**
 * HQ server — System route handlers.
 *
 * Extracted from the monolithic routes.ts for maintainability.
 * Covers: system update check, system health, command audit log, alerts.
 */

import type * as http from 'node:http';
import type {
  HqAlertEngine,
  HqCommandAuditLog,
  HqEventEnvelope,
  HqPersistence,
} from '@wrongstack/hq';
import type { WebSocket } from 'ws';
import type { HqMailboxGatewayHealth } from '../mailbox-gateway-health.js';
import type { ConnectedClient } from '../types.js';

export async function handleApiSystemUpdate(res: http.ServerResponse): Promise<void> {
  const [{ checkForUpdate }, { detectUpdatePackageName }] = await Promise.all([
    import('../../update-check.js'),
    import('../../subcommands/handlers/update.js'),
  ]);
  const packageName = detectUpdatePackageName();
  const info = await checkForUpdate({ packageName });
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify({
      ...info,
      packageName,
      command: 'wstack update',
    }),
  );
}

export async function handleApiSystemHealth(
  res: http.ServerResponse,
  clients: Map<WebSocket, ConnectedClient>,
  persistence: HqPersistence,
  eventLog: HqEventEnvelope[],
): Promise<void> {
  const now = Date.now();
  const eventCount = eventLog.length;

  let timeseriesStoreStatus: 'ok' | 'degraded' | 'unknown' = 'unknown';
  let kanbanStoreStatus: 'ok' | 'degraded' | 'unknown' = 'unknown';

  try {
    const tsOk = await persistence.timeseries.read(now - 300_000);
    timeseriesStoreStatus = Array.isArray(tsOk) ? 'ok' : 'degraded';
  } catch {
    timeseriesStoreStatus = 'degraded';
  }

  try {
    await persistence.kanban.load('__hq_health_probe__');
    kanbanStoreStatus = 'ok';
  } catch {
    kanbanStoreStatus = 'degraded';
  }

  const inMemoryEventLogActive = true;
  const allOk =
    inMemoryEventLogActive && timeseriesStoreStatus === 'ok' && kanbanStoreStatus === 'ok';

  const clientCount = clients.size;
  const connectedClients = [...clients.values()].filter(
    (c) => Date.now() - new Date(c.lastSeenAt).getTime() < 60_000,
  ).length;

  // W1 #18 (architecture overview): per-client inbound rate + staleness for the
  // cockpit's "Publisher backpressure" tile. The publisher's own `getQueueStats()`
  // lives on the CLIENT side — the server-side analogue is "how recently has
  // this client refreshed?". A stale client is the visible symptom of a
  // saturated publisher queue (offline backlog growing faster than drain).
  const clientHealth = [...clients.values()].map((c) => {
    const lastSeenMs = new Date(c.lastSeenAt).getTime();
    const ageMs = Number.isFinite(lastSeenMs) ? now - lastSeenMs : Number.POSITIVE_INFINITY;
    return {
      clientId: c.clientId,
      hostname: c.hostname ?? null,
      machineId: c.machineId ?? null,
      lastSeenAt: c.lastSeenAt,
      ageMs,
      // Bucket the staleness the same way the cockpit tile renders it: fresh
      // (<5s), quiet (<60s), stale (>60s).
      staleness: ageMs < 5_000 ? 'fresh' : ageMs < 60_000 ? 'quiet' : 'stale',
    };
  });

  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(
    JSON.stringify({
      status: allOk ? 'healthy' : 'degraded',
      uptime: {
        serverTime: new Date().toISOString(),
        eventLogSize: eventCount,
      },
      stores: {
        events: 'ok',
        timeseries: timeseriesStoreStatus,
        kanban: kanbanStoreStatus,
      },
      connections: {
        total: clientCount,
        active: connectedClients,
        stale: clientCount - connectedClients,
      },
      // New: per-client publisher health (W1 #18).
      publisherHealth: clientHealth,
    }),
  );
}

export async function handleApiCommandsAudit(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  auditLog: HqCommandAuditLog,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
  const limit = Math.min(1000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ commands: auditLog.recent(limit) }));
}

export async function handleApiAlerts(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  alertEngine: HqAlertEngine,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '100', 10);
  const limit = Math.min(500, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 100));
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      active: alertEngine.activeAlerts(),
      history: alertEngine.recentAlerts(limit),
    }),
  );
}

/**
 * Structural view of the gateway manager this handler needs. Typing the
 * parameter structurally — rather than importing `MailboxGatewayManager` —
 * keeps this module out of the type-inclusive cycle
 * `mailbox-gateway-manager → routes → system-handlers`, which
 * `check:architecture` reports as unexcepted. The real manager satisfies this
 * shape, so callers and the wire contract are unaffected.
 */
interface MailboxHealthSource {
  getHealth(): HqMailboxGatewayHealth;
}

/**
 * W2 #14 (RFC hq-improvements-2026-09.md): GET /api/health/mailbox —
 * mailbox gateway health snapshot for the cockpit's "Mailbox gateway" card.
 *
 * Surfaces {@link MailboxHealthSource.getHealth} verbatim. The contract
 * (basename as `projectId`, full path as `projectRoot`, `actorAttached: false`
 * on the HQ mount, sorted gateways) is locked by the focused test in
 * `packages/cli/tests/hq-mailbox-gateway-health.test.ts`.
 *
 * No query parameters. No mutation. Same auth contract as
 * `/api/system/health` — gated by `requireBrowserAuth` upstream in the
 * router, not duplicated here.
 */
export function handleApiMailboxHealth(
  res: http.ServerResponse,
  mailboxManager: MailboxHealthSource,
): void {
  const health = mailboxManager.getHealth();
  res.writeHead(200, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(health));
}
