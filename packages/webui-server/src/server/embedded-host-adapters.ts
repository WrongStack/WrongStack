import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { type EventBus, TOKENS } from '@wrongstack/contracts/kernel';
import type {
  Config,
  MemoryPort,
  ModelsRegistry,
  ModeStore,
  Provider,
  ProviderConfig,
  SessionEvent,
  SessionStore,
  SessionWriter,
} from '@wrongstack/contracts/types';
import type { Agent, Context } from '@wrongstack/core/agent';
import { DefaultSessionStore } from '@wrongstack/core/storage';
import { resolveWstackPaths, toErrorMessage, wstackGlobalRoot } from '@wrongstack/core/utils';
import { makeProviderFromConfig, withCatalogCapabilities } from '@wrongstack/providers';
import type { WebSocket } from 'ws';
import { recordConversationPrimary } from './conversation-fallback.js';
import {
  type ConversationOperations,
  createConversationOperations,
} from './conversation-operations.js';
import type { CustomModeStore } from './custom-context-modes.js';
import type { WebuiLeaderAutoWakeHost } from './leader-auto-wake-host.js';
import type { PendingConfirm } from './pending-confirms.js';
import { createProjectHandlers } from './project-handlers.js';
import type { ProjectRouteHandlers } from './project-routes.js';
import type { HostProvider } from './provider/host-providers.js';
import { createProviderOperations } from './provider-handlers.js';
import { routeProviderCfgThroughProxy } from './proxy-runtime.js';
import type { LoadAgentSessions } from './session-agent-sessions.js';
import { createSessionHandlers, type SessionHandlersContext } from './session-handlers.js';
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
  providerAuthRegistry?: import('@wrongstack/core/registry').ProviderAuthRegistry | undefined;
  getDisabledModels?: (() => readonly string[]) | undefined;
  getDisabledProviders?: (() => readonly string[]) | undefined;
  /** Providers the host serves itself (the CLI's ACP leader), listed beside the saved ones. */
  hostProviders?: (() => readonly HostProvider[]) | undefined;
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
  /**
   * The host's own provider builder, tried before the provider package's: a
   * provider only the host registers (the CLI's ACP leader, `acp`) is built
   * there. Returns undefined for anything it does not build itself.
   */
  buildProvider?:
    | ((providerId: string, config: ProviderConfig) => Provider | undefined)
    | undefined;
}

export async function applyEmbeddedModelSwitch(
  ctx: EmbeddedAgentConfigContext,
  providerId: string,
  modelId: string,
  /**
   * The tab that asked. A model switch rebuilds the provider, the model, the
   * context ceiling and the price table OF ONE CONVERSATION; applying it to
   * `ctx.agent.ctx` — the leader, i.e. the boot tab's runtime — meant that
   * choosing a model in ANY tab re-pointed the boot tab instead, and left the
   * asking tab still running the model it had. Resolved through the caller so
   * hosts without a registry keep the single-context behaviour.
   */
  targetContext?: Context | undefined,
): Promise<void> {
  const agentContext = targetContext ?? ctx.agent.ctx;
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
    const builtProvider =
      ctx.buildProvider?.(providerId, routedConfig) ??
      makeProviderFromConfig(providerId, routedConfig);
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
    const nextProvider = ctx.modelsRegistry
      ? await withCatalogCapabilities(ctx.modelsRegistry, providerId, builtProvider, {
          ...routedConfig,
          type: routedConfig.type ?? providerId,
          model: modelId,
        })
      : builtProvider;
    const catalogId =
      providerConfig.type && providerConfig.type !== providerId ? providerConfig.type : providerId;
    const resolved = await ctx.modelsRegistry?.getModel(catalogId, modelId).catch(() => undefined);
    const maxContext = resolved?.capabilities.maxContext ?? nextProvider.capabilities.maxContext;
    nextProvider.capabilities.maxContext = maxContext;
    await ctx.persistPrefs?.({ provider: providerId, model: modelId });

    agentContext.provider = nextProvider;
    agentContext.model = modelId;
    // This conversation's own primary, for any fallback-model extension on it:
    // the persisted global selection is the LAST tab's pick, not this one's.
    recordConversationPrimary(agentContext, providerId, modelId);
    // The host's `onMaxContextResolved` is PROCESS-WIDE: it rewrites the shared
    // `effectiveMaxContext` ref, the leader context's meta (window size and
    // context-window policy), the shared auto-compactor's ceiling, and it
    // announces `ctx.max_context` under the LEADER's session. That is exactly
    // right when the tab that switched IS the leader — the CLI and the TUI have
    // no other — and completely wrong for any other tab: choosing a model in
    // tab 3 moved tab 1's context window, re-resolved tab 1's policy, and told
    // every surface the change belonged to tab 1.
    //
    // So the global hook runs only for its own context; every other
    // conversation takes the per-context branch, which writes its own meta and
    // names itself in the broadcast.
    const isHostContext = agentContext === ctx.agent.ctx;
    if (ctx.onMaxContextResolved && isHostContext)
      ctx.onMaxContextResolved(providerId, modelId, maxContext);
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
    const switchedSessionId = agentContext.session?.id;
    ctx.broadcast({
      type: 'session.start',
      payload: await ctx.buildSessionStart(
        switchedSessionId ? { sessionId: switchedSessionId } : undefined,
      ),
    });
  });
}

