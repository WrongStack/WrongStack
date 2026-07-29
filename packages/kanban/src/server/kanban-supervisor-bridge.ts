/**
 * Kanban Supervisor Bridge — forward daemon mutation events to a
 * subscriber (typically the webui-server's `KanbanSupervisor`).
 *
 * The IPC daemon emits push events whenever a board is mutated. This bridge
 * subscribes to that event stream, follows daemon restarts, and forwards each
 * event to a caller-supplied handler.
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
  /** Called after the event listener is attached to each new connection. */
  onConnected?: (() => void | Promise<void>) | undefined;
}

export function bridgeKanbanSupervisor(
  projectRoot: string,
  handler: (event: KanbanSupervisorEvent) => void | Promise<void>,
  options: BridgeOptions = {},
): () => void {
  const autoReconnect = options.autoReconnect ?? true;
  const reconnectDelayMs = options.reconnectDelayMs ?? 1000;
  let disposed = false;
  let unsubscribe: (() => void) | null = null;
  let unsubscribeDisconnect: (() => void) | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  let connecting = false;

  const scheduleReconnect = (): void => {
    if (!autoReconnect || disposed || reconnectTimer !== undefined) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = undefined;
      subscribe();
    }, reconnectDelayMs);
    reconnectTimer.unref?.();
  };

  const clearConnectionSubscriptions = (): void => {
    unsubscribe?.();
    unsubscribe = null;
    unsubscribeDisconnect?.();
    unsubscribeDisconnect = null;
  };

  const subscribe = (): void => {
    if (disposed || connecting) {
      // Re-arm so a reconnect that collides with an in-flight connection is
      // not permanently lost (scheduleReconnect dedups via reconnectTimer).
      scheduleReconnect();
      return;
    }
    connecting = true;
    void (async () => {
      try {
        const conn = await getKanbanServerConnection(projectRoot);
        if (disposed || !conn) return;
        clearConnectionSubscriptions();
        unsubscribe = conn.subscribe((ev) => {
          try {
            void Promise.resolve(handler(ev)).catch(() => {
              // Async handler failures are isolated from the socket stream.
            });
          } catch {
            // Swallow handler errors — one bad subscriber must not break others
          }
        });
        unsubscribeDisconnect = conn.onDisconnect(() => {
          clearConnectionSubscriptions();
          scheduleReconnect();
        });
        try {
          await options.onConnected?.();
        } catch {
          // Refresh callbacks are best-effort and must not break reconnection.
        }
      } catch {
        scheduleReconnect();
      } finally {
        connecting = false;
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
    clearConnectionSubscriptions();
  };
}
