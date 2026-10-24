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
import * as path from 'node:path';
import type { SessionWriter } from '@wrongstack/contracts/types';
import { createCompatibilityTrustBoundary, DefaultSecretScrubber } from '@wrongstack/core/security';
import { addFatalSalvageHook } from '@wrongstack/core/utils';
import {
  buildWebUIAccessUrl,
  type CustomModeStore,
  createCustomModeStore,
  createWebuiLeaderAutoWakeHost,
  envFlag,
  findFreePort,
  type PendingConfirm,
  resolveAuthToken,
  type SessionAgentRegistry,
  startTerminalDashboard,
} from '@wrongstack/webui-server';
import type { WebSocket } from 'ws';
import { setAcpLeaderSessionAgents } from './acp-leader/acp-leader-host.js';
import {
  createEmbeddedClientRegistration,
  startEmbeddedLiveStatusLogger,
} from './webui-client-observability.js';
import type { ConnectedClient } from './webui-server/connection-handler.js';
import type {
  WSClientMessage as EmbeddedWSClientMessage,
  WSServerMessage as EmbeddedWSServerMessage,
} from './webui-server/contracts.js';
import { createWebuiDomainHandlers } from './webui-server/domain-handlers.js';
import { resolveWebuiHostSettings } from './webui-server/host-settings.js';
import { startWebuiHttpBridge } from './webui-server/http-bridge.js';
import { registerEmbeddedWebuiInstance } from './webui-server/instance-registration.js';
import { createCliKanbanHostRoutes } from './webui-server/kanban-host-adapter.js';
import { createWebuiKanbanServices } from './webui-server/kanban-services.js';
import { consoleLogger } from './webui-server/logger-shim.js';
import { createCliEmbeddedMessageRouter } from './webui-server/message-router.js';
import { createPrefsSeeding, seedConfigToMeta } from './webui-server/prefs-seeding.js';
import { createEmbeddedProviderPlane } from './webui-server/provider-plane.js';
import { createWebuiRouteContexts } from './webui-server/route-contexts.js';
import { createEmbeddedSessionAgents } from './webui-server/session-agents.js';
import { createLiveSessionStartPayloadBuilder } from './webui-server/session-start-live.js';
import { createSetupEvents } from './webui-server/setup-events.js';
import { createStreamCoalescer } from './webui-server/stream-coalescer.js';
import { createWebuiTransport } from './webui-server/transport.js';
import { runWebuiServerLifecycle } from './webui-server-lifecycle.js';
import type { CliWebUIOptions } from './webui-server-options.js';
import { setupWebuiSessionMaintenance } from './webui-session-maintenance.js';
import { createWebuiSessionRetirement } from './webui-session-retirement.js';
export type WSClientMessage = EmbeddedWSClientMessage;
export type WSServerMessage = EmbeddedWSServerMessage;

