import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { Agent } from '@wrongstack/core/agent';
import { TOKENS, type EventBus } from '@wrongstack/core/kernel';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import type {
  Config,
  MemoryPort,
  ModelsRegistry,
  ModeStore,
  ProviderConfig,
  SessionStore,
  SessionWriter,
} from '@wrongstack/core/types';
import { toErrorMessage, wstackGlobalRoot } from '@wrongstack/core/utils';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';
import { makeProviderFromConfig } from '@wrongstack/providers';
import type { WebSocket } from 'ws';
import { createConversationOperations } from './conversation-operations.js';
import type { ConversationRouteHandlers } from './conversation-routes.js';
import type { CustomModeStore } from './custom-context-modes.js';
import type { PendingConfirm } from './pending-confirms.js';
import { createProjectHandlers } from './project-handlers.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import { createProviderOperations } from './provider-handlers.js';
import { createSessionHandlers } from './session-handlers.js';
import type { SessionRouteHandlers } from './session-routes.js';
import type { SessionIdentityTarget } from './standalone-session-identity.js';
import type { WSServerMessage } from './types.js';

export interface EmbeddedHostTransport {
  send: (ws: WebSocket, message: WSServerMessage) => void;
  broadcast: (message: WSServerMessage) => void;
  log: (message: string) => void;
}

export interface EmbeddedProviderStore {
  load(): Promise<Record<string, ProviderConfig>>;
  save(providers: Record<string, ProviderConfig>): Promise<void>;
}

export interface EmbeddedProviderContext extends EmbeddedHostTransport {
  providerStore: EmbeddedProviderStore;
  modelsRegistry: ModelsRegistry | undefined;
}

export interface EmbeddedAgentConfigContext extends EmbeddedHostTransport {
  agent: Agent;
  modeStore: ModeStore | undefined;
  buildSessionStart: (overrides?: Record<string, unknown>) => Promise<unknown>;
  loadSavedProviders: () => Promise<Record<string, ProviderConfig>>;
  modelsRegistry?: ModelsRegistry | undefined;
  memoryStore?: MemoryPort | undefined;
  getConfig?: (() => Config | undefined) | undefined;
  onMaxContextResolved?:
    | ((providerId: string, modelId: string, maxContext: number) => void)
    | undefined;
  persistPrefs?: ((payload: Record<string, unknown>) => Promise<void>) | undefined;
}

export async function applyEmbeddedModelSwitch(
  ctx: EmbeddedAgentConfigContext,
  providerId: string,
  modelId: string,
): Promise<void> {
  const agentContext = ctx.agent.ctx;
  await agentContext.runModelTransition(async () => {
    const saved = await ctx.loadSavedProviders();
    const providerConfig = saved[providerId] ?? { type: providerId };
    // WrongProxy / WrongTrace: rewrite the switched provider's base URL through
    // the shared helper so the embedded WebUI honors the proxy toggle, same as
    // the other WebUI provider-build paths. The live config's top-level baseUrl
    // is the fallback when the saved cfg carries no explicit one.
    const routedConfig = routeProviderCfgThroughProxy(
      providerConfig,
      ctx.getConfig?.()?.baseUrl,
      providerId,
    );
    const nextProvider = makeProviderFromConfig(providerId, routedConfig);
    await ctx.modelsRegistry?.refresh().catch((error) => {
      ctx.log(
        JSON.stringify({
          level: 'warn',
          event: 'models.refresh_failed',
          provider: providerId,
          model: modelId,
          message: toErrorMessage(error),
          timestamp: new Date().toISOString(),
        }),
      );
    });
    const catalogId =
      providerConfig.type && providerConfig.type !== providerId ? providerConfig.type : providerId;
    const resolved = await ctx.modelsRegistry?.getModel(catalogId, modelId).catch(() => undefined);
    const maxContext = resolved?.capabilities.maxContext ?? nextProvider.capabilities.maxContext;
    nextProvider.capabilities.maxContext = maxContext;
    await ctx.persistPrefs?.({ provider: providerId, model: modelId });

    agentContext.provider = nextProvider;
    agentContext.model = modelId;
    if (ctx.onMaxContextResolved) ctx.onMaxContextResolved(providerId, modelId, maxContext);
    else {
      if (maxContext > 0) agentContext.meta['effectiveMaxContext'] = maxContext;
      else delete agentContext.meta['effectiveMaxContext'];
      ctx.broadcast({
        type: 'ctx.max_context',
        payload: {
          sessionId: agentContext.session.id,
          providerId,
          modelId,
          maxContext,
        },
      });
    }
    ctx.broadcast({ type: 'session.start', payload: await ctx.buildSessionStart() });
  });
}

