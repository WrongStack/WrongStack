import type * as http from 'node:http';
import { readHqAuthAuditTail } from '@wrongstack/core/hq';
import * as HqServerAuthRef from '../../auth.js';
import type { HqRouterMutableAuth, HqSessionEntry } from '../../types.js';

export function handleApiAuthSessions(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
): void {
  const now = Date.now();
  const list = [];
  for (const [id, session] of sessions) {
    if (session.pending2fa) continue;
    list.push({
      id,
      shortId: id.slice(0, 8),
      kind: session.kind,
      createdAt: new Date(session.createdAt).toISOString(),
      lastSeenAt: new Date(session.lastSeenAt).toISOString(),
      ageMinutes: Math.round((now - session.createdAt) / 60_000),
      idleMinutes: Math.round((now - session.lastSeenAt) / 60_000),
    });
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(
    JSON.stringify({
      sessions: list,
      idleTimeoutMinutes: Math.round(
        (HqServerAuthRef.HQ_SESSION_IDLE_TIMEOUT_MS ?? 30 * 60_000) / 60_000,
      ),
      maxAgeDays: Math.round(HqServerAuthRef.HQ_SESSION_MAX_AGE_MS / (24 * 60 * 60_000)),
      passwordMode: mutableAuth.passwordHash !== undefined,
    }),
  );
}

export async function handleApiAuthSessionsRevoke(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  sessions: Map<string, HqSessionEntry>,
): Promise<void> {
  const pathParts = url.pathname.split('/').filter(Boolean);
  const targetId = pathParts[3];

  if (targetId) {
    const session = sessions.get(targetId);
    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: { code: 'NOT_FOUND', message: 'Session not found.' } }));
      return;
    }
    sessions.delete(targetId);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ revoked: 1 }));
    return;
  }

  const count = sessions.size;
  sessions.clear();
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ revoked: count }));
}

export function handleApiAuthAudit(
  _req: http.IncomingMessage,
  res: http.ServerResponse,
  dataDir: string,
): void {
  const entries = readHqAuthAuditTail(dataDir, 50);
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ entries }));
}
