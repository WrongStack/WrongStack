/**
 * BrainMonitor — the Brain's SELF-ACTIVATION layer.
 *
 * The BrainArbiter alone is reactive: subsystems (director, goal,
 * eternal engine) ask it questions. The monitor closes the loop the other
 * way — it WATCHES the live EventBus for distress signals, consults the
 * Brain proactively, and when the decision calls for it, INTERVENES in the
 * running work by delivering a corrective steer to the working agent
 * (steers are folded into the agent's conversation before its next step
 * via the mailbox loop, so no new plumbing is needed).
 *
 * Watched signals:
 *   - tool-failure streak — the same tool failing N times consecutively
 *     (default 3). Classic stuck-loop: the agent keeps retrying an
 *     approach that does not work.
 *   - error storm — N `error` events within a sliding window (default
 *     4 in 60s). Something is systematically wrong.
 *   - agent stall — a run is active (`agent.run.started` without its
 *     matching completion) but no tool call or iteration progress has been
 *     observed for `stallMs` (default 5 min). A wedged provider call or a
 *     dead-loop that produces no work.
 *   - file churn — the same file edited ≥ N times (default 5) within a
 *     sliding window (default 10 min). Classic edit/revert oscillation:
 *     the agent keeps rewriting the same file without converging.
 *
 * Decision contract: every consultation offers [steer | continue] with
 * fallback `continue`, at `medium` risk. Degradation is safe by design:
 *   - tiered brain with an LLM layer → a real judgement call, with the
 *     LLM's rationale becoming the steer text;
 *   - policy-only brain → fallback `continue` → observe, never interfere.
 *
 * Every engagement (whether or not it intervened) emits
 * `brain.intervention` for the TUI/WebUI surfaces, and is rate-limited by
 * a per-signal cooldown so the Brain never spams the agent.
 *
 * @module brain-monitor
 */

import { randomUUID } from 'node:crypto';
import type { BrainInterventionKind, EventBus } from '../kernel/events.js';
import type { BrainArbiter, BrainDecision, BrainDecisionRequest } from './brain.js';

export type { BrainInterventionKind };

export interface BrainInterventionInput {
  subject: string;
  body: string;
  /**
   * The session whose distress triggered this intervention.
   *
   * The steer has to reach THAT leader. A host that resolves the target from
   * its own "current session" instead delivers the correction to whichever
   * session is in front — with several sessions live under one host, the tab
   * that is struggling gets nothing and an unrelated one is told to change
   * approach. Undefined only when the signal itself carried no session.
   */
  sessionId?: string | undefined;
}

/**
 * How a detected distress signal is resolved.
 *
 * - `llm` (default) — consult the Brain. Historically the ONLY behaviour, and
 *   an expensive one: the monitor's request carries options, `medium` risk and
 *   `fallback: 'ask_human'`, which defeats `quickDecide` (it declines
 *   option-bearing requests) and the low-risk policy fast path alike, so every
 *   engagement reached a provider. Deterministic handling is available without
 *   leaving this mode by adding a `brain.rules` entry matching
 *   `source: 'system'` with `offersOption: 'steer'` — the rule tier runs in
 *   front of everything that costs tokens.
 * - `steer` — always intervene, no Brain call at all.
 * - `observe` — never intervene; only emit `brain.intervention` for the
 *   surfaces. Useful to measure how often signals fire before acting on them.
 */
export type BrainMonitorPolicy = 'llm' | 'steer' | 'observe';

/** Per-signal kill switches. Omitted = enabled. */
export interface BrainMonitorSignalToggles {
  toolFailureStreak?: boolean | undefined;
  errorStorm?: boolean | undefined;
  agentStall?: boolean | undefined;
  fileChurn?: boolean | undefined;
}

