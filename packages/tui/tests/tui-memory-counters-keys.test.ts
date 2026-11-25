import { describe, expect, it } from 'vitest';
import {
  resetTuiMemoryCounters,
  setTuiHistoryMemoryGauges,
  snapshotTuiMemoryCounters,
} from '../src/tui-memory-counters.js';

describe('setTuiHistoryMemoryGauges known-key guard', () => {
  it('ignores unknown keys instead of polluting memory counters', () => {
    resetTuiMemoryCounters();
    try {
      setTuiHistoryMemoryGauges({
        historyRetainedEntries: 1,
        historyGroupedEntries: 1,
        historyMountedGroups: 1,
        historyMountedEntries: 1,
        historyCachedGroups: 1,
        historyMeasuredGroups: 1,
        historyViewportRows: 1,
        historyTotalRows: 1,
        extraUnexpectedKey: 999,
      } as Parameters<typeof setTuiHistoryMemoryGauges>[0]);
      const snap = snapshotTuiMemoryCounters() as Record<string, unknown>;
      expect('extraUnexpectedKey' in snap).toBe(false);
    } finally {
      resetTuiMemoryCounters();
    }
  });
});
