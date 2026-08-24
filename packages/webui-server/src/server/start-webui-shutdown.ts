import * as path from 'node:path';
import type * as http from 'node:http';
import type { WebSocket, WebSocketServer } from 'ws';
import { toErrorMessage } from '@wrongstack/core/utils';
import { unregisterInstance } from './instance-registry.js';
import { registerShutdown } from './server-runtime.js';
import type { ConnectedClient } from './types.js';

export function setupWebuiShutdown(options: {
  session: any;
  tokenCounter: any;
  clients: Map<WebSocket, ConnectedClient>;
  httpServer: http.Server;
  companionServer: http.Server | null;
  wssPrimary: WebSocketServer;
  wssSecondary?: WebSocketServer | null | undefined;
  stopEmptySessionCleanup: { dispose: () => Promise<void> };
  getKanbanSupervisorDispose: () => (() => void | Promise<void>) | null;
  todosCheckpoint: { detach: () => Promise<void> };
  stopHeapWatchdog: () => Promise<void>;
  getCredentialWatcherClose: () => (() => void) | undefined;
  getProxyInstantApplyDispose: () => () => void;
  disposeRealtimeHandlers: () => void;
  governanceHandle?:
    | { close: () => Promise<{ ok: boolean; action?: string; message?: string } | undefined> }
    | undefined;
  logger: any;
  brainMonitor: any;
  agentServices: any;
  mcpRegistry: any;
  sessionIdentity: any;
  eventArming: any;
  getEternalSubscription: () => { dispose: () => void } | null;
  clearEternalSubscription: () => void;
  codebaseIndexing: any;
  memoryStore: any;
  /** Vector memory store (mirrors CLI's teardown). `undefined` when the
   *  standalone WebUI host failed to construct one (read-only FS, etc.). */
  vectorMemoryStore:
    | { close(): void }
    | undefined;
  globalConfigPath: string;
}): () => void {
  let unregister = (): void => {};
  unregister = registerShutdown({
    flushSession: async () => {
      await options.session.append({
        type: 'session_end',
        ts: new Date().toISOString(),
        usage: options.tokenCounter.total(),
      });
      await options.session.close();
    },
    clients: () => options.clients.keys(),
    servers: [
      options.httpServer,
      ...(options.companionServer ? [options.companionServer] : []),
      options.wssPrimary,
      ...(options.wssSecondary ? [options.wssSecondary] : []),
    ],
    onPreShutdown: async () => {
      await options.stopEmptySessionCleanup.dispose();
      const disposeKanban = options.getKanbanSupervisorDispose();
      await disposeKanban?.();
    },
    onShutdown: async () => {
      unregister();
      await options.todosCheckpoint.detach();
      await options.stopHeapWatchdog();
      options.getCredentialWatcherClose()?.();
      options.getProxyInstantApplyDispose()();
      options.disposeRealtimeHandlers();
      const governanceCleanup = await options.governanceHandle?.close();
      if (governanceCleanup && !governanceCleanup.ok) {
        options.logger.warn(
          `governance: standalone WebUI ${governanceCleanup.action} cleanup failed`,
          {
            message: governanceCleanup.message,
          },
        );
      }
      options.brainMonitor.stop();
      await options.agentServices.brainLedger?.stop().catch(() => {});
      await options.mcpRegistry.stopAll().catch(() => undefined);
      await options.sessionIdentity.stop();
      options.eventArming.getDispose()?.();
      const eternalSub = options.getEternalSubscription();
      if (eternalSub) {
        eternalSub.dispose();
        options.clearEternalSubscription();
      }
      options.codebaseIndexing.dispose();
      await options.agentServices
        .runSageSessionHygiene()
        .catch((err: unknown) =>
          options.logger.warn(`sage session hygiene failed: ${toErrorMessage(err)}`),
        );
      await options.memoryStore
        .dispose()
        .catch((err: unknown) =>
          options.logger.warn(`sage connection disposal failed: ${toErrorMessage(err)}`),
        );
      // Close the vector memory SQLite handle — keeps the WAL frame file
      // consistent and mirrors the CLI's teardown contract. Safe when the
      // store failed to construct (undefined).
      options.vectorMemoryStore?.close();
      await unregisterInstance(process.pid, path.dirname(options.globalConfigPath));
    },
  });
  return unregister;
}
