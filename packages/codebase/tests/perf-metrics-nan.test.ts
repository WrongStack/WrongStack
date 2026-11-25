import { describe, expect, it } from 'vitest';
import {
  getCodebaseIndexPerfSnapshot,
  recordFilesystemRead,
  recordIpcPending,
  recordParserGateWait,
  recordWriteQueueWait,
  resetCodebaseIndexPerfMetrics,
} from '../src/perf-metrics.js';

describe('codebase perf metrics non-finite guards', () => {
  it('ignores non-finite inputs instead of poisoning counters with NaN', () => {
    resetCodebaseIndexPerfMetrics();
    recordFilesystemRead(100);
    recordFilesystemRead(Number.NaN);
    recordParserGateWait(10);
    recordParserGateWait(Number.POSITIVE_INFINITY);
    recordIpcPending(4);
    recordIpcPending(Number.NaN);
    recordWriteQueueWait(5);
    recordWriteQueueWait(Number.NaN);

    const snap = getCodebaseIndexPerfSnapshot();
    expect(snap.filesystemBytesRead).toBe(100);
    expect(snap.filesystemReadCount).toBe(1);
    expect(snap.parserGateWaitMs).toBe(10);
    expect(snap.parserGateCalls).toBe(1);
    expect(snap.ipcPendingPeak).toBe(4);
    expect(snap.writeQueueWaitMs).toBe(5);
    expect(snap.writeQueueCalls).toBe(1);
  });
});
