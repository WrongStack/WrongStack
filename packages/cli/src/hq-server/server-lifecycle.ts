/**
 * HQ server lifecycle and shutdown management.
 *
 * @module hq-server/server-lifecycle
 */

import type { Server as HttpServer } from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import type { HqPersistence } from '@wrongstack/core/hq';
import type { LoginAttemptStore } from './login-attempt-store.js';
import type { MailboxGatewayManager } from './mailbox-gateway-manager.js';
import { clearHqRuntimeMarker } from './startup.js';

interface HqServerShutdownParams {
  cleanupTimer: NodeJS.Timeout;
  browserHeartbeatTimer: NodeJS.Timeout;
  timeseriesFlushTimer: NodeJS.Timeout;
  sessionCleanupTimer: NodeJS.Timeout;
  loginAttempts: LoginAttemptStore;
  stopAlertEngine: () => void;
  authWatcher: { close(): void };
  snapshotBroadcaster: { close(): void };
  bootstrapStore: { clear(): void };
  persistence: HqPersistence;
  browsers: Set<WebSocket>;
  clients: Map<WebSocket, unknown>;
  wss: WebSocketServer;
  mailboxManager: MailboxGatewayManager;
  httpServer: HttpServer;
  dataDir: string;
  hqUrl: string;
}

export function createHqServerShutdown(params: HqServerShutdownParams): () => Promise<void> {
  let closed = false;

  return () =>
    new Promise<void>((res) => {
      if (closed) {
        res();
        return;
      }
      closed = true;

      clearInterval(params.cleanupTimer);
      clearInterval(params.browserHeartbeatTimer);
      clearInterval(params.timeseriesFlushTimer);
      clearInterval(params.sessionCleanupTimer);

      params.stopAlertEngine();
      params.authWatcher.close();
      params.snapshotBroadcaster.close();
      params.bootstrapStore.clear();
      params.persistence.timeseries.flush();

      for (const ws of [...params.browsers, ...params.clients.keys()]) {
        try {
          ws.close(1001, 'HQ shutting down');
          ws.terminate();
        } catch {
          // Already gone.
        }
      }
      params.wss.close();
      params.mailboxManager.close();

      params.httpServer.close(() => {
        const mailboxCloses = [...params.mailboxManager.mailboxGateways.values()].map(({ mailbox }) =>
          mailbox.close().catch(() => undefined),
        );
        params.mailboxManager.mailboxGateways.clear();
        params.mailboxManager.mailboxGatewayLastUsed.clear();

        void Promise.all([
          ...mailboxCloses,
          // Chimera/race: flush the login-attempt store INSIDE the awaited
          // shutdown set — the old fire-and-forget `void flush()` let close()
          // resolve before the debounced write landed, so persistence tests
          // had to sleep past it (and restarts could miss lockout state).
          params.loginAttempts.flush(),
          params.persistence.eventLog.drain(),
          params.persistence.snapshotStore.drain(),
          params.persistence.timeseries.drain(),
          params.persistence.kanban.drain(),
        ])
          .then(() => clearHqRuntimeMarker(params.dataDir, params.hqUrl))
          .catch(() => undefined)
          .finally(() => res());
      });
    });
}
