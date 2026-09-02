/**
 * First-boot SAGE → vector-memory mirror.
 *
 * `VectorMemoryStore.syncFromSage()` has no production caller on its own;
 * this module is that caller. On the first boot per project (no sync marker
 * next to the vector db), the active SAGE corpus is mirrored into the vector
 * store so semantic search starts with the project's existing knowledge
 * instead of an empty index.
 *
 * Semantics:
 *  - Fire-and-forget: the CLI never waits on the sync (first run pays the
 *    ONNX model download; boot must not block on it).
 *  - Marker-based: `sage-sync.complete.json` in `store.directory`. A
 *    `complete` marker means "corpus fully mirrored — don't rescan". A
 *    `running` marker owned by a LIVE pid means another CLI process owns the
 *    sync; takeover happens when the marker is >10 minutes old AND the owning
 *    pid is confirmed dead (`process.kill(pid, 0)`), or when the pid is our
 *    own (second call in-process).
 *  - The `complete` marker is only written when the sync had zero failures
 *    and the embedding provider was available. Anything less leaves no
 *    marker, so the next boot retries — content-hash dedup inside
 *    `syncFromSage` makes that retry cheap (already-mirrored texts skip).
 *  - Privacy: the adapter (createSageSurfaceSyncSource) deliberately omits
 *    sessionId/includeAllSessions, keeping SAGE's under-report default for
 *    session-scoped memories — another session's private records are never
 *    mirrored into this shared project-scoped store.
 *  - Teardown race: if the store is closed mid-sync, subsequent remember()
 *    calls throw inside syncFromSage's per-entry guard, the report comes
 *    back with failures, and no marker is written — next boot retries.
 */
import { getSageSurface } from '@wrongstack/sage';
import type { MemoryPort } from '@wrongstack/core/types';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createSageSurfaceSyncSource } from './sage-sync-source.js';
import type { VectorMemoryStore } from './store.js';

/** Sync marker file written next to the vector db (`running` → `complete` phases). */
export const SAGE_SYNC_MARKER_FILENAME = 'sage-sync.complete.json';

/** A `running` marker older than this is considered dead and taken over. */
const RUNNING_STALE_MS = 10 * 60 * 1000;

export interface SageSyncMarker {
  phase: 'running' | 'complete';
  pid?: number;
  startedAt?: string;
  completedAt?: string;
  providerId?: string;
  scanned?: number;
  indexed?: number;
  skipped?: number;
  failed?: number;
}

export interface FirstBootSageSyncOptions {
  store: VectorMemoryStore;
  /** The host MemoryPort — the SAGE surface capability is read from it. */
  memoryStore: MemoryPort;
  /** Structurally compatible with `@wrongstack/core`'s `Logger`. */
  logger?:
    | {
        debug?(msg: string, ctx?: unknown): void | undefined;
        info?(msg: string, ctx?: unknown): void | undefined;
        warn?(msg: string, ctx?: unknown): void | undefined;
      }
    | undefined;
  /** Tests: inject a custom staleness window. */
  staleAfterMs?: number | undefined;
  /**
   * Tests / hosts: pid liveness probe used before taking over a `running`
   * marker. Defaults to `process.kill(pid, 0)` — throws for a dead pid.
   */
  pidAlive?: ((pid: number) => boolean) | undefined;
  /**
   * Force a full re-sync, ignoring any `complete` marker from a prior
   * boot. Used by operator-initiated re-sync (CLI flag, slash command)
   * where the user explicitly opted in to replay. The new sync still
   * respects the cursor-walker's own termination and the completion
   * invariant (every entry has a vector) — `force` only bypasses the
   * "already-complete, skip" decision.
   */
  force?: boolean | undefined;
}

export interface FirstBootSageSyncResult {
  synced: boolean;
  reason: string;
  marker?: SageSyncMarker | undefined;
}

