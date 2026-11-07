/**
 * LeaderDeliveryHub — in-process queue of results owed to a session's leader.
 *
 * A background `delegate` settles on its own schedule. Its outcome waits here,
 * OUTSIDE `ctx.messages`, until the owning leader's agent loop reaches an
 * iteration boundary and drains it (see `agent-loop.ts`
 * `injectPendingDeliveries`). Living outside the conversation is what makes an
 * undelivered result survive compaction.
 *
 * Exactly-once in-process: `enqueue` is idempotent on `deliveryId` (the dedupe
 * set is kept after the item is taken or consumed) and items leave only via
 * `take` / `markConsumed`. Across a crash the journal re-queues (at-least-once)
 * and the model dedupes on `delegationId`.
 *
 * @module coordination/delegation/leader-delivery-hub
 */

import type { EventBus } from '@wrongstack/contracts/kernel/events';

export interface DelegationDeliveryPayload {
  delegationId: string;
  /** Terminal attempt's task id — the `roll_up` handle. */
  taskId?: string | undefined;
  subagentId?: string | undefined;
  target: string;
  task: string;
  ok: boolean;
  status?: string | undefined;
  stopReason?: string | undefined;
  handoffs: number;
  summary: string;
  /** Bounded result text, structured report first (≤4k chars). */
  excerpt?: string | undefined;
  hint?: string | undefined;
  /**
   * Why the outcome is not a normal finish: `user` (Stop / session cancel) or
   * `restart` (rehydrated from the journal after a process restart).
   */
  cause?: 'user' | 'restart' | undefined;
}

/**
 * Something the leader asked to be told about later: a `session_wakeup` timer
 * fired, a `process_watch` produced output or ended, or a background shell
 * process exited. Session-scoped and in-process only — never journaled, so a
 * restart forgets it (the timers and watches that raise it die with the
 * process too).
 */
export interface RuntimeNoticePayload {
  source: 'timer' | 'watch' | 'process';
  /** The handle the model holds: wakeup id, watch id, or pid. */
  handle: string;
  /** One line saying what happened. */
  title: string;
  /** Bounded detail (output lines, log tail, the scheduled prompt). */
  body?: string | undefined;
}

interface LeaderDeliveryBase {
  deliveryId: string;
  sessionId: string;
  createdAt: number;
  /**
   * Whether this delivery may start a new leader turn when the leader is idle
   * (Phase 3 auto-wake). False for user-caused outcomes and boot-rehydrated
   * items.
   */
  wake: boolean;
}

export interface DelegationLeaderDelivery extends LeaderDeliveryBase {
  kind: 'delegation_result';
  payload: DelegationDeliveryPayload;
}

export interface RuntimeNoticeLeaderDelivery extends LeaderDeliveryBase {
  kind: 'runtime_notice';
  payload: RuntimeNoticePayload;
}

export type LeaderDelivery = DelegationLeaderDelivery | RuntimeNoticeLeaderDelivery;

export interface LeaderDeliveryPendingEvent {
  sessionId: string;
  /** Pending items for the session after this enqueue. */
  count: number;
  wake: boolean;
  deliveryIds: string[];
}

export interface TakeBudget {
  maxItems?: number | undefined;
  maxChars?: number | undefined;
}

/** Default per-iteration drain budget. */
export const DELIVERY_TAKE_MAX_ITEMS = 8;
export const DELIVERY_TAKE_MAX_CHARS = 12_000;
const SEEN_CAP = 10_000;

function normalizeSessionId(sessionId: string): string {
  return sessionId.trim().replace(/\\/g, '/');
}

export class LeaderDeliveryHub {
  private readonly pendingBySession = new Map<string, LeaderDelivery[]>();
  /** Every deliveryId ever accepted — insertion-ordered for trimming. */
  private readonly seen = new Set<string>();
  private readonly listeners = new Set<(event: LeaderDeliveryPendingEvent) => void>();

