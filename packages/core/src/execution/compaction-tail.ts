import type { ContextWindowPolicy } from '@wrongstack/contracts/types/context-window';
import type { Message } from '@wrongstack/contracts/types/messages';
import { estimateMessageTokens } from '../utils/token-estimate.js';

/** The slice of a run context the kept-tail rule reads. */
export interface KeptTailContext {
  meta?: Record<string, unknown> | undefined;
  provider?: { capabilities?: { maxContext?: number | undefined } | undefined } | undefined;
}

/** Target load assumed when the active policy does not carry one. */
const DEFAULT_TARGET_LOAD = 0.65;

function positive(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : undefined;
}

/**
 * The token-denominated tail this pass must keep verbatim, or undefined when
 * `keepTokens` is not configured. Capped at half of the policy's target load
 * (of the active window): a tail that big would leave the pass nothing to
 * compact, and the point of compacting is to make room.
 */
function effectiveKeepTokens(ctx: KeptTailContext): number | undefined {
  const policy = ctx.meta?.['contextWindowPolicy'] as Partial<ContextWindowPolicy> | undefined;
  const keep = positive(policy?.keepTokens);
  if (keep === undefined) return undefined;
  const maxContext =
    positive(ctx.meta?.['effectiveMaxContext']) ?? positive(ctx.provider?.capabilities?.maxContext);
  if (maxContext === undefined) return keep;
  const targetLoad =
    typeof policy?.targetLoad === 'number' && policy.targetLoad > 0 && policy.targetLoad <= 1
      ? policy.targetLoad
      : DEFAULT_TARGET_LOAD;
  return Math.min(keep, Math.max(1, Math.floor((maxContext * targetLoad) / 2)));
}

/**
 * Index where the newest `keepTokens` worth of messages begins: walking back
 * from the end, the first message at which the running total reaches the
 * budget. 0 when the whole conversation is smaller than the budget.
 */
function tokenTailStart(messages: readonly Message[], keepTokens: number): number {
  let total = 0;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (!message) continue;
    total += estimateMessageTokens([message]);
    if (total >= keepTokens) return i;
  }
  return 0;
}

/**
 * Widen a compactor's count-based cut (the first index of the kept verbatim
 * tail) so the tail also holds at least `keepTokens` tokens. Only ever moves
 * the cut EARLIER — `preserveK` stays the floor — and is a no-op when
 * `keepTokens` is unset.
 */
export function widenTailCut(
  ctx: KeptTailContext,
  messages: readonly Message[],
  countCut: number,
): number {
  const keep = effectiveKeepTokens(ctx);
  if (keep === undefined) return countCut;
  return Math.min(countCut, tokenTailStart(messages, keep));
}