export interface BrainMonitorOptions {
  events: EventBus;
  brain: BrainArbiter;
  /** Active host session id, read lazily so resume/new-session switches are reflected. */
  sessionId?: (() => string | undefined) | undefined;
  /**
   * Leader session id used to filter out subagent events. The BrainMonitor
   * subscribes to global events (tool.executed, agent.run.*, error, etc.)
   * which fire for BOTH the leader agent and subagents. Without this filter,
   * a subagent's tool failures or stalls incorrectly trigger a steer to the
   * leader — disrupting the leader's work for problems it didn't cause.
   *
   * When set, any event whose `sessionId` differs from this value is skipped.
   * Events without a `sessionId` field are always passed through (backward
   * compatibility). Pass a **lazy getter** when the session id may change
   * at runtime (session resume), or a string for static sessions.
   */
  leaderSessionId?: string | (() => string | undefined) | undefined;
  /**
   * Deliver a corrective steer to the working agent(s). Hosts typically
   * send a `steer` mail to this session's leader via the project mailbox — the agent loop injects it before the next LLM call.
   */
  intervene: (input: BrainInterventionInput) => Promise<void>;
  /** Consecutive failures of the SAME tool before engaging. Default 3. */
  toolFailureStreak?: number | undefined;
  /** Number of `error` events within the window before engaging. Default 4. */
  errorStormCount?: number | undefined;
  /** Sliding window for the error storm signal (ms). Default 60_000. */
  errorStormWindowMs?: number | undefined;
  /**
   * Active run with no observable progress (tool call / iteration) for this
   * long → agent-stall signal. Default 300_000 (5 min). 0 disables.
   */
  stallMs?: number | undefined;
  /** How often the stall watchdog checks (ms). Default 30_000. */
  stallCheckIntervalMs?: number | undefined;
  /** Edits to the SAME file within the churn window before engaging. Default 5. */
  fileChurnThreshold?: number | undefined;
  /** Sliding window for the file-churn signal (ms). Default 600_000 (10 min). */
  fileChurnWindowMs?: number | undefined;
  /** Minimum gap between engagements of the same signal kind (ms). Default 120_000. */
  cooldownMs?: number | undefined;
  /** Master kill switch. Default true; false makes `start()` a no-op. */
  enabled?: boolean | undefined;
  /** How an engagement is resolved. Default 'llm'. */
  policy?: BrainMonitorPolicy | undefined;
  /** Per-signal kill switches. Omitted signals stay enabled. */
  signals?: BrainMonitorSignalToggles | undefined;
  /**
   * Tool names whose successful execution counts as a file edit for the
   * churn signal. Replaces the built-in set; matched case-insensitively.
   * Needed by hosts whose edit tools are named differently — otherwise the
   * churn signal silently never fires for them.
   */
  fileEditTools?: readonly string[] | undefined;
}

/**
 * The subset of `BrainMonitorOptions` that can be re-applied to a running
 * monitor via `reconfigure()` — everything except the wiring (`events`,
 * `brain`, `intervene`, session-id resolvers), which is fixed for the
 * monitor's lifetime. Mirrors `BrainConfig.monitor`.
 */
export type BrainMonitorTunables = Partial<
  Pick<
    BrainMonitorOptions,
    | 'enabled'
    | 'policy'
    | 'signals'
    | 'toolFailureStreak'
    | 'errorStormCount'
    | 'errorStormWindowMs'
    | 'stallMs'
    | 'stallCheckIntervalMs'
    | 'fileChurnThreshold'
    | 'fileChurnWindowMs'
    | 'cooldownMs'
    | 'fileEditTools'
  >
>;

/** Tools whose successful execution mutates a file we can churn-track. */
export const DEFAULT_FILE_EDIT_TOOLS: readonly string[] = [
  'edit',
  'write',
  'patch',
  'multi_edit',
  'multiedit',
  'str_replace',
];

/** Best-effort path extraction from a file-editing tool's input. */
function editedPath(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const r = input as Record<string, unknown>;
  const candidate = r['file_path'] ?? r['path'] ?? r['filePath'] ?? r['file'];
  return typeof candidate === 'string' && candidate.length > 0 ? candidate : undefined;
}

/**
 * Everything the monitor accumulates while watching ONE session.
 *
 * These used to be flat instance fields, which made every counter project-wide:
 * with several sessions live under one host, tab 1's failing tool and tab 2's
 * failing tool advanced the SAME streak, and whichever crossed the threshold
 * engaged the Brain with the host's current session id attached. The steer then
 * went to a session that was doing nothing wrong, while the one that was
 * actually stuck got no help. Distress is a property of a session, so the
 * evidence for it has to be too.
 */
