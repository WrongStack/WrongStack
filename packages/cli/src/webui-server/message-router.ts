/**
 * WebSocket message router for the CLI WebUI bridge.
 *
 * A declarative route table keyed by `WSClientMessage['type']`, replacing
 * the former 112-case switch statement. Each route is a closure that calls
 * the matching `handleXxx(ctx, ws, ...)` from the shared ws-handlers groups
 * (or, for file/mcp/skills/prompts/design/shell, the handlers shared with
 * the standalone `@wrongstack/webui-server`). Prefix-based message types
 * (`autophase.*`, `specs.*`, `sdd.board.*`, `sdd.spec.*`/`sdd.run.*`,
 * `worktree.*`) fall through to their dedicated handler instance instead of
 * a route-table entry.
 *
 * `createMessageRouter(deps)` receives every per-group context object
 * already constructed by the caller (`webui-server.ts`) — it does not build
 * any wiring itself, only routes.
 *
 * PR 15 of Issue #30: extracted from `webui-server.ts`.
 */
import type { PhaseTemplate, TodoItem } from '@wrongstack/core';
import { PhaseGraphBuilder, resolveWstackPaths } from '@wrongstack/core';
import { exportBoardToTaskGraph } from '@wrongstack/kanban';
import { startSddRunFromGraph } from '@wrongstack/webui-server';
import type { KanbanRunMirror } from './kanban-run-mirror.js';
import type { KanbanSupervisor } from './kanban-supervisor.js';
import type {
  AutoPhaseWebSocketHandler,
  DesignContext,
  PromptsContext,
  SddBoardWebSocketHandler,
  SddWizardWebSocketHandler,
  SkillsContext,
  SpecsWebSocketHandler,
  TerminalWebSocketHandler,
  WorktreeWebSocketHandler,
} from '@wrongstack/webui-server';
import {
  createToolLspCompletionSource,
  handleCompletionRequest,
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignState,
  handleDesignUse,
  handleDesignVerify,
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
  handleGitChanges,
  handleGitDiff,
  handleGitInfo,
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
  handleMemoryForget,
  handleMemoryList,
  handleMemoryRemember,
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsList,
  handlePromptsRecent,
  handlePromptsSearch,
  handlePromptsUsed,
  handleShellOpen,
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsUninstall,
  handleSkillsUpdate,
} from '@wrongstack/webui-server';
import type { WebSocket } from 'ws';
import type { CliWebUIOptions, WSClientMessage, WSServerMessage } from '../webui-server.js';
import type { ConnectedClient } from './connection-handler.js';
import { consoleLogger } from './logger-shim.js';
import type {
  AgentConfigContext,
  BrainHandlerContext,
  ConnectionContext,
  ContextHandlerContext,
  IntrospectionContext,
  MailboxContext,
  PrefsContext,
  ProjectsContext,
  SessionsContext,
  WorklistContext,
  WsCommon,
  WsHandlerContext,
} from './ws-handlers/index.js';
import {
  handleAbort,
  handleAutonomySwitch,
  handleBrainAsk,
  handleBrainConfigGet,
  handleBrainConfigSet,
  handleBrainRisk,
  handleBrainStatus,
  handleContextClear,
  handleContextCompact,
  handleContextDebug,
  handleContextModeCreate,
  handleContextModeDelete,
  handleContextModeSwitch,
  handleContextModesList,
  handleContextModeUpdate,
  handleContextRepair,
  handleDiagGet,
  handleGoalGet,
  handleKeyDelete,
  handleKeySetActive,
  handleKeyUpsert,
  handleModelRefine,
  handleModelSwitch,
  handleModeSwitch,
  handleModesList,
  handleOAuthCancel,
  handleOAuthCode,
  handleOAuthStart,
  handlePing,
  handlePlanGet,
  handlePlanItemUpdate,
  handlePlanTemplateUse,
  handlePrefsGet,
  handlePrefsUpdate,
  handleProcessKill,
  handleProcessKillAll,
  adoptDefaultProviderIfUnset,
  handleProcessList,
  handleProjectsAdd,
  handleProjectsList,
  handleProjectsSelect,
  handleProviderAdd,
  handleProviderClearModels,
  handleProviderModels,
  handleProviderProbe,
  handleProviderRemove,
  handleProvidersList,
  handleProvidersSaved,
  handleProviderUndoClear,
  handleProviderUpdate,
  handleSessionCheckpoints,
  handleSessionDelete,
  handleSessionNew,
  handleSessionRename,
  handleSessionResume,
  handleSessionRewind,
  handleSessionSave,
  handleSessionsList,
  handleSkillsList,
  handleStatsGet,
  handleTasksGet,
  handleTaskUpdate,
  handleTodosClear,
  handleTodosGet,
  handleTodosRemove,
  handleTodoUpdate,
  handleToolConfirmResult,
  handleToolDisable,
  handleToolEnable,
  handleToolsList,
  handleUserMessage,
  handleWorkingDirSet,
} from './ws-handlers/index.js';
import {
  handleMailboxAgents,
  handleMailboxClear,
  handleMailboxCompact,
  handleMailboxMessages,
  handleMailboxPurge,
} from './ws-handlers/mailbox.js';

