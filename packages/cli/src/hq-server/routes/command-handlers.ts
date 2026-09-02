import { randomUUID } from 'node:crypto';
import type * as http from 'node:http';
import type {
  HqCommand,
  HqCommandAuditEntry,
  HqCommandAuditLog,
  HqQueuedCommand,
} from '@wrongstack/core/hq';
import { tokenHasCapability, validateHqCommand } from '@wrongstack/core/hq';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { WebSocket } from 'ws';
import { authenticateBrowserRequest, hqAuthRequired, isCookieAuth, isTokenAuth } from '../auth.js';
import * as HqServerSnapshot from '../snapshot.js';
import { authorizeHqCommand } from '../trust-boundary.js';
import type { ConnectedClient, HqRouterMutableAuth, HqSessionEntry } from '../types.js';
import { readRequestBody, writeInvalidBody } from '../utils.js';
import { callerCanEnqueue } from './mailbox-handlers.js';

export async function handleApiCommand(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  url: URL,
  mutableAuth: HqRouterMutableAuth,
  sessions: Map<string, HqSessionEntry>,
  clients: Map<WebSocket, ConnectedClient>,
  browsers: Set<WebSocket>,
  auditLog: HqCommandAuditLog,
  trustBoundary: TrustBoundary,
): Promise<void> {
  const auth = authenticateBrowserRequest(req, url, mutableAuth, sessions);
  if (hqAuthRequired(mutableAuth) && !auth) {
    res.writeHead(401, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unauthorized' }));
    return;
  }
  const canEnqueue = callerCanEnqueue(auth, mutableAuth);
  if (!canEnqueue) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'forbidden: token lacks control.enqueue capability' }));
    return;
  }

  let body: { clientId?: string; type?: string; payload?: unknown };
  try {
    body = JSON.parse(await readRequestBody(req)) as {
      clientId?: string;
      type?: string;
      payload?: unknown;
    };
  } catch (error) {
    writeInvalidBody(res, error);
    return;
  }
  if (typeof body.clientId !== 'string' || typeof body.type !== 'string') {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'missing clientId or type' }));
    return;
  }

  let target: ConnectedClient | undefined;
  for (const c of clients.values()) {
    if (c.clientId === body.clientId) {
      target = c;
      break;
    }
  }
  if (target === undefined) {
    res.writeHead(404, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'client not connected', clientId: body.clientId }));
    return;
  }
  if (!target.capabilities.includes('control.receive')) {
    res.writeHead(409, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'client does not accept control commands',
        clientId: body.clientId,
      }),
    );
    return;
  }

  const commandId = randomUUID();
  const queued: HqQueuedCommand = {
    commandId,
    type: body.type,
    createdAt: new Date().toISOString(),
    payload: body.payload ?? {},
    requiresAck: true,
  };
  const validated: HqCommand | null = validateHqCommand(queued);
  if (validated === null) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'unrecognized or malformed command', type: body.type }));
    return;
  }

  if (
    validated.type === 'run-command' &&
    !tokenHasCapability(target.authToken, 'control.execute')
  ) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: 'forbidden: target client token lacks control.execute capability',
      }),
    );
    return;
  }

  const enqueuedBy = isCookieAuth(auth)
    ? (auth.tokenId ?? 'password-session')
    : isTokenAuth(auth)
      ? auth.id
      : 'open-mode';
  const authorization = await authorizeHqCommand({
    boundary: trustBoundary,
    command: validated,
    commandId,
    enqueuedBy,
    authMethod: isCookieAuth(auth) ? 'session' : 'bearer-token',
    target,
  });
  if (!authorization.allowed) {
    res.writeHead(403, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: `command denied: ${authorization.reason}` }));
    return;
  }

  target.commandQueue.push(queued);
  if (target.commandQueue.length > 200)
    target.commandQueue.splice(0, target.commandQueue.length - 200);

  const auditEntry: HqCommandAuditEntry = {
    commandId,
    type: validated.type,
    clientId: target.clientId,
    enqueuedBy,
    enqueuedAt: queued.createdAt,
    status: 'queued',
  };
  auditLog.record(auditEntry);
  HqServerSnapshot.broadcastCommandStatus(auditEntry, browsers);

  res.writeHead(202, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ commandId, queued: true, clientId: target.clientId }));
}
