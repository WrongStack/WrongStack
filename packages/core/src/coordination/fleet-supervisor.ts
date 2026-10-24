import {
  engageBacklog as delegateEngageBacklog,
  engageRebalance as delegateEngageRebalance,
  type FleetSupervisorRebalanceHost,
} from './fleet-supervisor-rebalance.js';
import type {
  FleetSupervisorOptions,
  ResolvedSupervisorConfig,
  SupervisedSubagent,
  SupervisorLogEntry,
} from './fleet-supervisor-rebalance-types.js';

export type {
  FleetSupervisorActions,
  FleetSupervisorOptions,
  FleetSupervisorSource,
  SupervisedSubagent,
  SupervisorLogEntry,
} from './fleet-supervisor-rebalance-types.js';

/**
 * FleetSupervisor — brain-gated shadow watcher over the generic fleet.
 *
 * The Director gives a leader agent orchestration TOOLS; this module gives
 * the fleet a SUPERVISOR that works even while the leader is deep in its
 * own task: it continuously watches queue shape + worker activity, detects
 * imbalance (a pending task starving behind a busy worker while a sibling
 * idles, a deep backlog, a stuck or repeatedly-failing worker), and — after
 * clearing every proposal through the tiered BrainArbiter (policy → LLM →
 * human, honoring the /brain risk ceiling) — acts: retargets pending
 * tasks ("I'm reducing your workload"), spawns a helper, steers an agent
 * by mail, notifies the leader, or (opt-in) terminates.
 *
 * Design lineage: BrainMonitor (watch bus → decide → intervene, cooldowns,
 * single engagement in flight) generalized from "steer the leader" to the
 * full fleet action set; SddSupervisor's brain-verdict contract reused for
 * the decision step. The SDD subsystem itself is untouched.
 *
 * Non-interference guarantees (also pinned by tests):
 *   - never calls extend/deny on budget negotiations — the Director's
 *     budgetFilter remains the sole negotiator; we only OBSERVE events
 *   - never preempts a RUNNING task — only still-pending tasks move
 *   - never flips autonomy mode
 *   - dormant once the director declares work complete
 *
 * @module fleet-supervisor
 */

import { randomUUID } from 'node:crypto';
import type { TaskSpec } from '@wrongstack/contracts/types/multi-agent';
import type { BrainDecision, BrainDecisionOption, BrainDecisionRequest } from '../brain/brain.js';
import {
  engageFailureStreak as engageFailureStreakImpl,
  engageIdleWithWork as engageIdleWithWorkImpl,
  engageLooping as engageLoopingImpl,
  engageStuck as engageStuckImpl,
} from './fleet-supervisor-worker-health.js';

export type { FleetSupervisorConfig } from '@wrongstack/contracts/types/config';

/** Collab subagents (spawned by /collab review flows) and host-owned resident
 *  companions are never supervised — same exclusion the Director's budget
 *  filter and sealed-agent boundary apply. */
const COLLAB_ID_PREFIXES = [
  'bug-hunter-',
  'refactor-planner-',
  'critic-',
  'explore-companion-',
  'memory-companion-',
  'skill-companion-',
];

const DEFAULTS = {
  intervalMs: 20_000,
  cooldownMs: 120_000,
  maxInterventionsPerSubagent: 3,
  pinnedWaitMs: 60_000,
  overloadPinnedThreshold: 2,
  backlogFactor: 2,
  stuckMs: 180_000,
  failureStreak: 2,
  loopStreak: 3,
} as const;

const HISTORY_MAX = 100;

export class FleetSupervisor {
  private readonly cfg: ResolvedSupervisorConfig;
  private readonly now: () => number;
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly offHandles: Array<() => void> = [];
  private engaging = false;
  private stopped = false;

  // ── observation state ─────────────────────────────────────────────────
  /** taskId → first tick timestamp we saw it pending. */
  private readonly pendingSince = new Map<string, number>();
  /** subagentId → last observable fleet event timestamp. */
  private readonly lastActivityAt = new Map<string, number>();
  /**
   * subagentId → loop detections since its last successful task.
   *
   * The `stuck_agent` signal cannot see a loop: `lastActivityAt` is refreshed by
   * ANY fleet event, and a worker going in circles is the loudest thing on the
   * bus. So the one failure mode operators actually report — "the watchers
   * never cut the loop" — had no signal at all. The per-agent loop detector
   * already publishes `tool.loop_detected`, and `FleetBus.attach` forwards every
   * subagent event, so the evidence was on the bus the whole time; nothing
   * subscribed to it. Cleared on a successful task (real progress).
   */
  private readonly loopHits = new Map<string, number>();
  /** subagentId → consecutive non-success completions. */
  private readonly failStreaks = new Map<string, number>();
  /** Consecutive ticks the backlog condition held. */
  private backlogTicks = 0;