export function createEmbeddedProviderOperations(ctx: EmbeddedProviderContext) {
  return createProviderOperations({
    providerStore: ctx.providerStore,
    broadcast: ctx.broadcast,
    send: ctx.send,
    modelsRegistry: ctx.modelsRegistry,
    providerAuthRegistry: ctx.providerAuthRegistry,
    getDisabledModels: ctx.getDisabledModels,
    getDisabledProviders: ctx.getDisabledProviders,
    hostProviders: ctx.hostProviders,
    log: ctx.log,
  });
}

export interface EmbeddedConversationContext extends EmbeddedHostTransport {
  agent: Agent;
  events: EventBus;
  /**
   * The Agent that owns ONE session's runs.
   *
   * Without this every tab was handed `ctx.agent`, the single leader instance,
   * and the second tab to start a run walked straight into `Agent.run()`'s
   * concurrency guard — "already in progress on this instance". The guard is
   * correct; one Agent for four tabs was not. Hosts supply a per-session
   * registry (see `session-agent-registry.ts`); omitting it keeps the old
   * single-agent behaviour for hosts that genuinely have one session.
   */
  getAgent?: ((sessionId?: string | undefined) => Agent) | undefined;
  /**
   * Non-creating registry lookup for session-ownership checks. `getAgent`
   * CREATES on read, so using it to ask "does this host serve session X?"
   * materialised an agent for every id a client ever typed; `peekAgent`
   * answers the same question without side effects. Optional: hosts without
   * a registry omit it and keep the single-session behaviour.
   */
  peekAgent?: ((sessionId?: string | undefined) => Agent | undefined) | undefined;
  /** Session-keyed abort controllers — one active run per session. */
  abortControllers: Map<string, AbortController>;
  pendingConfirms: Map<string, PendingConfirm>;
  /**
   * Stop the subagents a session spawned. Called when that session's run is
   * aborted: killing the leader's controller only unwinds workers it is
   * blocked on, so async ones keep running unless someone asks them to stop.
   */
  stopSessionFleet?:
    | ((sessionId: string, subagentIds?: readonly string[]) => void | Promise<void>)
    | undefined;
  /**
   * The host's session-transition serialiser, SHARED with the session routes.
   *
   * `user_message` setup reads and mutates the target agent's context, so it
   * must not interleave with a `session.new` / `session.resume` that is
   * halfway through re-pointing writers and contexts. The standalone host has
   * always passed its gate here; this one passed nothing, so
   * `createConversationOperations` fell back to a pass-through and the CLI
   * host — the one people actually run — serialised transitions against each
   * other but never against turn setup. Only the SETUP is gated; runs proceed
   * outside it so four tabs still stream concurrently.
   */
  withSessionTransition?: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined;
  /**
   * Background-delegation auto-wake binding (see `leader-auto-wake-host.ts`).
   * The conversation path reports user submits and finished runs to it, and
   * hands it the runtime-turn starter so a woken turn takes the exact path a
   * user message does. Absent: no auto-wake on this host.
   */
  autoWake?:
    | Pick<WebuiLeaderAutoWakeHost, 'onUserMessage' | 'onRunEnded' | 'bindRuntimeTurnStarter'>
    | undefined;
  /** The sessions directory the host-owned prompt queue persists in (see `session-prompt-queue.ts`). */
  promptQueueSessionsDir?: string | undefined;
}

