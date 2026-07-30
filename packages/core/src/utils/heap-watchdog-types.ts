export interface HeapSample {
  ts: string;
  /** Resident set size, bytes. */
  rss: number;
  heapUsed: number;
  heapTotal: number;
  /** Off-heap (buffers, etc.), bytes. */
  external: number;
  /** ArrayBuffer/Buffer backing stores, included in `external`. */
  arrayBuffers?: number | undefined;
  /**
   * RSS not explained by V8's committed heap or external allocations.
   * This is a diagnostic heuristic, not an accounting identity: code pages,
   * stacks, allocator fragmentation, Ink/Yoga and native addons live here.
   */
  nativeResidual?: number | undefined;
  /** Selected V8 space usage, bytes. */
  oldSpaceUsed?: number | undefined;
  newSpaceUsed?: number | undefined;
  largeObjectSpaceUsed?: number | undefined;
  codeSpaceUsed?: number | undefined;
  /** Native memory tracked by V8's allocator, bytes. */
  mallocedMemory?: number | undefined;
  peakMallocedMemory?: number | undefined;
  nativeContexts?: number | undefined;
  detachedContexts?: number | undefined;
  /** Active libuv/Node resources (timers, pipes, sockets, etc.). */
  activeResources?: number | undefined;
  /** V8 hard heap limit, bytes — the OOM ceiling. */
  heapLimit: number;
  /** heapUsed / heapLimit, 0–1. */
  load: number;
}

export type HeapDiagnosticValue = string | number | boolean | null | undefined;
export type HeapDiagnosticFields = Record<string, HeapDiagnosticValue>;

export interface HeapWatchdogOptions {
  /** Sampling cadence. Default 30s. */
  sampleEveryMs?: number | undefined;
  /** Diagnostic-file append cadence. Default 60s. */
  logEveryMs?: number | undefined;
  /** Diagnostics file. Default ~/.wrongstack/logs/heap.jsonl */
  logPath?: string | undefined;
  /** Fraction of the heap limit that triggers a 'warn' callback. Default 0.6. */
  warnAt?: number | undefined;
  /** Fraction of the heap limit that triggers a 'critical' callback. Default 0.85. */
  criticalAt?: number | undefined;
  /**
   * Extra structure sizes merged into every diagnostic line — supply cheap
   * counters (array lengths, approximate char totals). Must not throw.
   */
  collectStats?: (() => HeapDiagnosticFields) | undefined;
  /** Override the JSONL writer, primarily for deterministic tests. */
  writeDiagnosticLine?: ((logPath: string, line: string) => Promise<void>) | undefined;
  /** Called on threshold crossings with a human-readable message. */
  onWarn?: ((level: 'warn' | 'critical', message: string, sample: HeapSample) => void) | undefined;
}
