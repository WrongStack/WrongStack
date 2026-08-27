/**
 * WebSocket message dispatcher for the standalone WebUI server.
 *
 * Phase 1b of the god-module split (issue: God-modules >1500 lines).
 * `startWebUI` in `./index.ts` previously inlined the entire `handleMessage`
 * function (~445 lines): the 13-route delegation prefix, the per-feature
 * handler short-circuits (worktree / collab / terminal), and the big
 * `switch (msg.type)` covering user_message, tool.confirm_result, abort,
 * tools.list, memory.*, skills.*, prompts.*, design.*, diag.get, worklist,
 * files.*, completion, stats.get, side_effects.list, process.*, webui.shutdown,
 * goal.get, autonomy.switch, and the mcp/prefs tripwire arms.
 *
 * All of that moves here. The factory returns the
 * `(ws, client, msg) => Promise<void>` dispatcher that the connection handler
 * calls after parsing + rate-limiting. Behaviour is preserved verbatim —
 * message shapes, ordering, validation, tripwire throws, and the runLock
 * guard around `agent.run` are all unchanged.
 */

import path from 'node:path';
import type { WebSocket } from 'ws';
import { AgentRosterWSHandler } from './agent-roster-handlers.js';
import type { ClientTransportRouteHandlers } from './client-transport-routes.js';
import { handleCodebaseIndexServerControl } from './codebase-index-server-control.js';
import { createToolLspCompletionSource, handleCompletionRequest } from './completion-handlers.js';
import type { CompletionRouteHandlers } from './completion-routes.js';
import { createAutoHealer } from './connections/auto-healer.js';
import {
  handleConnectionsHealthRoute,
  handleConnectionsServiceAction,
} from './connections-health-route.js';
import { createConversationOperations } from './conversation-operations.js';
import { handleGoalGet } from './goal-handlers.js';
import type { GoalSnapshotRouteHandlers } from './goal-snapshot-routes.js';
import type { HostRouteHandlers } from './host-routes.js';
import type { KanbanHostRouteHandlers } from './kanban-host-routes.js';
import { handleKanbanRoute } from './kanban-routes.js';
import { createKanbanSupervisor } from './kanban-supervisor.js';
import type { PendingConfirm } from './pending-confirms.js';
import { authorizeWebUIAction } from './privileged-actions.js';
import { handleProcessKill, handleProcessKillAll, handleProcessList } from './process-handlers.js';
import type { ProcessRouteHandlers } from './process-routes.js';
import { createRouteFamilyDispatcher } from './route-family-dispatcher.js';
import type { AllRoutes, WebuiDeps, WebuiMutableState } from './routes.js';
import { collectDisplayedSessionIds } from './session-handlers.js';
import type { ConnectedClient, WSClientMessage } from './types.js';
import { createWorklistRouteHandlers } from './worklist-routes.js';
import { createSessionAwareWorklistContext } from './worklist-session-context.js';
import { broadcast, send, sendResult } from './ws-utils.js';

/**
 * Shared run-lock control. `user_message` acquires/releases it around
 * `agent.run`. Both the dispatcher and the mutable-state wiring read through this object
 * so a second user_message while running is rejected and a project swap can
 * tear down the in-flight run.
 */
