import { resolveWstackPaths } from '@wrongstack/core/utils';
import { makeProviderFromConfig } from '@wrongstack/providers';
import type { WebSocket } from 'ws';
import { AgentRosterWSHandler } from './agent-roster-handlers.js';
import { createAutonomyRouteHandlers } from './autonomy-routes.js';
import { type BrainRouteHandlers, createBrainRouteHandlers } from './brain-routes.js';
import type { ClientTransportRouteHandlers } from './client-transport-routes.js';
import type { CodeAssistRouteHandlers } from './code-assist-routes.js';
import { handleCodebaseIndexServerControl } from './codebase-index-server-control.js';
import { createToolLspCompletionSource, handleCompletionRequest } from './completion-handlers.js';
import type { CompletionRouteHandlers } from './completion-routes.js';
import { createAutoHealer } from './connections/auto-healer.js';
import {
  handleConnectionsHealthRoute,
  handleConnectionsServiceAction,
} from './connections-health-route.js';
import {
  applyEmbeddedModelSwitch,
  broadcastEmbeddedGoalSnapshot,
  createEmbeddedConversationRoutes,
  createEmbeddedProjectRoutes,
  createEmbeddedSessionRoutes,
} from './embedded-host-adapters.js';
import { createEmbeddedMcpRoutes } from './embedded-mcp-routes.js';
import type {
  EmbeddedMessageRouter,
  EmbeddedMessageRouterDeps,
} from './embedded-message-router-types.js';
import { createEmbeddedProviderRoutes } from './embedded-provider-routes.js';
import { createEmbeddedSessionAccess } from './embedded-session-access.js';
import { createEmbeddedShellGitRoutes } from './embedded-shell-git-routes.js';
import { handleGoalStateMutation } from './goal-handlers.js';
import { createGoalRefinerAdapter } from './goal-refiner-adapter.js';
import type { GoalRouteHandlers } from './goal-routes.js';
import type { GoalSnapshotRouteHandlers } from './goal-snapshot-routes.js';
import type { HostRouteHandlers } from './host-routes.js';
import { handleJevRoute } from './jev-routes.js';
import { createModeRouteHandlers } from './mode-routes.js';
import { portableCommandRoute } from './portable-command-route.js';
import { createPrefsRouteHandlers } from './prefs-routes.js';
import { authorizeWebUIAction } from './privileged-actions.js';
import {
  handleProcessKill,
  handleProcessKillAll,
  handleProcessList,
  handleProcessOutput,
} from './process-handlers.js';
import type { ProcessRouteHandlers } from './process-routes.js';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';
import { createRouteFamilyDispatcher } from './route-family-dispatcher.js';
import type { SddBoardRouteHandlers } from './sdd-board-routes.js';
import type { SddWizardRouteHandlers } from './sdd-wizard-routes.js';
import { collectDisplayedSessionIds, createSessionTransitionGate } from './session-handlers.js';
import type { SpecsRouteHandlers } from './specs-routes.js';
import type { WSClientMessage } from './types.js';
import { createWorklistRouteHandlers } from './worklist-routes.js';
import { createSessionAwareWorklistContext } from './worklist-session-context.js';
import { errMessage } from './ws-utils.js';

export type {
  EmbeddedMessageRouter,
  EmbeddedMessageRouterDeps,
  EmbeddedMessageRouterOptions,
} from './embedded-message-router-types.js';

/**
 * Stand-in used when a host predates the Code Assist family. The family still
 * CLAIMS `code.assist.run` in the dispatcher chain (it is registered, not
 * optional, so ordering stays stable), so this must consume the message rather
 * than let it fall through to `onUnknown` — a silent no-op is the right
 * behaviour for a host that has no subagent factory to run it with.
 */
const inertCodeAssistRoutes: CodeAssistRouteHandlers = {
  run: async () => {},
  abort: async () => {},
};

