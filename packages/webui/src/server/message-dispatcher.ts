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
import type { WebSocket } from 'ws';

import type { AllRoutes, WebuiCallbacks, WebuiDeps, WebuiMutableState } from './routes.js';
import type { ConnectedClient, WSClientMessage } from './types.js';

import { handleAutoPhaseRoute } from './autophase-routes.js';
import { handleBrainRoute } from './brain-routes.js';
import {
  createToolLspCompletionSource,
  handleCompletionRequest,
} from './completion-handlers.js';
import {
  handleDesignList,
  handleDesignMaterialize,
  handleDesignSet,
  handleDesignState,
  handleDesignUse,
  handleDesignVerify,
} from './design-handlers.js';
import {
  handleFilesList,
  handleFilesRead,
  handleFilesTree,
  handleFilesWrite,
} from './file-handlers.js';
import { handleGoalGet } from './goal-handlers.js';
import {
  handleWorklistMessage,
  type WorklistContext,
  type WorklistMessage,
} from './handlers/index.js';
import { handleMailboxRoute } from './mailbox-routes.js';
import { handleMcpRoute } from './mcp-routes.js';
import {
  handleMemoryForget,
  handleMemoryList,
  handleMemoryRemember,
} from './memory-handlers.js';
import { handleModeRoute } from './mode-routes.js';
import { handlePrefsRoute } from './prefs-routes.js';
import {
  handleProcessKill,
  handleProcessKillAll,
  handleProcessList,
} from './process-handlers.js';
import { handleProjectRoute } from './project-routes.js';
import {
  handlePromptsContent,
  handlePromptsCreate,
  handlePromptsFavorite,
  handlePromptsList,
  handlePromptsRecent,
  handlePromptsSearch,
  handlePromptsUsed,
} from './prompts-handlers.js';
import { handleProviderRoute } from './provider-routes.js';
import {
  handleSkillsContent,
  handleSkillsCreate,
  handleSkillsEdit,
  handleSkillsExport,
  handleSkillsInstall,
  handleSkillsList,
  handleSkillsUninstall,
  handleSkillsUpdate,
} from './skills-handlers.js';
import { handleSddBoardRoute } from './sdd-board-routes.js';
import { handleSddWizardRoute } from './sdd-wizard-routes.js';
import { handleSessionRoute } from './session-routes.js';
import { handleShellGitRoute } from './shell-git-routes.js';
import { handleSpecsRoute } from './specs-routes.js';
import { computeUsageCost, getCostRates } from './usage-cost.js';
import { validateAutonomySwitchPayload } from './ws-payload-validation.js';
import { broadcast, errMessage, send, sendResult } from './ws-utils.js';

/** Decision type persisted for a pending tool.confirm_needed prompt. */
type ConfirmDecision = 'yes' | 'no' | 'always' | 'deny';

/**
 * Shared run-lock control. `user_message` acquires/releases it around
 * `agent.run`; `projects.select` aborts a stale run via `state.abortRunLock`.
 * Both the dispatcher and the mutable-state wiring read through this object
 * so a second user_message while running is rejected and a project swap can
 * tear down the in-flight run.
 */
export interface RunLockControl {
  get(): AbortController | null;
  set(ctrl: AbortController | null): void;
}

export interface MessageDispatcherOptions {
  state: WebuiMutableState;
  deps: WebuiDeps;
  cb: WebuiCallbacks;
  routes: AllRoutes;
  /** Prompt-library context ({ promptLoader, promptUsage }). */
  promptsCtx: { promptLoader: unknown; promptUsage: unknown };
  /** Codebase-indexing side-effect hook (files.write notifies the indexer). */
  codebaseIndexing: { onFileWritten: (filePath: string) => void };
  /** Shared run-lock guarding concurrent agent.run() calls. */
  runLock: RunLockControl;
  /** Pending permission confirmations — tool.confirm_result resolves one. */
  pendingConfirms: Map<string, (decision: ConfirmDecision) => void>;
}

/**
 * Build the inbound message dispatcher. Mirrors the `handleMessage` closure
 * that lived inline in `startWebUI`. Reads live config/session/projectRoot
 * through `state`, services through `deps`, and the boot-local closures
 * through `cb` — same reference semantics, no behaviour change.
 */
