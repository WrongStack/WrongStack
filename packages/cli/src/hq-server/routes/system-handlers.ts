/**
 * HQ server — System route handlers.
 *
 * Extracted from the monolithic routes.ts for maintainability.
 * Covers: system update check, system health, command audit log, alerts.
 */

import type * as http from 'node:http';
import { WebSocket } from 'ws';
import type { HqCommandAuditLog, HqEventEnvelope, HqPersistence } from '@wrongstack/core/hq';
import { HqAlertEngine } from '@wrongstack/core/hq';
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
  const allOk = inMemoryEventLogActive && timeseriesStoreStatus === 'ok' && kanbanStoreStatus === 'ok';

  const clientCount = clients.size;
  const connectedClients = [...clients.values()].filter(
    (c) => Date.now() - new Date(c.lastSeenAt).getTime() < 60_000,
  ).length;

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
