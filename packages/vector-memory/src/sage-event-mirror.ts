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
 * Useful after bulk operations (`memory.cleared`, `hygiene.purge_deleted`)
 * that emit a single top-level event but may not emit per-memory
 * `memory.deleted` events.
 */
export async function forgetStaleSageMirrors(
  store: VectorMemoryStore,
  memoryStore: MemoryPort,
  logger?: { warn?(msg: string, ctx?: unknown): void | undefined },
): Promise<{ scanned: number; removed: number }> {
  const surface = getSageSurface(memoryStore);
  if (!surface) return { scanned: 0, removed: 0 };
  let scanned = 0;
  let removed = 0;
  // `list({ limit: 1000 })` is the only listing primitive the store
  // exposes today. For projects with > 1000 entries this sweeps only the
  // head of the corpus — that's acceptable: SAGE's emission contract
  // handles per-memory events for the common path, and this sweep is the
  // safety net for the long tail.
  for (let offset = 0; ; offset += 1000) {
    const page = store.list({ limit: 1000 });
    if (page.length === 0) break;
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
    if (page.length < 1000) break;
  }
  return { scanned, removed };
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