interface SessionSignalState {
  failStreaks: Map<string, number>;
  errorTimestamps: number[];
  editTimestamps: Map<string, number[]>;
  /** Per-kind engagement cooldown. One session's steer must not mute another's. */
  lastEngagedAt: Map<string, number>;
  /** At most one in-flight engagement per session — an LLM call takes seconds. */
  engaging: boolean;
  activeRuns: number;
  lastProgressAt: number;
  /** Last time anything at all was recorded, for pruning idle sessions. */
  touchedAt: number;
}

/** Bucket for events that name no session (a host that does not stamp them). */
const UNATTRIBUTED_SESSION = '';

/**
 * Ceiling on tracked sessions. Four tabs is the supported maximum; the slack
 * absorbs sessions that end while their window is still open. Idle buckets are
 * pruned before this ever bites.
 */
const MAX_TRACKED_SESSIONS = 16;

export class BrainMonitor {
  private readonly bySession = new Map<string, SessionSignalState>();
  private readonly unsubscribers: Array<() => void> = [];
  private stallTimer: ReturnType<typeof setInterval> | undefined;

  // Mutable, not readonly: `reconfigure()` re-applies these live. Every knob
  // on the Brain except these used to be live-editable, so `/brain monitor …`
  // reported success and then quietly did nothing until the next session.
  private toolFailureStreak!: number;
  private errorStormCount!: number;
  private errorStormWindowMs!: number;
  private stallMs!: number;
  private stallCheckIntervalMs!: number;
  private fileChurnThreshold!: number;
  private fileChurnWindowMs!: number;
  private cooldownMs!: number;
  private enabled!: boolean;
  private policy!: BrainMonitorPolicy;
  private signals!: Required<BrainMonitorSignalToggles>;
  private fileEditTools!: ReadonlySet<string>;
  /** True while the watchers are attached; guards against double-subscribing. */
  private running = false;
  /**
   * HOST INTENT: set by `start()`, cleared by `stop()`. Distinct from
   * `running`, which is whether anything is currently attached — a monitor the
   * host started but that is `enabled: false` is intended-active yet detached,
   * and that is exactly the state `reconfigure({enabled: true})` must revive.
   */
  private hostStarted = false;

  /** Resolve the leader's own session id for event filtering. */
  private resolveLeaderSessionId(): string | undefined {
    const id = this.opts.leaderSessionId;
    return typeof id === 'function' ? id() : id;
  }

  /**
   * The signal state for one session, created on first sight.
   *
   * A host that pins `leaderSessionId` (the CLI, one session per process) only
   * ever reaches one bucket. A host that does not (the WebUI, four tabs on one
   * runtime) gets one bucket per tab, which is the point.
   */
  private stateFor(sessionId: string | undefined): SessionSignalState {
    const key = sessionId || UNATTRIBUTED_SESSION;
    let state = this.bySession.get(key);
    if (!state) {
      this.pruneIdleSessions();
      state = {
        failStreaks: new Map(),
        errorTimestamps: [],
        editTimestamps: new Map(),
        lastEngagedAt: new Map(),
        engaging: false,
        activeRuns: 0,
        lastProgressAt: 0,
        touchedAt: Date.now(),
      };
      this.bySession.set(key, state);
    }
    state.touchedAt = Date.now();
    return state;
  }

  /**
   * Drop buckets for sessions that have been quiet longer than any signal
   * window. Without this a long-lived host accumulates one bucket per session
   * it has ever seen — cheap individually, unbounded in aggregate.
   *
   * Cooldowns are the one thing worth losing sleep over here: pruning a bucket
   * resets its rate limit. That is acceptable only because the prune horizon is
   * strictly longer than the cooldown, so a pruned session could have engaged
   * again anyway.
   */
  private pruneIdleSessions(): void {
    if (this.bySession.size < MAX_TRACKED_SESSIONS) return;
    const now = Date.now();
    const horizon = Math.max(
      this.fileChurnWindowMs,
      this.errorStormWindowMs,
      this.stallMs,
      this.cooldownMs,
    );
    for (const [key, state] of this.bySession) {
      if (state.engaging) continue;
      if (now - state.touchedAt > horizon) this.bySession.delete(key);
    }
    // Still full: evict the least recently touched idle bucket.
    if (this.bySession.size >= MAX_TRACKED_SESSIONS) {
      let oldestKey: string | undefined;
      let oldestAt = Number.POSITIVE_INFINITY;
      for (const [key, state] of this.bySession) {
        if (state.engaging) continue;
        if (state.touchedAt < oldestAt) {
          oldestAt = state.touchedAt;
          oldestKey = key;
        }
      }
      if (oldestKey !== undefined) this.bySession.delete(oldestKey);
    }
  }

