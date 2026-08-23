/**
 * CLI embedded WebUI server — the backend behind `wrongstack --webui`.
 *
 * `runWebUI(opts)` boots a WebSocket bridge (and, when the webui package
 * is built, the static HTTP frontend) over the *same* agent/events/
 * session instances the REPL and eternal-autonomy loop use, then routes
 * browser messages through a `handleMessage` switch.
 *
 * Most self-contained concerns live under `webui-server/*`; this file now
 * assembles CLI-owned instances, route contexts, WebSocket lifecycle, and the
 * embedded shared router.
 *
 * Public surface: `runWebUI` plus WS message shapes.
 */
import type { Server as HttpServer } from 'node:http';
import * as path from 'node:path';
import { createCompatibilityTrustBoundary, DefaultSecretScrubber } from '@wrongstack/core/security';
import type { ProviderConfig } from '@wrongstack/core/types';
import { startSharedHeapWatchdog, wstackGlobalRoot } from '@wrongstack/core/utils';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import {
  buildWebUIAccessUrl,
  type CustomModeStore,
  createCustomModeStore,
  createEmbeddedMessageRouter,
  createEmbeddedProviderOperations,
  type EmbeddedProviderContext,
  envFlag,
  findFreePort,
  findInstalledPackageJson,
  isStrictPort,
  type PendingConfirm,
  resolveAuthToken,
  sendSerialized,
} from '@wrongstack/webui-server';
import { type WebSocket, WebSocketServer } from 'ws';
import { createWebuiClientRegistration } from './webui-server/client-registration.js';
import type {
  WSClientMessage as EmbeddedWSClientMessage,
  WSServerMessage as EmbeddedWSServerMessage,
} from './webui-server/contracts.js';
export type WSClientMessage = EmbeddedWSClientMessage;
export type WSServerMessage = EmbeddedWSServerMessage;

import { WEBUI_SESSION_CHILD_CAPABILITIES } from './boot/webui-session-child.js';
import {
  type ConnectedClient,
  createConnectionHandler,
} from './webui-server/connection-handler.js';
import { startWebuiCredentialWatcher } from './webui-server/credential-watcher.js';
import { createWebuiDomainHandlers } from './webui-server/domain-handlers.js';
import { createCliKanbanHostRoutes } from './webui-server/kanban-host-adapter.js';
import { createKanbanRunMirror } from './webui-server/kanban-run-mirror.js';
import { createKanbanSupervisor } from './webui-server/kanban-supervisor.js';
import {
  announceWebuiReady,
  createWebuiShutdown,
  registerWebuiInstance,
  registerWebuiSignalHandlers,
} from './webui-server/lifecycle.js';
import { startDeferredHttpListen, startIpv6LoopbackProxy } from './webui-server/listen-helpers.js';
import { consoleLogger } from './webui-server/logger-shim.js';
import { createPrefsSeeding, seedConfigToMeta } from './webui-server/prefs-seeding.js';
import { createProviderConfigStore } from './webui-server/provider-config.js';
import { createWebuiRouteContexts } from './webui-server/route-contexts.js';
import { createSessionStartPayloadBuilder } from './webui-server/session-start-payload.js';
import { createSetupEvents } from './webui-server/setup-events.js';
import { startStaticServe } from './webui-server/static-serve.js';
import { createStreamCoalescer } from './webui-server/stream-coalescer.js';
import { startQuietSurfaceConsole } from './webui-server/terminal-log-view.js';

import type { CliWebUIOptions } from './webui-server-options.js';