export function createEmbeddedConversationRoutes(
  ctx: EmbeddedConversationContext,
): ConversationOperations {
  const resolveAgent = (sessionId?: string | undefined): Agent =>
    ctx.getAgent?.(sessionId) ?? ctx.agent;
  const operations = createConversationOperations({
    broadcast: ctx.broadcast,
    promptQueueSessionsDir: ctx.promptQueueSessionsDir,
    ...(ctx.autoWake
      ? {
          onUserMessage: (sessionId: string) => ctx.autoWake?.onUserMessage(sessionId),
          onRunEnded: (sessionId: string, info: { aborted: boolean }) =>
            ctx.autoWake?.onRunEnded(sessionId, info),
        }
      : {}),
    getAgent: resolveAgent,
    getSessionId: () => ctx.agent.ctx.session?.id ?? '',
    // Four tabs share one socket, so "the runtime's current session" is only
    // ever ONE of them. Without this, every request from a background tab was
    // refused with "Request targeted session X, but this WebUI runtime is
    // currently on Y" — correct for a single-session host, fatal for four.
    // A session this host can SERVE is one its registry already knows, or the
    // leader's own. `peekAgent` is non-creating, so the question never
    // materialises an agent (the registry's `get` CREATES on read — the old
    // `() => true` admitted any non-empty string a client typed). Hosts
    // without a registry keep the previous "getAgent present ⇒ serve any
    // requested session" behaviour, which single-session hosts never reach
    // (they pass no getAgent and keep the mismatch refusal).
    hasSession: (id: string) =>
      ctx.peekAgent
        ? ctx.peekAgent(id) !== undefined || id === ctx.agent.ctx.session?.id
        : ctx.getAgent !== undefined,
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
      abort: (_ws, sessionId, subagentIds) => {
        ctx.abortControllers.get(sessionId)?.abort();
        // Stopping a run means stopping the work, and this session's subagents
        // are part of it. Session-scoped so one tab's Stop never reaches
        // another tab's fleet. Ids from the screen cover workers stamped with
        // an older session, which a session-only sweep would leave running.
        // Fire-and-forget: the run is already aborted and a teardown failure
        // must not surface instead of the stop.
        stopFleet(ctx, sessionId, subagentIds);
      },
    },
    pendingConfirms: ctx.pendingConfirms,
    submitUserInput: (sessionId, response) => {
      ctx.events.emit('user.input_submitted', { sessionId, response });
    },
    send: ctx.send,
    // Broadcast, not reply: the abort notice belongs to the SESSION, and a
    // second page showing that tab has to clear its spinner too. The host's
    // broadcast is session-filtered, so it reaches exactly the connections
    // displaying it — matching the standalone host, which answered this way
    // from the start.
    notifyAbort: (_ws, message) => ctx.broadcast(message),
    // Per-session iteration ceiling. `maxIterations` is a session-scoped
    // preference living on that tab's context meta; reading the leader's
    // (what happens when this is absent) applies the boot tab's ceiling to
    // every tab and makes the "3 / 500" readout describe the wrong one.
    // `peekAgent` first — this must not materialise an agent for a stale id.
    getMaxIterations: (sessionId?: string) => {
      const agent = sessionId
        ? (ctx.peekAgent?.(sessionId) ?? ctx.getAgent?.(sessionId))
        : undefined;
      const meta = agent?.ctx.meta ?? ctx.agent.ctx.meta;
      return typeof meta['maxIterations'] === 'number' ? meta['maxIterations'] : undefined;
    },
    ...(ctx.withSessionTransition ? { withSessionTransition: ctx.withSessionTransition } : {}),
    busyPhase: 'agent.run',
    busyMessage: 'A run is already in progress. Abort it first.',
  });
  // A woken turn goes through `startRuntimeTurn` — the same run lock, gate,
  // journaling and broadcasts as a user message, with runtime origin.
  ctx.autoWake?.bindRuntimeTurnStarter(operations.startRuntimeTurn);
  return operations;
}

