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
import type { ProviderConfig, SessionWriter } from '@wrongstack/core/types';
import {
  addFatalSalvageHook,
  startSharedHeapWatchdog,
  wstackGlobalRoot,
} from '@wrongstack/core/utils';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import {
  buildWebUIAccessUrl,
  type CustomModeStore,
  clientWantsSession,
  collectDisplayedSessionIds,
  createCustomModeStore,
  createEmbeddedMessageRouter,
  createEmbeddedProviderOperations,
  createSessionAgentRegistry,
  type EmbeddedProviderContext,
  envFlag,
  findFreePort,
  findInstalledPackageJson,
  isStrictPort,
  type PendingConfirm,
  resolveAuthToken,
  resolvePendingConfirmsForSession,
  type SessionAgentRegistry,
  scheduleOwnerlessEmptySessionCleanup,
  sendSerialized,
  stampDispatchSession,
  startTerminalDashboard,
  startWebUILiveStatusLogger,
  toSessionHistoryEntries,
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

import type { CliWebUIOptions } from './webui-server-options.js';

export type { CliWebUIOptions } from './webui-server-options.js';
export async function runWebUI(opts: CliWebUIOptions): Promise<void> {
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
    title: surface === 'simpleui' ? 'SimpleUI' : 'WebUI',
    quiet: !envFlag('WEBUI_LOGS'),
    // The dashboard is operator-owned terminal output, so retain the full
    // authenticated access URL here even though startup logs remain redacted.
    getUrl: () => accessUrl,
  });
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
  /**
   * Forward reference to the per-tab agent registry, which cannot be built
   * until the abort map exists further down. Everything that describes "one
   * session" reads through this, so a payload built for a background tab
   * reports that tab's model, mode and context window rather than the
   * leader's.
   */
  let sessionAgentsRef: SessionAgentRegistry | undefined;
  const buildSessionStartPayload = createSessionStartPayloadBuilder({
    ...opts,
    // Read through to the live `opts`, do NOT snapshot: `projects.select`
    // re-roots the host by assigning `opts.projectRoot` / `opts.session` on
    // this very object. A spread copy froze both at boot, so every
    // `session.start` broadcast after a project switch still announced the
    // previous project's root — the switch looked like it had not happened.
    get projectRoot() {
      return opts.projectRoot;
    },
    get session() {
      return opts.session;
    },
    // `peek`, never `get`: building a payload must not materialise an agent
    // for a session id that arrived from a stale browser tab.
    getSessionContext: (sessionId) => sessionAgentsRef?.peek(sessionId)?.ctx,
  });

  const { register: registerWebuiClient, unregister: unregisterWebuiClient } =
    createWebuiClientRegistration({
      projectRoot: opts.projectRoot,
      appConfig: opts.appConfig,
      events: opts.events,
      hqSessionId: opts.session.id,
      getSessionId: () => opts.agent.ctx.session?.id ?? opts.session.id,
      hqControl: {
        // HQ speaks for the LEADER — the boot session, the one it registered
        // itself under (`hqSessionId`) — not for whatever else the browser
        // has open. This used to abort every controller in the map and clear
        // it, so a remote "interrupt" issued against the leader also killed
        // the three other tabs' in-flight runs. Deleting the entries was
        // wrong on its own terms too: the run's own `end()` owns removal, and
        // clearing early makes `isRunActive` lie to every tab still running.
        interruptLeader: () => {
          const leaderId = opts.session.id;
          const controller = abortControllers.get(leaderId);
          if (!controller) return false;
          controller.abort();
          // Stopping a run means stopping its work; this session's subagents
          // are part of it (same treatment as the `abort` seam). Session
          // scoped, so one tab's Stop never reaches another tab's fleet.
          try {
            void Promise.resolve(opts.stopSessionFleet?.(leaderId)).catch(() => undefined);
          } catch {
            // Best effort: the run is already aborted and a teardown failure
            // must not surface instead of the stop.
          }
          return true;
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

  // Armed at construction, not at wiring time. Constructing a WebSocketServer
  // with {server} makes `ws` forward that HTTP server's 'error' events onto
  // this emitter, and the SimpleUI surface binds the HTTP server AFTER this
  // point (deferListen). A bind error arriving while this emitter had no
  // 'error' listener threw out of the emit loop as an uncaughtException,
  // which skipped the remaining HTTP-server 'error' listeners — including
  // listenWithRetry's — so the awaited bind never settled and startup hung
  // forever. Bun on Windows reaches that window routinely (phantom
  // EADDRINUSE on a free port), Node can reach it through a genuine
  // probe-to-bind race.
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

  /**
   * One Agent per open tab.
   *
   * The embedded host used to hand every tab the same leader Agent, so the
   * second tab to start a run hit `Agent.run()`'s concurrency guard —
   * "already in progress on this instance". Four tabs need four Agents; the
   * registry clones the leader's wiring and gives each session its own
   * `Context`, which is the state a run actually mutates.
   */
  const sessionAgents = createSessionAgentRegistry({
    template: opts.agent,
    ...(opts.modelsRegistry ? { modelsRegistry: opts.modelsRegistry } : {}),
    isRunActive: (sessionId) => abortControllers.has(sessionId),
    // A tab that is still on screen must outlive one that was closed, whatever
    // order their agents were created in.
    isDisplayed: (sessionId: string) => {
      for (const client of clients.values()) {
        if (client.sessionId === sessionId) return true;
        if (client.sessionIds?.has(sessionId) === true) return true;
      }
      return false;
    },
  });
  sessionAgentsRef = sessionAgents;

  /**
   * Live rows for the terminal panel: every session a connected browser tab
   * displays (plus the boot session when none do), with its running state,
   * model and provider. `peek`, never `get` — the panel must not materialise
   * agents for stale tab ids.
   */
  const stopLiveStatusLogger = startWebUILiveStatusLogger({
    events: opts.events,
    dashboard: terminalLogView,
    getSessionList: () => {
      const ids = new Set<string>();
      for (const client of clients.values()) {
        if (client.sessionId) ids.add(client.sessionId);
        for (const id of client.sessionIds ?? []) ids.add(id);
      }
      const currentId = opts.agent.ctx.session?.id ?? opts.session.id;
      if (ids.size === 0 && currentId) ids.add(currentId);
      return Array.from(ids).map((id) => {
        const ctx = sessionAgentsRef?.peek(id)?.ctx;
        return {
          id,
          model: ctx?.model ?? opts.agent.ctx.model ?? '',
          provider: ctx?.provider?.id ?? opts.agent.ctx.provider?.id ?? '',
          isRunning: abortControllers.has(id),
        };
      });
    },
  });

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

  /**
   * Retire the runtime of a tab that was closed.
   *
   * A closed tab used to leave everything behind: its Agent, that agent's
   * whole in-memory transcript, and an OPEN journal writer with a live file
   * handle. Nothing ever asked for them again, and the next session to need a
   * slot evicted a tab the user still had open instead.
   *
   * Two refusals, both deliberate:
   *   - a session with a live run keeps its agent, because the run outlives
   *     the tab that started it and still needs somewhere to write;
   *   - the boot session keeps its agent, because that agent IS the leader
   *     the whole host is wired to.
   */
  const retireUndisplayedSessions = (sessionIds: string[]): void => {
    for (const sessionId of sessionIds) {
      if (!sessionId || sessionId === opts.session.id) continue;
      if (sessionId === foregroundSession.id) continue;
      // Whatever happens to the agent, a permission prompt this session raised
      // is now unanswerable: it was parked on the closed tab's lane and that
      // lane is gone. Leaving it pending wedges `agent.run` forever, and a run
      // that never settles never releases its lock — which is what turned a
      // closed tab into a session that could neither be stopped nor deleted.
      const orphaned = resolvePendingConfirmsForSession(pendingConfirms, sessionId);
      if (orphaned > 0) {
        console.log(
          JSON.stringify({
            level: 'warn',
            event: 'webui.confirm_orphaned_by_tab_close',
            sessionId,
            count: orphaned,
            message: `Denied ${orphaned} unanswerable permission prompt(s) for closed session ${sessionId}.`,
          }),
        );
      }
      if (abortControllers.has(sessionId)) continue;
      // Past the live-run check: nothing this conversation started is still
      // going, so the background helpers pinned to it (explore companion,
      // shadow-review bookkeeping) have nothing left to watch.
      opts.onSessionRetired?.(sessionId);
      const agent = sessionAgents.peek(sessionId);
      if (!agent || agent === opts.agent) continue;
      // Ends the journal (`session_end`, then close) and forgets the agent.
      // The marker is not optional: "no trailing session_end" is exactly how
      // recovery recognises a journal a crash left hanging
      // (`SessionRecovery.listUnclosed`, `resolveSessionOutcome`), so without
      // it every tab the user closed on purpose was indistinguishable from one
      // that died — the recovery list filled up with finished work and the
      // history showed those sessions with no outcome at all.
      //
      // Fire-and-forget: the registry entry is gone before this returns, and
      // nothing the closing tab does next depends on the journal's last write.
      void sessionAgents.endAndClose(sessionId);
    }
  };

  /**
   * Sweep sessions that were started and never used.
   *
   * Every launch of this host opens a session, and so does every `New tab`
   * the user then closes without typing. This sweeper existed but was wired
   * into the STANDALONE WebUI host only, so the host `wstack --webui` actually
   * runs accumulated one dead, empty record per launch forever. They filled
   * the history list, and the ones the runtime or a tab still held could not
   * even be deleted by hand — "empty sessions I can't delete, and it says
   * they are live".
   *
   * Everything volatile is read at sweep time, never captured: the runtime's
   * current session, every session a connected page declares (a background
   * tab's brand-new session is empty BY DEFINITION and must not be swept out
   * from under it), and — stricter than the standalone host — every session
   * with a live run, whose journal is empty only because its first turn has
   * not landed yet. The store's own fail-closed `isEmpty` is the final word.
   */
  const stopEmptySessionCleanup = opts.sessionStore
    ? scheduleOwnerlessEmptySessionCleanup({
        getSessionStore: () => opts.sessionStore as NonNullable<typeof opts.sessionStore>,
        getActiveSessionId: () => foregroundSession.id,
        getActiveSessionIds: () =>
          collectDisplayedSessionIds({ getSession: () => foregroundSession, clients }),
        // A run outlives the tab that started it, and a turn that has not
        // written its first record yet looks exactly like a session nobody
        // ever used.
        hasParticipants: (sessionId) => abortControllers.has(sessionId),
        refreshSessions: async () => {
          const list = await opts.sessionStore?.list(200);
          if (!list) return;
          broadcastEveryone({
            type: 'sessions.list',
            payload: { sessions: toSessionHistoryEntries(list, foregroundSession.id) },
          });
        },
        logger: consoleLogger,
      })
    : null;

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
    chimeraRoutes: routeContexts.chimeraRoutes,
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

    signalShutdown = createWebuiShutdown({
      abortInFlight: () => {
        // First teardown step: stop the auto-heal watchdog's interval NOW so
        // no new daemon restart begins while the shutdown sequence runs its
        // child-kill sweep. dispose() stops the timer synchronously on its
        // first line and is idempotent — disposeResources still awaits it to
        // drain any restart already in flight.
        void embeddedAutoHealDispose?.();
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
        releaseSessionSalvage();
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

    registerWebuiSignalHandlers(signalShutdown);
  });

  function send(ws: WebSocket, msg: WSServerMessage): void {
    // `stampDispatchSession` names the tab whose message is being handled on
    // `key.operation_result` frames, which carry no session of their own. This
    // host writes straight to `sendSerialized` rather than going through the
    // shared `send`, so it has to apply the stamp itself or the CLI-embedded
    // WebUI keeps mis-routing background tabs' result toasts. See B-05.
    sendSerialized(ws, JSON.stringify(stampDispatchSession(msg)));
  }

  /**
   * Broadcast, but session-aware: a frame whose payload names a session is
   * delivered only to connections displaying that session (their declared
   * `sessionIds` set from `session.subscribe`, or their single `sessionId`).
   * The old loop pushed every tagged frame to every socket — delivery relied
   * entirely on each client's goodwill to file it under the right tab, which
   * is no isolation boundary at all.
   *
   * `targetSessionId` overrides the payload's id: a subagent's codemap frame
   * names the SUBAGENT's session, which no tab subscribes to.
   */
  function broadcast(msg: WSServerMessage, targetSessionId?: string): void {
    const data = JSON.stringify(msg);
    const payload = (msg as { payload?: unknown }).payload;
    const sessionId =
      targetSessionId ??
      (payload &&
      typeof payload === 'object' &&
      typeof (payload as { sessionId?: unknown }).sessionId === 'string'
        ? (payload as { sessionId: string }).sessionId
        : undefined);
    for (const [ws, client] of clients) {
      if (clientWantsSession(client, sessionId)) sendSerialized(ws, data);
    }
  }

  /** Every connection, unfiltered — see `ProjectHandlersContext.broadcastEveryone`. */
  function broadcastEveryone(msg: WSServerMessage): void {
    const data = JSON.stringify(msg);
    for (const [ws] of clients) sendSerialized(ws, data);
  }

  function sendResult(ws: WebSocket, success: boolean, message: string): void {
    send(ws, { type: 'key.operation_result', payload: { success, message } });
  }

  return stopped.finally(() => terminalLogView.stop());
}
