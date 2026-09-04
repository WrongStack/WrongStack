/**
 * Singleton gate for stream debug logging.
 *
 * WireAdapter reads this on every stream() call, so runtime toggles
 * (via /settings debug-stream on|off) take effect on the next request
 * without recreating provider instances.
 *
 * When enabled, WireAdapter accumulates per-chunk stats and pushes them
 * through a registered callback. In CLI (non-TUI) mode the default
 * callback writes a compact status line to stderr. The TUI replaces
 * the callback with one that dispatches to its reducer so the debug
 * info renders inside Ink's StatusBar line 3 instead of bypassing it.
 *
 * The CLI boot path seeds this from config.debugStream at startup.
 */

export interface DebugStreamStats {
  /** Monotonic chunk counter, resets per-stream. */
  chunkCount: number;
  /** Bytes of the most recent chunk. */
  lastChunkSize: number;
  /** Millisecond delta since the PREVIOUS chunk (reveals think gaps). */
  lastDeltaMs: number;
  /** Cumulative bytes received for this stream. */
  totalBytes: number;
  /** ISO timestamp of the most recent chunk. */
  lastChunkAt: string;
}

export type DebugStreamCallback = (stats: DebugStreamStats) => void;

let _debugStreamEnabled = false;
let _debugStreamCallback: DebugStreamCallback | null = null;

// ---- Throttle internals ----
let _throttleTimer: ReturnType<typeof setTimeout> | null = null;
let _pendingStats: DebugStreamStats | null = null;
const THROTTLE_MS = 200; // batch React dispatches at ~5 Hz

function _flush(): void {
  try {
    if (_pendingStats && _debugStreamCallback) {
      _debugStreamCallback({ ..._pendingStats });
    }
  } finally {
    _pendingStats = null;
    _throttleTimer = null;
  }
}

function _scheduleFlush(): void {
  if (_throttleTimer) return;
  _throttleTimer = setTimeout(_flush, THROTTLE_MS);
  if (_throttleTimer.unref) _throttleTimer.unref();
}

/** Check whether raw SSE stream debugging is currently active. */
export function isDebugStreamEnabled(): boolean {
  return _debugStreamEnabled;
}

/** Flip the stream debug flag at runtime. Persisted separately via ConfigStore. */
export function setDebugStreamEnabled(enabled: boolean): void {
  _debugStreamEnabled = enabled;
  if (!enabled && _throttleTimer) {
    clearTimeout(_throttleTimer);
    _throttleTimer = null;
    _pendingStats = null;
  }
}

/**
 * Register a callback that receives THROTTLED debug-chunk stats (~5 Hz).
 * WireAdapter calls `pushDebugChunkStats()` on every raw chunk; this module
 * batches them and calls `cb` at most once per THROTTLE_MS.
 *
 * Pass `null` to restore the default stderr behaviour.
 */
export function setDebugStreamCallback(cb: DebugStreamCallback | null): void {
  // Flush any pending stats before swapping the callback so the old consumer
  // doesn't miss the last batch.
  if (_throttleTimer) {
    clearTimeout(_throttleTimer);
    _flush();
  }
  _debugStreamCallback = cb;
}

/**
 * Called by WireAdapter on every raw chunk. Not throttled — call it as
 * often as chunks arrive; it's cheap (a few integer assigns + a debounced
 * setTimeout). The registered callback receives aggregated stats at most
 * once per THROTTLE_MS.
 */
export function pushDebugChunkStats(bytes: number, deltaMs: number): void {
  if (!_debugStreamEnabled) return;

  _pendingStats = {
    chunkCount: (_pendingStats?.chunkCount ?? 0) + 1,
    lastChunkSize: bytes,
    lastDeltaMs: deltaMs,
    totalBytes: (_pendingStats?.totalBytes ?? 0) + bytes,
    lastChunkAt: new Date().toISOString(),
  };
  _scheduleFlush();
}

/**
 * Default callback: write a compact status line to stderr (used in CLI /
 * headless mode where Ink isn't painting the terminal).
 */
export function defaultDebugStreamCallback(stats: DebugStreamStats): void {
  process.stderr.write(
    `[DEBUG-STREAM] chunk #${stats.chunkCount} (${stats.lastChunkSize}B, +${stats.lastDeltaMs}ms) · ${fmtBytes(stats.totalBytes)} total · ${stats.lastChunkAt}\n`,
  );
}

function fmtBytes(n: number): string {
  if (n < 1024) return `${n}B`;
  if (n < 1_048_576) return `${(n / 1024).toFixed(1)}KB`;
  return `${(n / 1_048_576).toFixed(1)}MB`;
}
