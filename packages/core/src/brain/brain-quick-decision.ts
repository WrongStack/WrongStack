import type { BrainDecision, BrainDecisionRequest } from './brain.js';
import {
  type BrainHeuristicsConfig,
  isBlockedResolved,
  isContinuePing,
  isDeadlockWithFailedWork,
  isRetryExhausted,
  resolveBrainHeuristics,
} from './brain-heuristics.js';

export function evaluateQuickBrainDecision(
  request: BrainDecisionRequest,
  heuristics?: BrainHeuristicsConfig | undefined,
): BrainDecision | null {
  if (request.options?.length) return null;

  const h = resolveBrainHeuristics(heuristics);
  const q = request.question.toLowerCase();
  const ctx = request.context?.toLowerCase() ?? '';

  if (h.deadlockSkip && isDeadlockWithFailedWork(q, ctx)) {
    return {
      type: 'answer',
      text: 'Skip deadlocked tasks and continue with remaining work. Failed tasks will be reported in the final summary.',
      rationale:
        'Heuristic: deadlocked tasks blocked by failed dependencies — skipping unblocks remaining work.',
    };
  }

  if (h.retryExhausted && isRetryExhausted(q, ctx)) {
    return {
      type: 'answer',
      text: 'Mark as failed and move on. Note the failure for the final report.',
      rationale: 'Heuristic: retries exhausted — continuing would waste resources.',
    };
  }

  if (
    h.blockedResolved &&
    request.fallback === 'continue' &&
    isBlockedResolved(q, ctx, h.blockedResolvedMarkers)
  ) {
    return {
      type: 'answer',
      text: 'Blocker resolved. Continue with the previously blocked work.',
      rationale: 'Heuristic: blocking dependency explicitly resolved — resuming.',
    };
  }

  if (q.includes('goal complete') || q.includes('mission complete')) {
    return null;
  }

  if (h.continuePing && request.fallback === 'continue' && isContinuePing(q)) {
    return {
      type: 'answer',
      text: 'Continue execution. Do not stop.',
      rationale: 'Heuristic: autonomy mode — continue until all work is complete.',
    };
  }

  return null;
}
