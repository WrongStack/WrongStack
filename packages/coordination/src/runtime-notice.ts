/**
 * Runtime notices: things the leader asked to be told about later.
 *
 * A `session_wakeup` timer firing, a `process_watch` producing output, a
 * background shell process exiting — each becomes a `runtime_notice` item in
 * the {@link leaderDeliveryHub}. From there the same two paths a background
 * delegation result takes apply: a running leader loop drains it at the next
 * iteration boundary, and an idle leader is woken by the auto-wake controller
 * (notice-only wakes use their own, wider budget).
 *
 * Only the leader receives deliveries (workers share the loop handler and
 * must never drain the leader's queue), so a notice raised from a worker's
 * tool call would never be read. {@link resolveRuntimeNoticeTarget} returns
 * `undefined` there and the tools refuse up front instead of scheduling a
 * timer nobody hears.
 *
 * @module runtime-notice
 */

import type { EventBus } from '@wrongstack/contracts/kernel/events';
import {
  leaderDeliveryHub,
  type RuntimeNoticePayload,
  runtimeNoticeDeliveryId,
} from './delegation/leader-delivery-hub.js';
import { isLeaderAgentId } from './leader-delivery-attach.js';
import { callerSessionId } from './origin-session.js';

/**
 * The session whose leader receives notices raised by this tool call, or
 * `undefined` when the caller is not a leader or no session is bound.
 */
export function resolveRuntimeNoticeTarget(ctx: unknown): string | undefined {
  const agentId = (ctx as { agentId?: unknown } | undefined)?.agentId;
  if (!isLeaderAgentId(agentId)) return undefined;
  return callerSessionId(ctx);
}

export interface RuntimeNoticeInput extends RuntimeNoticePayload {
  /** Distinguishes repeated notices from one handle (fire count, batch number). */
  seq: number | string;
  /** May start a turn when the leader is idle. Default true. */
  wake?: boolean | undefined;
}

/** Queue one notice for `sessionId`'s leader. False when it was a duplicate. */
export function enqueueRuntimeNotice(
  sessionId: string,
  notice: RuntimeNoticeInput,
  opts?: { events?: EventBus | undefined },
): boolean {
  const { seq, wake = true, ...payload } = notice;
  return leaderDeliveryHub.enqueue(
    {
      deliveryId: runtimeNoticeDeliveryId(payload.source, payload.handle, seq),
      sessionId,
      kind: 'runtime_notice',
      createdAt: Date.now(),
      wake,
      payload,
    },
    opts,
  );
}
