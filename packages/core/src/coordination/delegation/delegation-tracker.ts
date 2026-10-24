/**
 * DelegationTracker — follows each background `delegate` to settlement and
 * hands its outcome to the owning leader through the `LeaderDeliveryHub`.
 *
 * One tracker per host process. Entries are keyed by `delegationId` (stable
 * across handoff continuations) and owned by the session that called
 * `delegate`.
 *
 * State machine (illegal transitions are ignored and logged):
 *
 *   running ──onAttempt(n+1)──▶ handoff ──▶ running … ──settle──▶ settled
 *   settled ──drained by leader loop──▶ delivered
 *   settled ──terminal attempt consumed by leader await_tasks──▶ consumedInBand
 *   running ──dispose (host shutdown)──▶ cancelled   (no delivery)
 *
 * Cancellation is deliberately NOT tied to the leader's run signal: Esc / Stop
 * on the leader leaves background delegations running (same as
 * `spawn_subagent`). Only `cancelSession` (session fleet stop /
 * `Director.terminateSession`) and `dispose` abort an entry.
 *
 * @module coordination/delegation/delegation-tracker
 */

import { randomUUID } from 'node:crypto';
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { SessionEvent } from '@wrongstack/contracts/types/session';
import {
  type DelegationLookupSource,
  registerDelegationLookupSource,
  type TrackedDelegationInfo,
} from './delegation-lookup.js';
import {
  type DelegationDeliveryPayload,
  delegationDeliveryId,
  type LeaderDelivery,
  type LeaderDeliveryHub,
  leaderDeliveryHub,
} from './leader-delivery-hub.js';
import type { DelegateResult, DelegationAttempt, DelegationHooks } from './run-delegation.js';
import { buildDelegationResultExcerpt } from './run-delegation.js';

export type DelegationState =
  | 'running'
  | 'handoff'
  | 'settled'
  | 'delivered'
  | 'consumedInBand'
  | 'cancelled';

/** `user` = session fleet stop / terminateSession; `shutdown` = host dispose. */
export type DelegationCancelCause = 'user' | 'shutdown';

export interface DelegationEntry {
  readonly delegationId: string;
  readonly sessionId: string;
  readonly target: string;
  readonly task: string;
  readonly startedAt: number;
  state: DelegationState;
  /** Current attempt index (0 = first worker). */
  attempt: number;
  /** Task ids of every attempt, oldest first. */
  readonly taskIds: string[];
  subagentId?: string | undefined;
  /** Terminal attempt's task id, once settled. */
  finalTaskId?: string | undefined;
  readonly controller: AbortController;
  cancelCause?: DelegationCancelCause | undefined;
  /** Attempt task ids whose results the leader received in-band. */
  readonly leaderConsumedTaskIds: Set<string>;
  deliveryId?: string | undefined;
  settledAt?: number | undefined;
  result?: DelegateResult | undefined;
}

interface TrackerLogger {
  debug?: ((msg: string, meta?: unknown) => void) | undefined;
  warn?: ((msg: string, meta?: unknown) => void) | undefined;
}

export interface DelegationTrackerOptions {
  hub?: LeaderDeliveryHub | undefined;
  /** Host bus: `leader.delivery_pending`, `delegation.delivered`. */
  events?: EventBus | undefined;
  logger?: TrackerLogger | undefined;
  /** Terminal entries retained for lookups before pruning. Default 200. */
  retainTerminal?: number | undefined;
}

/** Director surface the tracker hooks for session termination. */
export interface SessionTerminateSource {
  onSessionTerminate?: ((listener: (sessionId: string) => void) => () => void) | undefined;
}

const TERMINAL: ReadonlySet<DelegationState> = new Set([
  'delivered',
  'consumedInBand',
  'cancelled',
]);

const ALLOWED: Record<DelegationState, readonly DelegationState[]> = {
  running: ['handoff', 'settled', 'cancelled'],
  handoff: ['running', 'settled', 'cancelled'],
  settled: ['delivered', 'consumedInBand'],
  delivered: [],
  consumedInBand: [],
  cancelled: [],
};

