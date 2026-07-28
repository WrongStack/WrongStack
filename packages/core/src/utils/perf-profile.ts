/**
 * Process-wide performance profile.
 *
 * `WRONGSTACK_PERF_PROFILE` (alias `WSTACK_PERF_PROFILE`):
 *   - `balanced` (default) — current throughput-oriented defaults
 *   - `frugal` / `cimri` — lower CPU concurrency, leaner SQLite caches,
 *     coarser UI stream paint. Correctness and APIs unchanged.
 */

export type PerfProfile = 'balanced' | 'frugal';

/**
 * Long-lived IPC daemons default to `frugal`.
 *
 * The SQLite pragmas below are per *connection*, and a daemon holds its
 * connections for its whole lifetime — the codebase-index daemon measured
 * 336MB RSS, essentially all of it the 128MiB page cache plus 512MiB mmap
 * reservation, while sitting idle. A foreground host pays that cost briefly;
 * a daemon pays it for hours. An explicit `WRONGSTACK_PERF_PROFILE` from the
 * operator still wins in both directions.
 */
let daemonDefaults = false;

/** Call once from a daemon entry point, before opening any store. */
export function useDaemonPerfDefaults(): void {
  daemonDefaults = true;
}

/** Resolve the active profile from the environment (evaluated each call). */
export function getPerfProfile(): PerfProfile {
  const explicit = process.env.WRONGSTACK_PERF_PROFILE ?? process.env.WSTACK_PERF_PROFILE;
  if (explicit === undefined || explicit.trim() === '') {
    return daemonDefaults ? 'frugal' : 'balanced';
  }
  const raw = explicit.trim().toLowerCase();
  if (raw === 'frugal' || raw === 'cimri' || raw === 'low' || raw === 'eco') {
    return 'frugal';
  }
  return 'balanced';
}

export function isFrugalPerf(): boolean {
  return getPerfProfile() === 'frugal';
}

/** Parallel file-parse batch size for the codebase indexer. */
export function indexParallelBatchSize(availableCores: number): number {
  const cores = Math.max(1, Math.floor(availableCores) || 1);
  if (isFrugalPerf()) {
    // Serial-ish: at most 4 files concurrent, never more than core count.
    return Math.min(4, cores);
  }
  // Historical default: cores×4, hard-capped at 40.
  return Math.min(cores * 4, 40);
}

/**
 * SQLite page-cache / mmap sizes in KiB (negative PRAGMA = KiB units for cache).
 * Frugal keeps correctness; just spends less RSS.
 */
export function sqliteCachePragmas(): { cacheSizeKiB: number; mmapBytes: number } {
  if (isFrugalPerf()) {
    return { cacheSizeKiB: 16_384, mmapBytes: 64 * 1024 * 1024 }; // 16 MiB / 64 MiB
  }
  return { cacheSizeKiB: 131_072, mmapBytes: 512 * 1024 * 1024 }; // 128 MiB / 512 MiB
}

/** sage store defaults (slightly smaller than index). */
export function SageCachePragmas(): { cacheSizeKiB: number; mmapBytes: number } {
  if (isFrugalPerf()) {
    return { cacheSizeKiB: 8_192, mmapBytes: 32 * 1024 * 1024 }; // 8 MiB / 32 MiB
  }
  return { cacheSizeKiB: 65_536, mmapBytes: 256 * 1024 * 1024 }; // 64 MiB / 256 MiB
}

/**
 * TUI stream paint interval. Higher = fewer React dispatches (less CPU/heap
 * churn). Balanced keeps the historical ~10fps; frugal ~6–7fps.
 */
export function tuiStreamFlushMs(): number {
  return isFrugalPerf() ? 150 : 100;
}
