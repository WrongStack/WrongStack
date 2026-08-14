import type { WebSocket } from 'ws';
import { collectConnectionsHealth } from './connections/collector.js';
import type { ConnectionsHealthContext } from './connections/types.js';
import type { WSClientMessage } from './types.js';

export * from './connections/types.js';
export * from './connections/collector.js';
export * from './connections/service-actions.js';

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
    context.send(ws, { type: 'connections.health_result', payload: report });
  } catch (error) {
    context.send(ws, {
      type: 'connections.health_error',
      payload: { message: error instanceof Error ? error.message : String(error) },
    });
  }
  return true;
}