  constructor(private readonly opts: BrainMonitorOptions) {
    this.applyTunables(opts);
  }

  /** Resolve the live-tunable subset onto the instance. Shared by the constructor and `reconfigure`. */
  private applyTunables(next: BrainMonitorTunables): void {
    this.toolFailureStreak = next.toolFailureStreak ?? 3;
    this.errorStormCount = next.errorStormCount ?? 4;
    this.errorStormWindowMs = next.errorStormWindowMs ?? 60_000;
    this.stallMs = next.stallMs ?? 300_000;
    this.stallCheckIntervalMs = next.stallCheckIntervalMs ?? 30_000;
    this.fileChurnThreshold = next.fileChurnThreshold ?? 5;
    this.fileChurnWindowMs = next.fileChurnWindowMs ?? 600_000;
    this.cooldownMs = next.cooldownMs ?? 120_000;
    this.enabled = next.enabled ?? true;
    this.policy = next.policy ?? 'llm';
    this.signals = {
      toolFailureStreak: next.signals?.toolFailureStreak ?? true,
      errorStorm: next.signals?.errorStorm ?? true,
      agentStall: next.signals?.agentStall ?? true,
      fileChurn: next.signals?.fileChurn ?? true,
    };
    this.fileEditTools = new Set(
      (next.fileEditTools ?? DEFAULT_FILE_EDIT_TOOLS).map((name) => name.toLowerCase()),
    );
  }

  /** The resolved tunables, for change detection. */
  private tunableFingerprint(): string {
    return JSON.stringify([
      this.toolFailureStreak,
      this.errorStormCount,
      this.errorStormWindowMs,
      this.stallMs,
      this.stallCheckIntervalMs,
      this.fileChurnThreshold,
      this.fileChurnWindowMs,
      this.cooldownMs,
      this.enabled,
      this.policy,
      this.signals,
      [...this.fileEditTools].sort(),
    ]);
  }

  /**
   * Apply new thresholds to a (possibly running) monitor.
   *
   * Hosts call this from the BrainRuntime's `onApplied`, which fires on EVERY
   * Brain setting change — so an unchanged monitor block must be a no-op, or
   * `/brain risk` would reset the monitor's in-flight streaks as a side effect.
   * That is what the fingerprint comparison is for; the return value says
   * whether anything actually moved.
   *
   * A real change re-subscribes rather than patching in place: `stallMs: 0`
   * and the per-signal toggles decide which listeners and timers exist at all,
   * so only a fresh attach can honour them. Accumulating counters (failure
   * streaks, the error window, churn timestamps) reset with the restart, which
   * is the right semantics — a partial streak measured against the OLD
   * threshold is not evidence for the new one. Engagement cooldowns are
   * deliberately preserved (`detach()` does not clear them), so re-tuning
   * cannot be used to bypass the rate limit.
   *
   * The re-attach is driven by HOST INTENT (`hostStarted`), not by whether the
   * watchers happen to be attached right now: toggling `enabled` false and
   * then true again must reattach, and after the first toggle nothing is
   * attached to observe.
   */
  reconfigure(next: BrainMonitorTunables): boolean {
    const before = this.tunableFingerprint();
    this.applyTunables(next);
    if (this.tunableFingerprint() === before) return false;
    if (this.hostStarted) {
      this.detach();
      this.attach();
    }
    return true;
  }

  /** Begin watching. Idempotent; a disabled monitor records the intent and stays detached. */
  start(): void {
    this.hostStarted = true;
    this.attach();
  }

