/**
 * Event-driven SAGE → vector-memory mirror.
 *
 * The first-boot mirror (`startFirstBootSageSync`) runs once and writes a
 * marker. After that, new SAGE writes are *not* automatically vectorized
 * — until this module subscribes the vector store to the SAGE event bus.
 *
 * Wired:
 *   - `memory.accepted`  → fetch SAGE, mirror to vector store (idempotent
 *                          thanks to `remember()`'s content_hash dedup).
 *   - `memory.updated`   → fetch SAGE, mirror again. If only metadata
 *                          changed the dedup returns the same entry; if
 *                          the text changed the dedup creates a new entry
 *                          under the new content_hash. The old entry
 *                          (with the previous hash) stays in the store —
 *                          see `forgetStaleSageMirrors` for the optional
 *                          cleanup path callers can run on demand.
 *   - `memory.deleted`   → find the entry by `metadata.sageId` and forget
 *                          it. Falls back silently when no mirror exists.
 *   - `memory.recovered` → treated as `memory.accepted` (a recovery
 *                          re-activates the memory; the mirror needs to
 *                          see it as well).
 *
 * Fail-open: any error from the vector store is logged and swallowed.
 * The mirror must never block the SAGE write path.
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import type { EventBus } from '@wrongstack/core/kernel';
import type { MemoryPort } from '@wrongstack/core/types';
import { getSageSurface } from '@wrongstack/sage';
import type { Sage } from '@wrongstack/sage';

import type { VectorMemoryStore } from './store.js';

export interface VectorMemoryMirrorOptions {
  store: VectorMemoryStore;
  memoryStore: MemoryPort;
  logger?:
    | {
        debug?(msg: string, ctx?: unknown): void | undefined;
        warn?(msg: string, ctx?: unknown): void | undefined;
      }
    | undefined;
  /**
   * Disable the listener (e.g. in tests where the bus is shared across
   * suites). Returns a no-op disposer.
   */
  enabled?: boolean | undefined;
}

export interface VectorMemoryMirrorHandle {
  /** Idempotent — calling twice is a no-op. */
  dispose: () => void;
}

/**
 * Subscribe the vector store to the SAGE event bus so live writes are
 * mirrored. Returns a handle whose `dispose()` removes all listeners.
 *
 * Idempotency:
 *  - `remember()` content-hash dedupes, so a re-fire of `memory.accepted`
 *    with identical text is a no-op.
 *  - The mirror skips session-scoped memories (privacy parity with
 *    `createSageSurfaceSyncSource`).
 *  - Errors are logged and swallowed; the SAGE write path is never blocked.
 */