export function createEmbeddedMessageRouter(
  deps: EmbeddedMessageRouterDeps,
): EmbeddedMessageRouter {
  const { opts, send, sendResult } = deps;
  const projectRoot = () => opts.projectRoot ?? opts.agent.ctx.projectRoot ?? '';

  // Opt-in server-side watchdog (env WRONGSTACK_AUTO_HEAL_SERVICES=1): reuses
  // the exact restart path behind the RotateCcw button for services stuck in
  // `error`. Disabled by default; `start()` is a no-op unless enabled. Mirrors
  // the wiring in the standalone `message-dispatcher.ts`.
  const autoHealer = createAutoHealer({
    projectRoot,
    indexDir: () =>
      typeof opts.agent.ctx.meta['codebaseIndexDir'] === 'string'
        ? opts.agent.ctx.meta['codebaseIndexDir']
        : undefined,
    trustBoundary: deps.trustBoundary,
    logger: deps.logger,
    onStatus: (event) =>
      deps.providerCtx.broadcast({
        type: 'connections.auto_heal_status',
        payload: event,
      }),
  });
  autoHealer.start();
  if (deps.onDispose) {
    deps.onDispose(async () => {
      await autoHealer.dispose();
    });
  }

  const terminal = async (ws: WebSocket, message: WSClientMessage) => {
    await deps.terminalHandler.handleMessage(ws, message).catch((error) => {
      const text = errMessage(error);
      const id = (message.payload as { id?: string } | undefined)?.id ?? '';
      send(ws, {
        type: 'terminal.output',
        payload: { id, data: `Internal terminal error: ${text}\r\n` },
      });
      send(ws, { type: 'terminal.exit', payload: { id, exitCode: -1 } });
    });
  };
  const { sessionContextOf, guardSession } = createEmbeddedSessionAccess(deps);
  const mcp = createEmbeddedMcpRoutes(deps);
  const shellGit = createEmbeddedShellGitRoutes(deps, projectRoot);

  /**
   * "Is THIS session running?" — session-keyed, never process-wide.
   *
   * Both consumers below used to pass `() => abortControllers.size > 0`, which
   * type-checks against the `(sessionId?: string) => boolean` contract because
   * a zero-arg function is assignable — so the argument every caller carefully
   * threaded through was silently dropped. With four tabs on one host that
   * answered "yes, running" for EVERY session whenever ANY one of them was
   * mid-run: `session.delete` refused with "an agent run is active" for a
   * session that had no tab left, `session.run_state` told all four tabs they
   * were still running, the context editor refused edits, and a resume skipped
   * `replaceMessages` and showed a stale transcript. The host's own
   * session-keyed answer (route-contexts) was spread in first and then
   * overwritten by these two lines.
   */
  /**
   * ONE serialiser for every operation that re-points a session's runtime,
   * shared by the session routes and by `user_message` setup.
   *
   * Both halves used to run ungated here: the session handlers created a
   * private gate (transitions ordered against each other) and the
   * conversation routes got none at all, so a turn could begin reading a
   * context a concurrent `session.resume` was halfway through re-pointing.
   * The standalone host has shared a single gate since the four-tab work; the
   * embedded host is the one people run.
   */
  const sessionTransitionGate = createSessionTransitionGate();

  /**
   * Best-effort cascade of a session stop into the fleet it spawned. Mirrors
   * `stopFleet` in embedded-host-adapters (the conversation `abort` route);
   * fire-and-forget, because a teardown failure must never surface instead of
   * the stop the caller asked for.
   */
  const stopSessionFleetFor = (sessionId: string): void => {
    const stop = deps.conversationCtx.stopSessionFleet;
    if (!sessionId || !stop) return;
    try {
      void Promise.resolve(stop(sessionId)).catch(() => undefined);
    } catch {
      // A synchronous throw from the host hook is best-effort too.
    }
  };

  const isRunActive = (sessionId?: string): boolean =>
    sessionId
      ? deps.conversationCtx.abortControllers.has(sessionId)
      : deps.conversationCtx.abortControllers.size > 0;
  const provider = createEmbeddedProviderRoutes(deps, sessionContextOf, isRunActive);

  const session = createEmbeddedSessionRoutes({
    ...deps.sessionCtx,
    withSessionTransition: sessionTransitionGate,
    // Abort every in-flight run before a session swap — a slow provider
    // stream from the previous session would otherwise keep running in the
    // background after session.new/resume. The run's own end() cleanup
    // removes controllers from the map when it unwinds.
    abortActiveRun: (sessionId) => {
      if (sessionId) {
        // Named target, so this stops exactly that session — including when
        // it has no live run. The old code fell through to "abort all" when
        // the id was absent from the map, which meant retiring an ALREADY
        // FINISHED session killed the three other tabs' in-flight runs.
        deps.conversationCtx.abortControllers.get(sessionId)?.abort();
        // Stopping a run means stopping the WORK, and this session's subagents
        // are part of that work: aborting the leader's controller only unwinds
        // workers it is BLOCKED on, while anything started with
        // `spawn_subagent` + `assign_task` keeps going unless asked to stop.
        // The standalone host has always done this on its own abort seam
        // (`abortRunLock`); this one did not, so a `session.delete` that stops
        // an off-screen run left that session's fleet running behind a
        // conversation that no longer exists. Scoped to the session, so one
        // tab's teardown never reaches another tab's fleet.
        stopSessionFleetFor(sessionId);
        return;
      }
      // Abort all — full teardown only, i.e. called with no session named.
      // Materialize first: .abort() triggers async unwinding that
      // eventually calls end() → map.delete, which would mutate the
      // map during iteration if we iterated the live values().
      const running = [...deps.conversationCtx.abortControllers.keys()];
      for (const controller of [...deps.conversationCtx.abortControllers.values()]) {
        controller.abort();
      }
      for (const key of running) stopSessionFleetFor(key);
    },
    isRunActive,
    // What a NEW tab starts on: the live config's current selection, which
    // every model switch updates regardless of which tab made it.
    getDefaultModel: () => {
      const cfg = deps.agentConfigCtx.getConfig?.();
      return { provider: cfg?.provider, model: cfg?.model };
    },
    // ...and the runtime has to follow it: the new tab's Context is cloned
    // from the leader's, so without this it would RUN the leader's model
    // while its record named the default.
    applyModelSwitch: (providerId, modelId, sessionId) =>
      applyEmbeddedModelSwitch(
        deps.agentConfigCtx,
        providerId,
        modelId,
        sessionContextOf(sessionId),
      ),
  });
  const project = createEmbeddedProjectRoutes(deps.projectCtx);
  const mode = createModeRouteHandlers({
    modeStore: deps.agentConfigCtx.modeStore,
    // The `mode_changed` entry belongs in the journal of the tab that switched.
    getSession: (sessionId?: string) => sessionContextOf(sessionId).session,
    // The mode belongs to the tab that switched it, not to the process — the
    // contract has carried `sessionId` since the four-tab work, and this host
    // ignored it and wrote the leader's meta, so switching mode in tab 3 moved
    // the boot tab's mode instead.
    applyModeId: (id, sessionId) => {
      sessionContextOf(sessionId).meta['mode'] = id;
    },
    send: deps.agentConfigCtx.send,
    // Announce the switch FOR THE TAB THAT MADE IT. Dropping `sessionId` here
    // built the payload for the leader instead, so a mode change in a
    // background tab re-announced the boot tab's session carrying the new
    // mode — and relabelled a conversation the user had not touched.
    afterSwitch: async (id, sessionId) =>
      deps.agentConfigCtx.broadcast({
        type: 'session.start',
        payload: await deps.agentConfigCtx.buildSessionStart({
          mode: id,
          ...(sessionId ? { sessionId } : {}),
        }),
      }),
  });
  const prefs = createPrefsRouteHandlers(deps.prefsCtx);
  // Shared with the standalone host: one table, one set of payload checks.
  // Both hosts used to hand-roll this with inline casts, which is how the
  // three validateBrain*Payload functions ended up tested but unreachable.
  const brain: BrainRouteHandlers = createBrainRouteHandlers(deps.brainCtx);
  brain.jev = (ws, msg) =>
    handleJevRoute(
      {
        store: deps.prefsCtx.configStore,
        file: opts.profileConfigPath,
        vault: deps.jevVault,
        send: deps.send,
      },
      ws,
      msg,
    );
  /**
   * Worklist (todos / tasks / plan) for the session the request NAMES.
   *
   * This host built one context off `opts.agent.ctx` — the leader, i.e. the
   * boot tab's runtime — with no message parameter at all. So with four tabs
   * open every tab showed the leader's todo list, a write in tab 3 mutated
   * tab 1's board, and all four shared one `.plan.json` / `.tasks.json`
   * because the sidecar paths came from the leader's meta. The standalone
   * host has resolved this per session since the four-tab work; the same
   * factory is used here now, so both hosts answer identically.
   */
  const worklistSessionContext = createSessionAwareWorklistContext({
    rootContext: opts.agent.ctx,
    ...(deps.sessionCtx.peekAgent ? { peekAgent: deps.sessionCtx.peekAgent } : {}),
    ...(deps.sessionCtx.getAgent ? { getAgent: deps.sessionCtx.getAgent } : {}),
    sessionsDir:
      deps.sessionCtx.opts.sessionsDir ??
      resolveWstackPaths({ projectRoot: projectRoot() }).projectSessions,
    send: (ws, message) => send(ws, message as never),
    broadcast: (message) => deps.providerCtx.broadcast(message as never),
  });
  const worklist = createWorklistRouteHandlers({
    getContext: (message) => worklistSessionContext(message as never),
  });
  const processRoutes: ProcessRouteHandlers = {
    list: handleProcessList,
    output: (ws, msg) => handleProcessOutput(ws, msg.payload),
    kill: (ws, msg) =>
      handleProcessKill(ws, msg.payload, deps.trustBoundary, undefined, {
        backend: 'cli-embedded',
      }),
    killAll: (ws, msg) =>
      handleProcessKillAll(
        ws,
        deps.trustBoundary,
        undefined,
        { backend: 'cli-embedded' },
        msg.payload,
      ),
  };
  const host: HostRouteHandlers = {
    shutdown: async (ws) => {
      const result = await authorizeWebUIAction(deps.trustBoundary, {
        capability: 'host.shutdown',
        subject: { kind: 'process', id: String(process.pid) },
        risk: 'elevated',
        metadata: { backend: 'cli-embedded' },
      });
      if (result.allowed) deps.shutdown();
      else sendResult(ws, false, `Shutdown denied: ${result.reason}`);
    },
  };
  const clientTransport: ClientTransportRouteHandlers = {
    collaboration: (ws, msg) =>
      send(ws, {
        type: 'error',
        payload: { phase: msg.type, message: 'Collaboration not available in this surface' },
      }),
    terminal,
  };
  const completion: CompletionRouteHandlers = {
    request: (ws, msg) =>
      handleCompletionRequest(ws, msg, {
        projectRoot: projectRoot(),
        provider: opts.agent.ctx.provider,
        model: opts.agent.ctx.model,
        indexDir:
          typeof opts.agent.ctx.meta['codebaseIndexDir'] === 'string'
            ? opts.agent.ctx.meta['codebaseIndexDir']
            : undefined,
        lspCompletion: createToolLspCompletionSource(
          opts.agent.ctx.tools.find((tool) => tool.name === 'lsp_completion'),
          opts.agent.ctx,
        ),
      }),
  };
  const goalSnapshot: GoalSnapshotRouteHandlers = {
    getSnapshot: async () => broadcastEmbeddedGoalSnapshot(deps.sessionCtx),
    mutate: (_ws, msg) => {
      const projectRoot =
        deps.sessionCtx.opts.projectRoot ?? deps.sessionCtx.opts.agent.ctx.projectRoot;
      const payload = msg.payload as Record<string, unknown> | undefined;
      const sessionId = typeof payload?.sessionId === 'string' ? payload.sessionId : undefined;
      const targetAgent = sessionId
        ? (deps.sessionCtx.peekAgent?.(sessionId) ??
          (!deps.sessionCtx.peekAgent || opts.agent.ctx.session?.id === sessionId
            ? opts.agent
            : undefined))
        : opts.agent;
      if (!targetAgent) {
        deps.sessionCtx.broadcast({
          type: 'goal-state.error',
          payload: { message: 'Goal refiner session is unavailable.' },
        });
        return;
      }
      const { provider, model } = targetAgent.ctx;
      const config = deps.agentConfigCtx.getConfig?.() ?? deps.prefsCtx.configStore?.get();
      const activeProviderId = provider?.id ?? config?.provider;
      const createProvider = (providerId: string) => {
        if (providerId === activeProviderId && provider) return provider;
        const providerConfig = config?.providers?.[providerId];
        if (!providerConfig) return undefined;
        try {
          return makeProviderFromConfig(
            providerId,
            routeProviderCfgThroughProxy(providerConfig, config?.baseUrl, providerId),
          );
        } catch {
          return undefined;
        }
      };
      return handleGoalStateMutation(
        projectRoot,
        msg.type as
          | 'goal-state.set'
          | 'goal-state.refine'
          | 'goal-state.pause'
          | 'goal-state.resume'
          | 'goal-state.clear',
        payload,
        deps.sessionCtx.broadcast,
        createGoalRefinerAdapter({
          config,
          primaryProvider: provider,
          primaryModel: model,
          activeProviderId,
          createProvider,
          onUsage: (usage, source) => {
            void targetAgent.ctx.session
              .append({
                type: 'enhance_usage',
                ts: new Date().toISOString(),
                usage,
                provider: source.providerId,
                model: source.model,
              })
              .catch(() => {
                // Session journaling is best-effort by contract.
              });
          },
          onOutcome: (outcome) => {
            opts.agent.events.emit('enhance.outcome', {
              providerId: outcome.providerId,
              model: outcome.model,
              result: outcome.result,
              passes: 1,
              parseRejections: 0,
              durationMs: outcome.durationMs,
              reason: outcome.reason,
              failureKind: outcome.failureKind,
            });
          },
        }),
      );
    },
  };
  const goal: GoalRouteHandlers = {
    handleMessage: (ws, msg) => deps.goalHandler.handleMessage(ws, msg),
  };
  const specs: SpecsRouteHandlers = {
    handleMessage: (msg) => deps.specsHandler.handleMessage(msg),
  };
  const sddBoard: SddBoardRouteHandlers = {
    handleMessage: (msg) => deps.sddBoardHandler.handleMessage(msg),
  };
  const sddWizard: SddWizardRouteHandlers = {
    handleMessage: (msg) => deps.sddWizardHandler?.handleMessage(msg) ?? Promise.resolve(),
  };

  const dispatch = createRouteFamilyDispatcher({
    routes: {
      shellGit,
      mailbox: deps.mailboxRoutes,
      mcp,
      provider,
      session,
      project,
      mode,
      prefs,
      brain,
      chimera: deps.chimeraRoutes,
      codeAssist: deps.codeAssistRoutes ?? inertCodeAssistRoutes,
      worklist,
      process: processRoutes,
      host,
      clientTransport,
      conversation: createEmbeddedConversationRoutes({
        ...deps.conversationCtx,
        withSessionTransition: sessionTransitionGate,
        promptQueueSessionsDir:
          deps.sessionCtx.opts.sessionsDir ??
          resolveWstackPaths({ projectRoot: projectRoot() }).projectSessions,
      }),
      completion,
      autonomy: createAutonomyRouteHandlers(deps.prefsCtx),
      goalSnapshot,
      goal,
      specs,
      sddBoard,
      sddWizard,
      worktree: deps.worktreeHandler,
      kanbanHost: deps.kanbanHostRoutes,
      agentRoster: {
        rosterHandler: new AgentRosterWSHandler({
          projectRoot,
          getAutoOptimizeSettings: () =>
            deps.agentConfigCtx.getConfig?.()?.fleet?.learning?.autoOptimize,
          getLlm: () => {
            const ctx = opts.agent.ctx;
            return ctx.provider && ctx.model
              ? { provider: ctx.provider, model: ctx.model }
              : undefined;
          },
          broadcast: (m) => deps.providerCtx.broadcast(m),
        }),
      },
    },
    memory: {
      getProjectRoot: projectRoot,
      getMemoryStore: () => opts.memoryStore,
      getConfig: () => deps.agentConfigCtx.getConfig?.() ?? deps.prefsCtx.configStore?.get(),
      send,
      sendResult,
    },
    content: {
      getProjectRoot: projectRoot,
      getSkillsContext: () => deps.skillsCtx,
      getPromptsContext: () => deps.promptsCtx,
      getDesignContext: (sessionId) =>
        typeof deps.designCtx === 'function' ? deps.designCtx(sessionId) : deps.designCtx,
    },
    chronicle: { getProjectRoot: projectRoot, send },
    introspection: deps.introspectionCtx,
    commands: portableCommandRoute({
      getSessionStore: () => deps.sessionCtx.opts.sessionStore,
      getProjectRoot: projectRoot,
      getContext: (sessionId) =>
        (sessionId ? deps.sessionCtx.getAgent?.(sessionId)?.ctx : undefined) ?? opts.agent.ctx,
      getConfigStore: () => deps.introspectionCtx.configStore,
      getPaths: () => resolveWstackPaths({ projectRoot: projectRoot() }),
      patchProfileConfig: deps.introspectionCtx.updateGlobalConfig
        ? (mutate) => deps.introspectionCtx.updateGlobalConfig!(mutate, 'gitid')
        : undefined,
      hostCommands: opts.hostCommands,
      getProfileConfigPath: () => opts.profileConfigPath,
      getMcpRegistry: () => opts.mcpRegistry,
      tuneup: opts.tuneupHooks,
      send,
    }),
    getKanbanContext: () => ({
      // Same root as shell, chronicle, and connections. An embedded host may
      // omit opts.projectRoot and carry the directory only on the agent.
      projectRoot: projectRoot(),
      context: opts.agent.ctx,
      broadcast: deps.providerCtx.broadcast,
      // Every board a tab is displaying is live, not just the runtime's.
      // Without this `kanban.delete` protected the leader's board alone, so
      // three of four live boards could be deleted out from under the tabs
      // showing them. This host was skipped as "single-session" when the guard
      // was added; it serves four tabs.
      getDisplayedSessionIds: () =>
        collectDisplayedSessionIds({
          getSession: () => ({ id: deps.currentSessionId() }),
          clients: deps.sessionCtx.clients as never,
        }),
      ...(opts.onKanbanDispatch ? { dispatchTask: opts.onKanbanDispatch } : {}),
    }),
    beforeDispatch: guardSession,
    onUnknown: (_ws, msg) => {
      if (!msg.type.startsWith('chronicle.'))
        console.debug(`[WebUI] Unhandled message type: ${msg.type}`);
    },
  });
  return async (ws, _client, message) => {
    if (
      await handleConnectionsHealthRoute(
        {
          getProjectRoot: projectRoot,
          getIndexDir: () =>
            typeof opts.agent.ctx.meta['codebaseIndexDir'] === 'string'
              ? opts.agent.ctx.meta['codebaseIndexDir']
              : undefined,
          send,
          backend: 'cli-embedded',
        },
        ws,
        message,
      )
    )
      return;
    if (
      await handleConnectionsServiceAction(ws, message, {
        trustBoundary: deps.trustBoundary,
        logger: deps.logger,
        getProjectRoot: projectRoot,
        getIndexDir: () =>
          typeof opts.agent.ctx.meta['codebaseIndexDir'] === 'string'
            ? opts.agent.ctx.meta['codebaseIndexDir']
            : undefined,
        send,
        backend: 'cli-embedded',
      })
    )
      return;
    if (
      await handleCodebaseIndexServerControl(ws, message, {
        trustBoundary: deps.trustBoundary,
        logger: deps.logger,
        getProjectRoot: projectRoot,
        getIndexDir: () =>
          typeof opts.agent.ctx.meta['codebaseIndexDir'] === 'string'
            ? opts.agent.ctx.meta['codebaseIndexDir']
            : undefined,
        send,
        backend: 'cli-embedded',
      })
    )
      return;
    await dispatch(ws, message);
  };
}