  /**
   * Queue one delivery. Returns false (and does nothing) when this deliveryId
   * was already accepted — even if it has since been taken or consumed.
   */
  enqueue(delivery: LeaderDelivery, opts?: { events?: EventBus | undefined }): boolean {
    const sessionId = normalizeSessionId(delivery.sessionId);
    if (!sessionId || !delivery.deliveryId) return false;
    if (this.seen.has(delivery.deliveryId)) return false;
    const item: LeaderDelivery = { ...delivery, sessionId };
    const queue = this.pendingBySession.get(sessionId) ?? [];
    queue.push(item);
    this.pendingBySession.set(sessionId, queue);
    this.remember(delivery.deliveryId);
    const event: LeaderDeliveryPendingEvent = {
      sessionId,
      count: queue.length,
      wake: item.wake,
      deliveryIds: [item.deliveryId],
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // A listener must never break delivery.
      }
    }
    try {
      opts?.events?.emit('leader.delivery_pending', event);
    } catch {
      // Observability must never break delivery.
    }
    return true;
  }

  pending(sessionId: string): number {
    return this.pendingBySession.get(normalizeSessionId(sessionId))?.length ?? 0;
  }

  /** Snapshot of the pending items for a session (not removed). */
  peek(sessionId: string): readonly LeaderDelivery[] {
    return [...(this.pendingBySession.get(normalizeSessionId(sessionId)) ?? [])];
  }

  /**
   * Remove and return pending items in arrival order, within the budget. The
   * first item is always taken even when it alone exceeds `maxChars` (the
   * renderer bounds each block), so an oversized item cannot starve the queue.
   */
  take(sessionId: string, budget: TakeBudget = {}): LeaderDelivery[] {
    const key = normalizeSessionId(sessionId);
    const queue = this.pendingBySession.get(key);
    if (!queue || queue.length === 0) return [];
    const maxItems = Math.max(1, budget.maxItems ?? DELIVERY_TAKE_MAX_ITEMS);
    const maxChars = Math.max(1, budget.maxChars ?? DELIVERY_TAKE_MAX_CHARS);
    const taken: LeaderDelivery[] = [];
    let chars = 0;
    while (queue.length > 0 && taken.length < maxItems) {
      const next = queue[0]!;
      const size = renderLeaderDeliveryBlock(next).length;
      if (taken.length > 0 && chars + size > maxChars) break;
      queue.shift();
      taken.push(next);
      chars += size;
    }
    if (queue.length === 0) this.pendingBySession.delete(key);
    return taken;
  }

  /**
   * Drop a pending item that was already consumed in-band. Returns true when
   * an item was removed. The id stays in the dedupe set.
   */
  markConsumed(deliveryId: string): boolean {
    this.remember(deliveryId);
    for (const [key, queue] of this.pendingBySession) {
      const index = queue.findIndex((item) => item.deliveryId === deliveryId);
      if (index < 0) continue;
      queue.splice(index, 1);
      if (queue.length === 0) this.pendingBySession.delete(key);
      return true;
    }
    return false;
  }

  on(listener: (event: LeaderDeliveryPendingEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Test helper: forget everything. */
  reset(): void {
    this.pendingBySession.clear();
    this.seen.clear();
    this.listeners.clear();
  }

  private remember(deliveryId: string): void {
    if (!deliveryId) return;
    this.seen.delete(deliveryId);
    this.seen.add(deliveryId);
    if (this.seen.size <= SEEN_CAP) return;
    const drop = this.seen.size - SEEN_CAP;
    let i = 0;
    for (const id of this.seen) {
      // Never forget an id still pending — it would become re-enqueueable.
      if (this.isPending(id)) continue;
      this.seen.delete(id);
      if (++i >= drop) break;
    }
  }

  private isPending(deliveryId: string): boolean {
    for (const queue of this.pendingBySession.values()) {
      if (queue.some((item) => item.deliveryId === deliveryId)) return true;
    }
    return false;
  }
}

/** Process-wide hub. Trackers enqueue; leader agent loops drain. */
export const leaderDeliveryHub = new LeaderDeliveryHub();

/** Stable delivery id for a delegation — shared by live settle and rehydrate. */
export function delegationDeliveryId(delegationId: string): string {
  return `delegation:${delegationId}`;
}

export const DELEGATION_RESULT_MARKER = '[DELEGATION RESULT]';
export const RUNTIME_NOTICE_MARKER = '[RUNTIME NOTICE]';
/** Upper bound for a runtime notice body in the conversation. */
export const RUNTIME_NOTICE_BODY_MAX_CHARS = 4_000;

/**
 * Stable delivery id for one runtime notice. `seq` distinguishes repeated
 * notices from the same handle (a recurring timer, a watch's batches).
 */
export function runtimeNoticeDeliveryId(
  source: RuntimeNoticePayload['source'],
  handle: string,
  seq: number | string,
): string {
  return `notice:${source}:${handle}#${seq}`;
}

/**
 * What a woken turn's prompt names for an item: the delegation id, or the
 * notice's `source:handle#seq` (unique per notice, so two wakes never carry
 * byte-identical input that `Agent.run` would burst-dedupe).
 */
export function leaderDeliveryRef(delivery: LeaderDelivery): string {
  return delivery.kind === 'delegation_result'
    ? delivery.payload.delegationId
    : delivery.deliveryId.replace(/^notice:/, '');
}

/** The text block folded into the leader conversation for one delivery. */
export function renderLeaderDeliveryBlock(delivery: LeaderDelivery): string {
  if (delivery.kind === 'runtime_notice') return renderRuntimeNoticeBlock(delivery);
  const p = delivery.payload;
  const lines: string[] = [`${DELEGATION_RESULT_MARKER} delegationId=${p.delegationId}`];
  const facts = [
    `target: ${p.target}`,
    `status: ${p.status ?? (p.ok ? 'success' : 'failed')}`,
    ...(p.stopReason ? [`stopReason: ${p.stopReason}`] : []),
    `handoffs: ${p.handoffs}`,
  ];
  lines.push(facts.join(' · '));
  if (p.cause === 'user') {
    lines.push('note: this outcome was caused by the user stopping the session fleet.');
  } else if (p.cause === 'restart') {
    lines.push('note: recovered from the session journal after a process restart.');
  }
  const task = p.task.length > 300 ? `${p.task.slice(0, 299)}…` : p.task;
  lines.push(`task: ${task}`);
  lines.push(`summary: ${p.summary}`);
  if (p.excerpt?.trim()) lines.push('', p.excerpt.trim());
  if (p.hint?.trim()) lines.push('', `hint: ${p.hint.trim()}`);
  if (p.taskId) lines.push('', `Full result: roll_up(["${p.taskId}"])`);
  lines.push(
    'This result was delivered automatically; do not poll or re-await it. Continue from it.',
  );
  return lines.join('\n');
}

function renderRuntimeNoticeBlock(delivery: RuntimeNoticeLeaderDelivery): string {
  const p = delivery.payload;
  const lines = [`${RUNTIME_NOTICE_MARKER} source=${p.source} handle=${p.handle}`, p.title];
  const body = p.body?.trim();
  if (body) {
    lines.push(
      '',
      body.length > RUNTIME_NOTICE_BODY_MAX_CHARS
        ? `${body.slice(0, RUNTIME_NOTICE_BODY_MAX_CHARS - 1)}…`
        : body,
    );
  }
  lines.push(
    '',
    'You asked to be told about this; it was delivered automatically. Act on it, or stop the timer/watch if it is no longer needed.',
  );
  return lines.join('\n');
}
