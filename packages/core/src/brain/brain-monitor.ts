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
 *     observed for `stallMs` (default 5 min), with no tool still running.
 *     A wedged provider call or a dead-loop that produces no work.
 *   - file churn — the same file edited ≥ N times (default 20) within a
 *     sliding window (default 10 min). High edit frequency warrants review,
 *     but does not by itself prove edit/revert oscillation.
 *
 * Decision contract: every consultation offers [steer | continue] with
 * fallback `ask_human`, at `medium` risk. Degradation is safe by design:
 *   - tiered brain with an LLM layer → a real judgement call, with the
 *     LLM's rationale becoming the steer text;
 *   - policy-only brain → human escalation or terminal deny → no automatic steer.
 *
 * Every engagement (whether or not it intervened) emits
 * `brain.intervention` for the TUI/WebUI surfaces, and is rate-limited by
 * a per-signal cooldown so the Brain never spams the agent.
 *
 * @module brain-monitor
 */

import { randomUUID } from 'node:crypto';
import type { BrainInterventionKind } from '@wrongstack/contracts/kernel/events';
import type { BrainDecision, BrainDecisionRequest } from './brain.js';
import { editedPaths } from './brain-monitor-paths.js';
import type {
  BrainMonitorOptions,
  BrainMonitorPolicy,
  BrainMonitorSignalToggles,
  BrainMonitorTunables,
} from './brain-monitor-types.js';

export type {
  BrainInterventionInput,
  BrainMonitorOptions,
  BrainMonitorPolicy,
  BrainMonitorSignalToggles,
  BrainMonitorTunables,
} from './brain-monitor-types.js';

