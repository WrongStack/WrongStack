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

export interface LeaderDelivery {
  deliveryId: string;
  sessionId: string;
  kind: 'delegation_result';
  createdAt: number;
  /**
   * Whether this delivery may start a new leader turn when the leader is idle
   * (Phase 3 auto-wake). False for user-caused outcomes and boot-rehydrated
   * items.
   */
  wake: boolean;
  payload: DelegationDeliveryPayload;
}

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
    this.remember(delivery.deliveryId);
    const item: LeaderDelivery = { ...delivery, sessionId };
    const queue = this.pendingBySession.get(sessionId) ?? [];
    queue.push(item);
    this.pendingBySession.set(sessionId, queue);
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

/** The text block folded into the leader conversation for one delivery. */
export function renderLeaderDeliveryBlock(delivery: LeaderDelivery): string {
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
