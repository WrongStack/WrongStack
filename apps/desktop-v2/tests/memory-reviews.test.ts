import { describe, expect, it } from 'vitest';
import { emptyEngineState, reduceEngine } from '../src/engine-state';
import {
  emptyMemoryReviews,
  foldMemoryReviews,
  MemoryReviewStore,
  mergeMemoryReviews,
} from '../src/memory-reviews';

/** Reviews kept per kind (memory-reviews.ts). */
const MEMORY_REVIEW_LIMIT = 128;
const check = (status: string) => ({ path: 'src/a.ts', text: 'exports run()', status });
const run = (memories: Record<string, unknown>[], extra: Record<string, unknown> = {}) => ({
  event: 'memory.injector_run',
  runId: 'r1',
  outcome: 'injected',
  injected: memories,
  ...extra,
});

describe('memory reviews', () => {
  it('keeps the validity check of each injected or activated memory', () => {
    const reviews = foldMemoryReviews(
      emptyMemoryReviews,
      run(
        [
          {
            id: 'm1',
            validityReview: {
              observedRevision: 3,
              checkedAt: '2026-11-05T10:00:00Z',
              checks: [check('not_satisfied'), check('bogus'), { status: 'unknown' }],
            },
          },
          { id: 'm2' },
        ],
        {
          activated: [
            {
              id: 'm3',
              validityReview: { observedRevision: 1, checkedAt: '2026-11-05T10:00:00Z' },
            },
          ],
        },
      ),
    );
    expect(Object.keys(reviews.validity).sort()).toEqual(['m1', 'm3']);
    expect(reviews.validity['m1']).toEqual({
      observedRevision: 3,
      checkedAt: '2026-11-05T10:00:00Z',
      applicability: 'unknown',
      checks: [{ path: 'src/a.ts', text: 'exports run()', status: 'not_satisfied' }],
    });
    expect(reviews.validity['m3']?.checks).toEqual([]);
  });

  it('keeps the companion review a memory last received', () => {
    const first = foldMemoryReviews(emptyMemoryReviews, {
      event: 'memory.companion_review',
      memoryId: 'm1',
      observedRevision: 2,
      verdict: 'stale',
      summary: 'The function moved.',
      evidence: [{ path: 'src/b.ts', quote: 'run()' }, { path: 3 }],
      at: '2026-11-05T10:00:00Z',
      sessionId: 's1',
    });
    expect(first.companion['m1']).toEqual({
      memoryId: 'm1',
      observedRevision: 2,
      at: '2026-11-05T10:00:00Z',
      verdict: 'stale',
      summary: 'The function moved.',
      evidence: [{ path: 'src/b.ts', quote: 'run()' }],
    });
    const second = foldMemoryReviews(first, {
      event: 'memory.companion_review',
      memoryId: 'm1',
      observedRevision: 3,
      summary: 'Still holds.',
    });
    expect(second.companion['m1']?.summary).toBe('Still holds.');
    expect(second.companion['m1']?.evidence).toBeUndefined();
  });

  it('returns the same reviews for frames that carry none', () => {
    expect(foldMemoryReviews(emptyMemoryReviews, { event: 'memory.context_snapshot' })).toBe(
      emptyMemoryReviews,
    );
    expect(foldMemoryReviews(emptyMemoryReviews, run([{ id: 'm1' }]))).toBe(emptyMemoryReviews);
    expect(
      foldMemoryReviews(emptyMemoryReviews, {
        event: 'memory.companion_review',
        memoryId: 'm1',
        observedRevision: 1.5,
        summary: 'x',
      }),
    ).toBe(emptyMemoryReviews);
  });

  it('keeps only the newest memories', () => {
    let reviews = emptyMemoryReviews;
    for (let index = 0; index <= MEMORY_REVIEW_LIMIT; index++)
      reviews = foldMemoryReviews(reviews, {
        event: 'memory.companion_review',
        memoryId: `m${index}`,
        observedRevision: 1,
        summary: 'ok',
      });
    expect(Object.keys(reviews.companion)).toHaveLength(MEMORY_REVIEW_LIMIT);
    expect(reviews.companion['m0']).toBeUndefined();
    expect(reviews.companion[`m${MEMORY_REVIEW_LIMIT}`]).toBeDefined();
  });

  it('merges the newest review of each memory across projects', () => {
    const older = foldMemoryReviews(emptyMemoryReviews, {
      event: 'memory.companion_review',
      memoryId: 'm1',
      observedRevision: 1,
      summary: 'older',
      at: '2026-11-05T09:00:00Z',
    });
    const newer = foldMemoryReviews(emptyMemoryReviews, {
      event: 'memory.companion_review',
      memoryId: 'm1',
      observedRevision: 2,
      summary: 'newer',
      at: '2026-11-05T10:00:00Z',
    });
    expect(mergeMemoryReviews([newer, older]).companion['m1']?.summary).toBe('newer');
    expect(mergeMemoryReviews([older, newer]).companion['m1']?.summary).toBe('newer');
  });

  it('notifies hook readers only when a review changes', () => {
    const store = new MemoryReviewStore();
    let calls = 0;
    const stop = store.subscribe(() => calls++);
    store.apply({ event: 'memory.context_snapshot' });
    store.apply({
      event: 'memory.companion_review',
      memoryId: 'm1',
      observedRevision: 1,
      summary: 'ok',
    });
    stop();
    store.apply({
      event: 'memory.companion_review',
      memoryId: 'm2',
      observedRevision: 1,
      summary: 'ok',
    });
    expect(calls).toBe(1);
    expect(Object.keys(store.reviews.companion)).toEqual(['m1', 'm2']);
  });

  it('collects reviews from every conversation of the project', () => {
    const state = reduceEngine(
      { ...emptyEngineState, sessionId: 'mine' },
      {
        type: 'memory.event',
        payload: {
          event: 'memory.companion_review',
          memoryId: 'm1',
          observedRevision: 1,
          summary: 'From another conversation.',
          sessionId: 'theirs',
        },
      },
    );
    expect(state.memoryReviews.companion['m1']?.summary).toBe('From another conversation.');
  });
});