export async function startFirstBootSageSync(
  opts: FirstBootSageSyncOptions,
): Promise<FirstBootSageSyncResult> {
  const { store, memoryStore } = opts;
  const log = opts.logger;
  try {
    // Operator-initiated `--vector-sync` re-runs the full walk even
    // when the `complete` marker says we're done. The `force` flag is
    // the single source of truth — the run-time checks below still
    // defend against taking over a live `running` marker from another
    // process.
    if (opts.force) {
      try {
        fs.unlinkSync(markerPath(store));
      } catch {
        // No marker to remove is the common case (first-ever force run
        // or after a crash); treat as success.
      }
    }
    const decision = decideWhetherToSync(
      store,
      opts.staleAfterMs ?? RUNNING_STALE_MS,
      undefined,
      opts.pidAlive,
    );
    if (!decision.run) {
      log?.debug?.(`vector-memory sage sync skipped: ${decision.reason}`);
      return { synced: false, reason: decision.reason };
    }

    const provider = storeProvider(store);
    // Cheap pre-check: module not even installed → defer without a throw.
    if (provider && typeof provider.isAvailable === 'function' && !(await provider.isAvailable())) {
      log?.debug?.(
        'vector-memory sage sync deferred: embedding provider unavailable (optional dependency not installed?)',
      );
      return { synced: false, reason: 'provider-unavailable' };
    }
    // Authoritative gate: actually embed a probe. `isAvailable()` only proves
    // the module imports — a model that fails to load/download would let the
    // fail-open `remember()` store vector-less entries and (absent the
    // completion invariant below) permanently mark the mirror complete.
    if (provider && typeof provider.embed === 'function') {
      try {
        const probe = await provider.embed(['wrongstack vector memory warmup probe']);
        if (!probe[0] || probe[0].length === 0) throw new Error('empty embedding');
      } catch {
        log?.debug?.(
          'vector-memory sage sync deferred: embedding probe failed (model not cached / backend error)',
        );
        return { synced: false, reason: 'provider-unavailable' };
      }
    }

    const surface = getSageSurface(memoryStore);
    if (!surface) {
      log?.debug?.('vector-memory sage sync skipped: memory store exposes no SAGE surface');
      return { synced: false, reason: 'no-sage-surface' };
    }

    writeMarker(store, {
      phase: 'running',
      pid: process.pid,
      startedAt: new Date().toISOString(),
    });
    const report = await store.syncFromSage(createSageSurfaceSyncSource(surface));
    if (report.failed > 0) {
      // Leave no complete marker: next boot retries, content-hash dedup
      // skips what already landed.
      log?.warn?.(
        `vector-memory sage sync finished with ${report.failed} failure(s) — will retry on next boot`,
      );
      return {
        synced: false,
        reason: 'partial-failure',
        marker: { phase: 'running', ...counts(report) },
      };
    }

    // Completion invariant: every entry must carry a vector for the current
    // provider. A provider that died mid-sync leaves vector-less entries
    // (remember() fails open) which syncFromSage's content-hash dedup would
    // then skip forever — reindexAll() is the only existing backfill path.
    let stats = store.stats();
    if (stats.vectors !== stats.entries) {
      log?.warn?.(
        `vector-memory sage sync healed ${stats.entries - stats.vectors} vector-less entr(ies) via reindexAll()`,
      );
      await store.reindexAll();
      stats = store.stats();
    }
    if (stats.vectors !== stats.entries) {
      log?.warn?.(
        `vector-memory sage sync incomplete: ${stats.entries - stats.vectors} entr(ies) still vector-less — will retry on next boot`,
      );
      return {
        synced: false,
        reason: 'vector-incomplete',
        marker: { phase: 'running', ...counts(report) },
      };
    }

    const marker: SageSyncMarker = {
      phase: 'complete',
      completedAt: new Date().toISOString(),
      ...(provider ? { providerId: provider.id } : {}),
      ...counts(report),
    };
    writeMarker(store, marker);
    log?.info?.(
      `vector-memory sage sync complete: ${report.indexed} indexed, ${report.skipped} skipped (already present)`,
    );
    return { synced: true, reason: 'synced', marker };
  } catch (error) {
    // Never let a fire-and-forget boot hook reject — but do surface it.
    log?.warn?.(
      `vector-memory sage sync failed: ${error instanceof Error ? error.message : String(error)} — will retry on next boot`,
    );
    return { synced: false, reason: 'error' };
  }
}

interface SyncDecision {
  run: boolean;
  reason: string;
}

