/** Opt-in counters for controlled codebase-index performance measurements. */
export interface CodebaseIndexPerfSnapshot {
  filesystemBytesRead: number;
  filesystemReadCount: number;
  parserGateWaitMs: number;
  parserGateCalls: number;
  parserSubprocessCount: number;
  ipcPendingPeak: number;
  writeQueueWaitMs: number;
  writeQueueCalls: number;
}

const counters: CodebaseIndexPerfSnapshot = {
  filesystemBytesRead: 0,
  filesystemReadCount: 0,
  parserGateWaitMs: 0,
  parserGateCalls: 0,
  parserSubprocessCount: 0,
  ipcPendingPeak: 0,
  writeQueueWaitMs: 0,
  writeQueueCalls: 0,
};

export function resetCodebaseIndexPerfMetrics(): void {
  for (const key of Object.keys(counters) as (keyof CodebaseIndexPerfSnapshot)[]) {
    counters[key] = 0;
  }
}

export function getCodebaseIndexPerfSnapshot(): CodebaseIndexPerfSnapshot {
  return { ...counters };
}

export function recordFilesystemRead(bytes: number): void {
  if (!Number.isFinite(bytes)) return;
  counters.filesystemBytesRead += Math.max(0, bytes);
  counters.filesystemReadCount++;
}

export function recordParserGateWait(waitMs: number): void {
  if (!Number.isFinite(waitMs)) return;
  counters.parserGateWaitMs += Math.max(0, waitMs);
  counters.parserGateCalls++;
}

export function recordParserSubprocess(): void {
  counters.parserSubprocessCount++;
}

export function recordIpcPending(depth: number): void {
  if (!Number.isFinite(depth)) return;
  counters.ipcPendingPeak = Math.max(counters.ipcPendingPeak, depth);
}

export function recordWriteQueueWait(waitMs: number): void {
  if (!Number.isFinite(waitMs)) return;
  counters.writeQueueWaitMs += Math.max(0, waitMs);
  counters.writeQueueCalls++;
}
