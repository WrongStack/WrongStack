/**
 * SageSyncSource adapter over a SAGE `SageSurface`.
 *
 * Cursor-walks `listSagePage({ statuses: ['active'] })` so the whole active
 * corpus can be mirrored into the vector store via `syncFromSage()` without
 * the caller hand-rolling pagination.
 *
 * Privacy note: `sessionId`/`includeAllSessions` are deliberately NOT set.
 * Every SAGE retrieval surface hides owned session-scoped memories from an
 * enumerator that omits them — this adapter keeps that under-report default
 * so one session's private records are never mirrored into the shared,
 * project-scoped vector store.
 */
import type { SageSurface } from '@wrongstack/sage';

import type { SageSyncSource } from './store.js';

/** Cap mirrors what `VectorMemoryStore.syncFromSage` asks for (5000). */
const DEFAULT_MAX_TOTAL = 5000;
const DEFAULT_PAGE_SIZE = 500;

export interface SageSurfaceSyncOptions {
  /** Hard cap on total mirrored memories. Clamped to [1, 5000]. */
  maxTotal?: number | undefined;
  /** Page size per `listSagePage` call. Clamped to [1, 500]. */
  pageSize?: number | undefined;
}

/**
 * Build a `SageSyncSource` from any SAGE surface exposing `listSagePage`.
 * The surface capability is obtained via `getSageSurface(memoryPort)` from
 * `@wrongstack/sage`; a `Pick` keeps this adapter honest about what it calls.
 */
export function createSageSurfaceSyncSource(
  sage: Pick<SageSurface, 'listSagePage'>,
  opts: SageSurfaceSyncOptions = {},
): SageSyncSource {
  const maxTotal = clamp(opts.maxTotal ?? DEFAULT_MAX_TOTAL, 1, DEFAULT_MAX_TOTAL);
  const pageSize = clamp(opts.pageSize ?? DEFAULT_PAGE_SIZE, 1, 500);
  return {
    async listActiveMemories({ limit }) {
      const cap = clamp(limit, 1, maxTotal);
      const memories: Array<{
        id: string;
        text: string;
        summary?: string;
        tags?: string[];
        metadata?: Record<string, unknown>;
      }> = [];
      let cursor: string | undefined;
      while (memories.length < cap) {
        const page = await sage.listSagePage({
          statuses: ['active'],
          limit: Math.min(pageSize, cap - memories.length),
          ...(cursor ? { cursor } : {}),
        });
        for (const m of page.memories ?? []) {
          memories.push({
            id: m.id,
            text: m.text,
            ...(m.summary ? { summary: m.summary } : {}),
            ...(m.tags && m.tags.length > 0 ? { tags: m.tags } : {}),
            metadata: {
              sageKind: m.kind,
              sageScope: m.scope,
              importance: m.importance,
              confidence: m.confidence,
            },
          });
        }
        if (!page.nextCursor || (page.memories ?? []).length === 0) break;
        cursor = page.nextCursor;
      }
      return memories.slice(0, cap);
    },
  };
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}