  private attach(): void {
    if (!this.enabled || this.running) return;
    this.running = true;
    this.unsubscribers.push(
      this.opts.events.on('tool.executed', (e) => {
        // Ignore subagent tool events — only respond to the leader's own tool activity
        const leaderSid = this.resolveLeaderSessionId();
        if (leaderSid && e.sessionId && e.sessionId !== leaderSid) return;

        const state = this.stateFor(e.sessionId);
        state.lastProgressAt = Date.now();
        this.trackFileChurn(state, e.sessionId, e.name, e.ok, e.input);
        if (!this.signals.toolFailureStreak) return;
        if (e.ok) {
          state.failStreaks.delete(e.name);
          return;
        }
        const streak = (state.failStreaks.get(e.name) ?? 0) + 1;
        state.failStreaks.set(e.name, streak);
        if (streak >= this.toolFailureStreak) {
          state.failStreaks.delete(e.name);
          void this.engage('tool_failure_streak', e.sessionId, {
            question: `The tool "${e.name}" has failed ${streak} times in a row. Should the agent be steered to a different approach?`,
            context: [
              `Tool: ${e.name}`,
              `Consecutive failures: ${streak}`,
              e.output ? `Last output (truncated): ${String(e.output).slice(0, 400)}` : '',
            ]
              .filter(Boolean)
              .join('\n'),
          });
        }
      }),
    );

    // ── Agent-stall watchdog ─────────────────────────────────────────────
    if (this.stallMs > 0 && this.signals.agentStall) {
      this.unsubscribers.push(
        this.opts.events.on('agent.run.started', (e) => {
          // Ignore subagent run events — only track the leader's runs
          const lsid = this.resolveLeaderSessionId();
          if (lsid && e.sessionId && e.sessionId !== lsid) return;
          const state = this.stateFor(e.sessionId);
          state.activeRuns += 1;
          state.lastProgressAt = Date.now();
        }),
        // `agent.run.completed` is the only terminator. `Agent.run` emits it on
        // every exit path — the success path and, unconditionally, the catch
        // path — and emits `agent.run.error` *in addition* when a run fails
        // (`core/agent.ts:302` then `:310`). Decrementing on both meant one
        // failed run subtracted two, and the `Math.max(0, …)` clamp hid it
        // instead of letting the counter go visibly negative.
        //
        // The effect was that the watchdog below stopped watching: with two
        // concurrent runs where one fails, `activeRuns` reaches 0 while a run
        // is still live, and the stall check returns early on every tick.
        this.opts.events.on('agent.run.completed', (e) => {
          const lsid = this.resolveLeaderSessionId();
          if (lsid && e.sessionId && e.sessionId !== lsid) return;
          const state = this.stateFor(e.sessionId);
          state.activeRuns = Math.max(0, state.activeRuns - 1);
        }),
        this.opts.events.on('iteration.started', (e) => {
          const lsid = this.resolveLeaderSessionId();
          if (lsid && e.sessionId && e.sessionId !== lsid) return;
          this.stateFor(e.sessionId).lastProgressAt = Date.now();
        }),
      );
      this.stallTimer = setInterval(() => {
        // Each session stalls on its own clock: a busy tab must not keep a
        // stuck neighbour's watchdog re-armed, which is what one shared
        // `lastProgressAt` did.
        for (const [key, state] of this.bySession) {
          if (state.activeRuns === 0 || state.lastProgressAt === 0) continue;
          const idleMs = Date.now() - state.lastProgressAt;
          if (idleMs < this.stallMs) continue;
          // Re-arm from now so a declined steer doesn't re-fire every tick
          // (the per-kind cooldown also applies).
          state.lastProgressAt = Date.now();
          void this.engage('agent_stall', key || undefined, {
            question: `An active run has made no observable progress (no tool call or iteration) for ${Math.round(idleMs / 60_000)} minute(s). Should the agent be steered before more time is wasted?`,
            context: [
              `Active runs: ${state.activeRuns}`,
              `Idle for: ${Math.round(idleMs / 1000)}s`,
              `Stall threshold: ${Math.round(this.stallMs / 1000)}s`,
            ].join('\n'),
          });
        }
      }, this.stallCheckIntervalMs);
      this.stallTimer.unref?.();
    }

    this.unsubscribers.push(
      this.opts.events.on('error', (e) => {
        if (!this.signals.errorStorm) return;
        // Ignore subagent errors — only respond to the leader's own errors
        const lsid = this.resolveLeaderSessionId();
        if (lsid && e.sessionId && e.sessionId !== lsid) return;

        const now = Date.now();
        const state = this.stateFor(e.sessionId);
        state.errorTimestamps.push(now);
        state.errorTimestamps = state.errorTimestamps.filter(
          (t) => now - t <= this.errorStormWindowMs,
        );
        if (state.errorTimestamps.length >= this.errorStormCount) {
          const count = state.errorTimestamps.length;
          state.errorTimestamps = [];
          const message = e.err instanceof Error ? e.err.message : String(e.err);
          void this.engage('error_storm', e.sessionId, {
            question: `${count} errors occurred within ${Math.round(this.errorStormWindowMs / 1000)}s (phase: ${e.phase}). Should the agent be steered before more work is wasted?`,
            context: `Latest error: ${message.slice(0, 400)}`,
          });
        }
      }),
    );
  }

