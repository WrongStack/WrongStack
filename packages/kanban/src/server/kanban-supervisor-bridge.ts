/**
 * Kanban Supervisor Bridge — forward daemon mutation events to a
 * subscriber (typically the webui-server's `KanbanSupervisor`).
 *
 * The `KanbanSupervisor` in `@wrongstack/webui-server` is an in-process
 * polling custodian that broadcasts WebSocket snapshots to connected
 * browsers. The IPC daemon emits push events whenever a board is
 * mutated. This bridge subscribes to the daemon's event bus and
 * forwards each event to a caller-supplied handler, which the
 * supervisor uses to publish a `kanban.supervisor.event` message.
 *
 * Usage:
 *   import { bridgeKanbanSupervisor } from '@wrongstack/kanban/server/kanban-supervisor-bridge';
 *   const dispose = bridgeKanbanSupervisor(projectRoot, (event) => {
 *     deps.broadcast({ type: 'kanban.supervisor.event', payload: event });
 *   });
 *   // later: dispose();
 */
import { getKanbanServerConnection } from './client.js';
import type { KanbanServerEvent } from './protocol.js';

export type KanbanSupervisorEvent = KanbanServerEvent;

export interface BridgeOptions {
  /** Auto-reconnect on disconnect. Default: true. */
  autoReconnect?: boolean;
  /** Reconnect delay in ms. Default: 1000. */
  reconnectDelayMs?: number;
}

export function bridgeKanbanSupervisor(
  projectRoot: string,
  handler: (event: KanbanSupervisorEvent) => void,
  options: BridgeOptions = {},
): () => void {
  const autoReconnect = options.autoReconnect ?? true;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;

  const subscribe = (): void => {
    if (disposed) return;
    void (async () => {
      try {
        const conn = await getKanbanServerConnection(projectRoot);
        if (disposed || !conn) return;
        unsubscribe = conn.subscribe((ev) => {
          try {
            handler(ev);
          } catch {
            // Swallow handler errors — one bad subscriber must not break others
          }
        });
      } catch {
        // Server not available; schedule retry if auto-reconnect is on
        if (autoReconnect && !disposed) {
          reconnectTimer = setTimeout(() => {
            reconnectTimer = undefined;
            subscribe();
          }, reconnectDelayMs);
          reconnectTimer.unref?.();
        }
      }
    })();
  };

  subscribe();

  return () => {
    disposed = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = undefined;
    }
    if (unsubscribe) {
      unsubscribe();
      unsubscribe = null;
    }
  };
}