interface RunLockControl {
  /** Controller for `sessionId`, or the most-recent run when omitted. */
  get(sessionId?: string): AbortController | null;
  /**
   * Register/release the controller for `sessionId`. The sessionId argument
   * is NOT optional in practice: omitting it used to leave the host's
   * per-session map empty, which made `isRunActive(id)` report `false` for
   * every running session and let a tab switch wipe a live transcript.
   */
  set(ctrl: AbortController | null, sessionId?: string): void;
  /** Session ID that owns the most recent run, or null when idle. */
  getSession(): string | null;
  setSession(id: string | null): void;
  has(sessionId: string): boolean;
  hasAny(): boolean;
  delete(sessionId: string): void;
  /** Snapshot of every session id that currently holds a run lock. */
  sessionIds(): string[];
}
interface MessageDispatcherOptions {
  state: WebuiMutableState;
  deps: WebuiDeps;
  routes: AllRoutes;
  /** Prompt-library context ({ promptLoader, promptUsage }). */
  promptsCtx: { promptLoader: unknown; promptUsage: unknown };
  /** Codebase-indexing side-effect hook (files.write notifies the indexer). */
  codebaseIndexing: { onFileWritten: (filePath: string) => void };
  /** Shared run-lock guarding concurrent agent.run() calls. */
  runLock: RunLockControl;
  /** Pending permission confirmations — tool.confirm_result resolves one. */
  pendingConfirms: Map<string, PendingConfirm>;
  /**
   * Caller-supplied register hook. The dispatcher calls this **once** during
   * construction to hand its disposer to the caller. The caller is
   * responsible for invoking the registered disposer during its own shutdown
   * — the dispatcher itself never invokes the disposer.
   */
  onDispose?: ((disposer: () => void) => void) | undefined;
}

/**
 * Build the inbound message dispatcher. Mirrors the `handleMessage` closure
 * that lived inline in `startWebUI`. Reads live config/session/projectRoot
 * through `state` and services through `deps` — same reference semantics,
 * no behaviour change.
 */