export function createEmbeddedProviderOperations(ctx: EmbeddedProviderContext) {
  return createProviderOperations({
    providerStore: ctx.providerStore,
    broadcast: ctx.broadcast,
    send: ctx.send,
    modelsRegistry: ctx.modelsRegistry,
    log: ctx.log,
  });
}

export interface EmbeddedConversationContext extends EmbeddedHostTransport {
  agent: Agent;
  /** Session-keyed abort controllers — one active run per session. */
  abortControllers: Map<string, AbortController>;
  pendingConfirms: Map<string, PendingConfirm>;
}

export function createEmbeddedConversationRoutes(
  ctx: EmbeddedConversationContext,
): ConversationRouteHandlers {
  return createConversationOperations({
    getAgent: () => ctx.agent,
    getSessionId: () => ctx.agent.ctx.session?.id ?? '',
    runControl: {
      begin: (_ws, sessionId) => {
        if (ctx.abortControllers.has(sessionId)) return undefined;
        const controller = new AbortController();
        ctx.abortControllers.set(sessionId, controller);
        return controller;
      },
      end: (_ws, sessionId, controller) => {
        if (ctx.abortControllers.get(sessionId) === controller)
          ctx.abortControllers.delete(sessionId);
      },
      abort: (_ws, sessionId) => ctx.abortControllers.get(sessionId)?.abort(),
    },
    pendingConfirms: ctx.pendingConfirms,
    send: ctx.send,
    notifyAbort: (ws, message) => ctx.send(ws, message),
    busyPhase: 'agent.run',
    busyMessage: 'A run is already in progress. Abort it first.',
  });
}

export interface EmbeddedSessionOptions {
  projectRoot?: string | undefined;
  agent: Agent;
  events?: EventBus | undefined;
  session: SessionWriter;
  sessionStore?: SessionStore | undefined;
  sessionsDir?: string | undefined;
  claimSession?:
    | ((sessionId: string, target?: SessionIdentityTarget) => Promise<() => Promise<void>>)
    | undefined;
  onBeforeSessionTodosReplaced?:
    | ((sessionId: string, sessionsDir: string) => void | Promise<void>)
    | undefined;
  onSessionSwapped?:
    | ((sessionId: string, target?: SessionIdentityTarget) => void | Promise<void>)
    | undefined;
}

export interface EmbeddedSessionContext extends EmbeddedHostTransport {
  opts: EmbeddedSessionOptions;
  buildSessionStart: (overrides?: Record<string, unknown>) => Promise<unknown>;
  getCustomModeStore: () => Promise<CustomModeStore>;
  /** When sessionId is provided, abort only that session's run; otherwise abort all. */
  abortActiveRun?: ((sessionId?: string) => void) | undefined;
  /** True while an embedded agent run is active. */
  isRunActive?: ((sessionId?: string) => boolean) | undefined;
}

function sessionStoreFor(opts: EmbeddedSessionOptions): SessionStore {
  const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
  return (
    opts.sessionStore ??
    new DefaultSessionStore({ dir: path.join(projectRoot, '.wrongstack', 'sessions'), projectRoot })
  );
}