  /** Stop watching and drop the host's intent to watch. */
  stop(): void {
    this.hostStarted = false;
    this.detach();
  }

  /**
   * Tear down the watchers without touching host intent. Note `lastEngagedAt`
   * is deliberately NOT cleared — cooldowns must survive a reconfigure so
   * re-tuning cannot be used to bypass the engagement rate limit.
   */
  private detach(): void {
    this.running = false;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    // Accumulating evidence resets per session; engagement cooldowns are
    // preserved so re-tuning cannot be used to bypass the rate limit.
    for (const state of this.bySession.values()) {
      state.failStreaks.clear();
      state.errorTimestamps = [];
      state.editTimestamps.clear();
      state.activeRuns = 0;
      state.lastProgressAt = 0;
    }
    if (this.stallTimer) {
      clearInterval(this.stallTimer);
      this.stallTimer = undefined;
    }
  }

  /** Sliding-window count of successful edits per file → churn signal. */
  private trackFileChurn(
    state: SessionSignalState,
    sessionId: string | undefined,
    toolName: string,
    ok: boolean,
    input: unknown,
  ): void {
    if (!this.signals.fileChurn) return;
    if (!ok || !this.fileEditTools.has(toolName.toLowerCase())) return;
    const path = editedPath(input);
    if (!path) return;
    const now = Date.now();
    const stamps = (state.editTimestamps.get(path) ?? []).filter(
      (t) => now - t <= this.fileChurnWindowMs,
    );
    stamps.push(now);
    if (stamps.length >= this.fileChurnThreshold) {
      state.editTimestamps.delete(path);
      void this.engage('file_churn', sessionId, {
        question: `The file "${path}" has been edited ${stamps.length} times within ${Math.round(this.fileChurnWindowMs / 60_000)} minutes — the agent may be oscillating (edit/revert loop) instead of converging. Should it be steered?`,
        context: [
          `File: ${path}`,
          `Edits in window: ${stamps.length}`,
          `Window: ${Math.round(this.fileChurnWindowMs / 1000)}s`,
        ].join('\n'),
      });
      return;
    }
    if (state.editTimestamps.size >= 500 && !state.editTimestamps.has(path)) {
      for (const [p, times] of state.editTimestamps) {
        if (times.every((t) => now - t > this.fileChurnWindowMs)) {
          state.editTimestamps.delete(p);
        }
      }
      if (state.editTimestamps.size >= 500) {
        const oldest = state.editTimestamps.keys().next().value;
        if (oldest !== undefined) state.editTimestamps.delete(oldest);
      }
    }
    state.editTimestamps.set(path, stamps);
  }

