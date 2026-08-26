import type { Agent } from '@wrongstack/core/agent';
import type { ProviderModelStatusTracker } from '@wrongstack/core/coordination';
import type { TrustBoundary } from '@wrongstack/core/security';
import type { Logger, MemoryPort, ProviderConfig } from '@wrongstack/core/types';
import type { MCPRegistry } from '@wrongstack/mcp';
import { makeProviderFromConfig } from '@wrongstack/providers';
import { planTool, taskTool, todoTool } from '@wrongstack/tools';
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
import type { WorklistContext } from './handlers/worklist-handlers.js';
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
import type { ShellGitRouteHandlers } from './shell-git-routes.js';
import { handleShellOpen, normalizeShellOpenTarget, type ShellOpenTarget } from './shell-open.js';
import type { SkillsContext } from './skills-handlers.js';
import type { SpecsRouteHandlers } from './specs-routes.js';
import type { SpecsWebSocketHandler } from './specs-ws-handler.js';
import type { TerminalWebSocketHandler } from './terminal-ws-handler.js';
import type { WSClientMessage, WSServerMessage } from './types.js';
import { createWorklistRouteHandlers } from './worklist-routes.js';
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
  designCtx: DesignContext;
  agentConfigCtx: EmbeddedAgentConfigContext;
  prefsCtx: PrefsHandlerContext;
  projectCtx: EmbeddedProjectContext;
  sessionCtx: EmbeddedSessionContext;
  conversationCtx: EmbeddedConversationContext;
  mailboxRoutes: MailboxRouteHandlers;
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
    applyModelSwitch: (providerId, modelId) =>
      applyEmbeddedModelSwitch(deps.agentConfigCtx, providerId, modelId),
    isRunActive: () => deps.conversationCtx.abortControllers.size > 0,
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
  };

  const session = createEmbeddedSessionRoutes({
    ...deps.sessionCtx,
    // Abort every in-flight run before a session swap — a slow provider
    // stream from the previous session would otherwise keep running in the
    // background after session.new/resume. The run's own end() cleanup
    // removes controllers from the map when it unwinds.
    abortActiveRun: (sessionId) => {
      if (sessionId && deps.conversationCtx.abortControllers.has(sessionId)) {
        deps.conversationCtx.abortControllers.get(sessionId)?.abort();
      } else {
        // Abort all — used during full session teardown or fallback when
        // sessionId does not match any entry in the map.
        // Materialize first: .abort() triggers async unwinding that
        // eventually calls end() → map.delete, which would mutate the
        // map during iteration if we iterated the live values().
        for (const controller of [...deps.conversationCtx.abortControllers.values()]) {
          controller.abort();
        }
      }
    },
    isRunActive: () => deps.conversationCtx.abortControllers.size > 0,
  });
  const project = createEmbeddedProjectRoutes(deps.projectCtx);
  const mode = createModeRouteHandlers({
    modeStore: deps.agentConfigCtx.modeStore,
    getSession: () => deps.agentConfigCtx.agent.ctx.session,
    applyModeId: (id) => {
      deps.agentConfigCtx.agent.ctx.meta['mode'] = id;
    },
    send: deps.agentConfigCtx.send,
    afterSwitch: async (id) =>
      deps.agentConfigCtx.broadcast({
        type: 'session.start',
        payload: await deps.agentConfigCtx.buildSessionStart({ mode: id }),
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
      ),
    ask: (ws, msg) =>
      handleBrainAsk(
        deps.brainCtx,
        ws,
        (msg.payload as { question?: string } | undefined)?.question,
      ),
    configGet: (ws) => handleBrainConfigGet(deps.brainCtx, ws),
    configSet: (ws, msg) => handleBrainConfigSet(deps.brainCtx, ws, msg.payload),
  };
  const worklist = createWorklistRouteHandlers({
    getContext: (): WorklistContext => ({
      context: {
        todos: opts.agent.ctx.todos,
        meta: opts.agent.ctx.meta,
        session: opts.agent.ctx.session ? { id: opts.agent.ctx.session.id } : null,
      },
      send,
      broadcast: deps.providerCtx.broadcast,
      replaceTodos: (todos) => opts.agent.ctx.state.replaceTodos(todos),
      mutateTodos: async (todos) => {
        const result = await todoTool.execute({ todos }, opts.agent.ctx, {
          signal: AbortSignal.timeout(30_000),
        });
        return {
          todos: [...opts.agent.ctx.todos],
          ...(result.kanban_warnings ? { warnings: result.kanban_warnings } : {}),
        };
      },
      mutateTaskStatus: async (id, status) =>
        taskTool.execute({ action: 'status', id, status }, opts.agent.ctx, {
          signal: AbortSignal.timeout(30_000),
        }),
      mutatePlan: async (operation) =>
        planTool.execute(operation, opts.agent.ctx, { signal: AbortSignal.timeout(30_000) }),
    }),
  });
  const processRoutes: ProcessRouteHandlers = {
    list: handleProcessList,
    kill: (ws, msg) =>
      handleProcessKill(ws, msg.payload, deps.trustBoundary, undefined, {
        backend: 'cli-embedded',
      }),
    killAll: (ws) =>
      handleProcessKillAll(ws, deps.trustBoundary, undefined, { backend: 'cli-embedded' }),
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
      worklist,
      process: processRoutes,
      host,
      clientTransport,
      conversation: createEmbeddedConversationRoutes(deps.conversationCtx),
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
      getDesignContext: () => deps.designCtx,
    },
    chronicle: { getProjectRoot: projectRoot, send },
    introspection: deps.introspectionCtx,
    getKanbanContext: () => ({
      projectRoot: opts.projectRoot ?? '',
      context: opts.agent.ctx,
      broadcast: deps.providerCtx.broadcast,
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
