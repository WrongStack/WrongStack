import { beforeEach, describe, expect, it } from 'vitest';
import {
  recordProviderResponse,
  recordProviderTextDelta,
  recordProviderThinkingDelta,
  recordStreamFlush,
  recordToolExecuted,
  recordToolProgress,
  recordTuiAppRender,
  resetTuiMemoryCounters,
  snapshotTuiMemoryCounters,
} from '../src/tui-memory-counters.js';

describe('TUI memory counters', () => {
  beforeEach(() => resetTuiMemoryCounters());

  it('records only bounded numeric totals without retaining event payloads', () => {
    recordTuiAppRender();
    recordProviderTextDelta(12);
    recordProviderThinkingDelta(7);
    recordProviderResponse();
    recordToolProgress(20);
    recordToolExecuted(1_024);
    recordStreamFlush();

    expect(snapshotTuiMemoryCounters()).toEqual({
      appRenders: 1,
      providerTextDeltaEvents: 1,
      providerTextDeltaChars: 12,
      providerThinkingDeltaEvents: 1,
      providerThinkingDeltaChars: 7,
      providerResponses: 1,
      toolProgressEvents: 1,
      toolProgressChars: 20,
      toolExecutedEvents: 1,
      toolOutputBytes: 1_024,
      streamFlushes: 1,
    });
  });

  it('ignores invalid and negative increments', () => {
    recordProviderTextDelta(Number.POSITIVE_INFINITY);
    recordToolProgress(-5);
    recordToolExecuted(undefined);

    expect(snapshotTuiMemoryCounters()).toMatchObject({
      providerTextDeltaEvents: 1,
      providerTextDeltaChars: 0,
      toolProgressEvents: 1,
      toolProgressChars: 0,
      toolExecutedEvents: 1,
      toolOutputBytes: 0,
    });
  });
});
