import { describe, expect, it } from 'vitest';
import { historyPageFromSummaries } from '../src/storage/session-history-page.js';

describe('historyPageFromSummaries non-finite budget guard', () => {
  it('falls back to default budget when budget is NaN or negative', () => {
    const rows = [{ id: 's1' }, { id: 's2' }] as Parameters<typeof historyPageFromSummaries>[0];
    expect(historyPageFromSummaries(rows, {}, Number.NaN).sessions).toHaveLength(2);
    expect(historyPageFromSummaries(rows, {}, -5).sessions).toHaveLength(2);
  });
});
