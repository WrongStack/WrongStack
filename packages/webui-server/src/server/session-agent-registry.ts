/**
 * session-agent-registry.ts — one Agent per open tab.
 *
 * `Agent.run()` refuses to run twice on the same instance, and it is right to:
 * a run mutates `ctx.signal`, `ctx.messages`, the session writer, token
 * bookkeeping and compaction state, none of which survive two runs racing
 * through them. So "four tabs running at once" is not a matter of relaxing that
 * guard — it is a matter of there being four Agents.
 *
 * The embedded WebUI host had exactly one, shared by every tab, and handed it
 * out no matter which session asked. Starting a run in a second tab therefore
 * hit the guard head-on:
 *
 *     [agent.run] Agent.run() is already in progress on this instance.
 *
 * This registry is the missing half. It hands each session its own Agent,
 * cloned from the leader's wiring — same container, tools, providers, events,
 * pipelines and executor, its own `Context`. Everything shared is deliberately
 * shared (the tool registry and provider registry are stateless surfaces; the
 * event bus is how the host observes every tab). Everything per-run is not.
 */

import { Agent, Context } from '@wrongstack/core/agent';
import { DefaultTokenCounter } from '@wrongstack/core/infrastructure';
import type { ModelsRegistry, SessionStore, TokenCounter } from '@wrongstack/core/types';
import { SESSION_SCOPED_PREF_KEYS } from './session-scoped-prefs.js';

/** Session-writer shape, as `SessionStore.create()` produces it. */
type Session = Awaited<ReturnType<SessionStore['create']>>;

export interface SessionAgentRegistryOptions {
  /**
   * The leader Agent. Supplies both the wiring every session agent inherits
   * and the identity of the boot session, which keeps using it.
   */
  template: Agent;
  /** Hard ceiling on live agents. Matches the four-tab ceiling. */
  maxAgents?: number | undefined;
  /**
   * Is this session mid-run? Consulted before eviction — a running agent owns
   * a live transcript that exists nowhere else.
   */
  isRunActive?: ((sessionId: string) => boolean) | undefined;
  /** Called once, right after a new session agent is constructed. */
  onCreate?: ((agent: Agent, sessionId: string) => void) | undefined;
  /** Models registry, so a session's own counter can price its own usage. */
  modelsRegistry?: ModelsRegistry | undefined;
  /**
   * Override how a session's Agent is built. The default clones the template's
   * wiring; a caller that already owns an Agent per session (or a test that
   * does not want a whole container) supplies its own.
   */
  createAgent?: ((sessionId: string) => Agent) | undefined;
  /**
   * Is any connected surface currently showing this session?
   *
   * Consulted before eviction. Without it the victim is simply the oldest
   * non-running entry, which is routinely a tab the user still has open while
   * the agents of tabs they closed minutes ago sit untouched — the open tab
   * then loses its in-memory transcript and comes back empty.
   */
  isDisplayed?: ((sessionId: string) => boolean) | undefined;
}

export interface SessionAgentRegistry {
  /**
   * The Agent for a session; the leader's when no session is named.
   *
   * CREATES one when the id is unknown, so this is for callers that own the
   * session (a run, a session transition). Read-only callers must use `peek`:
   * `get` on a stale id materialises an agent and can evict a live one.
   */
  get(sessionId?: string | undefined): Agent;
  /** The Agent for a session, or undefined. Never creates, never evicts. */
  peek(sessionId?: string | undefined): Agent | undefined;
  /**
   * Does this session have an agent with a REAL session writer?
   *
   * A freshly created agent carries a placeholder writer until the session
   * transition that owns the id installs the real one, so `has` alone does not
   * mean the session can be written to.
   */
  isLive(sessionId: string): boolean;
  has(sessionId: string): boolean;
  ids(): string[];
  /** Forget a session's agent — its tab closed. */
  drop(sessionId: string): void;
}

/**
 * A token counter that answers for ONE session while still feeding the
 * process-wide one.
 *
 * Four tabs shared a single counter, so every per-session question it was
 * asked came back as the sum of all four: the Inspector's token, cost and
 * cache figures for a tab, the usage stamped into a session's `session_end`
 * record, the before/after numbers on a compaction report. Reads here are this
 * session's own; `account` still forwards, so process-wide consumers (budget
 * watchdog, shutdown totals, project switch) keep seeing everything.
 *
 * Deliberately constructed WITHOUT an event bus: the root counter already
 * emits `token.accounted` for every call, and a second emitter would double
 * every downstream tally.
 */
