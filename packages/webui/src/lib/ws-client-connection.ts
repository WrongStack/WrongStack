import {
  DEFAULT_SURFACE_CONNECTION_CONFIG,
  decodeProtocolFrame,
  planConnectionReconnect,
  resetConnection,
  type SurfaceConnectionState,
} from '@wrongstack/webui-protocol';
import type { WSServerMessage } from '../types';

export interface SocketLifecycleCallbacks {
  isCurrentGeneration: () => boolean;
  onOpen: () => void;
  onMessage: (msg: WSServerMessage) => void;
  onError: (lastError: string) => void;
  onClose: (reasonText: string | undefined, isInitialFailure: boolean) => void;
  onTimeout: () => void;
}

/**
 * Bind standard WebSocket lifecycle handlers (open, message, error, close)
 * with generation check and connection timeout.
 */
export function bindSocketLifecycle(
  ws: WebSocket,
  callbacks: SocketLifecycleCallbacks,
  timeoutMs = 30_000,
): { cancelTimeout: () => void } {
  let established = false;
  const timer = setTimeout(() => {
    try {
      ws.close();
    } catch {
      // ignore
    }
    callbacks.onTimeout();
  }, timeoutMs);

  ws.onopen = () => {
    if (!callbacks.isCurrentGeneration()) return;
    clearTimeout(timer);
    established = true;
    callbacks.onOpen();
  };

  ws.onmessage = (event) => {
    if (!callbacks.isCurrentGeneration()) return;
    const decoded = decodeProtocolFrame(String(event.data), 'server');
    if (decoded.ok) {
      callbacks.onMessage(decoded.message as WSServerMessage);
    } else {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'ws_client.message_rejected',
          code: decoded.issue.code,
          message: decoded.issue.message,
          timestamp: new Date().toISOString(),
        }),
      );
    }
  };

  ws.onerror = (error) => {
    if (!callbacks.isCurrentGeneration()) return;
    console.error(
      JSON.stringify({
        level: 'error',
        event: 'ws_client.error',
        message: error instanceof Error ? error.message : String(error),
        timestamp: new Date().toISOString(),
      }),
    );
    const errText = 'Connection error (see browser devtools)';
    if (!established) {
      clearTimeout(timer);
      callbacks.onError(errText);
    }
  };

  ws.onclose = (ev) => {
    if (!callbacks.isCurrentGeneration()) return;
    if (!established) {
      clearTimeout(timer);
      const reason = ev.reason || `Closed with code ${ev.code}`;
      callbacks.onClose(reason, true);
      return;
    }
    let reasonText: string | undefined;
    if (ev.reason) {
      reasonText = `${ev.reason} (code ${ev.code})`;
    } else if (ev.code !== 1000) {
      reasonText = `Closed with code ${ev.code}`;
    }
    callbacks.onClose(reasonText, false);
  };

  return { cancelTimeout: () => clearTimeout(timer) };
}

export function planReconnectHelper(
  state: SurfaceConnectionState,
  maxReconnectAttempts: number,
  queueLimit: number,
): { state: SurfaceConnectionState; plan: ReturnType<typeof planConnectionReconnect>['plan'] } {
  const reconnect = planConnectionReconnect(state, {
    ...DEFAULT_SURFACE_CONNECTION_CONFIG,
    maxReconnectAttempts,
    queueLimit,
  });
  return { state: reconnect.state, plan: reconnect.plan };
}

export function retryNowHelper(
  statusState: string,
  reconnectTimer: ReturnType<typeof setTimeout> | null,
  connectionState: SurfaceConnectionState,
  connectFn: () => Promise<void>,
): {
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  connectionState: SurfaceConnectionState;
} {
  if (statusState === 'open') {
    return { reconnectTimer, connectionState };
  }
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
  }
  const nextState = resetConnection(connectionState);
  void connectFn().catch((err) =>
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'ws_client.reconnect_failed',
        message: err instanceof Error ? err.message : String(err),
        timestamp: new Date().toISOString(),
      }),
    ),
  );
  return { reconnectTimer: null, connectionState: nextState };
}
