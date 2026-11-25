import { describe, expect, it } from 'vitest';
import {
  type CheckpointEntry,
  retainCheckpoints,
  TUI_CHECKPOINTS_MAX_ENTRIES,
} from '../src/checkpoint-retention.js';

describe('retainCheckpoints non-finite budget guard', () => {
  it('falls back to default caps when maxEntries or maxBytes is Infinity or NaN', () => {
    const list: CheckpointEntry[] = Array.from(
      { length: TUI_CHECKPOINTS_MAX_ENTRIES + 20 },
      (_, i) => ({
        promptIndex: i,
        promptPreview: `prompt ${i}`,
        ts: '2026-07-05T10:00:00.000Z',
        fileCount: 1,
      }),
    );

    expect(retainCheckpoints(list, { maxEntries: Number.POSITIVE_INFINITY })).toHaveLength(
      TUI_CHECKPOINTS_MAX_ENTRIES,
    );
    expect(retainCheckpoints(list, { maxEntries: Number.NaN })).toHaveLength(
      TUI_CHECKPOINTS_MAX_ENTRIES,
    );
    expect(retainCheckpoints(list, { maxEntries: 0 })).toHaveLength(1);
  });
});
