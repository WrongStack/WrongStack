import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { expect, it } from 'vitest';
import { reindexOutcome, VectorMemoryReindex, vectorCoverage } from '../src/VectorMemoryEntries';

it('reads coverage only when its counts are consistent', () => {
  expect(vectorCoverage({ coverage: { entries: 3, covered: 2, missing: 1 } })).toEqual({
    entries: 3,
    covered: 2,
    missing: 1,
  });
  expect(vectorCoverage({ coverage: { entries: 3, covered: 2, missing: 2 } })).toBeNull();
  expect(vectorCoverage({})).toBeNull();
});

it('reports what a reindex did and what is still missing', () => {
  expect(
    reindexOutcome({
      processed: 1,
      errors: 0,
      coverage: { entries: 1, covered: 1, missing: 0 },
    }),
  ).toBe('Embedded 1 entry. All 1 entries have a vector for this provider.');
  expect(
    reindexOutcome({
      processed: 0,
      errors: 2,
      coverage: { entries: 2, covered: 0, missing: 2 },
    }),
  ).toBe(
    'Embedded 0 entries. 2 could not be embedded; the provider may be unavailable. 2 of 2 still have no vector for this provider.',
  );
});

it('offers embedding of missing entries only when some are missing', () => {
  const view = (missing: number) =>
    renderToStaticMarkup(
      createElement(VectorMemoryReindex, {
        http: async () => ({}),
        coverage: { entries: 4, covered: 4 - missing, missing },
        onDone() {},
      }),
    );
  expect(view(2)).toContain('Embed 2 missing');
  expect(view(2)).toContain('not found by semantic search');
  expect(view(0)).not.toContain('missing</button>');
  expect(view(0)).toContain('Re-embed all…');
});
