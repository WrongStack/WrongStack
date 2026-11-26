import { describe, expect, it } from 'vitest';
import { hintForKind } from '../src/delegation/delegation-results.js';
import {
  DELIVERY_TAKE_MAX_CHARS,
  type LeaderDelivery,
  renderLeaderDeliveryBlock,
} from '../src/delegation/leader-delivery-hub.js';

const CAP = 4_000;
/** Prompt text + capped partial + ellipsis. */
const HINT_CEILING = CAP + 300;

/**
 * F2493: `hintForKind` embedded the subagent's `lastAssistantText` unbounded
 * while the same text is capped at `subagentResultChars` (default 4000) as the
 * journaled excerpt and `[DELEGATION RESULT]` body. The delivery renderer bounds
 * `task` (300) and runtime-notice bodies (4000), and `LeaderDeliveryHub.take`'s
 * per-iteration budget assumes each block is bounded — an oversized hint broke
 * both.
 */
describe('delegation hint keeps the result-text bound (F2493)', () => {
  it.each(['budget_iterations', 'budget_tokens', 'budget_timeout', 'tool_failed'] as const)(
    'caps the partial text embedded by %s',
    (kind) => {
      const hint = hintForKind(kind, true, 1000, { lastAssistantText: 'x'.repeat(100_000) });

      expect(hint).toBeDefined();
      expect(hint?.length ?? 0).toBeLessThanOrEqual(HINT_CEILING);
      expect(hint?.endsWith('…')).toBe(true);
    },
  );

  it('leaves a short partial intact', () => {
    const hint = hintForKind('budget_iterations', true, 1000, {
      lastAssistantText: 'wrote 3 files, one test still red',
    });

    expect(hint).toContain('wrote 3 files, one test still red');
  });

  it('keeps a delivered block inside the drain budget', () => {
    const delivery: LeaderDelivery = {
      deliveryId: 'delegation:x',
      sessionId: 'sess',
      kind: 'delegation_result',
      createdAt: 0,
      wake: false,
      payload: {
        delegationId: 'x',
        target: 'bug-hunter',
        task: 'audit the deploy',
        ok: false,
        status: 'error',
        stopReason: 'budget_exhausted',
        handoffs: 0,
        summary: '[bug-hunter] budget exhausted',
        hint: hintForKind('budget_iterations', true, 1000, {
          lastAssistantText: 'y'.repeat(100_000),
        }),
      },
    };

    expect(renderLeaderDeliveryBlock(delivery).length).toBeLessThanOrEqual(DELIVERY_TAKE_MAX_CHARS);
  });
});
