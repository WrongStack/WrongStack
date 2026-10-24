/**
 * Drain results owed to a session's leader (settled background `delegate`
 * calls) into the running agent's conversation.
 *
 * Lives at the package root, beside `session-note-attach.ts` and
 * `mailbox-attach.ts`, because it bridges the agent loop (`core/`) to the
 * coordination layer's delivery hub — `core/` itself may not import runtime
 * values from `coordination/`.
 *
 * @module leader-delivery-attach
 */

import type { TextBlock } from '@wrongstack/contracts/types/blocks';
import type { AgentContext } from '@wrongstack/contracts/types/context';
import type { Logger } from '@wrongstack/contracts/types/logger';
import { markDelegationDelivered } from './coordination/delegation/delegation-lookup.js';
import {
  DELIVERY_TAKE_MAX_CHARS,
  DELIVERY_TAKE_MAX_ITEMS,
  leaderDeliveryHub,
  renderLeaderDeliveryBlock,
} from './coordination/delegation/leader-delivery-hub.js';
import { isMailboxLeader } from './coordination/mailbox-predicates.js';
import { recordCompletedWorkEvidence } from './utils/context-evidence.js';
import { toErrorMessage } from './utils/error.js';

/** True for the agent that may receive leader deliveries. */
export function isLeaderAgentId(agentId: unknown): boolean {
  const id = typeof agentId === 'string' ? agentId : '';
  return id === 'leader' || isMailboxLeader(id);
}

/**
 * Fold pending deliveries for `sessionIds` into the conversation, one
 * `[DELEGATION RESULT]` block per item, bounded per call (the rest wait for
 * the next iteration). Leader only: workers share the loop handler, and a
 * worker of the same session must never drain the leader's results.
 *
 * For each item: record completed-work evidence (the delivered block is a
 * runtime message and may be compacted; the ledger is not), mark the tracker
 * entry delivered, and journal `delegation_delivered` (awaited — the event is
 * critical and flushed).
 *
 * @returns the number of items delivered.
 */
export async function drainLeaderDeliveries(
  // Structural on purpose: importing AgentInternals would tie this module to
  // the agent-loop type graph (the architecture gate fails on new type cycles).
  a: { readonly ctx: AgentContext; readonly logger: Logger },
  sessionIds: readonly string[],
  fold: (block: TextBlock) => void,
): Promise<number> {
  if (!isLeaderAgentId(a.ctx.agentId)) return 0;
  let itemsLeft = DELIVERY_TAKE_MAX_ITEMS;
  let charsLeft = DELIVERY_TAKE_MAX_CHARS;
  let delivered = 0;
  for (const sessionId of sessionIds) {
    if (itemsLeft <= 0 || charsLeft <= 0) break;
    if (leaderDeliveryHub.pending(sessionId) === 0) continue;
    const items = leaderDeliveryHub.take(sessionId, { maxItems: itemsLeft, maxChars: charsLeft });
    for (const delivery of items) {
      const text = renderLeaderDeliveryBlock(delivery);
      itemsLeft -= 1;
      charsLeft -= text.length;
      fold({ type: 'text', text });
      delivered += 1;
      const p = delivery.payload;
      recordCompletedWorkEvidence(a.ctx, {
        key: `delegation:${p.delegationId}`,
        source: 'task',
        summary: `delegate → ${p.target} (${p.status ?? (p.ok ? 'success' : 'failed')}): ${p.summary}`,
        ...(p.taskId ? { evidence: `roll_up(["${p.taskId}"])` } : {}),
      });
      markDelegationDelivered(p.delegationId);
      try {
        await a.ctx.session.append({
          type: 'delegation_delivered',
          ts: new Date().toISOString(),
          delegationId: p.delegationId,
          deliveryId: delivery.deliveryId,
          via: 'loop',
        });
      } catch (err) {
        (a.logger.debug ?? a.logger.warn)?.(
          `delegation_delivered journal write failed: ${toErrorMessage(err)}`,
        );
      }
    }
  }
  return delivered;
}