/** Best-effort cascade of a session stop into the fleet it spawned. */
function stopFleet(
  ctx: EmbeddedConversationContext,
  sessionId: string,
  subagentIds?: readonly string[],
): void {
  if (!sessionId || !ctx.stopSessionFleet) return;
  try {
    const stop = ctx.stopSessionFleet;
    const pending =
      subagentIds && subagentIds.length > 0 ? stop(sessionId, subagentIds) : stop(sessionId);
    void Promise.resolve(pending).catch(() => undefined);
  } catch {
    // A synchronous throw from the host hook is best-effort too.
  }
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
  /**
   * The Agent that owns one session — the same registry the conversation
   * routes use. Session transitions re-point a CONTEXT (writer, messages,
   * todos, plan/task paths); without this they re-point the leader's, so
   * resuming tab 2 rewrote the context tab 1 was running in.
   */
  getAgent?: ((sessionId?: string | undefined) => Agent) | undefined;
  /**
   * Non-creating registry lookup for session-ownership checks — same reason
   * as `EmbeddedConversationContext.peekAgent`: asking "can this host serve
   * session X?" through the creating `getAgent` materialised agents for ids
   * no client ever opened.
   */
  peekAgent?: ((sessionId?: string | undefined) => Agent | undefined) | undefined;
  /**
   * The host's own "which tab is in front" pointer, and its setter.
   *
   * Multi-session hosts MUST supply both. Without them the pointer is the
   * leader agent's `ctx.session` — but the leader agent is simultaneously the
   * RUNTIME of the boot tab, so re-pointing it to another tab's writer made
   * the boot tab write into that tab's journal, and did so mid-run if the boot
   * tab was busy. With them, the pointer moves and no agent's context is
   * touched except the one that owns the session.
   */
  getForegroundSession?: (() => SessionWriter) | undefined;
  setForegroundSession?: ((next: SessionWriter) => void) | undefined;
  /** Does this host already hold an open writer for that session? */
  isSessionLive?: ((sessionId: string) => boolean) | undefined;
  /**
   * Read back NAMED subagents' transcripts, so a replayed session brings its
   * fleet panel back with it. See `session-agent-sessions.ts`.
   */
  loadAgentSessions?: LoadAgentSessions | undefined;
  /**
   * Per-connection display registry, so `session.subscribe` is honoured and
   * "which sessions are on screen right now" has an answer.
   *
   * Only the two session fields are read through this path (the embedded host
   * supplies its own send/broadcast), so a host may keep a leaner client
   * record than the standalone server's `ConnectedClient`. Without it a
   * background tab's session is invisible to the delete guard and to agent
   * eviction — both then treat an open tab as abandoned.
   */
  clients?:
    | Map<WebSocket, { sessionId: string | null; sessionIds?: Set<string> | undefined }>
    | undefined;
  /** Sessions no connection is displaying any more — retire their agents. */
  onSessionsUndisplayed?: ((sessionIds: string[]) => void) | undefined;
  /** Sessions a connection just started displaying (auto-wake hold release). */
  onSessionsDisplayed?: ((sessionIds: string[]) => void) | undefined;
  /**
   * Re-queue a resumed session's undelivered background delegation results.
   * Defaults to the leader container's `DelegationTracker`, when one is bound.
   */
  rehydrateDelegations?: ((sessionId: string, events: readonly unknown[]) => void) | undefined;
  /** When sessionId is provided, abort only that session's run; otherwise abort all. */
  abortActiveRun?: ((sessionId?: string) => void) | undefined;
  /** True while an embedded agent run is active. */
  isRunActive?: ((sessionId?: string) => boolean) | undefined;
  /**
   * The host's session-transition serialiser, SHARED with the conversation
   * routes. Omitting it leaves the session handlers to create a PRIVATE gate,
   * which orders transitions against each other but not against turn setup —
   * see the note on `EmbeddedConversationContext.withSessionTransition`.
   */
  withSessionTransition?: (<T>(operation: () => Promise<T>) => Promise<T>) | undefined;
  /**
   * The process-wide DEFAULT provider/model — the most recent choice made in
   * any tab, as the live config holds it.
   *
   * Without it this host answered "what is the current model" from the LEADER
   * context, i.e. whatever tab 1 last chose. Switching model in tab 2 then
   * left the default untouched, so the next new tab opened on tab 1's model
   * and the choice looked like it had reverted.
   */
  getDefaultModel?:
    | (() => { provider?: string | undefined; model?: string | undefined })
    | undefined;
  /** Re-point ONE session's runtime — see `SessionHandlersContext.applyModelSwitch`. */
  applyModelSwitch?:
    | ((provider: string, model: string, sessionId?: string) => Promise<void>)
    | undefined;
}

