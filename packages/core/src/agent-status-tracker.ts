/**
 * AgentStatusTracker — subscribes to EventBus events and keeps the
 * SessionRegistry updated with live agent status.
 *
 * Created once per process during boot. Listens for:
 * - agent.run.started / agent.run.completed → agent status changes
 * - tool.started / tool.executed → current tool tracking
 * - brain.ask_human → waiting_user status
 * - fleet events (subagent spawn/start/done) → agent entries
 *
 * @module agent-status-tracker
 */
import type { EventBus } from './kernel/events.js';
import type {
  AgentEntry,
  AgentLiveStatus,
  SessionRegistry,
} from './session-registry.js';

/** A finished (idle/error) subagent older than this is reaped from the fleet view. */
const AGENT_REAP_MS = 30_000;
/** How often the reaper sweeps for finished subagents. */
const AGENT_SWEEP_INTERVAL_MS = 10_000;
/** Max chars of streamed assistant text kept in the registry (the live tail). */
const PARTIAL_TEXT_CAP = 1200;
/** Min gap between registry flushes triggered purely by streamed text. */
const PARTIAL_FLUSH_THROTTLE_MS = 300;

function clampPct(pct: number): number {
  if (!Number.isFinite(pct)) return 0;
  return Math.max(0, Math.min(100, pct));
}

export interface AgentStatusTrackerOptions {
  events: EventBus;
  registry: SessionRegistry;
  /** Session id whose live agent state is mirrored by this tracker. */
  sessionId?: string | (() => string | undefined) | undefined;
  /** Leader agent name shown in the registry. Default: "leader". */
  leaderName?: string | undefined;
  /**
   * Best-effort callback fired after each registry write settles. Used to nudge
   * local WebUI servers (FleetNotifier) so cross-process status reaches the map
   * without waiting on their file-watch/poll. Never block or throw.
   */
  onUpdate?: (() => void) | undefined;
}

export class AgentStatusTracker {
  private readonly events: EventBus;
  private readonly registry: SessionRegistry;
  private readonly sessionId: string | (() => string | undefined) | undefined;
  private readonly leaderName: string;

  // Live agent map: agentId → AgentEntry
  private agents = new Map<string, AgentEntry>();
  // Last full agent list flushed (leader + subagents). Lets external consumers
  // read the current state synchronously without re-deriving it.
  private lastAgents: AgentEntry[] = [];

  // Leader tracking
  private leaderStatus: AgentLiveStatus = 'idle';
  private leaderCurrentTool: string | undefined;
  private leaderIterations = 0;
  private leaderToolCalls = 0;
  private leaderCostUsd = 0;
  private leaderTokensIn = 0;
  private leaderTokensOut = 0;
  private leaderCtxPct: number | undefined;
  private leaderModel: string | undefined;
  private leaderPartialText = '';
  private leaderStartedAt: string | undefined;

  private unsubscribers: Array<() => void> = [];
  private readonly onUpdate: (() => void) | undefined;
  private sweepTimer: ReturnType<typeof setInterval> | null = null;
  private partialTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(opts: AgentStatusTrackerOptions) {
    this.events = opts.events;
    this.registry = opts.registry;
    this.sessionId = opts.sessionId;
    this.leaderName = opts.leaderName ?? 'leader';
    this.onUpdate = opts.onUpdate;
  }

  /** Current full agent list (leader + subagents) as of the last flush. */
  getAgents(): AgentEntry[] {
    return this.lastAgents.length > 0 ? [...this.lastAgents] : [];
  }

