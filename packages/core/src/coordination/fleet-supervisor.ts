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
import type { EventBus } from '../kernel/events.js';
import type { TaskSpec } from '../types/multi-agent.js';
import type { FleetSupervisorConfig } from '../types/config.js';
import type {
  BrainArbiter,
  BrainDecision,
  BrainDecisionOption,
  BrainDecisionRequest,
} from './brain.js';
import type { FleetBus } from './fleet-bus.js';

export type { FleetSupervisorConfig } from '../types/config.js';

/** One subagent row of the snapshot the supervisor reasons over. */
export interface SupervisedSubagent {
  id: string;
  name: string;
  status: 'running' | 'idle' | 'stopped' | 'error';
  currentTask?: string | undefined;
}

/** Read port — implemented over Director/coordinator state by the host. */
export interface FleetSupervisorSource {
  subagents(): SupervisedSubagent[];
  listPendingTasks(): readonly TaskSpec[];
  isWorkComplete(): boolean;
}

/** Action port — every mutation the supervisor may perform, brain-gated. */
export interface FleetSupervisorActions {
  /** Move a still-pending task to another (or any idle) worker. */
  retargetPendingTask(taskId: string, subagentId: string | undefined): boolean | Promise<boolean>;
  /** Spawn an additional helper worker. Return {error} to degrade gracefully. */
  spawnHelper(input: {
    reason: string;
    /** Oldest queued task used to route the helper's role/tool profile. */
    task?: TaskSpec | undefined;
  }): Promise<{ subagentId: string } | { error: string }>;
  /** High-priority steer mail to one agent. */
  steerAgent(subagentId: string, subject: string, body: string): Promise<void>;
  /**
   * Status note to the session leader.
   *
   * `subagentId` names the worker the note is ABOUT, when there is one. The
   * host resolves the conversation from it: with several tabs sharing this
   * fleet, "the session leader" is not one address, and a note about tab 3's
   * worker sent to the boot tab's leader reaches nobody who can act on it.
   * Omitted for fleet-wide observations, which fall back to the host session.
   */
  notifyLeader(subject: string, body: string, subagentId?: string): Promise<void>;
  /** Abort a subagent (only used when config.allowTerminate). */
  terminate(subagentId: string): Promise<void>;
}

export interface FleetSupervisorOptions {
  events: EventBus;
  fleet: FleetBus;
  brain: BrainArbiter;
  source: FleetSupervisorSource;
  actions: FleetSupervisorActions;
  /** Active host session id, read lazily (resume/session-swap safe). */
  sessionId?: (() => string | undefined) | undefined;
  config?: FleetSupervisorConfig | undefined;
  /** Injectable clock for tests. Default Date.now. */
  now?: (() => number) | undefined;
}

export interface SupervisorLogEntry {
  at: number;
  kind: string;
  subagentId?: string | undefined;
  taskId?: string | undefined;
  proposedAction: string;
  outcome: 'approved' | 'denied' | 'escalated' | 'skipped' | 'error';
  detail: string;
}

/** Collab subagents (spawned by /collab review flows) are never supervised —
 *  same exclusion the Director's budget filter applies. */
const COLLAB_ID_PREFIXES = ['bug-hunter-', 'refactor-planner-', 'critic-'];

const DEFAULTS = {
  intervalMs: 20_000,
  cooldownMs: 120_000,
  maxInterventionsPerSubagent: 3,
  pinnedWaitMs: 60_000,
  overloadPinnedThreshold: 2,
  backlogFactor: 2,
  stuckMs: 180_000,
  failureStreak: 2,
} as const;

const HISTORY_MAX = 100;