  // ── rate-limit state ──────────────────────────────────────────────────
  /** `${kind}|${subject}` → last engagement ts. */
  private readonly lastEngagedAt = new Map<string, number>();
  private readonly interventionsBySubagent = new Map<string, number>();
  /** Tasks already retargeted once — never bounced twice. */
  private readonly retargetedTasks = new Set<string>();
  private readonly log: SupervisorLogEntry[] = [];

  constructor(private readonly opts: FleetSupervisorOptions) {
    const c = opts.config ?? {};
    this.cfg = {
      enabled: c.enabled !== false,
      // A timer delay: Node turns one over 2^31-1 ms (or 0/negative/NaN) into
      // 1 ms, which ran the scan back-to-back instead of every few seconds.
      intervalMs:
        typeof c.intervalMs === 'number' && Number.isFinite(c.intervalMs) && c.intervalMs > 0
          ? Math.min(c.intervalMs, 2_147_483_647)
          : DEFAULTS.intervalMs,
      cooldownMs: c.cooldownMs ?? DEFAULTS.cooldownMs,
      maxInterventionsPerSubagent:
        c.maxInterventionsPerSubagent ?? DEFAULTS.maxInterventionsPerSubagent,
      pinnedWaitMs: c.pinnedWaitMs ?? DEFAULTS.pinnedWaitMs,
      overloadPinnedThreshold: c.overloadPinnedThreshold ?? DEFAULTS.overloadPinnedThreshold,
      backlogFactor: c.backlogFactor ?? DEFAULTS.backlogFactor,
      stuckMs: c.stuckMs ?? DEFAULTS.stuckMs,
      loopStreak: c.loopStreak ?? DEFAULTS.loopStreak,
      failureStreak: c.failureStreak ?? DEFAULTS.failureStreak,
      allowSpawn: c.allowSpawn !== false,
      allowTerminate: c.allowTerminate === true,
    };
    this.now = opts.now ?? Date.now;
  }

  /** Idempotent; also re-arms after a stop() so `/supervisor on` works. */
  start(): void {
    if (!this.cfg.enabled || this.timer) return;
    this.stopped = false;
    // Fleet-wide activity map: provider streaming, reasoning, iteration, and
    // tool events all prove the worker is alive. Watching only tool.executed
    // falsely labels long reasoning/provider calls as stuck. This remains
    // observation-only: the supervisor never negotiates a worker's budget.
    this.offHandles.push(
      this.opts.fleet.onAny((e) => {
        if (this.isCollab(e.subagentId)) return;
        this.lastActivityAt.set(e.subagentId, this.now());
      }),
    );
    // Loop detections, forwarded from each worker's own detector.
    this.offHandles.push(
      this.opts.fleet.filter('tool.loop_detected', (e) => {
        if (this.isCollab(e.subagentId)) return;
        this.loopHits.set(e.subagentId, (this.loopHits.get(e.subagentId) ?? 0) + 1);
      }),
    );
    // Failure streaks from the host lifecycle event (terminal per-task).
    this.offHandles.push(
      this.opts.events.on('subagent.task_completed', (e) => {
        if (this.isCollab(e.subagentId)) return;
        if (e.status === 'success') {
          this.failStreaks.delete(e.subagentId);
          // A finished task is the only proof of forward motion we get; the
          // loop tally must not carry across it or an unlucky worker would be
          // condemned by detections from work it already completed.
          this.loopHits.delete(e.subagentId);
        } else {
          this.failStreaks.set(e.subagentId, (this.failStreaks.get(e.subagentId) ?? 0) + 1);
        }
        // A completion frees a worker — re-evaluate soon rather than
        // waiting out the full interval (early-finisher rebalance).
        this.scheduleNudge();
      }),
    );
    // Reclaim per-subagent observation/rate-limit state when a worker is
    // removed. Without this, lastActivityAt / failStreaks /
    // interventionsBySubagent and the subagent-keyed lastEngagedAt entries
    // accumulate one entry per distinct retired subagent for the supervisor's
    // lifetime (tiny entries, but unbounded over a long leader session that
    // spawns thousands of workers). Subagent ids are unique, so pruning on
    // removal cannot affect any live worker. retargetedTasks is keyed by
    // taskId and deliberately retained (see forgetSubagent).
    this.offHandles.push(
      this.opts.events.on('subagent.removed', (e) => {
        this.forgetSubagent(e.subagentId);
      }),
    );
    this.timer = setInterval(() => {
      // evaluate() only wraps its engage* calls in try/catch; a throw from the
      // scan phase (status providers, task listing) would otherwise reject
      // unhandled every tick. Absorb it so supervision degrades quietly.
      void this.evaluate().catch(() => {});
    }, this.cfg.intervalMs);
    this.timer.unref?.();
  }

