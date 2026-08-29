import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { Logger, MemoryPort, ProviderConfig } from '@wrongstack/core/types';
import type { MCPRegistry } from '@wrongstack/mcp';
import { makeProviderFromConfig } from '@wrongstack/providers';
import type { WebSocket } from 'ws';
import { AgentRosterWSHandler } from './agent-roster-handlers.js';
import { createAutonomyRouteHandlers } from './autonomy-routes.js';
import {
  type BrainHandlerContext,
  handleBrainAsk,
  handleBrainConfigGet,
  handleBrainConfigSet,
  handleBrainRisk,
  handleBrainStatus,
} from './brain-handlers.js';
import type { BrainRouteHandlers } from './brain-routes.js';
import type { ChimeraRouteHandlers } from './chimera-routes.js';
import type { ClientTransportRouteHandlers } from './client-transport-routes.js';
import { handleCodebaseIndexServerControl } from './codebase-index-server-control.js';
import { createToolLspCompletionSource, handleCompletionRequest } from './completion-handlers.js';
import type { CompletionRouteHandlers } from './completion-routes.js';
import { createAutoHealer } from './connections/auto-healer.js';
import {
  handleConnectionsHealthRoute,
  handleConnectionsServiceAction,
} from './connections-health-route.js';
import type { DesignContext } from './design-handlers.js';
import {
  applyEmbeddedModelSwitch,
  broadcastEmbeddedGoalSnapshot,
  createEmbeddedConversationRoutes,
  createEmbeddedProjectRoutes,
  createEmbeddedSessionRoutes,
  type EmbeddedAgentConfigContext,
  type EmbeddedConversationContext,
  type EmbeddedProjectContext,
  type EmbeddedProviderContext,
  type EmbeddedSessionContext,
} from './embedded-host-adapters.js';
import { emitFallbackChoice } from './fallback-choice.js';
import {
  handleGitChanges,
  handleGitCommit,
  handleGitDiff,
  handleGitDiscard,
  handleGitInfo,
  handleGitStage,
  handleGitUnstage,
} from './git-handlers.js';
import type { GoalRouteHandlers } from './goal-routes.js';
import type { GoalSnapshotRouteHandlers } from './goal-snapshot-routes.js';
import type { GoalWebSocketHandler } from './goal-ws-handler.js';
import type { HostRouteHandlers } from './host-routes.js';
import type { IntrospectionRouteContext } from './introspection-routes.js';
import type { KanbanTaskDispatcher } from './kanban-dispatch.js';
import type { KanbanHostRouteHandlers } from './kanban-host-routes.js';
import type { MailboxRouteHandlers } from './mailbox-routes.js';
import {
  handleMcpAdd,
  handleMcpDisable,
  handleMcpDiscover,
  handleMcpEnable,
  handleMcpList,
  handleMcpPromptGet,
  handleMcpPrompts,
  handleMcpRemove,
  handleMcpResourceRead,
  handleMcpResources,
  handleMcpRestart,
  handleMcpSleep,
  handleMcpUpdate,
  handleMcpWake,
} from './mcp-handlers.js';
import type { McpRouteHandlers } from './mcp-routes.js';
import { createModeRouteHandlers } from './mode-routes.js';
import { createModelOperations } from './model-operations.js';
import type { PrefsHandlerContext } from './prefs-handlers.js';
import { createPrefsRouteHandlers } from './prefs-routes.js';
import { authorizeWebUIAction } from './privileged-actions.js';
import { handleProcessKill, handleProcessKillAll, handleProcessList } from './process-handlers.js';
import type { ProcessRouteHandlers } from './process-routes.js';
import type { PromptsContext } from './prompts-handlers.js';
import { createProviderOperations } from './provider-handlers.js';
import type { ProviderRouteHandlers } from './provider-routes.js';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';
import { createRouteFamilyDispatcher } from './route-family-dispatcher.js';
import type { SddBoardRouteHandlers } from './sdd-board-routes.js';
import type { SddBoardWebSocketHandler } from './sdd-board-ws-handler.js';
import type { SddWizardRouteHandlers } from './sdd-wizard-routes.js';
import type { SddWizardWebSocketHandler } from './sdd-wizard-ws-handler.js';
import { collectDisplayedSessionIds, createSessionTransitionGate } from './session-handlers.js';
import type { ShellGitRouteHandlers } from './shell-git-routes.js';
import { handleShellOpen, normalizeShellOpenTarget, type ShellOpenTarget } from './shell-open.js';
import type { SkillsContext } from './skills-handlers.js';
import type { SpecsRouteHandlers } from './specs-routes.js';
import type { SpecsWebSocketHandler } from './specs-ws-handler.js';
import type { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import type { WSClientMessage, WSServerMessage } from './types.js';
import { createWorklistRouteHandlers } from './worklist-routes.js';
import { createSessionAwareWorklistContext } from './worklist-session-context.js';
import type { WorktreeWebSocketHandler } from './worktree-ws-handler.js';
import { messageSessionId } from './ws-utils.js';

export interface EmbeddedMessageRouterOptions {
  agent: Agent;
  projectRoot?: string | undefined;
  profileConfigPath: string;
  mcpRegistry?: MCPRegistry | undefined;
  memoryStore?: MemoryPort | undefined;
  onKanbanDispatch?: KanbanTaskDispatcher | undefined;
}

export interface EmbeddedMessageRouterDeps {
  trustBoundary: TrustBoundary;
  opts: EmbeddedMessageRouterOptions;
  logger: Logger;
  send: (ws: WebSocket, message: WSServerMessage) => void;
  sendResult: (ws: WebSocket, success: boolean, message: string) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  currentSessionId: () => string;
  shutdown: () => void;
  /**
   * Caller-supplied register hook for long-lived disposables created inside
   * the router (the auto-heal watchdog). The router hands its disposer to the
   * caller once during construction; the caller is responsible for invoking
   * it during its own shutdown — the router itself never invokes it. Mirrors
   * `MessageDispatcherOptions.onDispose` in the standalone dispatcher.
   */
  onDispose?: ((disposer: () => void | Promise<void>) => void) | undefined;
  providerCtx: EmbeddedProviderContext;
  brainCtx: BrainHandlerContext;
  introspectionCtx: IntrospectionRouteContext;
  skillsCtx: SkillsContext;
  promptsCtx: PromptsContext;
  /**
   * Built per tab: the active design kit is pinned on the picking session's
   * own meta, so the CLI host resolves that session's context here.
   */
  designCtx: DesignContext | ((sessionId?: string | undefined) => DesignContext);
  agentConfigCtx: EmbeddedAgentConfigContext;
  prefsCtx: PrefsHandlerContext;
  projectCtx: EmbeddedProjectContext;
  sessionCtx: EmbeddedSessionContext;
  conversationCtx: EmbeddedConversationContext;
  mailboxRoutes: MailboxRouteHandlers;
  /**
   * Chimera review-report routes. Optional so an older CLI host (built before
   * this family existed) can still construct the router — the tab then just
   * never receives report-list answers instead of failing to boot.
   */
  chimeraRoutes?: ChimeraRouteHandlers | undefined;
  goalHandler: GoalWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler | null;
  worktreeHandler: WorktreeWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  kanbanHostRoutes: KanbanHostRouteHandlers;
  /** Shared provider/model health tracker for the WebUI waiting-room panel.
   * Undefined when the host has not wired one (e.g. test harnesses). */
  statusTracker?: ProviderModelStatusTracker | undefined;
  /** Durable block/open audit trail (JSONL) next to the profile config.
   * Undefined when the host did not provide a profile path (test harnesses). */
  providerAuditFile?: string | undefined;
}

export type EmbeddedMessageRouter = (
  ws: WebSocket,
  client: unknown,
  message: WSClientMessage,
) => Promise<void>;

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
      const text = error instanceof Error ? error.message : String(error);
      const id = (message.payload as { id?: string } | undefined)?.id ?? '';
      send(ws, {
        type: 'terminal.output',
        payload: { id, data: `Internal terminal error: ${text}\r\n` },
      });
      send(ws, { type: 'terminal.exit', payload: { id, exitCode: -1 } });
    });
  };

  const guardedTypes = new Set([
    'user_message',
    'topic.advice',
    'abort',
    'tool.confirm_result',
    'session.new',
    'session.resume',
    'session.save',
    'session.checkpoints',
    'session.rewind',
    'context.clear',
    'context.compact',
    'context.repair',
    'context.debug',
    'context.editor.open',
    'context.editor.validate',
    'context.editor.apply',
    'context.modes.list',
    'context.mode.switch',
    'context.mode.create',
    'context.mode.update',
    'context.mode.delete',
    'todos.get',
    'todos.clear',
    'todos.remove',
    'todo.update',
    'tasks.get',
    'task.update',
    'plan.get',
    'plan.template_use',
    'plan.item.update',
  ]);
  /**
   * Can this host SERVE the named session, whichever tab is in front?
   *
   * Same rule `createEmbeddedConversationRoutes` applies: a session the
   * registry already knows, or the leader's own. `peekAgent` is non-creating,
   * so asking never materialises an agent for an id a client invented. Hosts
   * with no registry keep the strict "must be the current session" answer.
   */
  /**
   * The context that belongs to a session — the leader's when it is unknown.
   *
   * `opts.agent.ctx` is the LEADER, i.e. the boot tab's runtime. Reading it to
   * answer "this tab's" question is the single most common way a fix lands on
   * the wrong conversation once four tabs are open. `peekAgent` never creates.
   */
  const sessionContextOf = (sessionId?: string) => {
    if (!sessionId) return opts.agent.ctx;
    const peek = deps.sessionCtx.peekAgent ?? deps.conversationCtx.peekAgent;
    return (peek?.(sessionId) ?? deps.sessionCtx.getAgent?.(sessionId))?.ctx ?? opts.agent.ctx;
  };

  const canServeSession = (sessionId: string): boolean => {
    if (sessionId === opts.agent.ctx.session?.id) return true;
    const peek = deps.sessionCtx.peekAgent ?? deps.conversationCtx.peekAgent;
    // No non-creating lookup means no way to answer without materialising an
    // agent for whatever id arrived — and a stale id that materialises an agent
    // can evict a LIVE tab's. A gate must not widen past what it can verify, so
    // a host with no `peekAgent` keeps the strict answer.
    return peek ? peek(sessionId) !== undefined : false;
  };

  // `session.focus` is deliberately NOT guarded. The guard's job is to refuse
  // a request aimed at a session this runtime cannot serve — but a focus IS
  // the request to start serving it. A focus is sent after the client has
  // already moved its pointer, so both payload fields name the same session.
  // Guarding it would reject exactly the case it exists for: a page that
  // outlived its process, clicking a restored tab.
  const guardSession = (ws: WebSocket, message: WSClientMessage): boolean => {
    if (!guardedTypes.has(message.type)) return true;
    const payload = message.payload;
    const requested =
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { sessionId?: unknown }).sessionId === 'string'
        ? (payload as { sessionId: string }).sessionId
        : undefined;
    const current = deps.currentSessionId();
    if (!requested || requested === current) return true;
    // A request that TARGETS the session it is stamped with is that session
    // asking to be opened, and refusing it is refusing the only message that
    // could ever make the answer "yes".
    //
    // This is what broke Resume from the session list. The client moves its
    // foreground pointer onto the session first (the pane has to exist before
    // the transcript can land in it), so `withSession` stamps the payload with
    // the very id the resume is asking for — a session this runtime has never
    // heard of. `canServeSession` said no, the refusal came back as an error
    // frame the client discards as session-swap noise, and the tab sat there
    // empty with no transcript and no error: "Resume never resumes".
    // Scoped to `session.resume`, the only guarded type whose `id` IS a
    // session id — everywhere else `id` names a todo, a mode, a checkpoint or
    // a confirmation, and widening the exemption to those would let a stale
    // tab act on a session this host cannot serve.
    const target =
      message.type === 'session.resume' &&
      payload &&
      typeof payload === 'object' &&
      typeof (payload as { id?: unknown }).id === 'string'
        ? (payload as { id: string }).id
        : undefined;
    if (target && target === requested) return true;
    // Four tabs share one socket, so "the session the runtime is on" is only
    // ever ONE of them. Refusing every other named session turned every
    // background tab into a dead tab on this host: its `user_message`, its
    // `abort`, its answer to its OWN permission prompt and its worklist reads
    // were all rejected here, before the handlers that were carefully taught
    // to serve the asking session ever ran. The conversation routes have
    // carried this exemption since the four-tab work; the router-level gate in
    // front of them did not, which made that fix unreachable.
    if (canServeSession(requested)) return true;
    send(ws, {
      type: 'error',
      payload: deps.sessionPayload({
        phase: message.type,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };

  const mcp: McpRouteHandlers = {
    list: (ws, msg) => handleMcpList(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    // add/update are the spawn-capable pair — they take a `command`/`args`
    // from the wire and start it. They go past the trust boundary (M1).
    add: (ws, msg) =>
      handleMcpAdd(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    update: (ws, msg) =>
      handleMcpUpdate(ws, msg, opts.profileConfigPath, opts.mcpRegistry, deps.trustBoundary),
    remove: (ws, msg) => handleMcpRemove(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    enable: (ws, msg) => handleMcpEnable(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    disable: (ws, msg) => handleMcpDisable(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    sleep: (ws, msg) => handleMcpSleep(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    wake: (ws, msg) => handleMcpWake(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    restart: (ws, msg) => handleMcpRestart(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    discover: (ws, msg) => handleMcpDiscover(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    resources: (ws, msg) => handleMcpResources(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    prompts: (ws, msg) => handleMcpPrompts(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    resourceRead: (ws, msg) =>
      handleMcpResourceRead(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
    promptGet: (ws, msg) => handleMcpPromptGet(ws, msg, opts.profileConfigPath, opts.mcpRegistry),
  };

  const shellGit: ShellGitRouteHandlers = {
    gitInfo: (ws) => handleGitInfo(ws, projectRoot()),
    gitChanges: (ws) => handleGitChanges(ws, projectRoot()),
    gitDiff: (ws, msg) =>
      handleGitDiff(ws, projectRoot(), (msg.payload as { path?: string } | undefined)?.path ?? ''),
    gitStage: (ws, msg) => {
      const p = msg.payload as { paths?: string[]; path?: string } | undefined;
      const list = p?.paths ?? (p?.path ? [p.path] : []);
      return handleGitStage(ws, projectRoot(), list);
    },
    gitUnstage: (ws, msg) => {
      const p = msg.payload as { paths?: string[]; path?: string } | undefined;
      const list = p?.paths ?? (p?.path ? [p.path] : []);
      return handleGitUnstage(ws, projectRoot(), list);
    },
    gitDiscard: (ws, msg) => {
      const p = msg.payload as { paths?: string[]; path?: string } | undefined;
      const list = p?.paths ?? (p?.path ? [p.path] : []);
      return handleGitDiscard(ws, projectRoot(), list);
    },
    gitCommit: (ws, msg) => {
      const message = (msg.payload as { message?: string } | undefined)?.message ?? '';
      return handleGitCommit(ws, projectRoot(), message);
    },
    shellOpen: async (ws, msg) => {
      const payload = msg.payload as { path?: unknown; target?: unknown } | undefined;
      if (typeof payload?.path !== 'string')
        return sendResult(ws, false, 'shell.open path must be a string');
      const targets = ['file', 'file-manager', 'terminal'] as const;
      if (payload.target !== undefined && !targets.includes(payload.target as never)) {
        return sendResult(
          ws,
          false,
          `shell.open target must be one of: ${targets.join(', ')} when provided`,
        );
      }
      const target = payload.target as (typeof targets)[number] | undefined;
      // Normalize before authorization so the trust boundary audit log
      // records the same target that handleShellOpen actually executes.
      const normalizedTarget: ShellOpenTarget = normalizeShellOpenTarget(target);
      const authorization = await authorizeWebUIAction(deps.trustBoundary, {
        capability: normalizedTarget === 'terminal' ? 'process.spawn' : 'filesystem.open-native',
        subject: {
          kind: normalizedTarget === 'terminal' ? 'command' : 'path',
          id: payload.path,
          attributes: { target: normalizedTarget },
        },
        risk: 'elevated',
        cwd: projectRoot(),
        metadata: { backend: 'cli-embedded' },
      });
      if (!authorization.allowed)
        return sendResult(ws, false, `Shell action denied: ${authorization.reason}`);
      const result = await handleShellOpen(
        { path: payload.path, target: normalizedTarget },
        deps.logger,
        { projectRoot: projectRoot() },
      );
      sendResult(ws, result.success, result.message);
    },
  };

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

  const providerOperations = createProviderOperations({
    providerStore: deps.providerCtx.providerStore,
    broadcast: deps.providerCtx.broadcast,
    send: deps.providerCtx.send,
    modelsRegistry: deps.providerCtx.modelsRegistry,
    log: deps.providerCtx.log,
    hasActiveModel: () => Boolean(deps.agentConfigCtx.agent.ctx.model),
    applyModelSwitch: (providerId, modelId) =>
      applyEmbeddedModelSwitch(deps.agentConfigCtx, providerId, modelId),
  });
  const modelOperations = createModelOperations({
    context: deps.agentConfigCtx.agent.ctx,
    memoryStore: deps.agentConfigCtx.memoryStore,
    modelsRegistry: deps.agentConfigCtx.modelsRegistry,
    getConfig: () => deps.agentConfigCtx.getConfig?.(),
    getLiveProviderId: () => deps.agentConfigCtx.agent.ctx.provider.id,
    buildProvider: async (providerId) => {
      const saved = await deps.agentConfigCtx.loadSavedProviders();
      const providerCfg = saved[providerId] ?? { type: providerId };
      // WrongProxy / WrongTrace: rewrite the built provider's base URL through
      // the shared helper so the WebUI-linked helper honors the proxy toggle.
      return makeProviderFromConfig(
        providerId,
        routeProviderCfgThroughProxy(
          providerCfg,
          deps.agentConfigCtx.getConfig?.()?.baseUrl,
          providerId,
        ) as ProviderConfig,
      );
    },
    // The switch applies to the TAB that asked. Dropping the third argument
    // sent every tab's model change to the leader.
    applyModelSwitch: (providerId, modelId, sessionId) =>
      applyEmbeddedModelSwitch(
        deps.agentConfigCtx,
        providerId,
        modelId,
        sessionContextOf(sessionId),
      ),
    // Report the switch against the TAB that asked, so a "switched from X"
    // toast in tab 2 never quotes tab 3's model.
    getSessionContext: (sessionId?: string) => sessionContextOf(sessionId),
    isRunActive,
    send: deps.agentConfigCtx.send,
    broadcast: deps.providerCtx.broadcast,
    log: deps.agentConfigCtx.log,
  });
  const provider: ProviderRouteHandlers = {
    listProviders: (ws) => providerOperations.handleProvidersList(ws),
    listSavedProviders: (ws) => providerOperations.handleProvidersSaved(ws),
    listProviderModels: (ws, msg) =>
      providerOperations.handleProviderModels(
        ws,
        (msg.payload as { providerId: string }).providerId,
      ),
    searchProviderModels: (ws, query, limit) =>
      providerOperations.handleProviderModelsSearch(ws, query, limit),
    switchModel: (ws, msg) => modelOperations.switchModel(ws, msg.payload),
    refineModel: (ws, msg) => modelOperations.refineModel(ws, msg.payload as never),
    fallbackChoice: async (ws, msg) => {
      const result = emitFallbackChoice(deps.sessionCtx.opts.events, msg);
      if (!result.ok) {
        send(ws, {
          type: 'error',
          payload: { phase: 'invalid_request', message: result.message },
        });
      }
    },
    adoptDefaultProviderIfUnset: providerOperations.adoptDefaultProviderIfUnset,
    providerHandlers: providerOperations,
    statusTracker: deps.statusTracker,
    // Derived from the host profile path — no new dep threading needed.
    providerAuditFile: opts.profileConfigPath
      ? path.join(path.dirname(opts.profileConfigPath), 'provider-status-audit.jsonl')
      : undefined,
  };

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
  const brain: BrainRouteHandlers = {
    status: (ws, msg) => handleBrainStatus(deps.brainCtx, ws, messageSessionId(msg)),
    risk: (ws, msg) =>
      handleBrainRisk(
        deps.brainCtx,
        ws,
        (msg.payload as { level?: string } | undefined)?.level ?? '',
        messageSessionId(msg),
      ),
    ask: (ws, msg) =>
      handleBrainAsk(
        deps.brainCtx,
        ws,
        (msg.payload as { question?: string } | undefined)?.question,
        messageSessionId(msg),
      ),
    configGet: (ws) => handleBrainConfigGet(deps.brainCtx, ws),
    configSet: (ws, msg) =>
      handleBrainConfigSet(deps.brainCtx, ws, msg.payload, messageSessionId(msg)),
  };
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
      deps.sessionCtx.opts.sessionsDir ?? path.join(projectRoot(), '.wrongstack', 'sessions'),
    send: (ws, message) => send(ws, message as never),
    broadcast: (message) => deps.providerCtx.broadcast(message as never),
  });
  const worklist = createWorklistRouteHandlers({
    getContext: (message) => worklistSessionContext(message as never),
  });
  const processRoutes: ProcessRouteHandlers = {
    list: handleProcessList,
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
      worklist,
      process: processRoutes,
      host,
      clientTransport,
      conversation: createEmbeddedConversationRoutes({
        ...deps.conversationCtx,
        withSessionTransition: sessionTransitionGate,
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
    memory: { getMemoryStore: () => opts.memoryStore, send, sendResult },
    content: {
      getProjectRoot: projectRoot,
      getSkillsContext: () => deps.skillsCtx,
      getPromptsContext: () => deps.promptsCtx,
      getDesignContext: (sessionId) =>
        typeof deps.designCtx === 'function' ? deps.designCtx(sessionId) : deps.designCtx,
    },
    chronicle: { getProjectRoot: projectRoot, send },
    introspection: deps.introspectionCtx,
    getKanbanContext: () => ({
      projectRoot: opts.projectRoot ?? '',
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
