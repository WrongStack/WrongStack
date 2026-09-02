/**
 * Tests for createSageSurfaceSyncSource — the SageSyncSource adapter that
 * cursor-walks a SAGE surface's listSagePage into syncFromSage's input.
 *
 * Pins: cursor pagination, the 5000 hard cap, early stop on last page,
 * field mapping (id/text/summary/tags + sage metadata), and the privacy
 * default (statuses:['active'], no sessionId, no includeAllSessions).
 */
import { describe, expect, it } from 'vitest';

import type { SageSurface } from '@wrongstack/sage';

import { createSageSurfaceSyncSource } from '../src/sage-sync-source.js';

function fakeSurface(
  pages: Array<{ memories: unknown[]; nextCursor: string | null }>,
): SageSurface & { calls: unknown[] } {
  const calls: unknown[] = [];
  let i = 0;
  const surface = {
    listSagePage: async (options: unknown) => {
      calls.push(options);
      const page = pages[Math.min(i, pages.length - 1)]!;
      i++;
      return page;
    },
  } as unknown as SageSurface & { calls: unknown[] };
  surface.calls = calls;
  return surface;
}

function sageRow(id: string, text: string, extra: Record<string, unknown> = {}): unknown {
  return {
    id,
    revision: 1,
    scope: 'project',
    kind: 'fact',
    status: 'active',
    text,
    importance: 0.5,
    confidence: 0.9,
    freshness: 1,
    tags: ['sage'],
    anchors: [],
    sources: [],
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...extra,
  };
}

describe('createSageSurfaceSyncSource', () => {
  it('cursor-walks pages until nextCursor is null', async () => {
    const surface = fakeSurface([
      { memories: [sageRow('a', 'first')], nextCursor: 'c1' },
      { memories: [sageRow('b', 'second')], nextCursor: null },
    ]);
    const source = createSageSurfaceSyncSource(surface);
    const memories = await source.listActiveMemories({ limit: 5000 });
    expect(memories.map((m) => m.id)).toEqual(['a', 'b']);
    expect(surface.calls).toHaveLength(2);
    // Page 2 request carries the cursor from page 1.
    expect(surface.calls[1]).toMatchObject({ cursor: 'c1' });
  });

  it('maps fields and folds sage metadata', async () => {
    const surface = fakeSurface([
      {
        memories: [
          sageRow('a', 'the text', {
            summary: 'short',
            tags: ['x', 'y'],
            kind: 'fact',
            scope: 'user',
          }),
        ],
        nextCursor: null,
      },
    ]);
    const memories = await createSageSurfaceSyncSource(surface).listActiveMemories({ limit: 100 });
    expect(memories).toHaveLength(1);
    expect(memories[0]).toMatchObject({
      id: 'a',
      text: 'the text',
      summary: 'short',
      tags: ['x', 'y'],
    });
    expect(memories[0]!.metadata).toMatchObject({
      sageKind: 'fact',
      sageScope: 'user',
      importance: 0.5,
      confidence: 0.9,
    });
  });

  it('caps the total at the requested limit', async () => {
    const surface = fakeSurface([
      { memories: [sageRow('a', 'a'), sageRow('b', 'b')], nextCursor: 'c1' },
      { memories: [sageRow('c', 'c')], nextCursor: null },
    ]);
    const memories = await createSageSurfaceSyncSource(surface).listActiveMemories({ limit: 2 });
    expect(memories.map((m) => m.id)).toEqual(['a', 'b']);
    // Only as many pages as needed — the cap stops the walk before page 2.
    expect(surface.calls).toHaveLength(1);
  });

  it('keeps the privacy default: active statuses only, no session expansion', async () => {
    const surface = fakeSurface([{ memories: [], nextCursor: null }]);
    await createSageSurfaceSyncSource(surface).listActiveMemories({ limit: 10 });
    expect(surface.calls).toHaveLength(1);
    const opts = surface.calls[0]! as Record<string, unknown>;
    expect(opts['statuses']).toEqual(['active']);
    expect('sessionId' in opts).toBe(false);
    expect('includeAllSessions' in opts).toBe(false);
  });
});