export class DelegationTracker implements DelegationLookupSource {
  private readonly entries = new Map<string, DelegationEntry>();
  private readonly byTaskId = new Map<string, string>();
  private readonly hub: LeaderDeliveryHub;
  private readonly events: EventBus | undefined;
  private readonly logger: TrackerLogger | undefined;
  private readonly retainTerminal: number;
  private readonly attachedDirectors = new WeakSet<object>();
  private readonly directorDisposers: Array<() => void> = [];
  private readonly unregister: () => void;
  private disposed = false;

  constructor(opts: DelegationTrackerOptions = {}) {
    this.hub = opts.hub ?? leaderDeliveryHub;
    this.events = opts.events;
    this.logger = opts.logger;
    this.retainTerminal = Math.max(0, opts.retainTerminal ?? 200);
    this.unregister = registerDelegationLookupSource(this);
  }

  /** Open an entry for a background delegation about to start. */
  begin(init: {
    sessionId: string;
    target: string;
    task: string;
    delegationId?: string | undefined;
  }): DelegationEntry {
    const entry: DelegationEntry = {
      delegationId: init.delegationId ?? randomUUID(),
      sessionId: init.sessionId,
      target: init.target,
      task: init.task,
      startedAt: Date.now(),
      state: 'running',
      attempt: 0,
      taskIds: [],
      controller: new AbortController(),
      leaderConsumedTaskIds: new Set(),
    };
    this.entries.set(entry.delegationId, entry);
    if (this.disposed) {
      entry.cancelCause = 'shutdown';
      entry.controller.abort('host shutdown');
    }
    return entry;
  }

  /** Forget an entry whose launch failed before the first attempt started. */
  discard(delegationId: string): void {
    const entry = this.entries.get(delegationId);
    if (!entry) return;
    this.entries.delete(delegationId);
    for (const taskId of entry.taskIds) this.byTaskId.delete(taskId);
  }

  /** Settlement hooks that keep ownership current across handoffs. */
  hooksFor(
    delegationId: string,
  ): Required<Pick<DelegationHooks, 'onAttempt' | 'onLeaderConsumed'>> {
    return {
      onAttempt: (attempt: DelegationAttempt) => this.onAttempt(delegationId, attempt),
      onLeaderConsumed: (taskId: string) => {
        this.noteLeaderConsumed(taskId);
      },
    };
  }

  /** Hand the settle promise to the tracker. */
  track(delegationId: string, settle: Promise<DelegateResult>): void {
    settle.then(
      (result) => this.settle(delegationId, result),
      (err: unknown) =>
        this.settle(delegationId, {
          ok: false,
          stopReason: 'error',
          error: err instanceof Error ? err.message : String(err),
        }),
    );
  }

  /** Abort one session's running delegations (user-caused). */
  cancelSession(sessionId: string, cause: DelegationCancelCause = 'user'): number {
    if (!sessionId) return 0;
    let count = 0;
    for (const entry of this.entries.values()) {
      if (entry.sessionId !== sessionId) continue;
      if (entry.state !== 'running' && entry.state !== 'handoff') continue;
      entry.cancelCause ??= cause;
      if (!entry.controller.signal.aborted) {
        entry.controller.abort(cause === 'user' ? 'session fleet stopped' : 'host shutdown');
      }
      count += 1;
    }
    return count;
  }

  /**
   * Subscribe to a Director's session termination once, so any
   * `terminateSession` (tab Stop, session fleet stop) cancels that session's
   * delegations as user-caused.
   */
  attachDirector(director: object | null | undefined): void {
    if (!director || this.attachedDirectors.has(director)) return;
    const source = director as SessionTerminateSource;
    if (typeof source.onSessionTerminate !== 'function') return;
    this.attachedDirectors.add(director);
    const off = source.onSessionTerminate((sessionId) => {
      this.cancelSession(sessionId, 'user');
    });
    this.directorDisposers.push(off);
  }