  start(): void {
    const on = (
      pattern: string,
      fn: (event: string, payload: unknown) => void,
    ): (() => void) =>
      this.events.onPattern(pattern, (event, payload) => {
        if (!this.acceptsSession(payload)) return;
        fn(event, payload);
      });

    // Leader events
    this.unsubscribers.push(
      on('agent.run.started', (_event, payload) => {
        const p = payload as { at?: string; model?: string; ctx?: unknown } | undefined;
        this.markLeaderStarted(p?.at);
        this.captureLeaderContext(p?.ctx);
        if (p?.model) this.leaderModel = p.model;
        this.leaderStatus = 'running';
        this.leaderIterations++;
        this.flush();
      }),
    );

    // Capture the leader's model + context fill from each iteration's context.
    this.unsubscribers.push(
      on('iteration.started', (_e, payload) => {
        const p = payload as { ctx?: unknown; index?: number } | undefined;
        const ctx = p?.ctx;
        this.markLeaderStarted();
        this.leaderStatus = 'running';
        if (typeof p?.index === 'number') {
          this.leaderIterations = Math.max(this.leaderIterations, p.index + 1);
        }
        if (!ctx) {
          this.flush();
          return;
        }
        this.captureLeaderContext(ctx);
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('agent.run.completed', (_event, payload) => {
        const p = payload as { status?: string; ctx?: unknown } | undefined;
        this.captureLeaderContext(p?.ctx);
        this.leaderStatus = p?.status === 'failed' ? 'error' : 'idle';
        this.leaderCurrentTool = undefined;
        this.leaderPartialText = '';
        if (this.leaderStatus === 'idle') this.leaderStartedAt = undefined;
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('agent.run.error', (_event, payload) => {
        const p = payload as { ctx?: unknown } | undefined;
        this.captureLeaderContext(p?.ctx);
        this.leaderStatus = 'error';
        this.leaderCurrentTool = undefined;
        this.leaderPartialText = '';
        this.flush();
      }),
    );

    // Tool events — track current tool
    this.unsubscribers.push(
      on('tool.started', (_event, payload) => {
        const p = payload as { name?: string } | undefined;
        if (p?.name) {
          this.markLeaderStarted();
          this.leaderCurrentTool = p.name;
          this.leaderToolCalls++;
        }
        this.leaderStatus = 'running';
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('tool.executed', () => {
        this.leaderCurrentTool = undefined;
        this.flush();
      }),
    );

    // Brain ask_human → waiting for user input
    this.unsubscribers.push(
      on('brain.ask_human', () => {
        this.markLeaderStarted();
        this.leaderStatus = 'waiting_user';
        this.flush();
      }),
    );

    // Streaming events
    this.unsubscribers.push(
      on('llm.stream_started', () => {
        this.markLeaderStarted();
        this.leaderStatus = 'streaming';
        // A new response is starting — drop the previous turn's live tail.
        this.leaderPartialText = '';
        this.flush();
      }),
    );

    // Live assistant text — accumulate the streamed tail so a cross-process
    // watcher sees the response form. Flushed on a throttle, NOT per token
    // (text_delta fires once per chunk → would thrash the shared registry).
    this.unsubscribers.push(
      on('provider.text_delta', (_e, payload) => {
        const p = payload as { text?: string; ctx?: unknown } | undefined;
        const text = p?.text;
        if (!text) return;
        this.markLeaderStarted();
        this.captureLeaderContext(p?.ctx);
        this.leaderStatus = 'streaming';
        const next = this.leaderPartialText + text;
        this.leaderPartialText =
          next.length > PARTIAL_TEXT_CAP ? next.slice(next.length - PARTIAL_TEXT_CAP) : next;
        this.schedulePartialFlush();
      }),
    );

    this.unsubscribers.push(
      on('provider.response', (_e, payload) => {
        const p = payload as { ctx?: unknown } | undefined;
        this.captureLeaderContext(p?.ctx);
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('provider.fallback', (_e, payload) => {
        const p = payload as { to?: { providerId?: string; model?: string } } | undefined;
        if (p?.to?.model) {
          this.leaderModel = p.to.providerId
            ? `${p.to.providerId}/${p.to.model}`
            : p.to.model;
          this.flush();
        }
      }),
    );

    this.unsubscribers.push(
      on('ctx.pct', (_e, payload) => {
        const p = payload as { load?: number } | undefined;
        if (typeof p?.load === 'number' && Number.isFinite(p.load)) {
          this.leaderCtxPct = clampPct(Math.round(p.load * 100));
          this.flush();
        }
      }),
    );

    // Leader token + cost accounting (per provider call — accumulate).
    this.unsubscribers.push(
      on('token.accounted', (_e, payload) => {
        const p = payload as
          | { usage?: { input?: number; output?: number }; cost?: { total?: number } }
          | undefined;
        if (!p) return;
        this.leaderTokensIn += p.usage?.input ?? 0;
        this.leaderTokensOut += p.usage?.output ?? 0;
        this.leaderCostUsd += p.cost?.total ?? 0;
        this.flush();
      }),
    );

    // ── Subagent tracking ──────────────────────────────────────────────
    // These are the real fleet lifecycle events (emitted by MultiAgentHost /
    // the subagent runner / director). The previous code listened to a
    // `fleet.subagent.*` namespace that nothing emits, so subagents never
    // reached the registry — only the leader showed up.
    const touch = (id: string): AgentEntry => {
      let entry = this.agents.get(id);
      if (!entry) {
        const now = new Date().toISOString();
        entry = { id, name: id, status: 'idle', iterations: 0, toolCalls: 0, startedAt: now, lastActivityAt: now };
        this.agents.set(id, entry);
      }
      entry.lastActivityAt = new Date().toISOString();
      return entry;
    };

    this.unsubscribers.push(
      on('subagent.spawned', (_e, payload) => {
        const p = payload as { subagentId?: string; name?: string; model?: string } | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        entry.name = p.name?.trim() || entry.name;
        if (p.model) entry.model = p.model;
        if (!entry.startedAt) entry.startedAt = new Date().toISOString();
        entry.status = 'running';
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('subagent.ctx_pct', (_e, payload) => {
        const p = payload as { subagentId?: string; load?: number } | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        if (typeof p.load === 'number') entry.ctxPct = clampPct(Math.round(p.load * 100));
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('subagent.task_started', (_e, payload) => {
        const p = payload as { subagentId?: string } | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        entry.status = 'running';
        if (!entry.startedAt) entry.startedAt = new Date().toISOString();
        entry.iterations++;
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('subagent.tool_executed', (_e, payload) => {
        const p = payload as { subagentId?: string; name?: string } | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        entry.status = 'running';
        if (!entry.startedAt) entry.startedAt = new Date().toISOString();
        entry.currentTool = p.name;
        entry.toolCalls++;
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('subagent.iteration_summary', (_e, payload) => {
        const p = payload as
          | {
              subagentId?: string;
              iteration?: number;
              toolCalls?: number;
              currentTool?: string;
              costUsd?: number;
              partialText?: string;
            }
          | undefined;
        if (!p?.subagentId) return;
        const entry = touch(p.subagentId);
        entry.status = 'running';
        if (!entry.startedAt) entry.startedAt = new Date().toISOString();
        if (typeof p.iteration === 'number') entry.iterations = p.iteration;
        if (typeof p.toolCalls === 'number') entry.toolCalls = p.toolCalls;
        if (typeof p.costUsd === 'number') entry.costUsd = p.costUsd;
        if (p.currentTool) entry.currentTool = p.currentTool;
        // Live streamed tail of THIS subagent's current response (the runner
        // already accumulates it) — capped to the same budget as the leader.
        if (typeof p.partialText === 'string') {
          entry.partialText =
            p.partialText.length > PARTIAL_TEXT_CAP
              ? p.partialText.slice(p.partialText.length - PARTIAL_TEXT_CAP)
              : p.partialText;
        }
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('subagent.task_completed', (_e, payload) => {
        const p = payload as
          | { subagentId?: string; status?: string; iterations?: number; toolCalls?: number }
          | undefined;
        if (!p?.subagentId) return;
        // Only update an agent we already know — a completion for an unseen
        // agent isn't worth materialising.
        const entry = this.agents.get(p.subagentId);
        if (!entry) return;
        entry.status = p.status === 'failed' || p.status === 'timeout' ? 'error' : 'idle';
        entry.currentTool = undefined;
        entry.partialText = undefined;
        if (typeof p.iterations === 'number') entry.iterations = p.iterations;
        if (typeof p.toolCalls === 'number') entry.toolCalls = p.toolCalls;
        entry.lastActivityAt = new Date().toISOString();
        this.flush();
      }),
    );

    this.unsubscribers.push(
      on('subagent.stopped', (_e, payload) => {
        const p = payload as { subagentId?: string } | undefined;
        if (!p?.subagentId) return;
        if (this.agents.delete(p.subagentId)) this.flush();
      }),
    );

    // Reap finished subagents so the fleet view doesn't fill with dead/idle
    // desks. The leader is synthesised in flush() (never in `this.agents`), so
    // it is never reaped — it represents the live session.
    this.sweepTimer = setInterval(() => this.sweep(), AGENT_SWEEP_INTERVAL_MS);
    if (typeof this.sweepTimer.unref === 'function') this.sweepTimer.unref();
  }

  stop(): void {
    for (const unsub of this.unsubscribers) {
      try { unsub(); } catch { /* ignore */ }
    }
    this.unsubscribers = [];
    if (this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
    if (this.partialTimer) {
      clearTimeout(this.partialTimer);
      this.partialTimer = null;
    }
  }

  /**
   * Coalesce streamed-text flushes: at most one registry write per
   * {@link PARTIAL_FLUSH_THROTTLE_MS} while text streams in, so per-token
   * deltas never thrash the cross-process registry file.
   */
  private schedulePartialFlush(): void {
    if (this.partialTimer) return;
    this.partialTimer = setTimeout(() => {
      this.partialTimer = null;
      this.flush();
    }, PARTIAL_FLUSH_THROTTLE_MS);
    if (typeof this.partialTimer.unref === 'function') this.partialTimer.unref();
  }

  /**
   * Remove subagents that have been finished (idle/error) for longer than
   * {@link AGENT_REAP_MS}. Running / streaming / waiting_user agents are kept
   * regardless of age — only *not-working* agents are reaped.
   */
  private sweep(): void {
    const now = Date.now();
    let removed = false;
    for (const [id, a] of this.agents) {
      const finished = a.status !== 'running' && a.status !== 'streaming' && a.status !== 'waiting_user';
      const age = now - Date.parse(a.lastActivityAt);
      if (finished && Number.isFinite(age) && age > AGENT_REAP_MS) {
        this.agents.delete(id);
        removed = true;
      }
    }
    if (removed) this.flush();
  }

  private flush(): void {
    const leaderEntry: AgentEntry = {
      id: 'leader',
      name: this.leaderName,
      startedAt: this.leaderStartedAt,
      status: this.leaderStatus,
      currentTool: this.leaderCurrentTool,
      iterations: this.leaderIterations,
      toolCalls: this.leaderToolCalls,
      costUsd: this.leaderCostUsd,
      tokensIn: this.leaderTokensIn,
      tokensOut: this.leaderTokensOut,
      ctxPct: this.leaderCtxPct,
      model: this.leaderModel,
      partialText: this.leaderPartialText || undefined,
      lastActivityAt: new Date().toISOString(),
    };

    const allAgents = [leaderEntry, ...this.agents.values()];
    this.lastAgents = allAgents;
    // Broadcast the fresh agent list on the local bus so in-process consumers
    // (e.g. the HQ session-telemetry bridge) can build snapshots without
    // re-reading the shared registry file. Best-effort, never throws here.
    try {
      this.events.emit('session.agents_updated', {
        sessionId: this.currentSessionId(),
        agents: allAgents,
      });
    } catch {
      /* best-effort */
    }
    // Nudge local WebUIs only AFTER the write settles, so they re-read fresh
    // data. Best-effort — never let a notifier failure surface here.
    this.registry
      .updateAgents(allAgents)
      .then(() => {
        try {
          this.onUpdate?.();
        } catch {
          /* best-effort */
        }
      })
      .catch(() => undefined);
  }

  private currentSessionId(): string | undefined {
    return typeof this.sessionId === 'function' ? this.sessionId() : this.sessionId;
  }

  private acceptsSession(payload: unknown): boolean {
    const expected = this.currentSessionId();
    if (!expected) return true;
    if (typeof payload !== 'object' || payload === null) return true;
    const actual = (payload as { sessionId?: unknown }).sessionId;
    return typeof actual !== 'string' || actual.length === 0 || actual === expected;
  }

  private markLeaderStarted(startedAt?: string): void {
    if (
      this.leaderStartedAt &&
      (this.leaderStatus === 'running' ||
        this.leaderStatus === 'streaming' ||
        this.leaderStatus === 'waiting_user')
    ) {
      return;
    }
    this.leaderStartedAt = startedAt ?? new Date().toISOString();
  }

  private captureLeaderContext(ctx: unknown): void {
    if (typeof ctx !== 'object' || ctx === null) return;
    const c = ctx as {
      model?: unknown;
      lastRequestTokens?: unknown;
      meta?: Record<string, unknown> | undefined;
      provider?: { capabilities?: { maxContext?: unknown } | undefined } | undefined;
    };
    if (typeof c.model === 'string' && c.model.length > 0) this.leaderModel = c.model;

    const metaLimit = c.meta?.['effectiveMaxContext'];
    const providerMax = c.provider?.capabilities?.maxContext;
    const maxContext =
      typeof metaLimit === 'number' && metaLimit > 0
        ? metaLimit
        : typeof providerMax === 'number' && providerMax > 0
          ? providerMax
          : undefined;
    if (
      typeof c.lastRequestTokens === 'number' &&
      c.lastRequestTokens > 0 &&
      maxContext !== undefined
    ) {
      this.leaderCtxPct = clampPct(Math.round((c.lastRequestTokens / maxContext) * 100));
    }
  }
}
