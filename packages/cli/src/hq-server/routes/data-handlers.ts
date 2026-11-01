import type * as http from 'node:http';
import type {
  createHqPersistence,
  HqEventEnvelope,
  HqMachineRoster,
  HqTimeseriesSample,
} from '@wrongstack/hq';
import { scopeTimeseriesSamples } from '@wrongstack/hq';
import type { WebSocket } from 'ws';
import { authenticateBrowserRequest, hqAuthRequired } from '../auth.js';
import * as HqServerSnapshot from '../snapshot.js';
import type { ConnectedClient, HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import { decodePathSegment, hqMachineKey } from '../utils.js';
import { callerCanEnqueue } from './mailbox-handlers.js';

const rawMachineIdOf = (client: ConnectedClient): string =>
  client.machineId || client.project.machineId;
const machineKeyOfClient = (client: ConnectedClient): string =>
  hqMachineKey(client.hostname, rawMachineIdOf(client));

/** Client ids of the connected clients a predicate picks. */
function clientIdsWhere(
  clients: Map<WebSocket, ConnectedClient>,
  pick: (client: ConnectedClient) => boolean,
): Set<string> {
  const ids = new Set<string>();
  for (const client of clients.values()) if (pick(client)) ids.add(client.clientId);
  return ids;
}

function writeJson(res: http.ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

/**
 * `DELETE /api/machines/:key` — forget an OFFLINE machine from the roster.
 * Needs the same capability as steering a client (`control.enqueue`): it
 * changes what every operator sees. A connected machine is refused (409),
 * since the next snapshot would learn it again.
 */
export function handleApiForgetMachine(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  rawKey: string,
  deps: {
    mutableAuth: HqRouterMutableAuth;
    sessions: Map<string, HqSessionEntry>;
    roster: HqMachineRoster;
    /** Rebuilds the snapshot, so the roster's live set is current. */
    refresh: () => unknown;
    onChanged?: (() => void) | undefined;
  },
): void {
  const auth = authenticateBrowserRequest(req, url, deps.mutableAuth, deps.sessions);
  if (hqAuthRequired(deps.mutableAuth) && !auth) {
    writeJson(res, 401, { error: 'unauthorized' });
    return;
  }
  if (!callerCanEnqueue(auth, deps.mutableAuth)) {
    writeJson(res, 403, { error: 'forbidden: token lacks control.enqueue capability' });
    return;
  }
  // A machine key is a map key, never a path, so `:` is legitimate here and
  // the path-segment decoder (which refuses drive-relative forms) is not used.
  let key: string | null;
  try {
    key = decodeURIComponent(rawKey);
  } catch {
    key = null;
  }
  if (key === null || key.length > 300 || !/^(host|mid):[^\u0000-\u001f]+$/.test(key)) {
    writeJson(res, 400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid machine key.' } });
    return;
  }
  deps.refresh();
  const outcome = deps.roster.forget(key);
  if (outcome === 'live') {
    writeJson(res, 409, { error: 'machine is connected; it cannot be forgotten while online' });
    return;
  }
  if (outcome === 'unknown') {
    writeJson(res, 404, { error: 'machine not known', key });
    return;
  }
  deps.onChanged?.();
  writeJson(res, 200, { forgotten: key });
}

/**
 * `GET /api/sessions/history` — sessions that ended, newest first.
 * `?projectId=`, `?machineKey=`, `?limit=` (≤ 2000, default 200). True when handled.
 */
export function handleApiSessionHistory(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  persistence: ReturnType<typeof createHqPersistence>,
): boolean {
  if (url.pathname !== '/api/sessions/history' || req.method !== 'GET') return false;
  const limit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
  writeJson(res, 200, {
    sessions: persistence.sessionHistory.recent({
      projectId: url.searchParams.get('projectId') ?? undefined,
      machineKey: url.searchParams.get('machineKey') ?? undefined,
      limit: Number.isFinite(limit) ? limit : 200,
    }),
  });
  return true;
}

/** `GET /api/projects/:id/kanban` — the latest persisted boards. True when handled. */
export async function handleApiProjectKanban(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  persistence: ReturnType<typeof createHqPersistence>,
): Promise<boolean> {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/kanban$/);
  if (!match || req.method !== 'GET') return false;
  const projectId = decodePathSegment(match[1]!);
  if (projectId === null) {
    writeJson(res, 400, { error: { code: 'VALIDATION_ERROR', message: 'Invalid project id.' } });
    return true;
  }
  writeJson(res, 200, await persistence.kanban.load(projectId));
  return true;
}

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
  clients: Map<WebSocket, ConnectedClient>,
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
  // Every envelope carries its project, so a project scope is an exact match.
  const projectIdFilter = url.searchParams.get('projectId') ?? undefined;
  // The machine key groups every process on one computer (see hqMachineKey).
  const machineKeyFilter = url.searchParams.get('machineKey') ?? undefined;
  const clientsOnMachineKey =
    machineKeyFilter !== undefined
      ? clientIdsWhere(clients, (client) => machineKeyOfClient(client) === machineKeyFilter)
      : undefined;
  // Time-range bounds are resolved client-side into epoch-ms (see
  // `fetchEvents` in packages/hq-next/src/hq/data/api.ts) so the server
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
      ? clientIdsWhere(clients, (client) => rawMachineIdOf(client) === machineIdFilter)
      : undefined;
  const matches = (event: HqEventEnvelope): boolean => {
    if (clientIdFilter !== undefined && event.clientId !== clientIdFilter) return false;
    if (projectIdFilter !== undefined && event.projectId !== projectIdFilter) return false;
    if (machineKeyFilter !== undefined) {
      const payload = event.payload as
        | {
            machineId?: unknown;
            hostname?: unknown;
            client?: { machineId?: unknown; hostname?: unknown };
          }
        | undefined;
      const source = payload?.client ?? payload;
      const payloadKey =
        typeof source?.machineId === 'string' || typeof source?.hostname === 'string'
          ? hqMachineKey(
              typeof source.hostname === 'string' ? source.hostname : undefined,
              typeof source.machineId === 'string' ? source.machineId : undefined,
            )
          : undefined;
      const onMachine =
        payloadKey === machineKeyFilter ||
        (event.clientId !== undefined && clientsOnMachineKey?.has(event.clientId) === true);
      if (!onMachine) return false;
    }
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
    projectIdFilter !== undefined ||
    machineKeyFilter !== undefined ||
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
  const all: HqTimeseriesSample[] = await persistence.timeseries.read(since);
  // `?projectId=` or `?machineKey=` narrows the series to that breakdown.
  const projectId = url.searchParams.get('projectId') || undefined;
  const machineKey = url.searchParams.get('machineKey') || undefined;
  const samples = scopeTimeseriesSamples(all, { projectId, machineKey });
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ samples }));
}
