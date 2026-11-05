import type { CompanionReview, ValidityReview } from '@wrongstack/project-surfaces/host';
import { entries, record } from './engine-values.js';

/**
 * The latest validity check and companion review of each SAGE memory the engine reported.
 * The memory detail shows them: whether the memory's conditions held in the conversation that
 * used it, and what the companion model concluded when it reviewed the memory.
 */
export interface MemoryReviews {
  validity: Record<string, ValidityReview>;
  companion: Record<string, CompanionReview>;
}
export const emptyMemoryReviews: MemoryReviews = { validity: {}, companion: {} };
/** Memories kept per kind of review, newest last. */
const MEMORY_REVIEW_LIMIT = 128;

const STATUSES = new Set(['satisfied', 'not_satisfied', 'unknown']);

function validityReview(value: unknown): ValidityReview | null {
  const review = record(value);
  if (!Number.isInteger(review['observedRevision']) || typeof review['checkedAt'] !== 'string')
    return null;
  return {
    observedRevision: review['observedRevision'] as number,
    checkedAt: review['checkedAt'],
    applicability: 'unknown',
    checks: entries(review['checks']).flatMap((check) =>
      typeof check['path'] === 'string' && STATUSES.has(String(check['status']))
        ? [
            {
              path: check['path'],
              text: String(check['text'] ?? ''),
              status: check['status'] as ValidityReview['checks'][number]['status'],
              ...(typeof check['sourceHash'] === 'string'
                ? { sourceHash: check['sourceHash'] }
                : {}),
            },
          ]
        : [],
    ),
  };
}

function companionReview(payload: Record<string, unknown>): CompanionReview | null {
  if (
    typeof payload['memoryId'] !== 'string' ||
    !Number.isInteger(payload['observedRevision']) ||
    typeof payload['summary'] !== 'string'
  )
    return null;
  const evidence = entries(payload['evidence']).flatMap((item) =>
    typeof item['path'] === 'string' && typeof item['quote'] === 'string'
      ? [{ path: item['path'], quote: item['quote'] }]
      : [],
  );
  return {
    memoryId: payload['memoryId'],
    observedRevision: payload['observedRevision'] as number,
    at: typeof payload['at'] === 'string' ? payload['at'] : '',
    verdict: String(payload['verdict'] ?? ''),
    summary: payload['summary'],
    ...(evidence.length ? { evidence } : {}),
  };
}

/** `review` as the newest entry under `id`, dropping the oldest beyond the limit. */
function keep<T>(map: Record<string, T>, id: string, review: T): Record<string, T> {
  const rest = Object.entries(map).filter(([key]) => key !== id);
  return Object.fromEntries([...rest, [id, review] as const].slice(-MEMORY_REVIEW_LIMIT));
}

/**
 * Folds a `memory.event` payload in: an injector run carries a validity check for each memory
 * it activated or injected, a `memory.companion_review` one companion review. Returns `reviews`
 * itself when the payload carries neither, so callers can skip a re-render.
 */
export function foldMemoryReviews(
  reviews: MemoryReviews,
  payload: Record<string, unknown>,
): MemoryReviews {
  if (payload['event'] === 'memory.companion_review') {
    const review = companionReview(payload);
    return review
      ? { ...reviews, companion: keep(reviews.companion, review.memoryId, review) }
      : reviews;
  }
  if (payload['event'] !== 'memory.injector_run') return reviews;
  let validity = reviews.validity;
  for (const memory of [...entries(payload['activated']), ...entries(payload['injected'])]) {
    const review = validityReview(memory['validityReview']);
    if (typeof memory['id'] === 'string' && review) validity = keep(validity, memory['id'], review);
  }
  return validity === reviews.validity ? reviews : { ...reviews, validity };
}

const newer = (a: string, b: string) => Date.parse(a || '0') >= Date.parse(b || '0');

/** The newest review of each memory across several sources (projects read by this window). */
export function mergeMemoryReviews(sources: MemoryReviews[]): MemoryReviews {
  const merged: MemoryReviews = { validity: {}, companion: {} };
  for (const source of sources) {
    for (const [id, review] of Object.entries(source.validity)) {
      const current = merged.validity[id];
      if (!current || newer(review.checkedAt, current.checkedAt)) merged.validity[id] = review;
    }
    for (const [id, review] of Object.entries(source.companion)) {
      const current = merged.companion[id];
      if (!current || newer(review.at, current.at)) merged.companion[id] = review;
    }
  }
  return merged;
}

/** Reviews a surface host reads with hooks; `apply` folds a live `memory.event` in. */
export class MemoryReviewStore {
  private listeners = new Set<() => void>();
  constructor(public reviews: MemoryReviews = emptyMemoryReviews) {}
  subscribe = (listener: () => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };
  apply(payload: Record<string, unknown>) {
    const next = foldMemoryReviews(this.reviews, payload);
    if (next === this.reviews) return;
    this.reviews = next;
    for (const listener of this.listeners) listener();
  }
}