  private async engage(
    kind: BrainInterventionKind,
    sessionId: string | undefined,
    input: { question: string; context: string },
  ): Promise<void> {
    const state = this.stateFor(sessionId);
    // Rate limits, PER SESSION: a per-kind cooldown plus never more than one
    // engagement in flight for that session (an LLM-backed brain call takes
    // seconds). Sharing either across sessions meant one busy tab could
    // silence the Brain for every other tab.
    const last = state.lastEngagedAt.get(kind) ?? 0;
    if (state.engaging || Date.now() - last < this.cooldownMs) return;
    state.engaging = true;
    state.lastEngagedAt.set(kind, Date.now());
    try {
      const request: BrainDecisionRequest = {
        id: `brainmon-${randomUUID()}`,
        // The session whose evidence triggered this — NOT the host's current
        // one. They differ the moment two sessions run under one host, and
        // taking the host's sent the steer to the wrong leader.
        sessionId: sessionId ?? this.opts.sessionId?.(),
        source: 'system',
        question: input.question,
        context: input.context,
        // Deliberately NO `recommended` option. "Should I interrupt the
        // working agent?" has no caller-known safe default, and marking one
        // had two costs:
        //
        //   1. `terminalPolicyDecision` accepts a recommended option at
        //      low/medium risk, so whenever the LLM pool was unreachable the
        //      escalation collapsed to "steer" — a dead provider made the
        //      monitor inject a canned, model-less guidance string on EVERY
        //      signal. It now denies instead, which `maybeIntervene` reads as
        //      "do not interfere", leaving the engagement observe-only (the
        //      `brain.intervention` event still fires, with intervened=false).
        //   2. `buildBrainUserMessage` renders "★ recommended" into the
        //      prompt, biasing the model toward intervening on a question it
        //      is being asked precisely to judge neutrally.
        options: [
          {
            id: 'steer',
            label: 'Steer the agent with corrective guidance',
            consequence: 'A steer message is injected before its next step.',
            risk: 'low',
          },
          {
            id: 'continue',
            label: 'Let the agent continue unaided',
            risk: 'low',
          },
        ],
        risk: 'medium',
        // 'ask_human' routes to the LLM-backed autonomous layer via
        // createTieredBrainArbiter before any human escalation.
        fallback: 'ask_human',
      };
      // Deterministic policies resolve the signal WITHOUT consulting the
      // Brain at all — no provider call, no rule evaluation, no escalation.
      const decision: BrainDecision =
        this.policy === 'steer'
          ? {
              type: 'answer',
              optionId: 'steer',
              text: 'Steer the agent with corrective guidance',
              rationale: `Monitor policy "steer": ${kind.replace(/_/g, ' ')} always warrants a steer.`,
            }
          : this.policy === 'observe'
            ? {
                type: 'answer',
                optionId: 'continue',
                text: 'Let the agent continue unaided',
                rationale: `Monitor policy "observe": signals are recorded but never acted on.`,
              }
            : await this.opts.brain.decide(request);
      const intervened = await this.maybeIntervene(kind, request, decision);
      this.opts.events.emit('brain.intervention', {
        sessionId: request.sessionId,
        kind,
        request,
        decision,
        intervened,
        at: Date.now(),
      });
    } catch {
      // The monitor must never destabilize the host it protects.
    } finally {
      state.engaging = false;
    }
  }

  private async maybeIntervene(
    kind: string,
    request: BrainDecisionRequest,
    decision: BrainDecision,
  ): Promise<boolean> {
    if (decision.type !== 'answer') return false;
    // Intervene when the brain explicitly chose the steer option, or gave a
    // free-text answer that is not the bare continue fallback.
    const choseSteer = decision.optionId === 'steer';
    const freeTextGuidance =
      !decision.optionId &&
      !/^continue\b/i.test(decision.text.trim()) &&
      decision.text.trim().length > 0;
    if (!choseSteer && !freeTextGuidance) return false;
    const guidance = decision.rationale?.trim() || decision.text.trim();
    try {
      await this.opts.intervene({
        sessionId: request.sessionId,
        subject: `Brain intervention: ${kind.replace(/_/g, ' ')}`,
        body: [
          `The Brain engaged after detecting: ${request.question}`,
          '',
          `Guidance: ${guidance}`,
          '',
          'Adjust your approach accordingly — do not simply retry the same action.',
        ].join('\n'),
      });
      return true;
    } catch {
      return false;
    }
  }
}
