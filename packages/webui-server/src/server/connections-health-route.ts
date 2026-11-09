import type { WebSocket } from 'ws';
import { collectConnectionsHealth } from './connections/collector.js';
import type { ConnectionsHealthContext } from './connections/types.js';
import type { WSClientMessage } from './types.js';
import { errMessage, withRequestId } from './ws-utils.js';

export * from './connections/collector.js';
export * from './connections/service-actions.js';
export * from './connections/types.js';

/** One read-only health report for every per-project backend connection. */
export async function handleConnectionsHealthRoute(
  context: ConnectionsHealthContext,
  ws: WebSocket,
  message: WSClientMessage,
): Promise<boolean> {
  if (message.type !== 'connections.health') return false;
  try {
    const report =
      (await context.collect?.()) ??
      (await collectConnectionsHealth({
        projectRoot: context.getProjectRoot(),
        indexDir: context.getIndexDir(),
        backend: context.backend,
      }));
    context.send(ws, {
      type: 'connections.health_result',
      payload: withRequestId(message, { ...report }),
    });
  } catch (error) {
    context.send(ws, {
      type: 'connections.health_error',
      payload: withRequestId(message, { success: false, message: errMessage(error) }),
    });
  }
  return true;
}
