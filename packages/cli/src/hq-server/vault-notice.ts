/**
 * Tell every connected client the key vault changed (`hq.vault_changed`).
 * Every client, not one project's: the publisher's identity is not the
 * vault's device identity, and the notice names nothing — a machine enrolled
 * with this HQ fetches its own sealed bundle, every other one ignores it.
 */
import type * as http from 'node:http';
import type { HqVaultChangedNotice } from '@wrongstack/hq';
import type { WebSocket } from 'ws';
import { sendGuarded } from './snapshot.js';
import type { ConnectedClient } from './types.js';

export function broadcastHqVaultChanged(
  clients: Map<WebSocket, Pick<ConnectedClient, 'ws'>>,
  notice: HqVaultChangedNotice,
): number {
  const message = JSON.stringify({ type: 'hq.vault_changed', payload: notice });
  for (const client of clients.values()) sendGuarded(client.ws, message);
  return clients.size;
}

/**
 * `GET /api/vault/revision` → `{ hqId, revision }`, for devices to poll. No
 * credential: it names nothing and carries no value. `notice` is undefined
 * when the vault is not enabled (no operator password).
 */
export async function handleHqVaultRevisionRoute(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  notice: (() => Promise<HqVaultChangedNotice | undefined>) | undefined,
): Promise<void> {
  const answer = (status: number, body: unknown): void => {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (req.method !== 'GET') {
    answer(405, { error: { code: 'METHOD_NOT_ALLOWED', message: 'GET only.' } });
    return;
  }
  const current = await notice?.().catch(() => undefined);
  if (!current) {
    answer(404, {
      error: { code: 'NOT_FOUND', message: 'The key vault is not enabled on this HQ.' },
    });
    return;
  }
  answer(200, current);
}
