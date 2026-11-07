import { toErrorMessage } from '@wrongstack/core/utils/error';

import { createConnectionHandler } from './webui-server/connection-handler.js';

import { createWebuiShutdown, registerWebuiSignalHandlers } from './webui-server/lifecycle.js';

import { consoleLogger } from './webui-server/logger-shim.js';

export function runWebuiServerLifecycle({
  host,
  httpPort,
  setupEvents,
  opts,
  wsPort,
  accessUrl,
  wsToken,
  wss,
  httpServer,
  requireToken,
  publicHostnames,
  publicWsUrl,
  clients,
  currentSessionId,
  goalHandler,
  specsHandler,
  sddBoardHandler,
  sddWizardHandler,
  worktreeHandler,
  terminalHandler,
  rateLimitMax,
  send,
  sessionPayload,
  handleMessage,
  pendingConfirms,
  buildSessionStartPayload,
  sessionAgents,
  lifecycleState,
  abortControllers,
  flushAllStreamBuffers,
  eventUnsubscribers,
  releaseSessionSalvage,
  autoWakeHost,
  stopEmptySessionCleanup,
  credentialWatcherClose,
  kanbanRunMirror,
  kanbanSupervisor,
  stopKanbanSupervisorMemoryStats,
  unregisterWebuiClient,
  ipv6LoopbackServer,
  registryBaseDir,
  stopLiveStatusLogger,
  terminalLogView,
}: {
  host: string;
  httpPort: number;
  setupEvents: () => void;
  opts: import('./webui-server-options.js').CliWebUIOptions;
  wsPort: number;
  accessUrl: string;
  wsToken: string;
  wss: import('ws').Server<typeof import('ws').default, typeof import('http').IncomingMessage>;
  httpServer: import('@wrongstack/webui-server').StaticServeHandle | null;
  requireToken: boolean;
  publicHostnames: string[];
  publicWsUrl: string | undefined;
  clients: Map<
    import('ws').default,
    import('./webui-server/connection-handler.js').ConnectedClient
  >;
  currentSessionId: () => string;
  goalHandler: import('@wrongstack/webui-server').GoalWebSocketHandler;
  specsHandler: import('@wrongstack/webui-server').SpecsWebSocketHandler;
  sddBoardHandler: import('@wrongstack/webui-server').SddBoardWebSocketHandler;
  sddWizardHandler: import('@wrongstack/webui-server').SddWizardWebSocketHandler | null;
  worktreeHandler: import('@wrongstack/webui-server').WorktreeWebSocketHandler;
  terminalHandler: import('@wrongstack/webui-server').TerminalWebSocketHandler;
  rateLimitMax: number;
  send: (
    ws: import('ws').default,
    msg: import('./webui-server/contracts.js').WSServerMessage,
  ) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  handleMessage: import('@wrongstack/webui-server').EmbeddedMessageRouter;
  pendingConfirms: Map<string, import('@wrongstack/webui-server').PendingConfirm>;
  buildSessionStartPayload: import('./webui-server/session-start-payload.js').BuildSessionStartPayload;
  sessionAgents: import('@wrongstack/webui-server').SessionAgentRegistry;
  lifecycleState: {
    signalShutdown: (() => void) | undefined;
    embeddedAutoHealDispose: (() => void | Promise<void>) | null;
  };
  abortControllers: Map<string, AbortController>;
  flushAllStreamBuffers: () => void;
  eventUnsubscribers: (() => void)[];
  releaseSessionSalvage: () => void;
  autoWakeHost: import('@wrongstack/webui-server').WebuiLeaderAutoWakeHost | undefined;
  stopEmptySessionCleanup: { dispose: () => Promise<void>; runNow: () => Promise<unknown> } | null;
  credentialWatcherClose: (() => void) | undefined;
  kanbanRunMirror: import('@wrongstack/webui-server').KanbanRunMirror | null;
  kanbanSupervisor: import('@wrongstack/webui-server').KanbanSupervisor | null;
  stopKanbanSupervisorMemoryStats: (() => Promise<void>) | undefined;
  unregisterWebuiClient: () => void;
  ipv6LoopbackServer:
    | import('http').Server<
        typeof import('http').IncomingMessage,
        typeof import('http').ServerResponse
      >
    | null;
  registryBaseDir: string;
  stopLiveStatusLogger: () => void;
  terminalLogView: import('@wrongstack/webui-server').TerminalDashboard;
}) {
  const stopped = new Promise<void>((resolve) => {
    let listeningAnnounced = false;
    let shuttingDown = false;
    let unregisterSignalHandlers: (() => void) | undefined;
    const announceListening = () => {
      if (listeningAnnounced || shuttingDown) return;
      listeningAnnounced = true;
      console.log(`[WebUI] WebSocket server running on ws://${host}:${httpPort}`);
      try {
        setupEvents();
        opts.onListening?.({
          httpPort,
          wsPort,
          host,
          url: accessUrl,
          authToken: wsToken,
        });
      } catch (err) {
        consoleLogger.error('setup_events_failed', { message: toErrorMessage(err) });
      }
    };
    wss.on('listening', announceListening);
    if (httpServer?.server.listening || wss.address()) queueMicrotask(announceListening);

    wss.on(
      'connection',
      createConnectionHandler({
        host,
        wsToken,
        requireToken,
        publicHostnames,
        publicWsUrl,
        clients,
        currentSessionId,
        goalHandler,
        specsHandler,
        sddBoardHandler,
        sddWizardHandler,
        worktreeHandler,
        terminalHandler,
        rateLimitMax,
        send,
        sessionPayload,
        handleMessage,
        pendingConfirms,
        buildSessionStartPayload,
        loadReplay: async () => {
          const activeSession = opts.agent.ctx.session ?? opts.session;
          await activeSession.flush();
          if (opts.sessionStore) {
            const data = await opts.sessionStore.load(activeSession.id);
            return { messages: data.messages, events: data.events, usage: data.usage };
          }
          const usage = opts.agent.ctx.tokenCounter.total();
          return { messages: opts.agent.ctx.messages, usage };
        },
        loadAgentSessions: async (subagentIds) =>
          (await opts.agentTranscripts?.loadSessionsFromDisk(subagentIds)) ?? [],
        // What this process is actually holding right now. The browser
        // reconciles its persisted tab strip against it, so a restarted server
        // is not dressed in the previous run's tabs.
        openSessionIds: () => sessionAgents.ids(),
        needsSetup: opts.needsSetup ?? false,
      }),
    );

    lifecycleState.signalShutdown = createWebuiShutdown({
      abortInFlight: () => {
        shuttingDown = true;
        wss.off?.('listening', announceListening);
        unregisterSignalHandlers?.();
        unregisterSignalHandlers = undefined;
        // First teardown step: stop the auto-heal watchdog's interval NOW so
        // no new daemon restart begins while the shutdown sequence runs its
        // child-kill sweep. dispose() stops the timer synchronously on its
        // first line and is idempotent — disposeResources still awaits it to
        // drain any restart already in flight.
        void lifecycleState.embeddedAutoHealDispose?.();
        for (const c of abortControllers.values()) c.abort();
        abortControllers.clear();
      },
      unsubscribeEvents: () => {
        flushAllStreamBuffers();
        for (const unsub of eventUnsubscribers.splice(0)) unsub();
      },
      stopOwnedChildren: async () => {
        try {
          const { getProcessRegistry } = await import('@wrongstack/tools');
          getProcessRegistry().killAll({ force: true, includeProtected: true });
        } catch (err) {
          console.debug(
            `[webui-server] process-registry killAll failed: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
        if (opts.mcpRegistry) {
          try {
            await opts.mcpRegistry.stopAll();
          } catch (err) {
            console.debug(
              `[webui-server] mcpRegistry.stopAll failed: ${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }
      },
      disposeResources: async () => {
        releaseSessionSalvage();
        // Unbind the auto-wake port first: no woken turn may start while the
        // tabs' journals are being closed. The controller itself belongs to
        // the CLI, which disposes it after this server has stopped.
        autoWakeHost?.dispose();
        await stopEmptySessionCleanup?.dispose();
        // End the journals of every tab that is not the leader's. `close()`
        // alone would flush them, but a journal with no trailing
        // `session_end` is indistinguishable from one a crash left hanging —
        // so a clean quit with three background tabs used to hand the next
        // launch three sessions to "recover". The leader's own journal is
        // finalized by the CLI's execution teardown, which runs after this.
        await sessionAgents.closeAll().catch(() => undefined);
        credentialWatcherClose?.();
        credentialWatcherClose = undefined;
        goalHandler.dispose();
        sddBoardHandler.dispose();
        worktreeHandler.dispose();
        terminalHandler.dispose();
        kanbanRunMirror?.dispose();
        kanbanSupervisor?.dispose();
        await stopKanbanSupervisorMemoryStats?.();
        // Drain an in-flight auto-heal restart before the host exits
        // (createWebuiShutdown awaits this, bounded by its dispose timeout).
        await lifecycleState.embeddedAutoHealDispose?.();
        lifecycleState.embeddedAutoHealDispose = null;
        unregisterWebuiClient();
      },
      closeClients: () => {
        for (const [ws] of clients) ws.close();
        clients.clear();
      },
      closeHttpServer: () => {
        ipv6LoopbackServer?.close();
        httpServer?.server.close();
      },
      wss,
      pid: process.pid,
      registryBaseDir,
      onStopped: () => {
        // Unsubscribe the panel from the event bus FIRST, then erase it and
        // restore the raw console so the teardown lines print plainly.
        stopLiveStatusLogger();
        const muted = terminalLogView.mutedCount;
        terminalLogView.stop();
        if (muted > 0) {
          console.log(
            `[WebUI] ${muted} progress line(s) kept out of this terminal — set WEBUI_LOGS=1 to stream them.`,
          );
        }
        opts.onExit?.();
        resolve();
      },
    });

    unregisterSignalHandlers = registerWebuiSignalHandlers(lifecycleState.signalShutdown);
    if (shuttingDown) {
      unregisterSignalHandlers();
      unregisterSignalHandlers = undefined;
    }
  });
  return { stopped };
}