export function decideWhetherToSync(
  store: VectorMemoryStore,
  staleAfterMs: number,
  now: Date = new Date(),
  pidAlive: (pid: number) => boolean = defaultPidAlive,
): SyncDecision {
  const existing = readMarker(store);
  if (!existing) return { run: true, reason: 'no-marker' };
  if (existing.phase === 'complete') return { run: false, reason: 'already-complete' };
  if (existing.pid === process.pid) {
    // Our own marker — e.g. a second call in the same process. Safe to take
    // over: the pid is trivially alive and nobody else owns the sync.
    return { run: true, reason: 'running-own-pid' };
  }
  const startedAt = existing.startedAt ? Date.parse(existing.startedAt) : Number.NaN;
  const ageMs = Number.isNaN(startedAt) ? Number.POSITIVE_INFINITY : now.getTime() - startedAt;
  const stale = ageMs > staleAfterMs;
  if (existing.pid === undefined) {
    // Anonymous marker: no pid to probe — the wall-clock window is the only
    // signal, so a fresh one is respected and a stale/undated one is taken over.
    return Number.isNaN(startedAt) || stale
      ? {
          run: true,
          reason: Number.isNaN(startedAt) ? 'running-marker-undated' : 'running-marker-stale',
        }
      : { run: false, reason: 'running-unknown-pid' };
  }
  try {
    if (pidAlive(existing.pid)) {
      // Alive: never hijack — even when the marker looks stale, the owner may
      // legitimately still be working (e.g. a slow first-boot model download).
      return {
        run: false,
        reason: `running-pid-${existing.pid}${stale ? '-stale-but-alive' : ''}`,
      };
    }
    return { run: true, reason: `running-pid-${existing.pid}-dead` };
  } catch {
    // Probe itself failed unexpectedly (not "dead"): conservatively skip.
    return { run: false, reason: `running-pid-${existing.pid}-probe-failed` };
  }
}

/**
 * Liveness via `process.kill(pid, 0)`: no throw means alive; ESRCH means the
 * pid is gone (returns false — takeover is safe); EPERM means it exists but
 * is not ours (conservatively alive).
 */
function defaultPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readMarker(store: VectorMemoryStore): SageSyncMarker | undefined {
  try {
    const raw = fs.readFileSync(markerPath(store), 'utf8');
    const parsed = JSON.parse(raw) as SageSyncMarker;
    return parsed && (parsed.phase === 'running' || parsed.phase === 'complete')
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

function writeMarker(store: VectorMemoryStore, marker: SageSyncMarker): void {
  try {
    fs.writeFileSync(markerPath(store), `${JSON.stringify(marker, null, 2)}\n`, 'utf8');
  } catch {
    // Marker writes are advisory — an unwritable marker directory must not
    // break the sync itself. Worst case: the sync re-runs next boot and
    // dedups to zero new entries.
  }
}

function markerPath(store: VectorMemoryStore): string {
  // `directory` is additive API on VectorMemoryStore (>= the version that
  // introduced it); guard for older/foreign instances just in case.
  const dir = (store as { directory?: string }).directory;
  if (typeof dir !== 'string') {
    throw new Error('VectorMemoryStore.directory is required to place the sage sync marker');
  }
  return path.join(dir, SAGE_SYNC_MARKER_FILENAME);
}

function storeProvider(store: VectorMemoryStore):
  | {
      id: string;
      embed?: (texts: string[]) => Promise<Float32Array[]>;
      isAvailable?: () => Promise<boolean>;
    }
  | undefined {
  const provider = (store as unknown as { provider?: unknown }).provider;
  if (provider && typeof (provider as { id?: unknown }).id === 'string') {
    return provider as {
      id: string;
      embed?: (texts: string[]) => Promise<Float32Array[]>;
      isAvailable?: () => Promise<boolean>;
    };
  }
  return undefined;
}

function counts(report: { scanned: number; indexed: number; skipped: number; failed: number }): {
  scanned: number;
  indexed: number;
  skipped: number;
  failed: number;
} {
  return {
    scanned: report.scanned,
    indexed: report.indexed,
    skipped: report.skipped,
    failed: report.failed,
  };
}
