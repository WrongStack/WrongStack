import type * as http from 'node:http';
import type { createHqPersistence, HqEventEnvelope, HqTimeseriesSample } from '@wrongstack/core/hq';
import type { WebSocket } from 'ws';
import * as HqServerSnapshot from '../snapshot.js';
import type { ConnectedClient } from '../types.js';
import { decodePathSegment } from '../utils.js';

export async function handleApiProjectDetail(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  clients: Map<WebSocket, ConnectedClient>,
): Promise<void> {
  const projectId = decodePathSegment(url.pathname.slice('/api/projects/'.length));
  if (projectId === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'invalid projectId encoding' } }),
    );
    return;
  }
  if (!projectId) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { code: 'BAD_REQUEST', message: 'projectId is required' } }));
    return;
  }
  const detail = HqServerSnapshot.buildProjectDetail(clients, projectId);
  if (!detail) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({ error: { code: 'NOT_FOUND', message: `Unknown project: ${projectId}` } }),
    );
    return;
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(detail));
}

export async function handleApiEvents(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  persistence: ReturnType<typeof createHqPersistence>,
  resolveMachineClientIds?: (machineId: string) => ReadonlySet<string>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
  const limit = Math.min(5000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
  const typeFilter = url.searchParams.get('type') ?? undefined;
  // W5 #19 (RFC hq-improvements-2026-09.md): extend the event-log
  // query surface with clientId, machineId, and time-range filters so
  // the cockpit event timeline can scope to a single source within a
  // bounded window without scanning the whole archive. The
  // HqEventLog.recent() surface already iterates and filters by type;
  // we apply the additional filters client-side here over its
  // already-narrowed result.
  const clientIdFilter = url.searchParams.get('clientId') ?? undefined;
  const machineIdFilter = url.searchParams.get('machineId') ?? undefined;
  // Time-range bounds are resolved client-side into epoch-ms (see
  // `fetchEvents` in packages/webui-hq/src/data/api.ts) so the server
  // doesn't need to parse a date format. `since` is inclusive lower
  // bound, `until` is inclusive upper bound.
  const sinceMsRaw = url.searchParams.get('since');
  const untilMsRaw = url.searchParams.get('until');
  const sinceMs =
    sinceMsRaw !== null && sinceMsRaw.length > 0 && Number.isFinite(Number(sinceMsRaw))
      ? Number(sinceMsRaw)
      : undefined;
  const untilMs =
    untilMsRaw !== null && untilMsRaw.length > 0 && Number.isFinite(Number(untilMsRaw))
      ? Number(untilMsRaw)
      : undefined;
  // `clientId` lives on the ENVELOPE (the dashboard shows `event.clientId`);
  // the payload has none. `machineId` is carried only by a few payloads
  // (`client.hello`'s client, session snapshots), so an event from a machine
  // is also matched through the clients currently connected from it.
  const clientsOnMachine =
    machineIdFilter !== undefined
      ? (resolveMachineClientIds?.(machineIdFilter) ?? new Set())
      : undefined;
  const matches = (event: HqEventEnvelope): boolean => {
    if (clientIdFilter !== undefined && event.clientId !== clientIdFilter) return false;
    if (machineIdFilter !== undefined) {
      const payload = event.payload as
        | { machineId?: unknown; client?: { machineId?: unknown } }
        | undefined;
      const onMachine =
        payload?.machineId === machineIdFilter ||
        payload?.client?.machineId === machineIdFilter ||
        (event.clientId !== undefined && clientsOnMachine?.has(event.clientId) === true);
      if (!onMachine) return false;
    }
    if (sinceMs !== undefined || untilMs !== undefined) {
      const ts = event.timestamp !== undefined ? Date.parse(event.timestamp) : Number.NaN;
      // Best-effort: keep events with unparseable timestamps rather than
      // dropping them — the client can still filter them out visually.
      if (!Number.isFinite(ts)) return true;
      if (sinceMs !== undefined && ts < sinceMs) return false;
      if (untilMs !== undefined && ts > untilMs) return false;
    }
    return true;
  };
  const narrowed =
    clientIdFilter !== undefined ||
    machineIdFilter !== undefined ||
    sinceMs !== undefined ||
    untilMs !== undefined;
  // Filters run INSIDE the scan: applying them to the newest `limit` events
  // of the whole log answered "nothing" whenever the scoped source had been
  // quiet for a while.
  const filtered = await persistence.eventLog.recent(
    limit,
    typeFilter,
    narrowed ? matches : undefined,
  );
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events: filtered, total: filtered.length }));
}

export async function handleApiTrendsCost(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  persistence: ReturnType<typeof createHqPersistence>,
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawSince = Number.parseInt(url.searchParams.get('since') ?? '0', 10);
  const since = Number.isFinite(rawSince) ? rawSince : 0;
  const samples: HqTimeseriesSample[] = await persistence.timeseries.read(since);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ samples }));
}
