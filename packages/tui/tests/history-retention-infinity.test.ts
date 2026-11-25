import { describe, expect, it } from 'vitest';
import type { HistoryEntry } from '../src/components/history/types.js';
import { retainTuiHistory, TUI_HISTORY_MAX_ENTRIES } from '../src/history-retention.js';

describe('retainTuiHistory non-finite budget guard', () => {
  it('falls back to default cap when maxEntries is Infinity or NaN', () => {
    const entries: HistoryEntry[] = Array.from(
      { length: TUI_HISTORY_MAX_ENTRIES + 10 },
      (_, i) => ({
        id: i + 1,
        kind: 'info',
        text: `entry-${i + 1}`,
      }),
    );

    expect(retainTuiHistory(entries, { maxEntries: Number.POSITIVE_INFINITY })).toHaveLength(
      TUI_HISTORY_MAX_ENTRIES + 1,
    );
    expect(retainTuiHistory(entries, { maxEntries: Number.NaN })).toHaveLength(
      TUI_HISTORY_MAX_ENTRIES + 1,
    );
  });
});