interface ResolvedSupervisorConfig {
  enabled: boolean;
  intervalMs: number;
  cooldownMs: number;
  maxInterventionsPerSubagent: number;
  pinnedWaitMs: number;
  overloadPinnedThreshold: number;
  backlogFactor: number;
  stuckMs: number;
  failureStreak: number;
  allowSpawn: boolean;
  allowTerminate: boolean;
}

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
      intervalMs: c.intervalMs ?? DEFAULTS.intervalMs,
      cooldownMs: c.cooldownMs ?? DEFAULTS.cooldownMs,
      maxInterventionsPerSubagent:
        c.maxInterventionsPerSubagent ?? DEFAULTS.maxInterventionsPerSubagent,
      pinnedWaitMs: c.pinnedWaitMs ?? DEFAULTS.pinnedWaitMs,
      overloadPinnedThreshold: c.overloadPinnedThreshold ?? DEFAULTS.overloadPinnedThreshold,
      backlogFactor: c.backlogFactor ?? DEFAULTS.backlogFactor,
      stuckMs: c.stuckMs ?? DEFAULTS.stuckMs,
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
        this.lastActivityAt.set(e.subagentId, this.now());
      }),
    );
    // Failure streaks from the host lifecycle event (terminal per-task).
    this.offHandles.push(
      this.opts.events.on('subagent.task_completed', (e) => {
        if (this.isCollab(e.subagentId)) return;
        if (e.status === 'success') {
          this.failStreaks.delete(e.subagentId);
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
    if (!this.cooldownOk(kind, fromWorkerId) || !this.interventionBudgetOk(fromWorkerId)) return;
    this.engaging = true;
    try {
      const taskList = tasks.map((t) => `- ${t.id}: ${t.description.slice(0, 80)}`).join('\n');
      this.emitSignal(
        kind,
        `${tasks.length} pending task(s) pinned to busy worker ${fromWorkerId} while ${idleWorkerIds.length} worker(s) idle`,
        fromWorkerId,
        tasks[0]?.id,
      );
      const { choice, decision } = await this.decide(
        `Worker ${fromWorkerId} is busy with ${tasks.length} more task(s) queued behind it while ${idleWorkerIds.length} sibling worker(s) sit idle. Rebalance the queued tasks to the idle workers?`,
        `Queued behind ${fromWorkerId}:\n${taskList}\nIdle workers: ${idleWorkerIds.join(', ')}`,
        [
          {
            id: 'rebalance',
            label: 'Move the queued task(s) to idle worker(s)',
            consequence: 'Only unstarted tasks move; the running task is untouched.',
            risk: 'low',
            recommended: true,
          },
          { id: 'wait', label: 'Leave the queue as is', risk: 'low' },
        ],
        'low',
      );
      if (choice !== 'rebalance') {
        this.record({
          kind,
          subagentId: fromWorkerId,
          proposedAction: 'retarget',
          outcome: decision.type === 'answer' ? 'denied' : 'escalated',
          detail:
            decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
        });
        return;
      }
      this.recordIntervention(fromWorkerId);
      const moved: string[] = [];
      for (let i = 0; i < tasks.length; i++) {
        const task = tasks[i];
        const target = idleWorkerIds[i % idleWorkerIds.length];
        if (!task || !target) continue;
        const ok = await this.opts.actions.retargetPendingTask(task.id, target);
        this.emitAction('retarget', ok, `→ ${target}`, fromWorkerId, task.id);
        if (ok) {
          this.retargetedTasks.add(task.id);
          moved.push(`${task.id} → ${target}`);
        }
      }
      this.record({
        kind,
        subagentId: fromWorkerId,
        taskId: tasks[0]?.id,
        proposedAction: 'retarget',
        outcome: 'approved',
        detail:
          moved.length > 0 ? `moved ${moved.join(', ')}` : 'nothing movable (already dispatched)',
      });
      if (moved.length > 0) {
        await this.opts.actions
          .steerAgent(
            fromWorkerId,
            'Workload reduced by fleet supervisor',
            `The fleet supervisor moved ${moved.length} of your queued task(s) to idle workers: ${moved.join(
              ', ',
            )}. Do not start them — focus on your current task.`,
          )
          .catch(() => {});
        await this.opts.actions
          .notifyLeader(
            'Fleet rebalanced',
            `Supervisor moved ${moved.length} queued task(s) off busy worker ${fromWorkerId}: ${moved.join(', ')}.`,
            fromWorkerId,
          )
          .catch(() => {});
      }
    } catch {
      // The supervisor must never destabilize the fleet it protects.
    } finally {
      this.engaging = false;
    }
  }

  private async engageBacklog(pending: readonly TaskSpec[], liveWorkers: number): Promise<void> {
    if (!this.cooldownOk('backlog', 'fleet')) return;
    this.engaging = true;
    try {
      const pendingCount = pending.length;
      this.emitSignal('backlog', `${pendingCount} pending tasks vs ${liveWorkers} live worker(s)`);
      const { choice, decision } = await this.decide(
        `The task queue is deep: ${pendingCount} pending tasks for ${liveWorkers} live worker(s). Spawn one additional helper worker to drain it?`,
        `Pending: ${pendingCount}, live workers: ${liveWorkers}, factor threshold: ${this.cfg.backlogFactor}x`,
        [
          {
            id: 'spawn',
            label: 'Spawn one helper worker',
            consequence: 'One more subagent joins the fleet and takes queued work.',
            risk: 'medium',
            recommended: true,
          },
          { id: 'wait', label: 'Let the current fleet drain the queue', risk: 'low' },
        ],
        'medium',
      );
      if (choice !== 'spawn') {
        this.record({
          kind: 'backlog',
          proposedAction: 'spawn_helper',
          outcome: decision.type === 'answer' ? 'denied' : 'escalated',
          detail:
            decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
        });
        return;
      }
      const res = await this.opts.actions.spawnHelper({
        reason: `queue backlog: ${pendingCount} pending / ${liveWorkers} workers`,
        task: pending[0],
      });
      if ('subagentId' in res) {
        this.emitAction('spawn_helper', true, res.subagentId, res.subagentId);
        this.record({
          kind: 'backlog',
          subagentId: res.subagentId,
          proposedAction: 'spawn_helper',
          outcome: 'approved',
          detail: `spawned ${res.subagentId}`,
        });
        await this.opts.actions
          .notifyLeader(
            'Fleet helper spawned',
            `Supervisor spawned helper ${res.subagentId} to drain a ${pendingCount}-task backlog.`,
            res.subagentId,
          )
          .catch(() => {});
      } else {
        this.emitAction('spawn_helper', false, res.error);
        this.record({
          kind: 'backlog',
          proposedAction: 'spawn_helper',
          outcome: 'error',
          detail: res.error,
        });
        await this.opts.actions
          .notifyLeader(
            'Fleet backlog needs attention',
            `Queue is ${pendingCount} deep for ${liveWorkers} worker(s); supervisor could not spawn a helper (${res.error}). Consider rebalancing or finishing tasks before assigning more.`,
          )
          .catch(() => {});
      }
    } catch {
      /* never destabilize the fleet */
    } finally {
      this.engaging = false;
    }
  }

  private async engageStuck(s: SupervisedSubagent): Promise<void> {
    if (!this.cooldownOk('stuck_agent', s.id) || !this.interventionBudgetOk(s.id)) return;
    this.engaging = true;
    try {
      this.emitSignal(
        'stuck_agent',
        `no observable activity for ≥${Math.round(this.cfg.stuckMs / 1000)}s`,
        s.id,
      );
      const { choice, decision } = await this.decide(
        `Worker ${s.name} (${s.id}) is marked running but produced no observable activity for over ${Math.round(this.cfg.stuckMs / 1000)}s. Nudge it with a steer message?`,
        `Current task: ${s.currentTask ?? 'unknown'}`,
        [
          {
            id: 'steer',
            label: 'Send a corrective steer to the worker',
            consequence: 'A steer mail is injected before its next step.',
            risk: 'low',
            recommended: true,
          },
          { id: 'wait', label: 'Give it more time', risk: 'low' },
        ],
        'medium',
      );
      if (choice !== 'steer') {
        this.record({
          kind: 'stuck_agent',
          subagentId: s.id,
          proposedAction: 'steer',
          outcome: decision.type === 'answer' ? 'denied' : 'escalated',
          detail:
            decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
        });
        return;
      }
      this.recordIntervention(s.id);
      await this.opts.actions.steerAgent(
        s.id,
        'Progress check from fleet supervisor',
        `You appear stalled (no observable activity for ${Math.round(this.cfg.stuckMs / 1000)}s on: ${
          s.currentTask ?? 'your current task'
        }). If you are blocked, say so via mail_send to the leader and either narrow the scope or hand the task back — do not keep silently retrying the same step.`,
      );
      this.emitAction('steer', true, 'stuck nudge', s.id);
      await this.opts.actions
        .notifyLeader(
          `Worker ${s.name} may be stuck`,
          `No observable activity for ${Math.round(this.cfg.stuckMs / 1000)}s. Supervisor nudged it; consider terminate_subagent + reassigning if it stays silent.`,
          s.id,
        )
        .catch(() => {});
      this.record({
        kind: 'stuck_agent',
        subagentId: s.id,
        proposedAction: 'steer',
        outcome: 'approved',
        detail: 'steered + leader notified',
      });
    } catch {
      /* never destabilize the fleet */
    } finally {
      this.engaging = false;
    }
  }

  private async engageFailureStreak(subagentId: string, streak: number): Promise<void> {
    if (!this.cooldownOk('failure_streak', subagentId) || !this.interventionBudgetOk(subagentId)) {
      return;
    }
    this.engaging = true;
    try {
      this.emitSignal('failure_streak', `${streak} consecutive failed/timeout tasks`, subagentId);
      const options: BrainDecisionOption[] = [
        {
          id: 'steer',
          label: 'Steer the worker to change approach',
          risk: 'low',
          recommended: true,
        },
        { id: 'observe', label: 'Keep observing', risk: 'low' },
      ];
      if (this.cfg.allowTerminate) {
        options.push({
          id: 'terminate',
          label: 'Terminate the worker',
          consequence: 'Its current task fails; pending pinned tasks need reassignment.',
          risk: 'high',
        });
      }
      const { choice, decision } = await this.decide(
        `Worker ${subagentId} produced ${streak} consecutive failed/timed-out tasks. Intervene?`,
        `Consecutive failures: ${streak}`,
        options,
        'high',
      );
      if (choice === 'terminate' && this.cfg.allowTerminate) {
        this.recordIntervention(subagentId);
        await this.opts.actions.terminate(subagentId);
        this.emitAction('terminate', true, `${streak} consecutive failures`, subagentId);
        await this.opts.actions
          .notifyLeader(
            `Worker ${subagentId} terminated`,
            `Supervisor terminated ${subagentId} after ${streak} consecutive failures. Reassign its pending work.`,
            subagentId,
          )
          .catch(() => {});
        this.record({
          kind: 'failure_streak',
          subagentId,
          proposedAction: 'terminate',
          outcome: 'approved',
          detail: `terminated after ${streak} failures`,
        });
        return;
      }
      if (choice === 'steer') {
        this.recordIntervention(subagentId);
        await this.opts.actions.steerAgent(
          subagentId,
          'Change of approach required',
          `Your last ${streak} tasks failed. Stop, re-read the task, and take a different approach — if the task itself is impossible or under-specified, report that to the leader via mail_send instead of retrying.`,
        );
        this.emitAction('steer', true, 'failure streak', subagentId);
        await this.opts.actions
          .notifyLeader(
            `Worker ${subagentId} failing repeatedly`,
            `${streak} consecutive failures. Supervisor steered it; consider reassigning its work if the next task also fails.`,
            subagentId,
          )
          .catch(() => {});
        this.record({
          kind: 'failure_streak',
          subagentId,
          proposedAction: 'steer',
          outcome: 'approved',
          detail: `steered after ${streak} failures`,
        });
        return;
      }
      this.record({
        kind: 'failure_streak',
        subagentId,
        proposedAction: this.cfg.allowTerminate ? 'steer|terminate' : 'steer',
        outcome: decision.type === 'answer' ? 'denied' : 'escalated',
        detail: decision.type === 'answer' ? (decision.rationale ?? decision.text) : decision.type,
      });
    } catch {
      /* never destabilize the fleet */
    } finally {
      this.engaging = false;
    }
  }

  private async engageIdleWithWork(idleCount: number, pendingCount: number): Promise<void> {
    if (!this.cooldownOk('idle_with_work', 'fleet')) return;
    this.engaging = true;
    try {
      this.emitSignal(
        'idle_with_work',
        `${idleCount} idle worker(s) while ${pendingCount} task(s) cannot dispatch`,
      );
      // Pure notification — this state means tasks are pinned to
      // non-running workers or otherwise blocked; the leader owns the fix.
      await this.opts.actions.notifyLeader(
        'Idle workers with undispatchable tasks',
        `${idleCount} worker(s) idle while ${pendingCount} task(s) stay pending (likely pinned to stopped/errored workers). Reassign them with assign_task or let the supervisor retarget by unpinning.`,
      );
      this.emitAction('notify_leader', true, 'idle_with_work');
      this.record({
        kind: 'idle_with_work',
        proposedAction: 'notify_leader',
        outcome: 'approved',
        detail: `${idleCount} idle / ${pendingCount} pending`,
      });
    } catch {
      /* never destabilize the fleet */
    } finally {
      this.engaging = false;
    }
  }
}