function sessionStoreFor(opts: EmbeddedSessionOptions): SessionStore {
  const projectRoot = opts.projectRoot ?? opts.agent.ctx.projectRoot;
  return (
    opts.sessionStore ??
    new DefaultSessionStore({
      dir: resolveWstackPaths({ projectRoot }).projectSessions,
      projectRoot,
    })
  );
}

/**
 * The default provider/model a NEW tab starts from.
 *
 * The live config first: it tracks the most recent choice made in ANY tab, so
 * a model picked in tab 2 becomes the default for the next tab and for the
 * TUI's next boot. The leader's own runtime is only the fallback, for hosts
 * that supply no config reader — reading it FIRST is what made the default
 * "whatever tab 1 last chose" and made a switch in any other tab look like it
 * had reverted.
 *
 * Empty strings in the preferred pair count as absent: a half-configured
 * config must not blank out a working selection.
 */
export function resolveSessionDefaultModel(
  preferred: { provider?: string | undefined; model?: string | undefined } | undefined,
  leader: { provider?: string | undefined; model?: string | undefined },
): { provider: string; model: string } {
  return {
    provider: preferred?.provider || leader.provider || '',
    model: preferred?.model || leader.model || '',
  };
}

export function createEmbeddedSessionRoutes(ctx: EmbeddedSessionContext): SessionRouteHandlers {
  const { opts } = ctx;
  const actx = opts.agent.ctx;
  const getProjectRoot = () => opts.projectRoot ?? actx.projectRoot;
  const defaultModel = (): { provider: string; model: string } =>
    resolveSessionDefaultModel(ctx.getDefaultModel?.(), {
      provider: actx.provider?.id,
      model: actx.model,
    });
  return createSessionHandlers({
    config: defaultModel(),
    getConfig: defaultModel,
    ...(ctx.applyModelSwitch ? { applyModelSwitch: ctx.applyModelSwitch } : {}),
    context: actx,
    events: opts.events,
    listTools: () => opts.agent.tools.list(),
    getCompactor: () => opts.agent.container.resolve(TOKENS.Compactor),
    getCustomModeStore: ctx.getCustomModeStore,
    tokenCounter: actx.tokenCounter,
    getProjectRoot,
    getSession: () => ctx.getForegroundSession?.() ?? actx.session ?? opts.session,
    getSessionStore: () => sessionStoreFor(opts),
    canSwapSessions: () => opts.sessionStore !== undefined,
    getSessionsDir: () =>
      opts.sessionsDir ?? resolveWstackPaths({ projectRoot: getProjectRoot() }).projectSessions,
    setSession: (next) => {
      ctx.setForegroundSession?.(next);
      // Re-point a CONTEXT only when it is the context that owns this session.
      // `activateSession` already installs the writer on the target session's
      // own agent; the leader's context is a tab's runtime too, and assigning
      // another tab's writer to it is how a run ended up appending to a
      // different session's journal. A single-session host has no separate
      // foreground pointer, so it keeps the original assignment.
      if (!ctx.setForegroundSession || actx.session?.id === next.id) actx.session = next;
    },
    claimSession: opts.claimSession,
    onBeforeSessionTodosReplaced: async (sessionId, sessionsDir) =>
      opts.onBeforeSessionTodosReplaced?.(sessionId, sessionsDir),
    onSessionSwapped: async (sessionId, target) => opts.onSessionSwapped?.(sessionId, target),
    abortActiveRun: ctx.abortActiveRun,
    isRunActive: ctx.isRunActive,
    ...(ctx.withSessionTransition ? { withSessionTransition: ctx.withSessionTransition } : {}),
    ...(ctx.getAgent ? { getAgent: ctx.getAgent } : {}),
    // Read-only twin of `getAgent` above: context.debug resolves through the
    // non-creating lookup so a stale id is an honest error, not a freshly
    // materialised agent or another tab's root context.
    ...(ctx.peekAgent ? { peekAgent: ctx.peekAgent } : {}),
    // Same reason as the conversation routes: a request naming a background
    // tab's session is legitimate here, not a mismatch to refuse — but only
    // when the registry actually knows that session (peek is non-creating) or
    // it is the leader's own. The unconditional `() => true` admitted any
    // non-empty string a client typed.
    ...(ctx.getAgent
      ? {
          hasSession: (id: string) =>
            ctx.peekAgent ? ctx.peekAgent(id) !== undefined || id === actx.session?.id : true,
        }
      : {}),
    ...(ctx.isSessionLive ? { isSessionLive: ctx.isSessionLive } : {}),
    ...(ctx.loadAgentSessions ? { loadAgentSessions: ctx.loadAgentSessions } : {}),
    ...(ctx.onSessionsUndisplayed ? { onSessionsUndisplayed: ctx.onSessionsUndisplayed } : {}),
    ...(ctx.onSessionsDisplayed ? { onSessionsDisplayed: ctx.onSessionsDisplayed } : {}),
    // One tracker per process, bound in the leader's container next to the
    // delegate tool; per-tab agents share that wiring.
    rehydrateDelegations:
      ctx.rehydrateDelegations ??
      ((sessionId, events) => {
        opts.agent.container
          ?.safeResolve?.(TOKENS.DelegationTracker)
          ?.rehydrate(sessionId, events as readonly SessionEvent[]);
      }),
    // Structural: the handlers only read `sessionId`/`sessionIds` off these
    // records, and never broadcast through the map (this host passes its own
    // `broadcastMessage`).
    ...(ctx.clients
      ? { clients: ctx.clients as unknown as NonNullable<SessionHandlersContext['clients']> }
      : {}),
    sessionStartPayload: async (overrides) => (await ctx.buildSessionStart(overrides)) as never,
    sendMessage: ctx.send,
    broadcastMessage: ctx.broadcast,
  });
}

