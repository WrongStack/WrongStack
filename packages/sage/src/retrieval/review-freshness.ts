import { currentModelChallenge } from '../shared/model-feedback.js';
import type { Sage } from '../types.js';

/** Advisory freshness signal; never changes relevance, confidence or lifecycle. */
export function memoryReviewReason(memory: Sage, now = Date.now()): string | undefined {
  if (memory.contextPolicy === 'never' || !['active', 'stale'].includes(memory.status)) return;
  if (currentModelChallenge(memory)) return 'model_challenged';
  if (memory.validity) return 'conditional_applicability';
  if (memory.status === 'stale') return 'stale_anchor';
  // A user preference without code evidence cannot be checked by reading files.
  if (
    !(memory.anchors ?? []).some((anchor) => anchor?.path) &&
    !(memory.sources ?? []).some((source) => source?.path)
  )
    return;
  const verifiedAt = Date.parse(memory.lastVerifiedAt ?? '');
  if (!Number.isFinite(verifiedAt)) return 'unverified_anchor';
  const safeNow = Number.isFinite(now) ? now : Date.now();
  if (safeNow - verifiedAt >= 30 * 24 * 60 * 60_000) return 'verification_old';
  return undefined;
}