export type { CliWebUIOptions } from './webui-server-options.js';
export async function runWebUI(opts: CliWebUIOptions): Promise<void> {
  const terminalLogView = startQuietSurfaceConsole();
  const trustBoundary =
    opts.trustBoundary ??
    createCompatibilityTrustBoundary({ policyId: 'cli-webui-trusted-host-compat-v1' });
  const host = opts.host ?? process.env['WEBUI_HOST'] ?? process.env['WS_HOST'] ?? '127.0.0.1';
  const publicUrl = opts.publicUrl ?? process.env['WEBUI_PUBLIC_URL'];
  const publicWsUrl = opts.publicWsUrl ?? process.env['WEBUI_PUBLIC_WS_URL'];
  const requireToken = opts.requireToken ?? envFlag('WEBUI_REQUIRE_TOKEN');
  const surface = opts.surface ?? 'webui';
  const surfaceDefaults = surface === 'simpleui' ? { http: 3466 } : { http: 3456 };
  const requestedHttpPort = opts.httpPort ?? opts.port ?? surfaceDefaults.http;
  const strictPort = opts.strictPort ?? isStrictPort();
  let httpPort = requestedHttpPort;
  if (!strictPort) {
    httpPort = await findFreePort(host, requestedHttpPort);
  }
  let wsPort = httpPort;
  const globalRoot = opts.globalConfigPath
    ? path.dirname(opts.globalConfigPath)
    : wstackGlobalRoot();
  const profileConfigPath =
    opts.profileConfigPath ?? opts.globalConfigPath ?? path.join(globalRoot, 'config.json');
  const rateLimitMax = Number.parseInt(process.env['WEBUI_RATE_LIMIT'] ?? '600', 10);
  const clients = new Map<WebSocket, ConnectedClient>();
  const pendingConfirms = new Map<string, PendingConfirm>();
  const secretScrubber = new DefaultSecretScrubber();
  let abortController: AbortController | null = null;
  const abortControllers = new Map<string, AbortController>();

  const profileDir = path.dirname(profileConfigPath);
  let customModeStoreP: Promise<CustomModeStore> | null = null;
  const getCustomModeStore = (): Promise<CustomModeStore> => {
    customModeStoreP ??= (async () => {
      const store = createCustomModeStore(profileDir);
      await store.load();
      return store;
    })();
    return customModeStoreP;
  };

  const kanbanRunMirror = opts.projectRoot
    ? createKanbanRunMirror({
        projectRoot: opts.projectRoot,
        events: opts.events,
        broadcast,
        log: (m) => consoleLogger.info(m),
      })
    : null;
  const kanbanSupervisor = opts.projectRoot
    ? createKanbanSupervisor({
        projectRoot: opts.projectRoot,
        broadcast,
        ...(opts.onKanbanDispatch ? { dispatchTask: opts.onKanbanDispatch } : {}),
        log: (message) => consoleLogger.info(message),
      })
    : null;
  const stopKanbanSupervisorMemoryStats = kanbanSupervisor
    ? startSharedHeapWatchdog({
        collectStats: () => {
          const stats = kanbanSupervisor.getStats();
          return {
            kanbanSupervisorSnapshots: stats.snapshots,
            kanbanSupervisorScheduledBoards: stats.scheduledBoards,
            kanbanSupervisorAgentCooldowns: stats.agentCooldowns,
            kanbanSupervisorRunningAgents: stats.runningAgents,
          };
        },
      })
    : undefined;

  const {
    goalHandler,
    worktreeHandler,
    terminalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
  } = createWebuiDomainHandlers(opts, trustBoundary, kanbanRunMirror);

  await seedConfigToMeta(opts);
  if (typeof opts.agent.ctx?.meta?.['yolo'] === 'boolean') {
    opts.onYoloSwitch?.(opts.agent.ctx.meta['yolo']);
  }

  const { prefSnapshot, persistPrefs } = createPrefsSeeding(opts);
  const sessionStartedAt = Date.now();
  const buildSessionStartPayload = createSessionStartPayloadBuilder(opts);

  const { register: registerWebuiClient, unregister: unregisterWebuiClient } =
    createWebuiClientRegistration({
      projectRoot: opts.projectRoot,
      appConfig: opts.appConfig,
      events: opts.events,
      hqSessionId: opts.session.id,
      getSessionId: () => opts.agent.ctx.session?.id ?? opts.session.id,
      hqControl: {
        interruptLeader: () => {
          let aborted = false;
          if (abortController) {
            abortController.abort();
            abortController = null;
            aborted = true;
          }
          for (const c of abortControllers.values()) {
            c.abort();
            aborted = true;
          }
          abortControllers.clear();
          return aborted;
        },
        allowRunCommand: () => opts.hqAllowExec === true,
      },
    });

  registerWebuiClient();

  const wsToken = resolveAuthToken(opts.accessToken);
  const publicHostnames = [publicUrl, publicWsUrl]
    .map((value) => {
      if (!value) return undefined;
      try {
        return new URL(value).hostname;
      } catch {
        return undefined;
      }
    })
    .filter((value): value is string => Boolean(value));
  let accessUrl = buildWebUIAccessUrl({
    host,
    port: httpPort,
    token: wsToken,
    publicUrl,
  });

  let fleetBroadcastCli: (() => Promise<void>) | null = null;
  const httpServer = await startStaticServe({
    host,
    httpPort,
    globalRoot,
    distDir: opts.frontendDistDir,
    ensureDistDeps: {
      resolvePackageJson: (id) => {
        const packageJson = findInstalledPackageJson(id, import.meta.url);
        if (!packageJson) throw new Error(`Package not found: ${id}`);
        return packageJson;
      },
    },
    onFleetPing: () => {
      void fleetBroadcastCli?.();
    },
    onTechStackEvent: (event) => broadcast(event),
    getLlm: () =>
      opts.agent.ctx.provider && opts.agent.ctx.model
        ? { provider: opts.agent.ctx.provider, model: opts.agent.ctx.model }
        : undefined,
    projectRoot: opts.projectRoot,
    publicWsUrl,
    apiToken: wsToken,
    requireToken,
    deferListen: surface === 'simpleui',
    strictPort,
    ...(opts.getVectorMemoryStore ? { getVectorMemoryStore: opts.getVectorMemoryStore } : {}),
    ...(opts.vectorMemoryModelCacheDir
      ? { vectorMemoryModelCacheDir: opts.vectorMemoryModelCacheDir }
      : {}),
  });

  const wss = httpServer
    ? new WebSocketServer({ server: httpServer.server, maxPayload: 20 * 1024 * 1024 })
    : new WebSocketServer({ port: httpPort, host, maxPayload: 20 * 1024 * 1024 });

  if (httpServer) {
    const boundPort =
      surface === 'simpleui'
        ? await startDeferredHttpListen({
            server: httpServer.server,
            host,
            httpPort,
            logger: consoleLogger,
            strictPort,
          })
        : httpServer.port;
    if (boundPort !== httpPort) {
      // The bind advanced past a TOCTOU competitor — every downstream
      // consumer (access URL, WS bridge, instance registry, ready banner)
      // must carry the actually-bound port.
      httpPort = boundPort;
      wsPort = boundPort;
      accessUrl = buildWebUIAccessUrl({ host, port: httpPort, token: wsToken, publicUrl });
    }
  }

  let ipv6LoopbackServer: HttpServer | null = null;
  if (httpServer && host === '127.0.0.1') {
    ipv6LoopbackServer = await startIpv6LoopbackProxy({
      primary: httpServer.server,
      httpPort,
      logger: consoleLogger,
    });
  }

  console.log(`[WebUI] WebSocket server starting on ws://${host}:${httpPort}`);

  if (httpServer) {
    announceWebuiReady({
      surface,
      server: httpServer.server,
      host,
      httpPort,
      open: !!opts.open,
      wsToken,
      publicUrl,
    });
  } else {
    console.warn(
      `[WebUI] Frontend not served (run \`pnpm --filter @wrongstack/webui build\`). ` +
        `WS bridge still active on ws://${host}:${httpPort}.`,
    );
  }

  const currentSessionId = (): string => opts.agent.ctx.session?.id ?? opts.session.id;

  const registryBaseDir = globalRoot;
  let webuiInstanceRegistered = false;
  if (opts.projectRoot) {
    const registration = Promise.resolve(
      registerWebuiInstance({
        pid: process.pid,
        surface,
        host,
        httpPort,
        publicUrl,
        projectRoot: opts.projectRoot,
        startedAt: new Date().toISOString(),
        registryBaseDir,
        authToken: wsToken,
        ...(opts.webuiSessionChild
          ? {
              role: 'session-child' as const,
              sessionId: currentSessionId(),
              parentPid: opts.webuiSessionChild.parentPid,
              parentShellId: opts.webuiSessionChild.parentShellId,
              runtimeId: opts.webuiSessionChild.runtimeId,
              attachable: opts.webuiSessionChild.attachable,
              lastReadyAt: new Date().toISOString(),
              protocolVersion: opts.webuiSessionChild.protocolVersion,
              capabilities: [...WEBUI_SESSION_CHILD_CAPABILITIES],
            }
          : {}),
      }),
    ).then(
      (value: unknown) => value !== false,
      () => false,
    );
    if (opts.webuiSessionChild) {
      webuiInstanceRegistered = await registration;
    } else {
      void registration;
      webuiInstanceRegistered = true;
    }
  }

  const eventUnsubscribers: Array<() => void> = [];

  const sessionPayload = <T extends Record<string, unknown>>(
    payload: T,
  ): T & { sessionId: string } => {
    const provided = payload['sessionId'];
    const sessionId =
      typeof provided === 'string' && provided.length > 0 ? provided : currentSessionId();
    return { ...payload, sessionId };
  };

  const {
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
  } = createStreamCoalescer({ broadcast, sessionPayload });

  const setupEvents = createSetupEvents({
    events: opts.events,
    agent: opts.agent,
    subscribeEternalIteration: opts.subscribeEternalIteration,
    broadcast,
    sessionPayload,
    currentSessionId,
    queueTextDelta,
    queueThinkingDelta,
    queueToolProgress,
    flushThinkingDelta,
    flushAllStreamBuffers,
    pendingConfirms,
    secretScrubber,
    getClients: () => clients,
    eventUnsubscribers,
    globalConfigPath: path.join(globalRoot, 'config.json'),
    onFleetBroadcaster: (fn) => {
      fleetBroadcastCli = fn;
    },
    ...(opts.getFleetBudget ? { getFleetBudget: opts.getFleetBudget } : {}),
  });

  const wsHandlerCtx: EmbeddedProviderContext = {
    providerStore: createProviderConfigStore(
      profileConfigPath,
      () => (opts.appConfig?.providers as Record<string, ProviderConfig> | undefined) ?? {},
    ),
    modelsRegistry: opts.modelsRegistry,
    send,
    broadcast,
    log: (m) => console.log(m),
  };
  const embeddedProviderOperations = createEmbeddedProviderOperations(wsHandlerCtx);

  let credentialWatcherClose: (() => void) | undefined = startWebuiCredentialWatcher({
    opts,
    profileConfigPath,
    broadcast,
    broadcastSaved: (providers) =>
      embeddedProviderOperations.broadcastSaved(providers as Record<string, ProviderConfig>),
  });

  const routeContexts = createWebuiRouteContexts({
    opts,
    profileConfigPath,
    profileDir,
    globalRoot,
    sessionStartedAt,
    currentSessionId,
    getCustomModeStore,
    buildSessionStartPayload,
    prefSnapshot,
    persistPrefs,
    pendingConfirms,
    abortControllers,
    getAbortController: () => abortController,
    clearAbortController: () => {
      abortController = null;
    },
    send,
    broadcast,
  });

  const kanbanHostRoutes = createCliKanbanHostRoutes({
    opts,
    send,
    broadcast,
    goalHandler,
    ...(kanbanSupervisor ? { kanbanSupervisor } : {}),
    ...(kanbanRunMirror ? { kanbanRunMirror } : {}),
  });

  let signalShutdown: (() => void) | undefined;
  const shutdown = (): void => signalShutdown?.();
  let embeddedAutoHealDispose: (() => void | Promise<void>) | null = null;
  const handleMessage = createEmbeddedMessageRouter({
    trustBoundary,
    opts,
    logger: consoleLogger,
    send,
    sendResult,
    sessionPayload,
    currentSessionId,
    shutdown,
    // Auto-heal watchdog disposer — `disposeResources` awaits it (bounded) so
    // an in-flight daemon restart drains before the host exits.
    onDispose: (dispose) => {
      embeddedAutoHealDispose = dispose;
    },
    providerCtx: wsHandlerCtx,
    brainCtx: routeContexts.brainCtx,
    introspectionCtx: routeContexts.introspectionCtx,
    skillsCtx: routeContexts.skillsCtx,
    promptsCtx: routeContexts.promptsCtx,
    designCtx: routeContexts.designCtx,
    agentConfigCtx: routeContexts.agentConfigCtx,
    prefsCtx: routeContexts.prefsCtx,
    projectCtx: routeContexts.projectsCtx,
    mailboxRoutes: routeContexts.mailboxRoutes,
    sessionCtx: routeContexts.sessionsCtx,
    conversationCtx: routeContexts.connectionCtx,
    goalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
    terminalHandler,
    kanbanHostRoutes,
    statusTracker: opts.statusTracker,
  });

  const stopped = new Promise<void>((resolve) => {
    let listeningAnnounced = false;
    const announceListening = () => {
      if (listeningAnnounced) return;
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
          webuiInstanceRegistered,
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
        abortControllers,
        pendingConfirms,
        buildSessionStartPayload,
        loadReplay: async () => {
          const activeSession = opts.agent.ctx.session ?? opts.session;
          await activeSession.flush().catch(() => undefined);
          if (opts.sessionStore) {
            const data = await opts.sessionStore.load(activeSession.id);
            return { messages: data.messages, events: data.events, usage: data.usage };
          }
          const usage = opts.agent.ctx.tokenCounter.total();
          return { messages: opts.agent.ctx.messages, usage };
        },
        loadAgentSessions: async () => (await opts.agentTranscripts?.loadSessionsFromDisk()) ?? [],
        needsSetup: opts.needsSetup ?? false,
      }),
    );

    wss.on('error', (err) => {
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'webui_server.error',
          message: err instanceof Error ? err.message : String(err),
          timestamp: new Date().toISOString(),
        }),
      );
    });

    signalShutdown = createWebuiShutdown({
      abortInFlight: () => {
        // First teardown step: stop the auto-heal watchdog's interval NOW so
        // no new daemon restart begins while the shutdown sequence runs its
        // child-kill sweep. dispose() stops the timer synchronously on its
        // first line and is idempotent — disposeResources still awaits it to
        // drain any restart already in flight.
        void embeddedAutoHealDispose?.();
        if (abortController) {
          abortController.abort();
          abortController = null;
        }
        for (const c of abortControllers.values()) c.abort();
        abortControllers.clear();
      },
      unsubscribeEvents: () => {
        flushAllStreamBuffers();
        for (const unsub of eventUnsubscribers) unsub();
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
        credentialWatcherClose?.();
        credentialWatcherClose = undefined;
        goalHandler.dispose();
        sddBoardHandler.dispose();
        worktreeHandler.dispose();
        terminalHandler.dispose();
        kanbanRunMirror?.dispose();
        kanbanSupervisor?.dispose();
        void stopKanbanSupervisorMemoryStats?.();
        // Drain an in-flight auto-heal restart before the host exits
        // (createWebuiShutdown awaits this, bounded by its dispose timeout).
        await embeddedAutoHealDispose?.();
        embeddedAutoHealDispose = null;
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
        const muted = terminalLogView.mutedCount;
        terminalLogView.stop();
        if (muted > 0) {
          console.log(
            `[WebUI] ${muted} progress line(s) kept out of this terminal — set WEBUI_VERBOSE=1 to see them.`,
          );
        }
        opts.onExit?.();
        resolve();
      },
    });

    registerWebuiSignalHandlers(signalShutdown);
  });

  function send(ws: WebSocket, msg: WSServerMessage): void {
    sendSerialized(ws, JSON.stringify(msg));
  }

  function broadcast(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) sendSerialized(ws, data);
  }

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }

  return stopped.finally(() => terminalLogView.stop());
}
