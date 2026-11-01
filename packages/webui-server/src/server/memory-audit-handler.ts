import type { MemoryPort } from '@wrongstack/contracts/types';
import { getSageSurface } from '@wrongstack/sage';
import type { WebSocket } from 'ws';
import { requiresSage } from './memory-candidate-handlers.js';
import { errMessage, send, withRequestId } from './ws-utils.js';

/** The SAGE audit log keeps its newest 1,000 events. */
const AUDIT_MAX = 1000;

/**
 * SAGE audit events, newest first: injections into requests with their memories, trigger and
 * session, uses, and store changes. The store keeps a rolling window of its newest events.
 * Request:  { type: 'memory.sage.audit', payload?: { limit?: 1-1000, event?: string } }
 * Response: { type: 'memory.sage.audit', payload: { records, limit } | { error } }
 */
export async function handleSageAudit(
  ws: WebSocket,
  msg: unknown,
  memoryStore: MemoryPort,
): Promise<void> {
  const reply = (payload: Record<string, unknown>) =>
    send(ws, { type: 'memory.sage.audit', payload: withRequestId(msg, payload) });
  const sage = getSageSurface(memoryStore);
  if (!sage?.readAudit) {
    reply({ error: requiresSage('memory.sage.audit') });
    return;
  }
  const payload = (msg as { payload?: Record<string, unknown> } | undefined)?.payload ?? {};
  const limit =
    Number.isSafeInteger(payload['limit']) && (payload['limit'] as number) >= 1
      ? Math.min(payload['limit'] as number, AUDIT_MAX)
      : 200;
  const event = typeof payload['event'] === 'string' ? payload['event'] : '';
  try {
    // A filter reads the whole window so it finds older matches, then keeps `limit` of them.
    const records = await sage.readAudit(event ? AUDIT_MAX : limit);
    reply({
      limit,
      records: (event ? records.filter((row) => row.event === event) : records).slice(0, limit),
    });
  } catch (error) {
    reply({ error: errMessage(error) });
  }
}