export function subscribeVectorMemoryToSage(
  opts: VectorMemoryMirrorOptions,
): VectorMemoryMirrorHandle {
  const { store, memoryStore } = opts;
  const log = opts.logger;
  if (opts.enabled === false) {
    return { dispose: () => undefined };
  }

  const surface = getSageSurface(memoryStore);
  if (!surface) {
    log?.debug?.('vector-memory mirror disabled: memory store exposes no SAGE surface');
    return { dispose: () => undefined };
  }

  const events = (memoryStore as { events?: EventBus }).events;
  if (!events) {
    log?.debug?.('vector-memory mirror disabled: memory store has no event bus');
    return { dispose: () => undefined };
  }

  // Fetch the SAGE memory by id. `getSage` is the canonical retrieval —
  // returns the active memory object (text, tags, scope, kind, metadata).
  // If the memory was just deleted, `getSage` returns null and the mirror
  // is a no-op (the `memory.deleted` path handles cleanup separately).
  const fetch = async (memoryId: string): Promise<Sage | null> => {
    try {
      return await surface.getSage(memoryId);
    } catch (err) {
      log?.warn?.(`vector-memory mirror fetch failed for ${memoryId}: ${errMsg(err)}`);
      return null;
    }
  };

  const mirror = async (memoryId: string): Promise<void> => {
    const memory = await fetch(memoryId);
    if (!memory) return;
    // Session-scoped memories stay private — never mirror them. This
    // matches `createSageSurfaceSyncSource`'s privacy contract.
    if (memory.scope === 'session') return;
    try {
      // Drop any existing mirror for this SAGE id BEFORE re-inserting.
      // Without this step two update paths drift:
      //   - text change:  `remember()` content_hash-dedups to a NEW
      //     row, leaving the OLD row orphaned (a search for the old
      //     wording still hits a memory SAGE no longer has).
      //   - metadata-only change (same text): `remember()` returns the
      //     existing row unchanged, so updated tags / importance /
      //     confidence never reach the vector store.
      // The forget-then-remember churn is one extra DELETE per SAGE
      // write — an acceptable cost for a state that actually matches
      // the source of truth.
      const existing = store.findBySageId(memoryId);
      if (existing) await store.forget(existing.id);
      await store.remember({
        text: memory.text,
        ...(memory.summary ? { summary: memory.summary } : {}),
        tags: memory.tags ?? [],
        scope: 'project',
        kind: 'note',
        metadata: {
          source: 'sage',
          sageId: memory.id,
          sageKind: memory.kind,
          sageScope: memory.scope,
          importance: memory.importance,
          confidence: memory.confidence,
        },
      });
    } catch (err) {
      log?.warn?.(`vector-memory mirror remember failed for ${memoryId}: ${errMsg(err)}`);
    }
  };

  const forgetMirror = async (memoryId: string): Promise<void> => {
    try {
      const existing = store.findBySageId(memoryId);
      if (existing) await store.forget(existing.id);
    } catch (err) {
      log?.warn?.(`vector-memory mirror forget failed for ${memoryId}: ${errMsg(err)}`);
    }
  };

  // Pattern-based listeners share the same disposer so dropping the
  // mirror is a single `events.offPattern` call.
  const offAccepted = events.onPattern('memory.accepted', (_event, payload) => {
    const memoryId = (payload as { memoryId?: unknown } | undefined)?.memoryId;
    if (typeof memoryId !== 'string') return;
    void mirror(memoryId);
  });
  const offRecovered = events.onPattern('memory.recovered', (_event, payload) => {
    const memoryId = (payload as { memoryId?: unknown } | undefined)?.memoryId;
    if (typeof memoryId !== 'string') return;
    void mirror(memoryId);
  });
  const offUpdated = events.onPattern('memory.updated', (_event, payload) => {
    const memoryId = (payload as { memoryId?: unknown } | undefined)?.memoryId;
    if (typeof memoryId !== 'string') return;
    // A status patch to 'deleted' is the SAGE-side tombstone; the
    // companion `memory.deleted` event fires the actual delete. Skip
    // updates whose only change is the status field so we don't race
    // the explicit delete.
    const status = (payload as { status?: unknown } | undefined)?.status;
    if (status === 'deleted') return;
    void mirror(memoryId);
  });
  const offDeleted = events.onPattern('memory.deleted', (_event, payload) => {
    const memoryId = (payload as { memoryId?: unknown } | undefined)?.memoryId;
    if (typeof memoryId !== 'string') return;
    void forgetMirror(memoryId);
  });

  return {
    dispose: () => {
      offAccepted();
      offRecovered();
      offUpdated();
      offDeleted();
    },
  };
}

/**
 * Garbage-collect vector entries whose underlying SAGE memory is gone.
 * Walks the store, looks up each `metadata.sageId` in the SAGE surface,
 * and forgets entries whose SAGE id no longer resolves.
 *
 * This is the safety net for bulk operations — hygiene's archive/purge
 * passes, `memory.cleared` — which emit a single top-level event rather than
 * a per-memory `memory.deleted`, so the live mirror never sees them. Without
 * a periodic sweep those rows stay in the vector store forever.
 *
 * A stale row is not a *correctness* hole: a semantic-only hit is resolved
 * through `SageSurface.getSage` and re-checked with `isSageVisibleForSearch`,
 * which rejects an archived or deleted memory. It is a *cost* — every stale
 * row is scanned on every cosine pass and can consume one of the fusion's
 * bounded `maxMaterializations` slots before being dropped.
 *
 * Hosts run this from the session-end teardown, throttled alongside SAGE
 * hygiene (see `setupVectorMemory` / `startWebUI`).
 */