export function createSessionTokenCounter(opts: {
  root: TokenCounter;
  sessionId: string;
  registry?: ModelsRegistry | undefined;
  providerId?: (() => string | undefined) | undefined;
}): TokenCounter {
  const own = new DefaultTokenCounter({
    ...(opts.registry ? { registry: opts.registry } : {}),
    ...(opts.providerId ? { providerId: opts.providerId } : {}),
    sessionId: opts.sessionId,
  });
  return {
    account(usage, model, providerId) {
      own.account(usage, model, providerId);
      return opts.root.account(usage, model, providerId);
    },
    // Resetting must never reach the root: /clear in one tab would zero the
    // numbers of the three beside it.
    reset: () => own.reset(),
    total: () => own.total(),
    estimateCost: () => own.estimateCost(),
    cacheStats: () => own.cacheStats(),
    currentRequestTokens: () => own.currentRequestTokens(),
    setCurrentRequestTokens: (input, cacheRead, cacheWrite) =>
      own.setCurrentRequestTokens(input, cacheRead, cacheWrite),
    setSessionId: (sessionId) => own.setSessionId?.(sessionId),
  };
}

/**
 * The part of the leader's meta a NEW conversation may inherit.
 *
 * Host-level facts (mode, feature flags, the resolved window size) describe the
 * project, so a fresh tab starts configured rather than bare. The
 * SESSION-SCOPED PREFERENCES are removed, and that is the point: they are
 * per-conversation by design (YOLO, autonomy, the iteration ceiling, the
 * context strategy, the Lite/Standard/Pro identity), and the leader's meta is
 * not the project's copy of them — it is whatever the FIRST TAB last chose.
 * Copying it started a brand-new conversation under another tab's settings,
 * YOLO included. Each of those keys already falls back to the project default
 * when absent, so leaving them off is exactly "starts clean"; the tab's own
 * first choice writes its own.
 */
export function inheritedSessionMeta(rootMeta: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(rootMeta)) {
    if (SESSION_SCOPED_PREF_KEYS.has(key)) continue;
    out[key] = value;
  }
  return out;
}

const DEFAULT_MAX_AGENTS = 4;

