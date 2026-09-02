import type * as http from 'node:http';
import type { HqTimeseriesSample } from '@wrongstack/core/hq';
import type { createHqPersistence } from '@wrongstack/core/hq';
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
): Promise<void> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const rawLimit = Number.parseInt(url.searchParams.get('limit') ?? '200', 10);
  const limit = Math.min(5000, Math.max(1, Number.isFinite(rawLimit) ? rawLimit : 200));
  const typeFilter = url.searchParams.get('type') ?? undefined;
  const events = await persistence.eventLog.recent(limit, typeFilter);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ events, total: events.length }));
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