export type { CliWebUIOptions } from './webui-server-options.js';
export async function runWebUI(opts: CliWebUIOptions): Promise<void> {
  const trustBoundary =
    opts.trustBoundary ??
    createCompatibilityTrustBoundary({ policyId: 'cli-webui-trusted-host-compat-v1' });
  const {
    host,
    publicUrl,
    publicWsUrl,
    requireToken,
    surface,
    requestedHttpPort,
    strictPort,
    globalRoot,
    profileConfigPath,
    profileDir,
    rateLimitMax,
    publicHostnames,
  } = resolveWebuiHostSettings(opts);
  /**
   * One coordinator for the whole terminal: a fixed session-stats panel at
   * the bottom (live rows for every open tab, running or idle) plus an
   * ordered, timestamped log stream above it. `quiet` keeps the embedded
   * host's browser-owns-chatter contract — info-level lines land in the
   * ring buffer, warn/error still flow — and WEBUI_LOGS=1 streams the info
   * lines in as well. WEBUI_VERBOSE=1 or a non-TTY stdout bypasses the
   * dashboard entirely, keeping the raw append-only log.
   */
  const terminalLogView = startTerminalDashboard({
    title: surface === 'vibeui' ? 'VibeUI' : surface === 'simpleui' ? 'SimpleUI' : 'WebUI',
    quiet: !envFlag('WEBUI_LOGS'),
    // The dashboard is operator-owned terminal output, so retain the full
    // authenticated access URL here even though startup logs remain redacted.
    getUrl: () => accessUrl,
  });
  let httpPort = requestedHttpPort;
  if (!strictPort) {
    httpPort = await findFreePort(host, requestedHttpPort);
  }
  let wsPort = httpPort;
  const clients = new Map<WebSocket, ConnectedClient>();
  const { send, broadcast, broadcastEveryone, sendResult } = createWebuiTransport(clients);
  const pendingConfirms = new Map<string, PendingConfirm>();
  const secretScrubber = new DefaultSecretScrubber();
  /**
   * One abort controller per conversation. There is no process-wide one:
   * this server drives up to four tabs at once, so "the run" names nobody.
   *
   * A singular `abortController` used to sit beside this map. Nothing ever
   * assigned it — every run has registered here per session since the tabs
   * became independent — so the two places that read it (the project-switch
   * teardown and the shutdown sweep) were quietly doing nothing, and it stood
   * as an open invitation to reintroduce a global abort.
   */
  const abortControllers = new Map<string, AbortController>();

  let customModeStoreP: Promise<CustomModeStore> | null = null;
  const getCustomModeStore = (): Promise<CustomModeStore> => {
    customModeStoreP ??= (async () => {
      const store = createCustomModeStore(profileDir);
      await store.load();
      return store;
    })();
    return customModeStoreP;
  };

  const { kanbanRunMirror, kanbanSupervisor, stopKanbanSupervisorMemoryStats } =
    createWebuiKanbanServices(opts, broadcast);

  const domainHandlers = createWebuiDomainHandlers(opts, trustBoundary, kanbanRunMirror);
  const {
    goalHandler,
    worktreeHandler,
    terminalHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
  } = domainHandlers;

  await seedConfigToMeta(opts);
  if (typeof opts.agent.ctx?.meta?.['yolo'] === 'boolean') {
    opts.onYoloSwitch?.(opts.agent.ctx.meta['yolo']);
  }

  const { prefSnapshot, persistPrefs } = createPrefsSeeding(opts);
  const sessionStartedAt = Date.now();
  /**
   * Forward reference to the per-tab agent registry, which cannot be built
   * until the abort map exists further down. Everything that describes "one
   * session" reads through this, so a payload built for a background tab
   * reports that tab's model, mode and context window rather than the
   * leader's.
   */
  let sessionAgentsRef: SessionAgentRegistry | undefined;
  const buildSessionStartPayload = createLiveSessionStartPayloadBuilder(
    opts,
    () => sessionAgentsRef,
  );

  const { register: registerWebuiClient, unregister: unregisterWebuiClient } =
    createEmbeddedClientRegistration(opts, clients, abortControllers, () => sessionAgentsRef);

  registerWebuiClient();

  const wsToken = resolveAuthToken(opts.accessToken);
  let accessUrl = buildWebUIAccessUrl({
    host,
    port: httpPort,
    token: wsToken,
    publicUrl,
  });

  let fleetBroadcastCli: (() => Promise<void>) | null = null;
  const { httpServer, wss, ipv6LoopbackServer } = await startWebuiHttpBridge({
    opts,
    surface,
    host,
    httpPort,
    strictPort,
    globalRoot,
    wsToken,
    publicUrl,
    publicWsUrl,
    requireToken,
    getSessionAgents: () => sessionAgentsRef,
    onFleetPing: () => {
      void fleetBroadcastCli?.();
    },
    broadcast,
    onPortRebound: (port) => {
      httpPort = port;
      wsPort = port;
      accessUrl = buildWebUIAccessUrl({ host, port: httpPort, token: wsToken, publicUrl });
    },
  });

  /**
   * Which tab this host considers to be in front.
   *
   * Deliberately its OWN binding rather than `opts.agent.ctx.session`. The
   * leader agent is not a neutral pointer — it is the runtime of the boot
   * tab — so using its writer as "the current session" meant that resuming
   * any other tab re-pointed the boot tab's context at that tab's journal.
   * Everything the boot tab appended afterwards (mid-run included) landed in
   * the wrong session's file. The pointer moves; contexts do not.
   */
  let foregroundSession: SessionWriter = opts.agent.ctx.session ?? opts.session;
  const currentSessionId = (): string => foregroundSession.id;

  const registryBaseDir = globalRoot;
  const webuiInstanceRegistered = await registerEmbeddedWebuiInstance({
    opts,
    surface,
    host,
    httpPort,
    publicUrl,
    registryBaseDir,
    wsToken,
    currentSessionId,
  });

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
    sessionContext: (sessionId) => sessionAgentsRef?.peek(sessionId)?.ctx,
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

  const { wsHandlerCtx, credentialWatcherClose } = createEmbeddedProviderPlane({
    opts,
    profileConfigPath,
    send,
    broadcast,
  });

  const { sessionAgents, isSessionDisplayed } = createEmbeddedSessionAgents(
    opts,
    clients,
    abortControllers,
  );
  sessionAgentsRef = sessionAgents;
  // An ACP agent leading a tab asks that tab's policy and runs its fleet tools
  // on that tab's agent, so the workers it starts belong to the tab.
  setAcpLeaderSessionAgents((sessionId) => sessionAgents.peek(sessionId));

  /**
   * Background-delegation auto-wake. The controller is the CLI's — one per
   * process — and this host only binds its port: open = a session this
   * process holds a live writer for, displayed = some tab shows it (else the
   * results are held until a tab does), idle = no run lock. Woken turns run
   * through the conversation path's runtime-turn starter, bound when the
   * router builds the conversation routes.
   */
  const autoWakeHost = opts.leaderAutoWake
    ? createWebuiLeaderAutoWakeHost({
        controller: opts.leaderAutoWake,
        events: opts.events,
        abortControllers,
        pendingConfirms,
        isOpen: (sessionId) => sessionId === opts.session.id || sessionAgents.isLive(sessionId),
        isDisplayed: isSessionDisplayed,
        broadcast,
        logger: { warn: (message) => consoleLogger.warn(message) },
      })
    : undefined;

  /**
   * Live rows for the terminal panel: every session a connected browser tab
   * displays (plus the boot session when none do), with its running state,
   * model and provider. `peek`, never `get` — the panel must not materialise
   * agents for stale tab ids.
   */
  const stopLiveStatusLogger = startEmbeddedLiveStatusLogger(
    opts,
    clients,
    abortControllers,
    () => sessionAgentsRef,
    terminalLogView,
  );

  /**
   * Salvage every tab's journal on a fatal exit, not just the leader's.
   *
   * The boot-time salvage hook drains `sessionRef.current` — the session the
   * host itself speaks for. The other three tabs write through their own
   * writers, each with its own buffer, so a crash-shield exit or an unhandled
   * rejection truncated their journals at whatever the last critical record
   * happened to be. Registering here keeps the hook alive for exactly as long
   * as the registry it drains.
   */
  const releaseSessionSalvage = addFatalSalvageHook(() => {
    try {
      sessionAgents.flushAllSync();
    } catch {
      // best-effort — the process is already going down
    }
  });
  const { retireUndisplayedSessions } = createWebuiSessionRetirement({
    opts,
    getForegroundSession: () => foregroundSession,
    pendingConfirms,
    abortControllers,
    sessionAgents,
  });
  const { stopEmptySessionCleanup } = setupWebuiSessionMaintenance({
    opts,
    broadcastEveryone,
    getForegroundSession: () => foregroundSession,
    clients,
    abortControllers,
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
    getSessionAgent: (sessionId) => sessionAgents.get(sessionId),
    peekSessionAgent: (sessionId) => sessionAgents.peek(sessionId),
    onSessionsUndisplayed: retireUndisplayedSessions,
    ...(autoWakeHost ? { autoWake: autoWakeHost } : {}),
    isSessionLive: (sessionId) => sessionAgents.isLive(sessionId),
    getForegroundSession: () => foregroundSession,
    setForegroundSession: (next) => {
      foregroundSession = next;
    },
    clients,
    ...(opts.stopSessionFleet ? { stopSessionFleet: opts.stopSessionFleet } : {}),
    send,
    broadcast,
    broadcastEveryone,
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
  const handleMessage = createCliEmbeddedMessageRouter({
    trustBoundary,
    opts,
    send,
    sendResult,
    sessionPayload,
    currentSessionId,
    shutdown,
    onDispose: (dispose) => {
      embeddedAutoHealDispose = dispose;
    },
    providerCtx: wsHandlerCtx,
    routeContexts,
    domainHandlers,
    kanbanHostRoutes,
  });

  const { stopped } = runWebuiServerLifecycle({
    host,
    httpPort,
    setupEvents,
    opts,
    wsPort,
    accessUrl,
    wsToken,
    webuiInstanceRegistered,
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
    lifecycleState: {
      get signalShutdown() {
        return signalShutdown;
      },
      set signalShutdown(value) {
        signalShutdown = value;
      },
      get embeddedAutoHealDispose() {
        return embeddedAutoHealDispose;
      },
      set embeddedAutoHealDispose(value) {
        embeddedAutoHealDispose = value;
      },
    },
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
  });

  return stopped.finally(() => terminalLogView.stop());
}