export interface MessageRouterDeps {
  opts: CliWebUIOptions;
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  sendResult: (ws: WebSocket, success: boolean, message: string) => void;
  sessionPayload: <T extends Record<string, unknown>>(payload: T) => T & { sessionId: string };
  currentSessionId: () => string;
  shutdown: () => void;

  wsHandlerCtx: WsHandlerContext;
  brainCtx: BrainHandlerContext;
  introspectionCtx: IntrospectionContext;
  skillsCtx: SkillsContext;
  promptsCtx: PromptsContext;
  designCtx: DesignContext;
  worklistCtx: WorklistContext;
  agentConfigCtx: AgentConfigContext;
  prefsCtx: PrefsContext;
  projectsCtx: ProjectsContext;
  contextHandlerCtx: ContextHandlerContext;
  wsCommon: WsCommon;
  mailboxCtx: MailboxContext;
  sessionsCtx: SessionsContext;
  connectionCtx: ConnectionContext;

  autoPhaseHandler: AutoPhaseWebSocketHandler;
  specsHandler: SpecsWebSocketHandler;
  sddBoardHandler: SddBoardWebSocketHandler;
  sddWizardHandler: SddWizardWebSocketHandler | null;
  worktreeHandler: WorktreeWebSocketHandler;
  terminalHandler: TerminalWebSocketHandler;
  /** Live run↔kanban mirror; used by kanban.run.start to bind a launched run's board. */
  kanbanRunMirror?: KanbanRunMirror | undefined;
  /** Quiet deterministic/agentic Kanban health custodian. */
  kanbanSupervisor?: KanbanSupervisor | undefined;
}

export type MessageRouter = (
  ws: WebSocket,
  client: ConnectedClient,
  msg: WSClientMessage,
) => Promise<void>;