  stop(): void {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.nudgeTimer) clearTimeout(this.nudgeTimer);
    this.nudgeTimer = null;
    for (const off of this.offHandles.splice(0)) off();
  }

  /**
   * Drop per-subagent observation/rate-limit state when a worker is removed
   * (wired to the coordinator's `subagent.removed` event in start()). Without
   * this, lastActivityAt / failStreaks / interventionsBySubagent and the
   * subagent-keyed lastEngagedAt entries accumulate one entry per distinct
   * retired subagent for the supervisor's lifetime.
   *
   * lastEngagedAt is keyed `${kind}|${subject}` where subject may be a
   * subagentId or a taskId; only the subagent-keyed entries are pruned here.
   * The `|${subagentId}` suffix match cannot collide with a task-keyed entry
   * because neither subagent ids nor task ids contain '|', so a task subject
   * can never end with `|${subagentId}`.
   *
   * retargetedTasks is deliberately NOT pruned: it is keyed by taskId and is
   * the supervisor's "never bounced twice" guard (the overload retarget path
   * skips any task already in this set). Retargets are rare and each entry is
   * a tiny task-id string, so the set is bounded by the count of distinct
   * tasks ever retargeted — retained by design, consistent with prior
   * leak-audit rulings on tiny rare-event collections.
   */
  private forgetSubagent(subagentId: string): void {
    this.lastActivityAt.delete(subagentId);
    this.failStreaks.delete(subagentId);
    this.loopHits.delete(subagentId);
    this.interventionsBySubagent.delete(subagentId);
    const suffix = `|${subagentId}`;
    for (const key of this.lastEngagedAt.keys()) {
      if (key.endsWith(suffix)) this.lastEngagedAt.delete(key);
    }
  }

  history(): readonly SupervisorLogEntry[] {
    return this.log;
  }

  /** True while the evaluation loop is armed. */
  isRunning(): boolean {
    return this.timer !== null;
  }

  /** Resolved (defaulted) configuration — for status surfaces. */
  configSnapshot(): Readonly<ResolvedSupervisorConfig> {
    return { ...this.cfg };
  }

  private nudgeTimer: ReturnType<typeof setTimeout> | null = null;
  private scheduleNudge(): void {
    if (this.nudgeTimer || this.stopped || !this.cfg.enabled) return;
    this.nudgeTimer = setTimeout(() => {
      this.nudgeTimer = null;
      void this.evaluate().catch(() => {});
    }, 5_000);
    this.nudgeTimer.unref?.();
  }

  private isCollab(subagentId: string): boolean {
    return COLLAB_ID_PREFIXES.some((p) => subagentId.startsWith(p));
  }

  /** One evaluation pass. Public for tests; production runs it on the tick. */
  async evaluate(): Promise<void> {
    if (this.stopped || !this.cfg.enabled || this.engaging) return;
    if (this.opts.source.isWorkComplete()) return;
    const now = this.now();
    const subagents = this.opts.source.subagents().filter((s) => !this.isCollab(s.id));
    const pending = this.opts.source
      .listPendingTasks()
      .filter((t) => !t.subagentId || !this.isCollab(t.subagentId));

    // Refresh pending-age tracking.
    const pendingIds = new Set(pending.map((t) => t.id));
    for (const id of this.pendingSince.keys()) {
      if (!pendingIds.has(id)) this.pendingSince.delete(id);
    }
    for (const t of pending) {
      if (!this.pendingSince.has(t.id)) this.pendingSince.set(t.id, now);
    }

    const idle = subagents.filter((s) => s.status === 'idle');
    const running = subagents.filter((s) => s.status === 'running');
    const live = idle.length + running.length;

    // ── Signal 6: failure streak (highest risk first — most urgent) ──────
    for (const [subagentId, streak] of this.failStreaks) {
      if (streak >= this.cfg.failureStreak) {
        this.failStreaks.delete(subagentId);
        await this.engageFailureStreak(subagentId, streak);
        return; // one engagement per pass
      }
    }

    // ── Signal 7: looping worker (busy, but going in circles) ────────────
    // Deliberately ahead of the queue-shape signals: a looping worker is
    // spending budget continuously, and unlike a starved queue it will never
    // resolve itself.
    for (const s of running) {
      const hits = this.loopHits.get(s.id) ?? 0;
      if (hits >= this.cfg.loopStreak) {
        this.loopHits.delete(s.id);
        await this.engageLooping(s, hits);
        return; // one engagement per pass
      }
    }

    // ── Signals 1+2: pinned starvation / overloaded worker ──────────────
    if (idle.length > 0) {
      const runningIds = new Set(running.map((s) => s.id));
      const pinnedByWorker = new Map<string, TaskSpec[]>();
      for (const t of pending) {
        if (!t.subagentId || this.retargetedTasks.has(t.id)) continue;
        if (!runningIds.has(t.subagentId)) continue;
        const list = pinnedByWorker.get(t.subagentId) ?? [];
        list.push(t);
        pinnedByWorker.set(t.subagentId, list);
      }
      for (const [workerId, tasks] of pinnedByWorker) {
        const overloaded = tasks.length >= this.cfg.overloadPinnedThreshold;
        const starved = tasks.filter(
          (t) => now - (this.pendingSince.get(t.id) ?? now) >= this.cfg.pinnedWaitMs,
        );
        if (overloaded || starved.length > 0) {
          // Overload: move the queue tail, keep the head with its owner.
          // Starvation: move every starved task.
          const movable = overloaded ? tasks.slice(1) : starved;
          if (movable.length > 0) {
            await this.engageRebalance(
              overloaded ? 'overloaded_worker' : 'pinned_starvation',
              workerId,
              movable,
              idle.map((s) => s.id),
            );
            return;
          }
        }
      }
    }

    // ── Signal 4: deep backlog → spawn helper ────────────────────────────
    const backlogged = live > 0 && pending.length > this.cfg.backlogFactor * live;
    this.backlogTicks = backlogged ? this.backlogTicks + 1 : 0;
    if (backlogged && this.backlogTicks >= 2 && this.cfg.allowSpawn) {
      this.backlogTicks = 0;
      await this.engageBacklog(pending, live);
      return;
    }

    // ── Signal 5: stuck agent (below the watchdog's reap threshold) ──────
    for (const s of running) {
      const lastSeen = this.lastActivityAt.get(s.id);
      if (lastSeen !== undefined && now - lastSeen >= this.cfg.stuckMs) {
        this.lastActivityAt.set(s.id, now); // re-arm
        await this.engageStuck(s);
        return;
      }
    }

    // ── Signal 3: idle workers while unassignable work exists ────────────
    // (Unpinned pending work self-dispatches; landing here means pending
    // tasks are pinned to non-running workers or blocked some other way.)
    if (idle.length > 0 && pending.length > 0) {
      const oldest = Math.min(...pending.map((t) => this.pendingSince.get(t.id) ?? now));
      if (now - oldest >= this.cfg.pinnedWaitMs) {
        await this.engageIdleWithWork(idle.length, pending.length);
      }
    }
  }

  // ── engagements ────────────────────────────────────────────────────────

  private cooldownOk(kind: string, subject: string): boolean {
    const key = `${kind}|${subject}`;
    const last = this.lastEngagedAt.get(key) ?? 0;
    if (this.now() - last < this.cfg.cooldownMs) return false;
    this.lastEngagedAt.set(key, this.now());
    return true;
  }

  private interventionBudgetOk(subagentId: string): boolean {
    return (
      (this.interventionsBySubagent.get(subagentId) ?? 0) < this.cfg.maxInterventionsPerSubagent
    );
  }

  private recordIntervention(subagentId: string): void {
    this.interventionsBySubagent.set(
      subagentId,
      (this.interventionsBySubagent.get(subagentId) ?? 0) + 1,
    );
  }

  private emitSignal(kind: string, detail: string, subagentId?: string, taskId?: string): void {
    this.opts.events.emit('fleet.supervisor.signal', {
      sessionId: this.opts.sessionId?.(),
      kind,
      subagentId,
      taskId,
      detail,
    });
  }

  private record(entry: Omit<SupervisorLogEntry, 'at'>): void {
    this.log.push({ at: this.now(), ...entry });
    if (this.log.length > HISTORY_MAX) this.log.splice(0, this.log.length - HISTORY_MAX);
    this.opts.events.emit('fleet.supervisor.decision', {
      sessionId: this.opts.sessionId?.(),
      kind: entry.kind,
      proposedAction: entry.proposedAction,
      via: 'brain',
      outcome: entry.outcome === 'error' ? 'skipped' : entry.outcome,
      rationale: entry.detail,
    });
  }

  private emitAction(
    action: 'retarget' | 'spawn_helper' | 'steer' | 'notify_leader' | 'terminate',
    ok: boolean,
    detail: string,
    subagentId?: string,
    taskId?: string,
  ): void {
    this.opts.events.emit('fleet.supervisor.action', {
      sessionId: this.opts.sessionId?.(),
      action,
      subagentId,
      taskId,
      ok,
      detail,
    });
  }

  /**
   * Ask the brain to approve a proposal. Same contract as BrainMonitor:
   * `source:'system'`, the rule's proposal `recommended:true`, fallback
   * 'ask_human' (routes to the LLM tier under the risk ceiling before any
   * human). Returns the chosen option id, or null for deny/escalate.
   */
  private async decide(
    question: string,
    context: string,
    options: BrainDecisionOption[],
    risk: 'low' | 'medium' | 'high',
  ): Promise<{ choice: string | null; decision: BrainDecision }> {
    const request: BrainDecisionRequest = {
      id: `fleetsup-${randomUUID()}`,
      sessionId: this.opts.sessionId?.(),
      source: 'system',
      question,
      context,
      options,
      risk,
      fallback: 'ask_human',
    };
    const decision = await this.opts.brain.decide(request);
    if (decision.type !== 'answer') return { choice: null, decision };
    // An answer without an exact option id is not executable control-plane
    // authorization. Do not silently promote ambiguous free text to the
    // recommended action (especially spawn/retarget); policy brains that want
    // the recommendation already return its id explicitly.
    const choice = options.some((option) => option.id === decision.optionId)
      ? (decision.optionId ?? null)
      : null;
    return { choice, decision };
  }

  private async engageRebalance(
    kind: 'pinned_starvation' | 'overloaded_worker',
    fromWorkerId: string,
    tasks: TaskSpec[],
    idleWorkerIds: string[],
  ): Promise<void> {
    return delegateEngageRebalance(
      this.fleetSupervisorRebalanceHost(),
      kind,
      fromWorkerId,
      tasks,
      idleWorkerIds,
    );
  }

  private async engageBacklog(pending: readonly TaskSpec[], liveWorkers: number): Promise<void> {
    return delegateEngageBacklog(this.fleetSupervisorRebalanceHost(), pending, liveWorkers);
  }

  private engageLooping(s: SupervisedSubagent, hits: number): Promise<void> {
    return engageLoopingImpl(this.fleetSupervisorRebalanceHost(), s, hits);
  }

  private engageStuck(s: SupervisedSubagent): Promise<void> {
    return engageStuckImpl(this.fleetSupervisorRebalanceHost(), s);
  }

  private engageFailureStreak(subagentId: string, streak: number): Promise<void> {
    return engageFailureStreakImpl(this.fleetSupervisorRebalanceHost(), subagentId, streak);
  }

  private engageIdleWithWork(idleCount: number, pendingCount: number): Promise<void> {
    return engageIdleWithWorkImpl(this.fleetSupervisorRebalanceHost(), idleCount, pendingCount);
  }

  private fleetSupervisorRebalanceHost(): FleetSupervisorRebalanceHost {
    const self = this;
    return {
      cooldownOk: (...args) => this.cooldownOk(...args),
      interventionBudgetOk: (...args) => this.interventionBudgetOk(...args),
      get engaging() {
        return self.engaging;
      },
      set engaging(value) {
        self.engaging = value;
      },
      get stopped() {
        return self.stopped;
      },
      emitSignal: (...args) => this.emitSignal(...args),
      decide: (...args) => this.decide(...args),
      record: (...args) => this.record(...args),
      recordIntervention: (...args) => this.recordIntervention(...args),
      get opts() {
        return self.opts;
      },
      emitAction: (...args) => this.emitAction(...args),
      retargetedTasks: this.retargetedTasks,
      cfg: this.cfg,
    };
  }
}
