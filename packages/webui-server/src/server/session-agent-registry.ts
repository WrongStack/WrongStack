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
import type { SessionStore } from '@wrongstack/core/types';

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
}

export interface SessionAgentRegistry {
  /** The Agent for a session; the leader's when no session is named. */
  get(sessionId?: string | undefined): Agent;
  has(sessionId: string): boolean;
  ids(): string[];
  /** Forget a session's agent — its tab closed. */
  drop(sessionId: string): void;
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

  const evictOneIdle = (): void => {
    // Evict the oldest IDLE session. A running one owns a live transcript that
    // only exists in its context, so dropping it would lose the turn and hand
    // the tab a fresh, empty agent when the user clicks back. When every slot
    // is busy the registry is allowed to exceed the cap: over-cap memory is
    // recoverable, a destroyed in-flight turn is not.
    for (const key of agents.keys()) {
      if (key === template.ctx.session?.id) continue;
      if (opts.isRunActive?.(key)) continue;
      const evicted = agents.get(key);
      evicted?.ctx.readFiles.clear();
      evicted?.ctx.fileMtimes.clear();
      agents.delete(key);
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
      tokenCounter: root.tokenCounter,
      tools: root.tools,
      catalogTools: root.catalogTools,
    });
    // Host-level facts (mode, context-window mode, feature flags) describe the
    // project, not one tab — copied so a new tab starts configured rather than
    // bare. Per-run state is NOT copied: it belongs to the tab that earned it.
    Object.assign(sessionCtx.meta, root.meta);

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
      if (agents.size >= cap) evictOneIdle();
      const agent = create(sessionId);
      agents.set(sessionId, agent);
      return agent;
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