export async function forgetStaleSageMirrors(
  store: VectorMemoryStore,
  memoryStore: MemoryPort,
  logger?: { warn?(msg: string, ctx?: unknown): void | undefined },
  /** Rows per keyset page. Exposed so tests can exercise multi-page walks. */
  options?: { pageSize?: number | undefined },
): Promise<{ scanned: number; removed: number }> {
  const surface = getSageSurface(memoryStore);
  if (!surface) return { scanned: 0, removed: 0 };
  let scanned = 0;
  let removed = 0;
  // Keyset paging, not offset.
  //
  // This loop previously advanced an `offset` variable that `store.list()`
  // never accepted, so every iteration re-read the SAME first page. On a
  // store with 1000+ entries and nothing to remove — the healthy case — the
  // exit condition `page.length < 1000` was never reached and the sweep
  // spun forever. `list({ after })` resumes from the last row instead, which
  // is also the only correct primitive here: the sweep deletes as it walks,
  // and under OFFSET every deletion shifts the remaining rows left so the
  // next page skips exactly as many entries as were removed.
  const PAGE = Math.max(1, options?.pageSize ?? 500);
  let after: { updatedAt: string; id: string } | undefined;
  for (;;) {
    const page = store.list(after ? { limit: PAGE, after } : { limit: PAGE });
    if (page.length === 0) break;
    const last = page[page.length - 1]!;
    after = { updatedAt: last.updatedAt, id: last.id };
    for (const entry of page) {
      scanned++;
      const sageId = (entry.metadata as { sageId?: unknown } | undefined)?.sageId;
      if (typeof sageId !== 'string') continue;
      try {
        const memory = await surface.getSage(sageId);
        // `getSage` returns the row even when `status === 'deleted'`
        // (SAGE tombstones stay in the table for audit; only the
        // search filter hides them). Treat the tombstoned memory as
        // gone for the mirror's purposes — otherwise stale entries
        // accumulate forever after a `deleteSage`.
        if (memory !== null && memory.status !== 'deleted') continue;
        await store.forget(entry.id);
        removed++;
      } catch (err) {
        logger?.warn?.(`vector-memory stale-mirror sweep failed for ${sageId}: ${errMsg(err)}`);
      }
    }
    if (page.length < PAGE) break;
  }
  return { scanned, removed };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Sidecar recording the last stale-mirror sweep, next to the vector db. */
export const SAGE_SWEEP_MARKER_FILENAME = 'sage-mirror-sweep.json';
/** Default minimum gap between sweeps. Matches SAGE's auto-hygiene throttle. */
export const DEFAULT_SWEEP_INTERVAL_MS = 60 * 60_000;

export interface SweepStaleSageMirrorsOptions {
  store: VectorMemoryStore;
  memoryStore: MemoryPort;
  logger?: { debug?(msg: string): void | undefined; warn?(msg: string): void | undefined } | undefined;
  /** Skip when the last sweep was more recent than this. Default 1 hour. */
  minIntervalMs?: number | undefined;
  /** Run regardless of the throttle (operator-forced re-sync). */
  force?: boolean | undefined;
}

export interface SweepStaleSageMirrorsResult {
  swept: boolean;
  reason?: string;
  scanned?: number;
  removed?: number;
}

/**
 * Throttled wrapper around {@link forgetStaleSageMirrors} for host wiring.
 *
 * The sweep is O(corpus) with one `getSage` per mirrored row, so it must not
 * run on every boot of every surface — a project with the CLI and the WebUI
 * open would otherwise sweep twice per session start. The throttle is a
 * timestamp file beside the vector database rather than a process-local
 * variable, precisely so that those two independent processes share it.
 *
 * Fail-open in every direction: an unreadable or corrupt marker is treated as
 * "never swept", and a failed sweep is logged and swallowed. Callers
 * fire-and-forget this during boot.
 */
export async function sweepStaleSageMirrors(
  opts: SweepStaleSageMirrorsOptions,
): Promise<SweepStaleSageMirrorsResult> {
  const markerPath = path.join(opts.store.directory, SAGE_SWEEP_MARKER_FILENAME);
  const interval = opts.minIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS;
  if (!opts.force) {
    try {
      const raw = JSON.parse(fs.readFileSync(markerPath, 'utf8')) as { at?: unknown };
      const at = typeof raw.at === 'string' ? Date.parse(raw.at) : Number.NaN;
      if (Number.isFinite(at) && Date.now() - at < interval) {
        return { swept: false, reason: 'throttled' };
      }
    } catch {
      // No marker, unreadable, or corrupt — treat as never swept.
    }
  }
  // Claim the slot BEFORE the walk, not after. The sweep can take a while on
  // a large corpus, and a second host booting in that window must not start
  // its own concurrent pass over the same rows.
  try {
    fs.writeFileSync(markerPath, JSON.stringify({ at: new Date().toISOString() }), 'utf8');
  } catch {
    // A read-only data directory disables the throttle, not the sweep.
  }
  try {
    const result = await forgetStaleSageMirrors(opts.store, opts.memoryStore, opts.logger);
    opts.logger?.debug?.(
      `vector-memory stale-mirror sweep: scanned=${result.scanned} removed=${result.removed}`,
    );
    return { swept: true, ...result };
  } catch (err) {
    opts.logger?.warn?.(`vector-memory stale-mirror sweep failed: ${errMsg(err)}`);
    return { swept: false, reason: errMsg(err) };
  }
}
