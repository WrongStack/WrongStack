// ---------------------------------------------------------------------------
// Redacted Telegram runtime metrics.
//
// Counters, gauges, and histograms for polling, updates, retries, queue,
// approvals, and lock transitions.  Every value carries bounded cardinality:
// no message bodies, usernames, callback tokens, or secrets.
//
// Metric names follow the convention <domain>.<event>[.<outcome>] so they
// can be filtered, aggregated, and queried without exposing PII.
//
// The snapshot is exposed via `/telegram-health` and can be forwarded
// to the host's event/observability pipeline.
// ---------------------------------------------------------------------------

import type { Logger } from '@wrongstack/core/types';

// ---------------------------------------------------------------------------
// Metric value shapes
// ---------------------------------------------------------------------------

/** Single counter with last-update timestamp. */
export interface Counter {
  /** Total number of occurrences since the counter was created. */
  count: number;
  /** ISO-8601 timestamp of the most recent increment. */
  lastAt: string;
}

export interface Gauge {
  /** Current value. */
  value: number;
}

export interface Histogram {
  count: number;
  min: number;
  max: number;
  sum: number;
}

// ---------------------------------------------------------------------------
// Telemetry snapshot — serialisable, no PII
// ---------------------------------------------------------------------------

export interface TelegramTelemetrySnapshot {
  /** Time this snapshot was generated. */
  generatedAt: string;

  poll: {
    /** Total successful polls. */
    success: Counter;
    /** Total failed polls (any error). */
    failure: Counter;
    /** Current poll latency histogram (ms). */
    latencyMs: Histogram;
    /** Consecutive HTTP 409 conflict streak (reset on success). */
    conflictStreak: Gauge;
  };

  updates: {
    /** Total updates received via getUpdates. */
    received: Counter;
    /** Updates accepted (passed inbound auth). */
    accepted: Counter;
    /** Updates rejected (failed inbound auth). */
    rejected: Counter;
    /** Callback queries received. */
    callbacks: Counter;
    /** Callback queries settled (approved/denied). */
    callbacksSettled: Counter;
    /** Deduplicated updates (same update_id seen again). */
    deduplicated: Counter;
    /** Current cursor offset. */
    cursorOffset: Gauge;
  };

  retry: {
    /** Total retry attempts across all operations. */
    attempts: Counter;
    /** HTTP 429 rate-limit responses handled. */
    rateLimited: Counter;
    /** Terminal (non-retryable) errors. */
    terminalErrors: Counter;
  };

  queue: {
    /** Total items enqueued (all kinds). */
    enqueued: Counter;
    /** Total items sent successfully. */
    sent: Counter;
    /** Total items dropped (overflow). */
    dropped: Counter;
    /** Total send failures. */
    failures: Counter;
    /** Current in-flight count. */
    inflight: Gauge;
    /** Current pending count. */
    pending: Gauge;
  };

  approvals: {
    /** Total approval requests created. */
    created: Counter;
    /** Approvals that timed out. */
    timedOut: Counter;
    /** Approvals that were cancelled (abort). */
    cancelled: Counter;
    /** Approvals settled by user action. */
    settled: Counter;
  };

  locks: {
    /** Acquire attempts (including re-acquire). */
    acquireAttempts: Counter;
    /** Successful acquires. */
    acquires: Counter;
    /** Lost locks (stolen by another instance). */
    lost: Counter;
    /** Releases. */
    releases: Counter;
    /** Current held state. */
    held: Gauge;
  };
}

// ---------------------------------------------------------------------------
// Metric helpers
// ---------------------------------------------------------------------------

export function newCounter(): Counter {
  return { count: 0, lastAt: new Date(0).toISOString() };
}

export function bumpCounter(c: Counter): void {
  c.count += 1;
  c.lastAt = new Date().toISOString();
}

export function newGauge(v = 0): Gauge {
  return { value: v };
}

export function newHistogram(): Histogram {
  return { count: 0, min: Infinity, max: 0, sum: 0 };
}

export function observeHistogram(h: Histogram, ms: number): void {
  h.count += 1;
  h.sum += ms;
  if (ms < h.min) h.min = ms;
  if (ms > h.max) h.max = ms;
}

// ---------------------------------------------------------------------------
// Telemetry collector
// ---------------------------------------------------------------------------

export class TelegramTelemetry {
  readonly snapshot: TelegramTelemetrySnapshot;

  constructor() {
    const now = new Date().toISOString();
    this.snapshot = {
      generatedAt: now,
      poll: {
        success: newCounter(),
        failure: newCounter(),
        latencyMs: newHistogram(),
        conflictStreak: newGauge(0),
      },
      updates: {
        received: newCounter(),
        accepted: newCounter(),
        rejected: newCounter(),
        callbacks: newCounter(),
        callbacksSettled: newCounter(),
        deduplicated: newCounter(),
        cursorOffset: newGauge(0),
      },
      retry: {
        attempts: newCounter(),
        rateLimited: newCounter(),
        terminalErrors: newCounter(),
      },
      queue: {
        enqueued: newCounter(),
        sent: newCounter(),
        dropped: newCounter(),
        failures: newCounter(),
        inflight: newGauge(0),
        pending: newGauge(0),
      },
      approvals: {
        created: newCounter(),
        timedOut: newCounter(),
        cancelled: newCounter(),
        settled: newCounter(),
      },
      locks: {
        acquireAttempts: newCounter(),
        acquires: newCounter(),
        lost: newCounter(),
        releases: newCounter(),
        held: newGauge(0),
      },
    };
  }

  /** Produce a snapshot and log key metrics. The host Logger contract is
   *  string-only, so we format counters into one concise line that can be
   *  grepped for `telegram.metrics`. */
  logSnapshot(log: Logger): void {
    const s = this.snapshot;
    const pollsOk = s.poll.success.count;
    const pollsFail = s.poll.failure.count;
    const pollsTotal = pollsOk + pollsFail;
    log.info(
      `[telegram.metrics] polls=${pollsOk}/${pollsTotal} ` +
        `upd_accepted=${s.updates.accepted.count} upd_rejected=${s.updates.rejected.count} ` +
        `upd_dedup=${s.updates.deduplicated.count} retries=${s.retry.attempts.count} ` +
        `queue_pend=${s.queue.pending.value} queue_inflight=${s.queue.inflight.value} ` +
        `queue_drop=${s.queue.dropped.count} queue_fail=${s.queue.failures.count} ` +
        `approvals_settled=${s.approvals.settled.count} approvals_timeout=${s.approvals.timedOut.count} ` +
        `locks_acq=${s.locks.acquires.count} locks_lost=${s.locks.lost.count}`,
    );
  }
}
