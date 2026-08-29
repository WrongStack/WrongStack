import type * as http from 'node:http';
import * as path from 'node:path';
import { addFatalSalvageHook, toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket, WebSocketServer } from 'ws';
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
  stopLiveStatusLogger?: (() => void) | undefined;
  /** Erase the fixed status panel and restore the raw console. */
  stopTerminalDashboard?: (() => void) | undefined;
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
  vectorMemoryStore: { close(): void } | undefined;
  /**
   * Drain every open tab's journal synchronously. Registered as a fatal-exit
   * salvage hook: this host had none at all, so a crash truncated the buffered
   * tail of the leader's journal AND of every other open tab.
   */
  flushSessionJournalsSync?: (() => void) | undefined;
  /**
   * End and close the journals of every tab that is not the leader's. Without
   * it a clean quit left them with no trailing `session_end`, which is exactly
   * what a crash looks like — the next launch offered them all for recovery.
   */
  closeSessionJournals?: (() => Promise<void>) | undefined;
  globalConfigPath: string;
}): () => void {
  let unregister = (): void => {};
  const releaseSalvage = addFatalSalvageHook(() => {
    try {
      options.session.flushSync?.();
    } catch {
      // best-effort — the process is already going down
    }
    try {
      options.flushSessionJournalsSync?.();
    } catch {
      // one writer that cannot drain must not stop the others
    }
  });
  unregister = registerShutdown({
    flushSession: async () => {
      // Background tabs first: they are only reachable through the registry,
      // and the leader's close below is what ends the host.
      await options.closeSessionJournals?.().catch(() => undefined);
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
      releaseSalvage();
      await options.todosCheckpoint.detach();
      await options.stopHeapWatchdog();
      options.getCredentialWatcherClose()?.();
      if (options.disposeRealtimeHandlers) {
        options.disposeRealtimeHandlers();
      }
      options.stopLiveStatusLogger?.();
      options.stopTerminalDashboard?.();
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