export function createMessageDispatcher(
  opts: MessageDispatcherOptions,
): (ws: WebSocket, _client: ConnectedClient, msg: WSClientMessage) => Promise<void> {
  const { state, deps, routes, promptsCtx, codebaseIndexing, runLock, pendingConfirms } = opts;

  const worklistSessionContext = createSessionAwareWorklistContext({
    rootContext: deps.context,
    peekAgent: deps.peekAgent,
    getAgent: deps.getAgent,
    sessionsDir: deps.wpaths.projectSessions,
    send: (w, m) => send(w, m),
    broadcast: (m) => broadcast(state.getClients(), m),
  });

  function makeSkillsContext() {
    const projectRoot = state.getProjectRoot();
    return {
      skillLoader: deps.skillLoader,
      skillInstaller: deps.skillInstaller,
      projectRoot,
      projectSkillsDir: path.join(projectRoot, '.wrongstack', 'skills'),
      globalSkillsDir: deps.wpaths.globalSkills,
    };
  }

  function messageSessionId(msg: WSClientMessage): string | undefined {
    const payload = msg.payload;
    return payload &&
      typeof payload === 'object' &&
      typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined;
  }

  /**
   * Session gate mirroring conversation-operations.ts: a request that
   * explicitly targets a DIFFERENT session than the one this runtime is
   * currently on is rejected with an error frame. Both consumers of the
   * `false` return (worklist `allowMessage` and introspection
   * `sessionAllowed`) stop silently, so the frame must be sent HERE.
   * Allowed requests rebind the client so session-filtered broadcasts and
   * the onClose abort cleanup (keyed by client.sessionId) follow the
   * client's session; rejected ones must NOT rebind — the runtime never
   * switched, and a stale binding would misroute the abort.
   */
  function ensureCurrentSession(ws: WebSocket, msg: WSClientMessage, phase: string): boolean {
    const requested = messageSessionId(msg);
    const current = state.getSession().id;
    if (!requested || !current || requested === current) {
      const client = state.getClients().get(ws);
      if (client && requested) {
        client.sessionId = requested;
      }
      return true;
    }
    if (deps.hasSession?.(requested)) {
      const client = state.getClients().get(ws);
      if (client && requested) {
        client.sessionId = requested;
      }
      return true;
    }
    send(ws, {
      type: 'error',
      payload: {
        sessionId: current,
        phase,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      },
    });
    return false;
  }

  const worklistRoutes = createWorklistRouteHandlers({
    getContext: (message) => worklistSessionContext(message),
    allowMessage: (ws, msg) => ensureCurrentSession(ws, msg, msg.type),
  });
  const processRoutes: ProcessRouteHandlers = {
    list: (ws, msg) => handleProcessList(ws, msg),
    kill: (ws, msg) => handleProcessKill(ws, msg.payload, deps.trustBoundary, deps.logger),
    killAll: (ws, msg) =>
      handleProcessKillAll(ws, deps.trustBoundary, deps.logger, undefined, msg.payload),
  };
  const hostRoutes: HostRouteHandlers = {
    shutdown: async (ws) => {
      const authorization = await authorizeWebUIAction(
        deps.trustBoundary,
        {
          // 'elevated' (not 'critical') so the default compatibility trust
          // boundary allows WS-authenticated clients to shut down their own
          // agent process. 'critical' is unconditionally denied for
          // remote-client actors, which would silently break the Exit button.
          capability: 'host.shutdown',
          subject: { kind: 'process', id: String(process.pid) },
          risk: 'elevated',
          metadata: { transport: 'websocket' },
        },
        deps.logger,
      );
      if (authorization.allowed) {
        console.log('[WebUI] Shutdown requested from client');
        process.kill(process.pid, 'SIGINT');
      } else {
        sendResult(ws, false, `Shutdown denied: ${authorization.reason}`);
      }
    },
  };
  const clientTransportRoutes: ClientTransportRouteHandlers = {
    collaboration: (ws, msg) => {
      deps.collabHandler.handleMessage(ws, msg as { type: string; payload?: unknown | undefined });
    },
    terminal: (ws, msg) => {
      // Detached from the connection-lifecycle try/catch, so a rejection here
      // (e.g. authorizeWebUIAction denies) would otherwise be an unhandled
      // rejection and the client would never see terminal.exit — log it.
      void deps.terminalHandler.handleMessage(ws, msg).catch((err) => {
        console.warn(
          JSON.stringify({
            level: 'warn',
            event: 'webui.terminal_handler_failed',
            message: err instanceof Error ? err.message : String(err),
          }),
        );
      });
    },
  };
  const conversationRoutes = createConversationOperations({
    getAgent: (sessionId?: string) => deps.getAgent?.(sessionId) ?? deps.agent,
    getSessionId: () => state.getSession().id,
    withSessionTransition: state.withSessionTransition,
    hasSession: (id: string) => (deps.hasSession ? deps.hasSession(id) : false),
    runControl: {
      // The host's per-session lock map is the ONLY registry. A second
      // dispatcher-local map used to shadow it, so the host's
      // `isRunActive(sessionId)` never saw a running session.
      begin: (_ws, sessionId) => {
        const key = sessionId || state.getSession().id || '__default__';
        if (runLock.has(key)) return undefined;
        const controller = new AbortController();
        runLock.set(controller, key);
        runLock.setSession(key);
        return controller;
      },
      end: (_ws, sessionId, controller) => {
        const key = sessionId || state.getSession().id || '__default__';
        // Release only when this controller still owns the slot: a retry
        // for the same session may already have installed a newer one.
        if (runLock.get(key) === controller) runLock.set(null, key);
      },
      abort: (_ws, sessionId) => {
        if (sessionId) {
          // Session-scoped abort NEVER reaches another tab's run.
          runLock.get(sessionId)?.abort();
          runLock.set(null, sessionId);
          return;
        }
        for (const key of runLock.sessionIds()) {
          runLock.get(key)?.abort();
          runLock.set(null, key);
        }
        runLock.setSession(null);
      },
    },
    pendingConfirms,
    send,
    notifyAbort: (_ws, message) => broadcast(state.getClients(), message),
    getMaxIterations: (sessionId?: string) => {
      const meta =
        (sessionId ? deps.getAgent?.(sessionId)?.ctx.meta : undefined) ?? deps.context.meta;
      return typeof meta['maxIterations'] === 'number' ? meta['maxIterations'] : undefined;
    },
  });
  const completionRoutes: CompletionRouteHandlers = {
    request: (ws, msg) =>
      handleCompletionRequest(ws, msg, {
        projectRoot: state.getProjectRoot(),
        provider: deps.context.provider,
        model: deps.context.model,
        indexDir:
          typeof deps.context.meta['codebaseIndexDir'] === 'string'
            ? deps.context.meta['codebaseIndexDir']
            : undefined,
        lspCompletion: createToolLspCompletionSource(
          deps.toolRegistry.get('lsp_completion'),
          deps.context,
        ),
      }),
  };
  const goalSnapshotRoutes: GoalSnapshotRouteHandlers = {
    getSnapshot: () =>
      handleGoalGet(state.getProjectRoot(), (message) => broadcast(state.getClients(), message)),
  };
  const kanbanSupervisor = createKanbanSupervisor({
    projectRoot: () => state.getProjectRoot(),
    broadcast: (message: { type: string; payload: unknown }) =>
      broadcast(state.getClients(), message),
    log: (message) => deps.logger.warn?.(`[KanbanSupervisor] ${message}`),
  });
  // Opt-in server-side watchdog (env WRONGSTACK_AUTO_HEAL_SERVICES=1): reuses
  // the exact restart path behind the RotateCcw button for services stuck in
  // `error`. Disabled by default; `start()` is a no-op unless enabled.
  const autoHealer = createAutoHealer({
    projectRoot: () => state.getProjectRoot(),
    indexDir: () =>
      typeof deps.context.meta['codebaseIndexDir'] === 'string'
        ? deps.context.meta['codebaseIndexDir']
        : undefined,
    trustBoundary: deps.trustBoundary,
    logger: deps.logger,
    onStatus: (event) =>
      broadcast(state.getClients(), {
        type: 'connections.auto_heal_status',
        payload: event,
      }),
  });
  autoHealer.start();
  if (opts.onDispose) {
    const dispose = async () => {
      kanbanSupervisor.dispose();
      await autoHealer.dispose();
    };
    opts.onDispose(dispose);
  }
  const kanbanContext = () => ({
    projectRoot: state.getProjectRoot(),
    context: deps.context,
    broadcast: (message: object) => broadcast(state.getClients(), message),
    // Every board a tab is displaying is live, not just the runtime's.
    getDisplayedSessionIds: () =>
      collectDisplayedSessionIds({ getSession: state.getSession, clients: state.getClients() }),
    supervisor: kanbanSupervisor,
  });
  const kanbanHostRoutes: KanbanHostRouteHandlers = {
    meta: async (ws) => {
      const skills = deps.skillLoader
        ? (await deps.skillLoader.list()).map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
          }))
        : [];
      send(ws, {
        type: 'kanban.meta',
        payload: {
          success: true,
          data: {
            tools: deps.agent.ctx.tools.map((tool) => ({
              name: tool.name,
              description: tool.description ?? '',
            })),
            skills,
            fallbackProfiles: state.getConfig().fallbackProfiles ?? {},
            sessionProvider: deps.context.provider,
            sessionModel: deps.context.model,
          },
        },
      });
    },
    supervisorStatus: async (ws, msg) => {
      await handleKanbanRoute(ws, msg, kanbanContext());
    },
    supervisorAudit: async (ws, msg) => {
      await handleKanbanRoute(ws, msg, kanbanContext());
    },
    runStart: (ws) => {
      send(ws, {
        type: 'kanban.run.start',
        payload: {
          success: false,
          error: 'Kanban run launch is unavailable in this standalone runtime.',
        },
      });
    },
  };

  const dispatch = createRouteFamilyDispatcher({
    routes: {
      shellGit: routes.shellGitRoutes,
      mailbox: routes.mailboxRoutes,
      mcp: routes.mcpRoutes,
      provider: routes.providerRoutes,
      session: routes.sessionRoutes,
      project: routes.projectRoutes,
      mode: routes.modeRoutes,
      prefs: routes.prefsRoutes,
      brain: routes.brainRoutes,
      worklist: worklistRoutes,
      process: processRoutes,
      host: hostRoutes,
      clientTransport: clientTransportRoutes,
      conversation: conversationRoutes,
      completion: completionRoutes,
      autonomy: routes.autonomyRoutes,
      goalSnapshot: goalSnapshotRoutes,
      goal: routes.goalRoutes,
      specs: routes.specsRoutes,
      sddBoard: routes.sddBoardRoutes,
      sddWizard: routes.sddWizardRoutes,
      worktree: deps.worktreeHandler,
      kanbanHost: kanbanHostRoutes,
      agentRoster: {
        rosterHandler: new AgentRosterWSHandler({
          projectRoot: state.getProjectRoot,
          getAutoOptimizeSettings: () => state.getConfig().fleet?.learning?.autoOptimize,
          getLlm: () => {
            const ctx = deps.agent.ctx;
            return ctx.provider && ctx.model
              ? { provider: ctx.provider, model: ctx.model }
              : undefined;
          },
          broadcast: (m) => broadcast(state.getClients(), m),
        }),
      },
    },
    memory: { getMemoryStore: () => deps.memoryStore, send, sendResult },
    content: {
      getProjectRoot: state.getProjectRoot,
      getSkillsContext: makeSkillsContext,
      getPromptsContext: () => promptsCtx as never,
      getDesignContext: (sessionId) => ({
        projectRoot: state.getProjectRoot(),
        // The active kit is pinned on the picking tab's own context, the same
        // way the system-prompt variant is.
        agentMeta: (sessionId ? deps.getAgent?.(sessionId)?.ctx : undefined) ?? deps.context,
      }),
      onFileWritten: codebaseIndexing.onFileWritten,
    },
    chronicle: { getProjectRoot: state.getProjectRoot, send },
    introspection: {
      agent: deps.agent,
      // Answer `diag.get` / `stats.get` / `side_effects.list` from the agent
      // that owns the ASKING session, not the one the runtime last switched to.
      getAgent: (sessionId?: string) => deps.getAgent?.(sessionId),
      modelsRegistry: deps.modelsRegistry,
      configStore: deps.configStore,
      getConfig: state.getConfig,
      getProjectRoot: state.getProjectRoot,
      getSessionId: () => state.getSession().id,
      getSessionStartedAt: state.getSessionStartedAt,
      getModeId: state.getModeId,
      send,
      allowSessionMessage: (socket, message) => ensureCurrentSession(socket, message, message.type),
    },
    getKanbanContext: kanbanContext,
    onUnknown: (ws, msg) => {
      send(ws, {
        type: 'error',
        payload: { phase: 'handleMessage', message: `Unknown message type: ${msg.type}` },
      });
    },
  });

  return async (ws, _client, msg) => {
    if (
      await handleConnectionsHealthRoute(
        {
          getProjectRoot: state.getProjectRoot,
          getIndexDir: () =>
            typeof deps.context.meta['codebaseIndexDir'] === 'string'
              ? deps.context.meta['codebaseIndexDir']
              : undefined,
          send,
          backend: 'standalone',
        },
        ws,
        msg,
      )
    )
      return;
    // Registered here too. Only the CLI-embedded router had it, so on the
    // standalone server the browser sent `connections.service_action`, nothing
    // handled it, no `connections.service_action_result` ever came back, and
    // the Settings → Connections row sat in its pending state forever.
    if (
      await handleConnectionsServiceAction(ws, msg, {
        trustBoundary: deps.trustBoundary,
        logger: deps.logger,
        getProjectRoot: state.getProjectRoot,
        getIndexDir: () =>
          typeof deps.context.meta['codebaseIndexDir'] === 'string'
            ? deps.context.meta['codebaseIndexDir']
            : undefined,
        send,
        backend: 'standalone',
      })
    )
      return;
    if (
      await handleCodebaseIndexServerControl(ws, msg, {
        trustBoundary: deps.trustBoundary,
        logger: deps.logger,
        getProjectRoot: state.getProjectRoot,
        getIndexDir: () =>
          typeof deps.context.meta['codebaseIndexDir'] === 'string'
            ? deps.context.meta['codebaseIndexDir']
            : undefined,
        send,
        backend: 'standalone',
      })
    )
      return;
    await dispatch(ws, msg);
  };
}