/** Tools whose successful execution mutates a file we can churn-track. */
export const DEFAULT_FILE_EDIT_TOOLS: readonly string[] = [
  'edit',
  'write',
  'patch',
  'multi_edit',
  'multiedit',
  'str_replace',
];

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
  toolRecoveries: Map<string, object>;
  runEpoch: number;
  errorTimestamps: number[];
  editTimestamps: Map<string, number[]>;
  /** Per-kind engagement cooldown. One session's steer must not mute another's. */
  lastEngagedAt: Map<string, number>;
  /** At most one in-flight engagement per session — an LLM call takes seconds. */
  engaging: boolean;
  activeRuns: number;
  activeTools: Set<string>;
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
  /** Invalidates every pending consultation on stop or reconfiguration. */
  private generation = 0;
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
        toolRecoveries: new Map(),
        runEpoch: 0,
        errorTimestamps: [],
        editTimestamps: new Map(),
        lastEngagedAt: new Map(),
        engaging: false,
        activeRuns: 0,
        activeTools: new Set(),
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
    this.fileChurnThreshold = next.fileChurnThreshold ?? 20;
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
        if (e.id) state.activeTools.delete(e.id);
        state.lastProgressAt = Date.now();
        this.trackFileChurn(state, e.sessionId, e.name, e.ok, e.input, e.writeTargets);
        if (!this.signals.toolFailureStreak) return;
        if (e.ok) {
          if (state.engaging) state.toolRecoveries.set(e.name, {});
          state.failStreaks.delete(e.name);
          return;
        }
        const streak = (state.failStreaks.get(e.name) ?? 0) + 1;
        state.failStreaks.set(e.name, streak);
        if (streak >= this.toolFailureStreak) {
          state.failStreaks.delete(e.name);
          const toolName = e.name;
          const recovery = state.toolRecoveries.get(toolName);
          void this.engage('tool_failure_streak', e.sessionId, {
            stillRelevant: () => state.toolRecoveries.get(toolName) === recovery,
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

    // Run ownership invalidates every signal, even with the stall watchdog off.
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
        if (lsid && e.sessionId && e.sessionId !== lsid && !this.bySession.has(e.sessionId)) return;
        const state = this.stateFor(e.sessionId);
        state.activeRuns = Math.max(0, state.activeRuns - 1);
        if (state.activeRuns === 0) {
          state.activeTools.clear();
          state.runEpoch++;
        }
      }),
    );

    // ── Agent-stall watchdog ─────────────────────────────────────────────
    if (this.stallMs > 0 && this.signals.agentStall) {
      this.unsubscribers.push(
        this.opts.events.on('tool.started', (e) => {
          const lsid = this.resolveLeaderSessionId();
          if (lsid && e.sessionId && e.sessionId !== lsid) return;
          const state = this.stateFor(e.sessionId);
          state.activeTools.add(e.id);
          state.lastProgressAt = Date.now();
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
          // Tool execution has its own timeout/cancellation policy. A silent,
          // long-running command is not evidence that the agent has stalled.
          if (state.activeRuns === 0 || state.activeTools.size > 0 || state.lastProgressAt === 0)
            continue;
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
          const evidence = state.errorTimestamps;
          const count = state.errorTimestamps.length;
          state.errorTimestamps = [];
          const message = e.err instanceof Error ? e.err.message : String(e.err);
          void this.engage('error_storm', e.sessionId, {
            stillRelevant: () =>
              evidence.filter((t) => Date.now() - t <= this.errorStormWindowMs).length >=
              this.errorStormCount,
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
    this.generation++;
    this.running = false;
    for (const off of this.unsubscribers) off();
    this.unsubscribers.length = 0;
    // Accumulating evidence resets per session; engagement cooldowns are
    // preserved so re-tuning cannot be used to bypass the rate limit.
    for (const state of this.bySession.values()) {
      state.failStreaks.clear();
      state.toolRecoveries.clear();
      state.errorTimestamps = [];
      state.editTimestamps.clear();
      state.activeRuns = 0;
      state.activeTools.clear();
      state.lastProgressAt = 0;
      state.engaging = false;
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
    writeTargets?: readonly string[] | undefined,
  ): void {
    if (!this.signals.fileChurn) return;
    if (!ok || !this.fileEditTools.has(toolName.toLowerCase())) return;
    const now = Date.now();
    for (const { key, path } of editedPaths(input, writeTargets)) {
      // One engagement per call: a patch touching several churned files is
      // one oscillation to steer, and engage() is rate-limited anyway.
      if (this.trackFileEdit(state, sessionId, key, path, now)) return;
    }
  }

  /** Record one edit (`key` counts, `path` is shown); true when it engaged the churn signal. */
  private trackFileEdit(
    state: SessionSignalState,
    sessionId: string | undefined,
    key: string,
    path: string,
    now: number,
  ): boolean {
    const stamps = (state.editTimestamps.get(key) ?? []).filter(
      (t) => now - t <= this.fileChurnWindowMs,
    );
    stamps.push(now);
    if (stamps.length >= this.fileChurnThreshold) {
      state.editTimestamps.delete(key);
      void this.engage('file_churn', sessionId, {
        stillRelevant: () =>
          stamps.filter((t) => Date.now() - t <= this.fileChurnWindowMs).length >=
          this.fileChurnThreshold,
        question: `The file "${path}" has been edited ${stamps.length} times within ${Math.round(this.fileChurnWindowMs / 60_000)} minutes. Edit frequency alone does not establish an edit/revert loop; incremental implementation can legitimately require many edits. Is there independent evidence of repeated reversals or lack of progress that warrants steering? Otherwise, let the agent continue.`,
        context: [
          `File: ${path}`,
          `Edits in window: ${stamps.length}`,
          `Window: ${Math.round(this.fileChurnWindowMs / 1000)}s`,
        ].join('\n'),
      });
      return true;
    }
    if (state.editTimestamps.size >= 500 && !state.editTimestamps.has(key)) {
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
    state.editTimestamps.set(key, stamps);
    return false;
  }

  private async engage(
    kind: BrainInterventionKind,
    sessionId: string | undefined,
    input: { question: string; context: string; stillRelevant?: () => boolean },
  ): Promise<void> {
    const state = this.stateFor(sessionId);
    const generation = this.generation;
    const runEpoch = state.runEpoch;
    const progressAtEngagement = state.lastProgressAt;
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
      // A council decision can arrive after work has resumed or the run ended.
      const staleStall =
        kind === 'agent_stall' &&
        (!this.running ||
          state.activeRuns === 0 ||
          state.activeTools.size > 0 ||
          state.lastProgressAt !== progressAtEngagement);
      if (generation !== this.generation || !this.running || !this.enabled) return;
      const staleSignal =
        staleStall || state.runEpoch !== runEpoch || input.stillRelevant?.() === false;
      const intervened = !staleSignal && (await this.maybeIntervene(kind, request, decision));
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
      if (generation === this.generation) {
        state.engaging = false;
        state.toolRecoveries.clear();
      }
    }
  }

  private async maybeIntervene(
    kind: string,
    request: BrainDecisionRequest,
    decision: BrainDecision,
  ): Promise<boolean> {
    if (decision.type !== 'answer') return false;
    // INVARIANT: Brain decisions are control-plane input — act on the exact
    // `optionId`, never on prose.
    //
    // This used to also steer on any free-text answer that did not start with
    // "continue". The request always offers `steer`/`continue`, so an
    // optionless answer means no tier actually made this choice — and it IS
    // reachable (a council whose winner is not one of the offered options
    // used to surface exactly that shape). Regex-matching the prose then
    // injected a steer into a live agent on the strength of a sentence that
    // happened not to begin with the word "continue".
    if (decision.optionId !== 'steer') return false;
    const guidance = decision.rationale?.trim() || decision.text.trim();
    if (guidance.length === 0) return false;
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