export function createSessionAgentRegistry(
  opts: SessionAgentRegistryOptions,
): SessionAgentRegistry {
  const template = opts.template;
  const cap = opts.maxAgents ?? DEFAULT_MAX_AGENTS;
  const agents = new Map<string, Agent>();

  const bootSessionId = template.ctx.session?.id;
  if (bootSessionId) agents.set(bootSessionId, template);

  /**
   * Agents the cap actually governs.
   *
   * The leader's own agent is pinned — `evictOneIdle` skips it and `drop`
   * refuses it — so counting it against the budget spent a slot that could
   * never be reclaimed: four tabs plus the pinned entry read as "over cap" and
   * evicted a tab the user still had open. (It reads as over-cap on its own
   * the moment the leader's context moves to a new session, which
   * `session.new` does, leaving the previous id behind as an ordinary entry.)
   * Budgeting only what can be evicted keeps the ceiling honest.
   */
  const evictableCount = (): number => {
    const pinned = template.ctx.session?.id;
    let n = 0;
    for (const key of agents.keys()) if (key !== pinned) n++;
    return n;
  };

  const evictOneIdle = (): void => {
    // Evict the oldest IDLE session. A running one owns a live transcript that
    // only exists in its context, so dropping it would lose the turn and hand
    // the tab a fresh, empty agent when the user clicks back. When every slot
    // is busy the registry is allowed to exceed the cap: over-cap memory is
    // recoverable, a destroyed in-flight turn is not.
    //
    // Two passes, and the order is the point: a session nobody is looking at
    // goes first. Insertion order alone picks the OLDEST tab, which is usually
    // one the user still has open, while the agent of a tab closed ten minutes
    // ago survives because it was created later.
    const candidates = (displayed: boolean): string[] => {
      const out: string[] = [];
      for (const key of agents.keys()) {
        if (key === template.ctx.session?.id) continue;
        if (opts.isRunActive?.(key)) continue;
        if ((opts.isDisplayed?.(key) ?? false) !== displayed) continue;
        out.push(key);
      }
      return out;
    };
    const victim = candidates(false)[0] ?? candidates(true)[0];
    if (victim !== undefined) {
      const evicted = agents.get(victim);
      evicted?.ctx.readFiles.clear();
      evicted?.ctx.fileMtimes.clear();
      agents.delete(victim);
      return;
    }
    console.warn(
      JSON.stringify({
        level: 'warn',
        event: 'webui.session_agents_over_cap',
        size: agents.size,
        cap,
        reason: 'every session agent is running; kept them all rather than killing a turn',
        timestamp: new Date().toISOString(),
      }),
    );
  };

  const create = (sessionId: string): Agent => {
    const root = template.ctx;
    const sessionCtx = new Context({
      projectRoot: (root as { projectRoot?: string }).projectRoot ?? process.cwd(),
      cwd: root.cwd,
      model: root.model,
      provider: root.provider,
      // A placeholder writer: the real one is installed by the session
      // transition (`session.new` / `session.resume`) that owns this id. Until
      // then the context still knows which session it speaks for, which is what
      // every downstream stamp reads.
      session: { id: sessionId, traceId: root.traceId } as Session,
      traceId: root.traceId,
      systemPrompt: root.systemPrompt,
      agentId: 'leader',
      agentName: 'Leader Agent',
      allowOutsideProjectRoot: root.allowOutsideProjectRoot,
      signal: root.signal,
      tokenCounter: createSessionTokenCounter({
        root: root.tokenCounter,
        sessionId,
        ...(opts.modelsRegistry ? { registry: opts.modelsRegistry } : {}),
        providerId: () => root.provider?.id,
      }),
      tools: root.tools,
      catalogTools: root.catalogTools,
    });
    // Host-level facts (mode, feature flags, resolved window size) describe the
    // project, not one tab — copied so a new tab starts configured rather than
    // bare. Per-run state is NOT copied: it belongs to the tab that earned it.
    //
    // The SESSION-SCOPED PREFERENCES are excluded, and that is the point of the
    // filter. They are per-conversation by design (YOLO, autonomy, the
    // iteration ceiling, the context strategy, the Lite/Standard/Pro identity),
    // and `root.meta` is not the project's copy of them — it is the LEADER's
    // live copy, i.e. whatever tab 1 last chose. Copying it made a brand-new
    // conversation start under another tab's settings, YOLO included, instead
    // of the project defaults. Each of these keys already falls back to the
    // project default when absent, so leaving them off is what "starts clean"
    // means; the tab's own first choice writes its own.
    Object.assign(sessionCtx.meta, inheritedSessionMeta(root.meta));

    const agent = new Agent({
      container: template.container,
      tools: template.tools,
      providers: template.providers,
      events: template.events,
      pipelines: template.pipelines,
      context: sessionCtx,
      maxIterations: template.maxIterations,
      executionStrategy: template.executionStrategy,
      perIterationOutputCapBytes: template.perIterationOutputCapBytes,
      autoExtendLimit: template.autoExtendLimit,
      loopDetection: template.loopDetection,
      refreshSystemPrompt: true,
      toolExecutor: template.toolExecutor,
    });
    opts.onCreate?.(agent, sessionId);
    return agent;
  };
  const build = (sessionId: string): Agent => opts.createAgent?.(sessionId) ?? create(sessionId);

  return {
    get(sessionId) {
      if (!sessionId) return template;
      const existing = agents.get(sessionId);
      if (existing) return existing;
      // The leader keeps whichever session its context currently speaks for.
      if (template.ctx.session?.id === sessionId) {
        agents.set(sessionId, template);
        return template;
      }
      if (evictableCount() >= cap) evictOneIdle();
      const agent = build(sessionId);
      agents.set(sessionId, agent);
      return agent;
    },
    peek(sessionId) {
      if (!sessionId) return template;
      return (
        agents.get(sessionId) ?? (template.ctx.session?.id === sessionId ? template : undefined)
      );
    },
    isLive(sessionId) {
      const agent =
        agents.get(sessionId) ?? (template.ctx.session?.id === sessionId ? template : undefined);
      const writer = agent?.ctx.session as { id?: string; append?: unknown } | undefined;
      return Boolean(writer && writer.id === sessionId && typeof writer.append === 'function');
    },
    has: (sessionId) => agents.has(sessionId),
    ids: () => [...agents.keys()],
    drop(sessionId) {
      if (sessionId === template.ctx.session?.id) return;
      const agent = agents.get(sessionId);
      agent?.ctx.readFiles.clear();
      agent?.ctx.fileMtimes.clear();
      agents.delete(sessionId);
    },
  };
}
