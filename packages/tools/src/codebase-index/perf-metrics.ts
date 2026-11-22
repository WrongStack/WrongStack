export type { CodebaseIndexPerfSnapshot } from '@wrongstack/codebase/perf-metrics';
export {
  getCodebaseIndexPerfSnapshot,
  recordFilesystemRead,
  recordIpcPending,
  recordParserGateWait,
  recordParserSubprocess,
  recordWriteQueueWait,
  resetCodebaseIndexPerfMetrics,
} from '@wrongstack/codebase/perf-metrics';
