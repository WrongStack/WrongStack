/**
 * Backwards-compatible TUI import surface for heap diagnostics.
 *
 * The implementation lives in core so CLI, TUI and WebUI use identical
 * sampling semantics. Production TUI wiring joins the process-wide shared
 * watchdog; the independent starter remains re-exported for embedders/tests.
 */
export {
  defaultHeapLogPath,
  type HeapDiagnosticFields,
  type HeapDiagnosticValue,
  type HeapSample,
  type HeapWatchdogOptions,
  startHeapWatchdog,
  startSharedHeapWatchdog,
  takeHeapSample,
} from '@wrongstack/core/utils';