export function createMessageRouter(deps: MessageRouterDeps): MessageRouter {
  const {
    opts,
    send,
    sendResult,
    sessionPayload,
    currentSessionId,
    shutdown,
    wsHandlerCtx,
    brainCtx,
    introspectionCtx,
    skillsCtx,
    promptsCtx,
    designCtx,
    worklistCtx,
    agentConfigCtx,
    prefsCtx,
    projectsCtx,
    contextHandlerCtx,
    wsCommon,
    mailboxCtx,
    sessionsCtx,
    connectionCtx,
    autoPhaseHandler,
    specsHandler,
    sddBoardHandler,
    sddWizardHandler,
    worktreeHandler,
  } = deps;

  type WsRouteHandler = (msg: WSClientMessage, ws: WebSocket) => void | Promise<void>;
  const noop = () => {};
  const terminalRoute: WsRouteHandler = (msg, ws) => {
    deps.terminalHandler.handleMessage(ws, msg as { type: string; payload?: unknown });
  };
  const sessionBoundRouteTypes = new Set<string>([
    'user_message',
    'abort',
    'tool.confirm_result',
    'diag.get',
    'stats.get',
    'side_effects.list',
    'session.new',
    'session.resume',
    'session.save',
    'session.checkpoints',
    'session.rewind',
    'context.clear',
    'context.compact',
    'context.repair',
    'context.debug',
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

  const requestedSessionId = (msg: WSClientMessage): string | undefined => {
    const payload = msg.payload;
    return payload &&
      typeof payload === 'object' &&
      typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined;
  };

  const ensureRouteSession = (ws: WebSocket, msg: WSClientMessage): boolean => {
    if (!sessionBoundRouteTypes.has(msg.type)) return true;
    const requested = requestedSessionId(msg);
    const current = currentSessionId();
    if (!requested || requested === current) return true;
    send(ws, {
      type: 'error',
      payload: sessionPayload({
        phase: msg.type,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  };

  const projectRootFor = () =>
    opts.projectRoot ?? (opts.agent.ctx as { projectRoot?: string }).projectRoot ?? '';

  /** Validate an `auth.oauth.*` message's `kind` field. */
  const oauthKindOf = (msg: unknown): 'chatgpt' | 'claude' | 'copilot' | null => {
    const kind = (msg as { payload?: { kind?: unknown } })?.payload?.kind;
    return kind === 'chatgpt' || kind === 'claude' || kind === 'copilot' ? kind : null;
  };

  const wsRoutes: Record<string, WsRouteHandler> = {
    // ── Core connection ──
    user_message: (msg, ws) => {
      const payload = (
        msg as {
          payload: {
            content: string;
            sessionId?: string;
            images?: Array<{ data: string; mediaType?: string; name?: string }>;
            imageBase64?: string;
          };
        }
      ).payload;
      return handleUserMessage(connectionCtx, ws, payload.content, payload.sessionId, {
        images: payload.images,
        imageBase64: payload.imageBase64,
      });
    },
    abort: (msg, ws) =>
      handleAbort(
        connectionCtx,
        ws,
        (msg as { payload?: { sessionId?: string } }).payload?.sessionId,
      ),
    ping: (_msg, ws) => handlePing(connectionCtx, ws),
    'tool.confirm_result': (msg, _ws) => {
      const { id, decision } = (
        msg as {
          payload: { id: string; decision: 'yes' | 'no' | 'always' | 'deny'; sessionId?: string };
        }
      ).payload;
      handleToolConfirmResult(
        connectionCtx,
        id,
        decision,
        (msg as { payload: { sessionId?: string } }).payload.sessionId,
      );
    },
    'webui.shutdown': () => {
      console.log('[WebUI] Shutdown requested from client');
      shutdown();
    },

    // ── Providers / keys ──
    'providers.list': (_msg, ws) => handleProvidersList(wsHandlerCtx, ws),
    'provider.models': (msg, ws) =>
      handleProviderModels(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'providers.saved': (_msg, ws) => handleProvidersSaved(wsHandlerCtx, ws),
    'key.add': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
      handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
    },
    'key.update': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string; apiKey: string } };
      handleKeyUpsert(wsHandlerCtx, ws, m.payload.providerId, m.payload.label, m.payload.apiKey);
    },
    'key.delete': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string } };
      handleKeyDelete(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
    },
    'key.set_active': (msg, ws) => {
      const m = msg as { payload: { providerId: string; label: string } };
      handleKeySetActive(wsHandlerCtx, ws, m.payload.providerId, m.payload.label);
    },
    'provider.add': async (msg, ws) => {
      const payload = (
        msg as { payload: { id: string; family: string; baseUrl?: string; apiKey?: string } }
      ).payload;
      await handleProviderAdd(wsHandlerCtx, ws, payload);
      // Adopt the just-added provider as the live default when the agent has
      // no usable model yet — parity with the boot auto-select so the first
      // provider added in the WebUI is immediately usable, not blank.
      await adoptDefaultProviderIfUnset(agentConfigCtx, wsHandlerCtx, payload.id);
    },
    'provider.remove': (msg, ws) =>
      handleProviderRemove(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'provider.clear_models': (msg, ws) =>
      handleProviderClearModels(
        wsHandlerCtx,
        ws,
        (msg as { payload: { providerId: string } }).payload.providerId,
      ),
    'provider.undo_clear': (msg, ws) => {
      const m = msg as { payload: { providerId: string; previousModels: string[] } };
      handleProviderUndoClear(wsHandlerCtx, ws, m.payload.providerId, m.payload.previousModels);
    },
    'provider.update': (msg, ws) =>
      handleProviderUpdate(
        wsHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              family?: string;
              baseUrl?: string;
              envVars?: string[];
              models?: string[];
            };
          }
        ).payload,
      ),
    'provider.probe': (msg, ws) => {
      const m = msg as { payload: { providerId: string; timeoutMs?: number } };
      handleProviderProbe(wsHandlerCtx, ws, m.payload.providerId, m.payload.timeoutMs);
    },

    // ── Subscription OAuth login (ChatGPT / Claude / Copilot) ──
    'auth.oauth.start': (msg, ws) => {
      const kind = oauthKindOf(msg);
      if (kind) void handleOAuthStart(wsHandlerCtx, ws, kind);
    },
    'auth.oauth.code': (msg, ws) => {
      const kind = oauthKindOf(msg);
      const input = (msg as { payload?: { input?: unknown } }).payload?.input;
      if (kind && typeof input === 'string' && input.trim()) {
        void handleOAuthCode(wsHandlerCtx, ws, kind, input);
      }
    },
    'auth.oauth.cancel': (msg, ws) => {
      const kind = oauthKindOf(msg);
      if (kind) handleOAuthCancel(wsHandlerCtx, ws, kind);
    },

    // ── Todos / goals / plans / tasks ──
    'todos.get': (_msg, ws) => handleTodosGet(worklistCtx, ws),
    'todos.clear': (_msg, ws) => handleTodosClear(worklistCtx, ws),
    'todos.remove': (msg, ws) =>
      handleTodosRemove(
        worklistCtx,
        ws,
        msg.payload as { id?: string; index?: number } | undefined,
      ),
    'todo.update': (msg, ws) =>
      handleTodoUpdate(
        worklistCtx,
        ws,
        msg.payload as { id: string; status?: TodoItem['status']; activeForm?: string },
      ),
    'goal.get': (_msg, ws) => handleGoalGet(sessionsCtx, ws),
    'plan.get': (_msg, ws) => handlePlanGet(worklistCtx, ws),
    'plan.template_use': (msg, ws) =>
      handlePlanTemplateUse(
        worklistCtx,
        ws,
        (msg as { payload: { template: string } }).payload.template,
      ),
    'plan.item.update': (msg, ws) =>
      handlePlanItemUpdate(
        worklistCtx,
        ws,
        msg.payload as { target: string; status: 'open' | 'in_progress' | 'done' },
      ),
    'tasks.get': (_msg, ws) => handleTasksGet(worklistCtx, ws),
    'task.update': (msg, ws) =>
      handleTaskUpdate(
        worklistCtx,
        ws,
        msg.payload as {
          id: string;
          status: 'pending' | 'in_progress' | 'blocked' | 'failed' | 'review' | 'completed';
        },
      ),

    // ── Sessions ──
    'sessions.list': (msg, ws) =>
      handleSessionsList(
        sessionsCtx,
        ws,
        (msg as { payload?: { limit?: number } }).payload?.limit ?? 50,
      ),
    'session.new': (_msg, ws) => handleSessionNew(sessionsCtx, ws),
    'session.rename': (msg, ws) =>
      handleSessionRename(
        sessionsCtx,
        ws,
        (msg as { payload: { id: string; name?: string } }).payload.id,
        (msg as { payload: { id: string; name?: string } }).payload.name ?? '',
      ),
    'session.delete': (msg, ws) =>
      handleSessionDelete(sessionsCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'session.save': (_msg, ws) => handleSessionSave(sessionsCtx, ws),
    'session.resume': (msg, ws) =>
      handleSessionResume(sessionsCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'session.checkpoints': (_msg, ws) => handleSessionCheckpoints(sessionsCtx, ws),
    'session.rewind': (msg, ws) =>
      handleSessionRewind(
        sessionsCtx,
        ws,
        (msg as { payload: { checkpointIndex: number } }).payload.checkpointIndex,
      ),

    // ── Context ──
    'context.clear': (_msg, ws) => handleContextClear(contextHandlerCtx, ws),
    'context.debug': (_msg, ws) => handleContextDebug(contextHandlerCtx, ws),
    'context.compact': (msg, ws) =>
      handleContextCompact(
        contextHandlerCtx,
        ws,
        !!(msg as { payload?: { aggressive?: boolean } }).payload?.aggressive,
      ),
    'context.repair': (_msg, ws) => handleContextRepair(contextHandlerCtx, ws),
    'context.modes.list': (_msg, ws) => handleContextModesList(contextHandlerCtx, ws),
    'context.mode.switch': (msg, ws) =>
      handleContextModeSwitch(
        contextHandlerCtx,
        ws,
        (msg as { payload: { id: string } }).payload.id,
      ),
    'context.mode.create': (msg, ws) =>
      handleContextModeCreate(
        contextHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              name: string;
              description: string;
              thresholds: { warn: number; soft: number; hard: number };
              preserveK: number;
              eliseThreshold: number;
            };
          }
        ).payload,
      ),
    'context.mode.update': (msg, ws) =>
      handleContextModeUpdate(
        contextHandlerCtx,
        ws,
        (
          msg as {
            payload: {
              id: string;
              name?: string;
              description?: string;
              thresholds?: { warn?: number; soft?: number; hard?: number };
              preserveK?: number;
              eliseThreshold?: number;
            };
          }
        ).payload,
      ),
    'context.mode.delete': (msg, ws) =>
      handleContextModeDelete(
        contextHandlerCtx,
        ws,
        (msg as { payload: { id: string } }).payload.id,
      ),

    // ── Agent config: modes / models ──
    'modes.list': (_msg, ws) => handleModesList(agentConfigCtx, ws),
    'mode.switch': (msg, ws) =>
      handleModeSwitch(agentConfigCtx, ws, (msg as { payload: { id: string } }).payload.id),
    'model.switch': (msg, ws) =>
      handleModelSwitch(
        agentConfigCtx,
        ws,
        (msg as { payload: { provider: string; model: string } }).payload,
      ),
    'model.refine': (msg, ws) =>
      handleModelRefine(
        agentConfigCtx,
        ws,
        (
          msg as {
            payload: {
              text: string;
              timeoutMs?: number;
              provider?: string;
              model?: string;
            };
          }
        ).payload,
      ),

    // ── Process management ──
    'process.list': (_msg, ws) => handleProcessList(wsCommon, ws),
    'process.kill': (msg, ws) =>
      handleProcessKill(wsCommon, ws, (msg as { payload: { pid: number } }).payload.pid),
    'process.killAll': (_msg, ws) => handleProcessKillAll(wsCommon, ws),

    // ── Diagnostics / introspection ──
    'diag.get': (_msg, ws) => handleDiagGet(introspectionCtx, ws),
    'stats.get': (_msg, ws) => handleStatsGet(introspectionCtx, ws),
    'side_effects.list': (_msg, ws) => {
      const sideEffects = opts.agent.ctx.sideEffects ?? [];
      send(ws, {
        type: 'side_effects',
        payload: sessionPayload({
          sideEffects: sideEffects.slice(-50).map((se) => ({
            toolUseId: se.toolUseId,
            toolName: se.toolName,
            ts: se.ts,
            input: se.input,
            outcome: se.outcome,
            risk: se.risk,
          })),
        }),
      });
    },
    'tools.list': (_msg, ws) => handleToolsList(introspectionCtx, ws),
    'tool.disable': (msg, ws) => handleToolDisable(introspectionCtx, ws, msg.payload),
    'tool.enable': (msg, ws) => handleToolEnable(introspectionCtx, ws, msg.payload),

    // ── Kanban inspector metadata (quiet — unlike tools.list it does NOT
    //    print to chat). Feeds the task inspector's real tool picker and the
    //    live session provider/model so nothing has to be typed by hand. ──
    'kanban.meta': async (_msg, ws) => {
      const tools = (opts.agent.ctx.tools ?? []).map((tool) => ({
        name: tool.name,
        description: (tool as { description?: string }).description ?? '',
      }));
      const skills = opts.skillLoader
        ? (await opts.skillLoader.list()).map((skill) => ({
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
            tools,
            skills,
            fallbackProfiles: opts.appConfig?.fallbackProfiles ?? {},
            sessionProvider: opts.agent.ctx.provider,
            sessionModel: opts.agent.ctx.model,
          },
        },
      });
    },
    'kanban.supervisor.status': async (msg, ws) => {
      const boardId = (msg.payload as { boardId?: string } | undefined)?.boardId;
      if (!boardId || !deps.kanbanSupervisor) {
        send(ws, {
          type: 'kanban.supervisor.status',
          payload: { success: false, error: 'Kanban supervisor is unavailable.' },
        });
        return;
      }
      const snapshot =
        deps.kanbanSupervisor.getSnapshot(boardId) ??
        (await deps.kanbanSupervisor.auditNow(boardId))[0];
      send(ws, {
        type: 'kanban.supervisor.status',
        payload: { success: true, data: snapshot ?? null },
      });
    },
    'kanban.supervisor.audit': async (msg, ws) => {
      const boardId = (msg.payload as { boardId?: string } | undefined)?.boardId;
      if (!deps.kanbanSupervisor) {
        send(ws, {
          type: 'kanban.supervisor.audit',
          payload: { success: false, error: 'Kanban supervisor is unavailable.' },
        });
        return;
      }
      const snapshots = await deps.kanbanSupervisor.auditNow(boardId);
      send(ws, {
        type: 'kanban.supervisor.audit',
        payload: { success: true, data: boardId ? (snapshots[0] ?? null) : snapshots },
      });
    },

    // ── Launch a run FROM a kanban board (phase 4). AutoPhase runs in-process
    //    here; the mirror binds the launched run back to the SAME board so it
    //    updates live. SDD launch is deferred (needs the CLI run-start machinery)
    //    — SDD runs started via /sdd still mirror + are controllable here. ──
    'kanban.run.start': async (msg, ws) => {
      const p = (msg.payload ?? {}) as {
        boardId?: string;
        engine?: string;
        autonomous?: boolean;
      };
      const boardId = p.boardId;
      const engine = p.engine === 'autophase' ? 'autophase' : p.engine === 'sdd' ? 'sdd' : undefined;
      const projectRoot = opts.projectRoot ?? '';
      const failRun = (error: string) =>
        send(ws, { type: 'kanban.run.start', payload: { success: false, error } });
      if (!boardId || !engine) return failRun('boardId and engine required');
      if (!projectRoot) return failRun('No project root');
      try {
        const exported = await exportBoardToTaskGraph(projectRoot, boardId, {
          preserveOriginTaskIds: true,
        });
        if (!exported) return failRun(`Board not found: ${boardId}`);
        if (exported.graph.nodes.size === 0) return failRun('Board has no tasks to run');
        if (engine === 'autophase') {
          const pg = await PhaseGraphBuilder.fromTaskGraph(exported.graph, {
            title: exported.board.title,
            description: exported.board.description ?? exported.board.title,
          });
          const phases: PhaseTemplate[] = Array.from(pg.phases.values()).map((ph) => ({
            name: ph.name,
            description: ph.description,
            priority: ph.priority,
            estimateHours: ph.estimateHours,
            parallelizable: ph.parallelizable,
            taskTemplates: Array.from(ph.taskGraph.nodes.values()).map((t) => ({
              title: t.title,
              description: t.description,
              type: t.type,
              priority: t.priority,
              estimateHours: t.estimateHours ?? 0,
              ...(t.tags ? { tags: t.tags } : {}),
            })),
          }));
          // The run mirrors into a FRESH live board (reusing this hand-built
          // board would duplicate tasks — its cards have no run `origin` to
          // reconcile against). This board stays as the recipe.
          await autoPhaseHandler.handleMessage({
            type: 'autophase.start',
            payload: { title: exported.board.title, phases, autonomous: p.autonomous ?? false },
          });
          send(ws, {
            type: 'kanban.run.start',
            payload: { success: true, data: { engine: 'autophase', boardId } },
          });
          return;
        }
        // engine === 'sdd'
        if (!opts.sddSubagentFactory) {
          return failRun('SDD runs need the multi-agent host, which is not available here.');
        }
        const paths = resolveWstackPaths({ projectRoot });
        const handle = startSddRunFromGraph(
          exported.graph,
          {
            agent: opts.agent,
            events: opts.events,
            projectRoot,
            subagentFactory: opts.sddSubagentFactory,
            projectSddBoards: paths.projectSddBoards,
            ...(opts.brain ? { brain: opts.brain } : {}),
          },
          { worktrees: true },
        );
        void handle.completion.catch(() => {});
        send(ws, {
          type: 'kanban.run.start',
          payload: { success: true, data: { engine: 'sdd', boardId, runId: handle.runId } },
        });
      } catch (err) {
        failRun(err instanceof Error ? err.message : String(err));
      }
    },

    // ── Autonomy ──
    'autonomy.switch': (msg, ws) =>
      handleAutonomySwitch(prefsCtx, ws, (msg as { payload: { mode: string } }).payload.mode),

    // ── Brain ──
    'brain.status': (_msg, ws) => handleBrainStatus(brainCtx, ws),
    'brain.risk': (msg, ws) =>
      handleBrainRisk(brainCtx, ws, (msg as { payload?: { level?: string } }).payload?.level ?? ''),
    'brain.ask': (msg, ws) =>
      handleBrainAsk(brainCtx, ws, (msg as { payload?: { question?: string } }).payload?.question),
    'brain.config.get': (_msg, ws) => handleBrainConfigGet(brainCtx, ws),
    'brain.config.set': (msg, ws) =>
      handleBrainConfigSet(brainCtx, ws, (msg as { payload?: unknown }).payload),

    // ── Preferences ──
    'prefs.get': (_msg, ws) => handlePrefsGet(prefsCtx, ws),
    'prefs.update': (msg, ws) =>
      handlePrefsUpdate(prefsCtx, ws, (msg as { payload: Record<string, unknown> }).payload),

    // ── File operations (delegated to shared file-handlers.ts) ──
    'files.list': (msg, ws) => handleFilesList(ws, msg, projectRootFor()),
    'files.tree': (msg, ws) => handleFilesTree(ws, msg, projectRootFor()),
    'files.read': (msg, ws) => handleFilesRead(ws, msg, projectRootFor()),
    'files.write': (msg, ws) => handleFilesWrite(ws, msg, projectRootFor()),
    'completion.request': (msg, ws) =>
      handleCompletionRequest(ws, msg, {
        projectRoot: projectRootFor(),
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

    // ── Memory (guarded — opts.memoryStore may be undefined) ──
    'memory.list': (_msg, ws) => {
      if (!opts.memoryStore) {
        send(ws, {
          type: 'memory.list',
          payload: { text: '', error: 'Memory store not available' },
        });
        return;
      }
      return handleMemoryList(ws, opts.memoryStore);
    },
    'memory.remember': (msg, ws) => {
      if (!opts.memoryStore) {
        sendResult(ws, false, 'Memory store not available');
        return;
      }
      return handleMemoryRemember(ws, msg, opts.memoryStore);
    },
    'memory.forget': (msg, ws) => {
      if (!opts.memoryStore) {
        sendResult(ws, false, 'Memory store not available');
        return;
      }
      return handleMemoryForget(ws, msg, opts.memoryStore);
    },

    // ── MCP operations (shared handlers from @wrongstack/webui-server) ──
    'mcp.list': (msg, ws) => handleMcpList(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.add': (msg, ws) => handleMcpAdd(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.remove': (msg, ws) =>
      handleMcpRemove(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.update': (msg, ws) =>
      handleMcpUpdate(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.wake': (msg, ws) => handleMcpWake(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.sleep': (msg, ws) =>
      handleMcpSleep(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.discover': (msg, ws) =>
      handleMcpDiscover(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.enable': (msg, ws) =>
      handleMcpEnable(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.disable': (msg, ws) =>
      handleMcpDisable(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.restart': (msg, ws) =>
      handleMcpRestart(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.resources': (msg, ws) =>
      handleMcpResources(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.prompts': (msg, ws) =>
      handleMcpPrompts(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.resource.read': (msg, ws) =>
      handleMcpResourceRead(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),
    'mcp.prompt.get': (msg, ws) =>
      handleMcpPromptGet(ws, msg, opts.globalConfigPath ?? '', opts.mcpRegistry),

    // ── Skills ──
    'skills.list': (_msg, ws) => handleSkillsList(introspectionCtx, ws),
    'skills.content': (msg, ws) => handleSkillsContent(ws, skillsCtx, msg),
    'skills.install': (msg, ws) => handleSkillsInstall(ws, skillsCtx, msg),
    'skills.uninstall': (msg, ws) => handleSkillsUninstall(ws, skillsCtx, msg),
    'skills.update': (msg, ws) => handleSkillsUpdate(ws, skillsCtx, msg),
    'skills.create': (msg, ws) => handleSkillsCreate(ws, skillsCtx, msg),
    'skills.edit': (msg, ws) => handleSkillsEdit(ws, skillsCtx, msg),
    'skills.export': (_msg, ws) => handleSkillsExport(ws, skillsCtx),

    // ── Prompt library ──
    'prompts.list': (_msg, ws) => handlePromptsList(ws, promptsCtx),
    'prompts.search': (msg, ws) => handlePromptsSearch(ws, promptsCtx, msg),
    'prompts.content': (msg, ws) => handlePromptsContent(ws, promptsCtx, msg),
    'prompts.favorite': (msg, ws) => handlePromptsFavorite(ws, promptsCtx, msg),
    'prompts.create': (msg, ws) => handlePromptsCreate(ws, promptsCtx, msg),
    'prompts.used': (msg, ws) => handlePromptsUsed(ws, promptsCtx, msg),
    'prompts.recent': (_msg, ws) => handlePromptsRecent(ws, promptsCtx),

    // ── Design Studio ──
    'design.list': (_msg, ws) => handleDesignList(ws, designCtx),
    'design.use': (msg, ws) => handleDesignUse(ws, designCtx, msg),
    'design.state': (_msg, ws) => handleDesignState(ws, designCtx),
    'design.set': (msg, ws) => handleDesignSet(ws, designCtx, msg),
    'design.materialize': (msg, ws) => handleDesignMaterialize(ws, designCtx, msg),
    'design.verify': (_msg, ws) => handleDesignVerify(ws, designCtx),

    // ── Projects / working dir ──
    'projects.list': (_msg, ws) => handleProjectsList(projectsCtx, ws),
    'projects.select': (msg, ws) =>
      handleProjectsSelect(
        projectsCtx,
        ws,
        (msg as { payload: { root: string; name?: string } }).payload,
      ),
    'projects.add': (msg, ws) =>
      handleProjectsAdd(
        projectsCtx,
        ws,
        (msg as { payload: { root: string; name?: string } }).payload,
      ),
    'working_dir.set': (msg, ws) =>
      handleWorkingDirSet(projectsCtx, ws, (msg as { payload: { path: string } }).payload.path),

    // ── Git ──
    'git.changes': (_msg, ws) => handleGitChanges(ws, projectRootFor()),
    'git.diff': (msg, ws) =>
      handleGitDiff(
        ws,
        projectRootFor(),
        (msg as { payload?: { path?: string } }).payload?.path ?? '',
      ),
    'git.info': (_msg, ws) => handleGitInfo(ws, projectRootFor()),

    // ── Shell ──
    'shell.open': async (msg, ws) => {
      const result = await handleShellOpen(
        msg.payload as Parameters<typeof handleShellOpen>[0],
        consoleLogger,
      );
      sendResult(ws, result.success, result.message);
    },

    // ── Mailbox ──
    'mailbox.messages': (msg, ws) =>
      handleMailboxMessages(mailboxCtx, msg as Parameters<typeof handleMailboxMessages>[1], ws),
    'mailbox.agents': (msg, ws) =>
      handleMailboxAgents(mailboxCtx, msg as Parameters<typeof handleMailboxAgents>[1], ws),
    'mailbox.clear': (_msg, ws) => handleMailboxClear(mailboxCtx, ws),
    'mailbox.purge': (msg, ws) =>
      handleMailboxPurge(mailboxCtx, msg as Parameters<typeof handleMailboxPurge>[1], ws),
    'mailbox.compact': (msg, ws) =>
      handleMailboxCompact(mailboxCtx, msg as Parameters<typeof handleMailboxCompact>[1], ws),

    // ── Silent no-ops (standalone server wires real handlers) ──
    'collab.join': noop,
    'collab.leave': noop,
    'collab.annotate': noop,
    'collab.resolve': noop,
    'collab.request_pause': noop,
    'collab.resume': noop,
    'collab.grant_control': noop,
    'collab.inject_tool': noop,
    // Integrated terminal — the shared per-client node-pty transport
    // (clients are registered by the connection handler on connect).
    'terminal.create': terminalRoute,
    'terminal.input': terminalRoute,
    'terminal.resize': terminalRoute,
    'terminal.close': terminalRoute,
  };

  return async function handleMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    if (!ensureRouteSession(ws, msg)) return;
    const handler = wsRoutes[msg.type];
    if (handler) {
      await handler(msg, ws);
      return;
    }
    // ── Prefix-based fallback for delegated handlers ──
    const msgType = (msg as { type: string }).type;
    if (msgType.startsWith('autophase.')) {
      await autoPhaseHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('specs.')) {
      await specsHandler.handleMessage(msg as { type: string; payload?: Record<string, unknown> });
    } else if (msgType.startsWith('sdd.board.')) {
      await sddBoardHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('sdd.spec.') || msgType.startsWith('sdd.run.')) {
      await sddWizardHandler?.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('worktree.')) {
      await worktreeHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else if (msgType.startsWith('kanban.')) {
      const { handleKanbanMessage } = await import('./ws-handlers/kanban.js');
      type KContext = import('./ws-handlers/kanban.js').KanbanContext;
      const kanbanCtx: KContext = {
        send,
        broadcast: deps.wsCommon?.broadcast ?? (() => {}),
        log: (msg: string) => consoleLogger.info(msg),
        projectRoot: deps.opts.projectRoot ?? '',
        sessionContext: deps.worklistCtx.agent.ctx,
        ...(deps.opts.onKanbanDispatch ? { dispatchTask: deps.opts.onKanbanDispatch } : {}),
      };
      await handleKanbanMessage(
        kanbanCtx,
        ws,
        msg as { type: string; payload?: Record<string, unknown> },
      );
    } else {
      console.debug(`[WebUI] Unhandled message type: ${msgType}`);
    }
  };
}