export function createMessageDispatcher(
  opts: MessageDispatcherOptions,
): (ws: WebSocket, _client: ConnectedClient, msg: WSClientMessage) => Promise<void> {
  const { state, deps, cb, routes, promptsCtx, codebaseIndexing, runLock, pendingConfirms } = opts;

  function makeWorklistContext(): WorklistContext {
    return {
      context: {
        todos: deps.context.todos,
        meta: deps.context.meta as Record<string, unknown>,
        session: deps.context.session ? { id: deps.context.session.id } : null,
        state: deps.context.state,
      },
      send: (w, m) => send(w, m),
      broadcast: (m) => broadcast(state.getClients(), m),
    };
  }

  function messageSessionId(msg: WSClientMessage): string | undefined {
    const payload = msg.payload;
    return payload && typeof payload === 'object' && typeof (payload as { sessionId?: unknown }).sessionId === 'string'
      ? (payload as { sessionId: string }).sessionId
      : undefined;
  }

  function sessionPayload(payload: Record<string, unknown>): Record<string, unknown> {
    const current = state.getSession().id;
    const provided = payload['sessionId'];
    const sessionId = typeof provided === 'string' && provided.length > 0 ? provided : current;
    return { ...payload, sessionId };
  }

  function ensureCurrentSession(ws: WebSocket, msg: WSClientMessage, phase: string): boolean {
    const requested = messageSessionId(msg);
    const current = state.getSession().id;
    if (!requested || requested === current) return true;
    send(ws, {
      type: 'error',
      payload: sessionPayload({
        phase,
        message: `Request targeted session ${requested}, but this WebUI runtime is currently on ${current}.`,
        requestedSessionId: requested,
      }),
    });
    return false;
  }

  return async function handleMessage(
    ws: WebSocket,
    _client: ConnectedClient,
    msg: WSClientMessage,
  ): Promise<void> {
    if (await handleProviderRoute(ws, msg, routes.providerRoutes)) return;
    if (await handleSessionRoute(ws, msg, routes.sessionRoutes)) return;
    if (await handleProjectRoute(ws, msg, routes.projectRoutes)) return;
    if (await handleModeRoute(ws, msg, routes.modeRoutes)) return;
    if (await handlePrefsRoute(ws, msg, routes.prefsRoutes)) return;
    if (await handleShellGitRoute(ws, msg, routes.shellGitRoutes)) return;
    if (await handleMailboxRoute(ws, msg, routes.mailboxRoutes)) return;
    if (await handleMcpRoute(ws, msg, routes.mcpRoutes)) return;
    if (await handleBrainRoute(ws, msg, routes.brainRoutes)) return;
    if (await handleAutoPhaseRoute(ws, msg, routes.autoPhaseRoutes)) return;
    if (await handleSpecsRoute(ws, msg, routes.specsRoutes)) return;
    if (await handleSddBoardRoute(ws, msg, routes.sddBoardRoutes)) return;
    if (await handleSddWizardRoute(ws, msg, routes.sddWizardRoutes)) return;
    if (
      msg.type.startsWith('worktree.') &&
      (await deps.worktreeHandler.handleMessage(
        msg as { type: string; payload?: Record<string, unknown> },
      ))
    )
      return;

    switch (msg.type) {
      // Collaboration messages short-circuit the user/agent flow.
      case 'collab.join':
      case 'collab.leave':
      case 'collab.annotate':
      case 'collab.resolve':
      case 'collab.request_pause':
      case 'collab.resume':
      case 'collab.grant_control':
      case 'collab.inject_tool': {
        deps.collabHandler.handleMessage(ws, msg as { type: string; payload?: unknown | undefined });
        return;
      }
      // Integrated terminal — interactive pty transport, bypasses the agent loop.
      case 'terminal.create':
      case 'terminal.input':
      case 'terminal.resize':
      case 'terminal.close': {
        deps.terminalHandler.handleMessage(ws, msg);
        return;
      }
      case 'user_message': {
        if (!ensureCurrentSession(ws, msg, 'user_message')) return;
        const content = (msg as { payload: { content: string } }).payload.content;

        // Guard against concurrent agent runs — a second user_message while
        // the agent is already processing would kick off two agent.run()
        // calls on the same shared context/agent, leading to corrupted
        // state. Reject with an inline error; the frontend should wait for
        // run.result before sending the next message.
        if (runLock.get()) {
          send(ws, {
            type: 'error',
            payload: sessionPayload({
              phase: 'user_message',
              message: 'Agent is already processing a request. Wait for the current run to finish.',
            }),
          });
          break;
        }

        const thisRun = new AbortController();
        runLock.set(thisRun);

        try {
          // Read maxIterations from context.meta so the webui settings
          // panel can adjust the cap dynamically without restarting.
          const maxIt =
            typeof deps.context.meta['maxIterations'] === 'number'
              ? deps.context.meta['maxIterations']
              : undefined;
          const result = await deps.agent.run(content, { signal: thisRun.signal, maxIterations: maxIt });
          send(ws, {
            type: 'run.result',
            payload: sessionPayload({
              status: result.status,
              iterations: result.iterations,
              finalText: result.finalText,
              error: result.error
                ? {
                    code: result.error.code,
                    message: result.error.message,
                    recoverable: result.error.recoverable,
                  }
                : undefined,
            }),
          });
        } catch (err) {
          send(ws, {
            type: 'error',
            payload: sessionPayload({
              phase: 'agent.run',
              message: errMessage(err),
            }),
          });
        } finally {
          // Only clear runLock if it's still ours — otherwise we'd wipe a
          // newer run's controller set after we returned.
          if (runLock.get() === thisRun) {
            runLock.set(null);
          }
        }
        break;
      }

      case 'tool.confirm_result': {
        if (!ensureCurrentSession(ws, msg, 'tool.confirm_result')) return;
        const { id, decision } = (
          msg as { payload: { id: string; decision: ConfirmDecision } }
        ).payload;
        const resolve = pendingConfirms.get(id);
        if (resolve) {
          pendingConfirms.delete(id);
          resolve(decision);
        }
        break;
      }

      case 'abort':
        if (!ensureCurrentSession(ws, msg, 'abort')) return;
        runLock.get()?.abort();
        broadcast(state.getClients(), {
          type: 'error',
          payload: sessionPayload({ phase: 'abort', message: 'User aborted' }),
        });
        break;

      case 'ping':
        send(ws, { type: 'pong', payload: {} });
        break;

      case 'tools.list': {
        // Full tool registry dump for the /tools inspect view.
        const list = deps.toolRegistry.list().map((t) => {
          const schema =
            (t as { inputSchema?: { properties?: Record<string, unknown> } }).inputSchema ?? {};
          const params = schema.properties ? Object.keys(schema.properties) : [];
          return {
            name: t.name,
            description: (t as { description?: string | undefined }).description ?? '',
            params,
          };
        });
        send(ws, { type: 'tools.list', payload: { tools: list } });
        break;
      }

      // ── Memory operations — delegated to shared handlers (memory-handlers.ts) ──
      case 'memory.list':
        return handleMemoryList(ws, deps.memoryStore);
      case 'memory.remember':
        return handleMemoryRemember(ws, msg, deps.memoryStore);
      case 'memory.forget':
        return handleMemoryForget(ws, msg, deps.memoryStore);

      // ── MCP tripwires — handleMcpRoute claims these upstream. ──
      case 'mcp.list':
        throw new Error('handleMcpRoute did not claim mcp.list — check chain order');
      case 'mcp.add':
        throw new Error('handleMcpRoute did not claim mcp.add — check chain order');
      case 'mcp.update':
        throw new Error('handleMcpRoute did not claim mcp.update — check chain order');
      case 'mcp.remove':
        throw new Error('handleMcpRoute did not claim mcp.remove — check chain order');
      case 'mcp.enable':
        throw new Error('handleMcpRoute did not claim mcp.enable — check chain order');
      case 'mcp.disable':
        throw new Error('handleMcpRoute did not claim mcp.disable — check chain order');
      case 'mcp.sleep':
        throw new Error('handleMcpRoute did not claim mcp.sleep — check chain order');
      case 'mcp.wake':
        throw new Error('handleMcpRoute did not claim mcp.wake — check chain order');
      case 'mcp.restart':
        throw new Error('handleMcpRoute did not claim mcp.restart — check chain order');
      case 'mcp.discover':
        throw new Error('handleMcpRoute did not claim mcp.discover — check chain order');

      // Skills — full request→response cycle lives in skills-handlers.ts.
      case 'skills.list':
        await handleSkillsList(ws, {
          skillLoader: deps.skillLoader,
          skillInstaller: deps.skillInstaller,
          projectRoot: state.getProjectRoot(),
        });
        break;
      case 'skills.content':
        await handleSkillsContent(ws, {
          skillLoader: deps.skillLoader,
          skillInstaller: deps.skillInstaller,
          projectRoot: state.getProjectRoot(),
        }, msg);
        break;
      case 'skills.install':
        await handleSkillsInstall(ws, {
          skillLoader: deps.skillLoader,
          skillInstaller: deps.skillInstaller,
          projectRoot: state.getProjectRoot(),
        }, msg);
        break;
      case 'skills.uninstall':
        await handleSkillsUninstall(ws, {
          skillLoader: deps.skillLoader,
          skillInstaller: deps.skillInstaller,
          projectRoot: state.getProjectRoot(),
        }, msg);
        break;
      case 'skills.update':
        await handleSkillsUpdate(ws, {
          skillLoader: deps.skillLoader,
          skillInstaller: deps.skillInstaller,
          projectRoot: state.getProjectRoot(),
        }, msg);
        break;
      case 'skills.create':
        await handleSkillsCreate(ws, {
          skillLoader: deps.skillLoader,
          skillInstaller: deps.skillInstaller,
          projectRoot: state.getProjectRoot(),
        }, msg);
        break;
      case 'skills.edit':
        await handleSkillsEdit(ws, {
          skillLoader: deps.skillLoader,
          skillInstaller: deps.skillInstaller,
          projectRoot: state.getProjectRoot(),
        }, msg);
        break;
      case 'skills.export':
        await handleSkillsExport(ws, {
          skillLoader: deps.skillLoader,
          skillInstaller: deps.skillInstaller,
          projectRoot: state.getProjectRoot(),
        });
        break;

      // Prompt library — shared handlers (prompts-handlers.ts).
      case 'prompts.list':
        await handlePromptsList(ws, promptsCtx as never);
        break;
      case 'prompts.search':
        await handlePromptsSearch(ws, promptsCtx as never, msg);
        break;
      case 'prompts.content':
        await handlePromptsContent(ws, promptsCtx as never, msg);
        break;
      case 'prompts.favorite':
        await handlePromptsFavorite(ws, promptsCtx as never, msg);
        break;
      case 'prompts.create':
        await handlePromptsCreate(ws, promptsCtx as never, msg);
        break;
      case 'prompts.used':
        await handlePromptsUsed(ws, promptsCtx as never, msg);
        break;
      case 'prompts.recent':
        await handlePromptsRecent(ws, promptsCtx as never);
        break;

      // Design Studio — shared handlers (design-handlers.ts).
      case 'design.list':
        await handleDesignList(ws, { projectRoot: state.getProjectRoot(), agentMeta: deps.context });
        break;
      case 'design.use':
        await handleDesignUse(ws, { projectRoot: state.getProjectRoot(), agentMeta: deps.context }, msg);
        break;
      case 'design.state':
        await handleDesignState(ws, { projectRoot: state.getProjectRoot(), agentMeta: deps.context });
        break;
      case 'design.set':
        await handleDesignSet(ws, { projectRoot: state.getProjectRoot(), agentMeta: deps.context }, msg);
        break;
      case 'design.materialize':
        await handleDesignMaterialize(ws, { projectRoot: state.getProjectRoot(), agentMeta: deps.context }, msg);
        break;
      case 'design.verify':
        await handleDesignVerify(ws, { projectRoot: state.getProjectRoot(), agentMeta: deps.context });
        break;

      case 'diag.get': {
        if (!ensureCurrentSession(ws, msg, 'diag.get')) return;
        const config = state.getConfig();
        const session = state.getSession();
        const usage = deps.tokenCounter.total();
        send(ws, {
          type: 'diag.get',
          payload: {
            provider: config.provider,
            model: config.model,
            cwd: state.getProjectRoot(),
            sessionId: session.id,
            tools: {
              count: deps.toolRegistry.list().length,
              names: deps.toolRegistry.list().map((t) => t.name),
            },
            features: {
              memory: !!config.features?.memory,
              skills: !!config.features?.skills,
              modelsRegistry: !!config.features?.modelsRegistry,
            },
            mode: state.getModeId() ?? 'default',
            usage,
            messages: deps.context.messages.length,
            todos: deps.context.todos.length,
          },
        });
        break;
      }

      // ── Worklist (todos / tasks / plan) — shared dispatcher ──
      case 'todos.get':
      case 'todos.clear':
      case 'todos.remove':
      case 'tasks.get':
      case 'plan.get':
      case 'plan.template_use':
      case 'todo.update':
      case 'task.update':
      case 'plan.item.update': {
        if (!ensureCurrentSession(ws, msg, msg.type)) return;
        await handleWorklistMessage(makeWorklistContext(), ws, msg as WorklistMessage);
        break;
      }

      // ── File operations — shared handlers (file-handlers.ts) ──
      case 'files.list':
        return handleFilesList(ws, msg, state.getProjectRoot());
      case 'files.tree':
        return handleFilesTree(ws, msg, state.getProjectRoot());
      case 'files.read':
        return handleFilesRead(ws, msg, state.getProjectRoot());
      case 'files.write':
        return handleFilesWrite(ws, msg, state.getProjectRoot(), {
          onWritten: (filePath) => codebaseIndexing.onFileWritten(filePath),
        });
      case 'completion.request':
        return handleCompletionRequest(ws, msg, {
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
        });

      case 'stats.get': {
        if (!ensureCurrentSession(ws, msg, 'stats.get')) return;
        const config = state.getConfig();
        const session = state.getSession();
        const usage = deps.tokenCounter.total();
        const cacheStats = deps.tokenCounter.cacheStats();
        const m = await deps.modelsRegistry.getModel(config.provider, config.model).catch(() => null);
        const cost = computeUsageCost(usage, getCostRates(m));
        send(ws, {
          type: 'stats.get',
          payload: {
            sessionId: session.id,
            provider: config.provider,
            model: config.model,
            usage,
            cache: cacheStats,
            cost,
            messages: deps.context.messages.length,
            readFiles: deps.context.readFiles.size,
            tools: deps.toolRegistry.list().length,
            sideEffectCount: deps.context.sideEffects?.length ?? 0,
            elapsedMs: Date.now() - state.getSessionStartedAt(),
          },
        });
        break;
      }

      case 'side_effects.list': {
        if (!ensureCurrentSession(ws, msg, 'side_effects.list')) return;
        const sideEffects = deps.context.sideEffects ?? [];
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
        break;
      }

      case 'process.list': {
        await handleProcessList(ws);
        break;
      }

      case 'process.kill': {
        await handleProcessKill(ws, msg.payload);
        break;
      }

      case 'process.killAll': {
        await handleProcessKillAll(ws);
        break;
      }

      case 'webui.shutdown': {
        // `/exit` from the client. Route through SIGINT so the registered
        // shutdown handlers (session flush, disposers, registry unregister)
        // all run.
        console.log('[WebUI] Shutdown requested from client');
        process.kill(process.pid, 'SIGINT');
        break;
      }

      case 'goal.get': {
        await handleGoalGet(state.getProjectRoot(), (m) => broadcast(state.getClients(), m));
        break;
      }

      case 'autonomy.switch': {
        const parsed = validateAutonomySwitchPayload(msg.payload);
        if (!parsed.ok) {
          sendResult(ws, false, parsed.message);
          break;
        }
        const { mode } = parsed.value;
        deps.context.meta['autonomy'] = mode;
        sendResult(ws, true, `Autonomy mode set to "${mode}"`);
        broadcast(state.getClients(), { type: 'prefs.updated', payload: { autonomy: mode } });
        void cb.persistPrefsToConfig({ autonomy: mode });
        break;
      }

      case 'prefs.update': {
        // Routed via handlePrefsRoute — tripwire for chain-order regressions.
        void ws;
        throw new Error('handlePrefsRoute did not claim prefs.update — check chain order');
      }

      case 'prefs.get': {
        // Routed via handlePrefsRoute — tripwire for chain-order regressions.
        throw new Error('handlePrefsRoute did not claim prefs.get — check chain order');
      }

      default:
        send(ws, {
          type: 'error',
          payload: { phase: 'handleMessage', message: `Unknown message type: ${msg.type}` },
        });
    }
  };
}