export function createEmbeddedSessionRoutes(ctx: EmbeddedSessionContext): SessionRouteHandlers {
  const { opts } = ctx;
  const actx = opts.agent.ctx;
  const getProjectRoot = () => opts.projectRoot ?? actx.projectRoot;
  return createSessionHandlers({
    config: { model: actx.model ?? '', provider: actx.provider?.id ?? '' },
    getConfig: () => ({ model: actx.model ?? '', provider: actx.provider?.id ?? '' }),
    context: actx,
    events: opts.events,
    listTools: () => opts.agent.tools.list(),
    getCompactor: () => opts.agent.container.resolve(TOKENS.Compactor),
    getCustomModeStore: ctx.getCustomModeStore,
    tokenCounter: actx.tokenCounter,
    getProjectRoot,
    getSession: () => actx.session ?? opts.session,
    getSessionStore: () => sessionStoreFor(opts),
    canSwapSessions: () => opts.sessionStore !== undefined,
    getSessionsDir: () =>
      opts.sessionsDir ?? path.join(getProjectRoot(), '.wrongstack', 'sessions'),
    setSession: (next) => {
      actx.session = next;
    },
    claimSession: opts.claimSession,
    onBeforeSessionTodosReplaced: async (sessionId, sessionsDir) =>
      opts.onBeforeSessionTodosReplaced?.(sessionId, sessionsDir),
    onSessionSwapped: async (sessionId, target) => opts.onSessionSwapped?.(sessionId, target),
    abortActiveRun: ctx.abortActiveRun,
    isRunActive: ctx.isRunActive,
    sessionStartPayload: async (overrides) => (await ctx.buildSessionStart(overrides)) as never,
    sendMessage: ctx.send,
    broadcastMessage: ctx.broadcast,
  });
}

export async function broadcastEmbeddedGoalSnapshot(ctx: EmbeddedSessionContext): Promise<void> {
  const projectRoot = ctx.opts.projectRoot ?? ctx.opts.agent.ctx.projectRoot;
  try {
    const raw = await fs.readFile(path.join(projectRoot, '.wrongstack', 'goal.json'), 'utf8');
    ctx.broadcast({ type: 'goal-state.updated', payload: JSON.parse(raw) });
  } catch {
    ctx.broadcast({ type: 'goal-state.updated', payload: null });
  }
}

export interface EmbeddedProjectContext extends EmbeddedHostTransport {
  opts: EmbeddedSessionOptions & { globalConfigPath?: string | undefined };
  /** Session-keyed — same instance as EmbeddedConversationContext. */
  abortControllers: Map<string, AbortController>;
  abortLegacyRun: () => void;
  buildSessionStart: (overrides?: Record<string, unknown>) => Promise<unknown>;
}

export function createEmbeddedProjectRoutes(ctx: EmbeddedProjectContext): ProjectRouteHandlers {
  const { opts } = ctx;
  const actx = opts.agent.ctx;
  const globalConfigPath = opts.globalConfigPath ?? path.join(wstackGlobalRoot(), 'config.json');
  return createProjectHandlers({
    globalConfigPath,
    wpaths: { globalRoot: path.dirname(globalConfigPath) },
    context: actx,
    tokenCounter: actx.tokenCounter,
    config: { model: actx.model, provider: actx.provider.id },
    getConfig: () => ({ model: actx.model, provider: actx.provider.id }),
    getProjectRoot: () => opts.projectRoot ?? actx.projectRoot,
    getSession: () => actx.session ?? opts.session,
    setProjectRoot: (projectRoot) => {
      opts.projectRoot = projectRoot;
    },
    setWorkingDir: (workingDir) => {
      actx.cwd = workingDir;
    },
    setSession: (session) => {
      opts.session = session;
      actx.session = session;
    },
    setSessionStore: (store) => {
      opts.sessionStore = store;
    },
    abortRunLock: ctx.abortLegacyRun,
    abortAllRuns: () => {
      for (const controller of ctx.abortControllers.values()) controller.abort();
      ctx.abortControllers.clear();
    },
    onBeforeSessionTodosReplaced: async (sessionId, sessionsDir) =>
      opts.onBeforeSessionTodosReplaced?.(sessionId, sessionsDir),
    onSessionSwapped: async (sessionId, target) => opts.onSessionSwapped?.(sessionId, target),
    allowProjectMutations: true,
    sessionStartPayload: ctx.buildSessionStart,
    sendMessage: ctx.send,
    broadcastMessage: ctx.broadcast,
  });
}