  /** Host shutdown: abort everything, stop delivering, unregister. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const entry of this.entries.values()) {
      if (entry.state !== 'running' && entry.state !== 'handoff') continue;
      entry.cancelCause = 'shutdown';
      if (!entry.controller.signal.aborted) entry.controller.abort('host shutdown');
    }
    for (const off of this.directorDisposers.splice(0)) {
      try {
        off();
      } catch {
        /* best-effort */
      }
    }
    this.unregister();
  }

  get(delegationId: string): DelegationEntry | undefined {
    return this.entries.get(delegationId);
  }

  list(sessionId?: string): DelegationEntry[] {
    return [...this.entries.values()].filter((e) => !sessionId || e.sessionId === sessionId);
  }

  /** True once `taskId` is known to be the delegation's terminal attempt. */
  isTerminalAttempt(taskId: string): boolean {
    return this.lookupByTaskId(taskId)?.isTerminal ?? false;
  }

  lookupByTaskId(taskId: string): TrackedDelegationInfo | undefined {
    const id = this.byTaskId.get(taskId);
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry) return undefined;
    return {
      delegationId: entry.delegationId,
      sessionId: entry.sessionId,
      state: entry.state,
      taskIds: [...entry.taskIds],
      isTerminal: entry.finalTaskId === taskId,
    };
  }

  noteLeaderConsumed(taskId: string): boolean {
    const id = this.byTaskId.get(taskId);
    const entry = id ? this.entries.get(id) : undefined;
    if (!entry) return false;
    entry.leaderConsumedTaskIds.add(taskId);
    // Settled already and this was the terminal attempt: pull the pending
    // delivery before the leader loop drains it.
    if (entry.state === 'settled' && entry.finalTaskId === taskId && entry.deliveryId) {
      this.hub.markConsumed(entry.deliveryId);
      this.consumeInBand(entry);
    }
    return true;
  }

  markDelivered(delegationId: string): boolean {
    const entry = this.entries.get(delegationId);
    if (!entry) return false;
    if (entry.state === 'settled') this.transition(entry, 'delivered');
    return true;
  }

  /**
   * Re-queue what a previous process left undelivered, from the session
   * journal. Never wakes (`wake:false`): nothing may start a turn at boot.
   *
   *  - `delegate_started` (background) without `delegate_completed` → the
   *    worker died with the old process: a synthetic "lost on restart" item.
   *  - `delegate_completed` (background) without `delegation_delivered` →
   *    re-queued from its `resultExcerpt`.
   */
  rehydrate(sessionId: string, events: readonly SessionEvent[]): number {
    if (this.disposed || !sessionId || !Array.isArray(events)) return 0;
    const started = new Map<string, Extract<SessionEvent, { type: 'delegate_started' }>>();
    const completed = new Map<string, Extract<SessionEvent, { type: 'delegate_completed' }>>();
    const delivered = new Set<string>();
    for (const ev of events) {
      if (!ev || typeof ev !== 'object') continue;
      if (ev.type === 'delegate_started' && ev.delegationId && ev.mode === 'background') {
        started.set(ev.delegationId, ev);
      } else if (ev.type === 'delegate_completed' && ev.delegationId) {
        completed.set(ev.delegationId, ev);
      } else if (ev.type === 'delegation_delivered') {
        delivered.add(ev.delegationId);
      }
    }
    // `delegate_completed` is flushed as critical while `delegate_started` is
    // batched, so a completed background delegation may have lost its start.
    for (const [delegationId, done] of completed) {
      if (done.mode !== 'background' || started.has(delegationId)) continue;
      started.set(delegationId, {
        type: 'delegate_started',
        ts: done.ts,
        target: done.target,
        task: done.task,
        subagentId: done.subagentId,
        delegationId,
        taskId: done.taskId,
        mode: 'background',
      });
    }
    let queued = 0;
    for (const [delegationId, ev] of started) {
      if (delivered.has(delegationId) || this.entries.has(delegationId)) continue;
      const done = completed.get(delegationId);
      const payload: DelegationDeliveryPayload = done
        ? {
            delegationId,
            taskId: done.taskId,
            subagentId: done.subagentId,
            target: done.target,
            task: done.task,
            ok: done.ok,
            status: done.status,
            stopReason: done.stopReason,
            handoffs: 0,
            summary: done.summary,
            excerpt: done.resultExcerpt,
            cause: 'restart',
          }
        : {
            delegationId,
            taskId: ev.taskId,
            subagentId: ev.subagentId,
            target: ev.target,
            task: ev.task,
            ok: false,
            status: 'lost',
            stopReason: 'aborted',
            handoffs: 0,
            summary: `[${ev.target}] lost on restart — the worker did not survive the process restart`,
            hint: 'Re-delegate the remaining work if it is still needed; inspect the workspace first.',
            cause: 'restart',
          };
      const ok = this.hub.enqueue(
        {
          deliveryId: delegationDeliveryId(delegationId),
          sessionId,
          kind: 'delegation_result',
          createdAt: Date.now(),
          wake: false,
          payload,
        },
        { events: this.events },
      );
      if (ok) queued += 1;
    }
    return queued;
  }

  // ── internals ────────────────────────────────────────────────────────────

  private onAttempt(delegationId: string, attempt: DelegationAttempt): void {
    const entry = this.entries.get(delegationId);
    if (!entry) return;
    if (!entry.taskIds.includes(attempt.taskId)) entry.taskIds.push(attempt.taskId);
    this.byTaskId.set(attempt.taskId, delegationId);
    entry.subagentId = attempt.subagentId;
    if (attempt.handoffCount > entry.attempt) {
      this.transition(entry, 'handoff');
      entry.attempt = attempt.handoffCount;
      this.transition(entry, 'running');
    }
  }

  private settle(delegationId: string, result: DelegateResult): void {
    const entry = this.entries.get(delegationId);
    if (!entry || TERMINAL.has(entry.state) || entry.state === 'settled') return;
    entry.result = result;
    entry.settledAt = Date.now();
    entry.finalTaskId =
      typeof result.taskId === 'string' ? result.taskId : entry.taskIds[entry.taskIds.length - 1];
    if (entry.finalTaskId) this.byTaskId.set(entry.finalTaskId, delegationId);

    if (entry.cancelCause === 'shutdown') {
      this.transition(entry, 'cancelled');
      this.prune();
      return;
    }
    if (!this.transition(entry, 'settled')) return;

    if (entry.finalTaskId && entry.leaderConsumedTaskIds.has(entry.finalTaskId)) {
      // The leader already holds the terminal result from `await_tasks`.
      this.consumeInBand(entry);
      return;
    }

    const handoffs = Array.isArray(result.handoffs) ? result.handoffs.length : 0;
    const delivery: LeaderDelivery = {
      deliveryId: delegationDeliveryId(entry.delegationId),
      sessionId: entry.sessionId,
      kind: 'delegation_result',
      createdAt: Date.now(),
      wake: entry.cancelCause !== 'user',
      payload: {
        delegationId: entry.delegationId,
        taskId: entry.finalTaskId,
        subagentId: typeof result.subagentId === 'string' ? result.subagentId : entry.subagentId,
        target: entry.target,
        task: entry.task,
        ok: result.ok === true,
        status: typeof result.status === 'string' ? result.status : undefined,
        stopReason: typeof result.stopReason === 'string' ? result.stopReason : undefined,
        handoffs,
        summary:
          typeof result.summary === 'string' && result.summary
            ? result.summary
            : typeof result.error === 'string'
              ? `[${entry.target}] ${result.error}`
              : `[${entry.target}] ${result.ok ? 'finished' : 'did not finish'}`,
        excerpt: buildDelegationResultExcerpt(result),
        hint: typeof result.hint === 'string' ? result.hint : undefined,
        ...(entry.cancelCause === 'user' ? { cause: 'user' as const } : {}),
      },
    };
    entry.deliveryId = delivery.deliveryId;
    this.hub.enqueue(delivery, { events: this.events });
  }

  private consumeInBand(entry: DelegationEntry): void {
    if (!this.transition(entry, 'consumedInBand')) return;
    try {
      this.events?.emit('delegation.delivered', {
        sessionId: entry.sessionId,
        delegationId: entry.delegationId,
        via: 'await_tasks',
      });
    } catch {
      /* observability only */
    }
    this.prune();
  }

  private transition(entry: DelegationEntry, next: DelegationState): boolean {
    if (!ALLOWED[entry.state].includes(next)) {
      (this.logger?.debug ?? this.logger?.warn)?.(
        `[delegation-tracker] ignored illegal transition ${entry.state} → ${next}`,
        { delegationId: entry.delegationId },
      );
      return false;
    }
    entry.state = next;
    if (TERMINAL.has(next)) this.prune();
    return true;
  }

  private prune(): void {
    const terminal = [...this.entries.values()].filter((e) => TERMINAL.has(e.state));
    const overflow = terminal.length - this.retainTerminal;
    if (overflow <= 0) return;
    for (const entry of terminal.slice(0, overflow)) {
      this.entries.delete(entry.delegationId);
      for (const taskId of entry.taskIds) this.byTaskId.delete(taskId);
      if (entry.finalTaskId) this.byTaskId.delete(entry.finalTaskId);
    }
  }
}
