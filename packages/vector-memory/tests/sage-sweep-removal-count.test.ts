import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSageSurface, SqliteMemoryPort } from '@wrongstack/sage';
import { expect, it, vi } from 'vitest';
import { forgetStaleSageMirrors } from '../src/sage-event-mirror.js';
import { VectorMemoryStore } from '../src/store.js';

it.each([false, true])(
  'counts rows actually removed (concurrent delete: %s)',
  async (concurrent) => {
    const projectRoot = mkdtempSync(join(tmpdir(), 'vector-sweep-count-'));
    const memoryStore = new SqliteMemoryPort({ projectRoot });
    let store: VectorMemoryStore | undefined;
    try {
      await memoryStore.initialize();
      const surface = getSageSurface(memoryStore);
      if (!surface) throw new Error('Fixture requires a SAGE surface');
      const vectorStore = new VectorMemoryStore({
        projectRoot,
        provider: {
          id: 'sweep-fixture',
          dimensions: 2,
          embed: async () => [new Float32Array([1, 0])],
        },
      });
      store = vectorStore;
      const entry = await vectorStore.remember({
        text: 'Stale mirror',
        metadata: { source: 'sage', sageId: 'missing-from-sage' },
      });
      const getSage = surface.getSage;
      let deletedByOtherCaller = false;
      vi.spyOn(surface, 'getSage').mockImplementation(async (id) => {
        if (concurrent) deletedByOtherCaller = await vectorStore.forget(entry.id);
        return getSage(id);
      });

      const result = await forgetStaleSageMirrors(vectorStore, memoryStore);
      expect(deletedByOtherCaller).toBe(concurrent);
      expect(vectorStore.get(entry.id)).toBeUndefined();
      expect(result).toEqual({ scanned: 1, removed: concurrent ? 0 : 1 });
    } finally {
      vi.restoreAllMocks();
      store?.close();
      await memoryStore.dispose();
      rmSync(projectRoot, { recursive: true, force: true });
    }
  },
);