export async function broadcastEmbeddedGoalSnapshot(ctx: EmbeddedSessionContext): Promise<void> {
  const projectRoot = ctx.opts.projectRoot ?? ctx.opts.agent.ctx.projectRoot;
  try {
    const raw = await fs.readFile(resolveWstackPaths({ projectRoot }).projectGoal, 'utf8');
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
  /**
   * The host's foreground-session pointer — the same one the session routes
   * move. A project switch retires every session in the process, so the
   * pointer has to follow it here too or the host keeps naming a session that
   * belongs to the previous project.
   */
  getForegroundSession?: (() => SessionWriter) | undefined;
  setForegroundSession?: ((next: SessionWriter) => void) | undefined;
  /**
   * Deliver to every connection regardless of what it displays. The project
   * switch needs it: `broadcast` routes on the payload's session, and the
   * switch announces one no client has had a chance to subscribe to.
   */
  broadcastEveryone?: ((message: WSServerMessage) => void) | undefined;
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
    getSession: () => ctx.getForegroundSession?.() ?? actx.session ?? opts.session,
    setProjectRoot: (projectRoot) => {
      opts.projectRoot = projectRoot;
    },
    setWorkingDir: (workingDir) => {
      actx.cwd = workingDir;
    },
    setSession: (session) => {
      opts.session = session;
      actx.session = session;
      ctx.setForegroundSession?.(session);
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
    ...(ctx.broadcastEveryone ? { broadcastEveryone: ctx.broadcastEveryone } : {}),
  });
}
