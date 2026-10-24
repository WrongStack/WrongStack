import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MemoryPort } from '@wrongstack/contracts/types';
import { SAGE_SURFACE_CAPABILITY } from '@wrongstack/sage';
import { describe, expect, it } from 'vitest';
import { forgetStaleSageMirrors } from '../src/sage-event-mirror.js';
import { VectorMemoryStore } from '../src/store.js';

describe('stale sweep scope parity with the live mirror', () => {
  for (const scope of ['project', 'user', 'session'] as const) {
    it.each(['active', 'stale', 'archived'] as const)(
      `retains only mirrorable ${scope}/%s records`,
      async (status) => {
        const store = new VectorMemoryStore({
          projectRoot: mkdtempSync(join(tmpdir(), 'wrongstack-sweep-scope-test-')),
          provider: {
            id: 'scope-test',
            dimensions: 2,
            embed: async () => [new Float32Array([1, 0])],
          },
        });
        try {
          await store.remember({
            text: 'existing mirror',
            metadata: { source: 'sage', sageId: 'sage-1' },
          });
          const memoryStore = {
            getCapability: (cap: { id: string }) =>
              cap.id === SAGE_SURFACE_CAPABILITY.id
                ? { getSage: async () => ({ scope, status }) }
                : undefined,
          } as unknown as MemoryPort;
          const keep = scope !== 'session' && status !== 'archived';
          await expect(forgetStaleSageMirrors(store, memoryStore)).resolves.toEqual({
            scanned: 1,
            removed: keep ? 0 : 1,
          });
          expect(store.findBySageId('sage-1') !== undefined).toBe(keep);
        } finally {
          store.close();
        }
      },
    );
  }
});
