import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DefaultAttachmentStore } from '../../src/storage/attachment-store.js';

describe('DefaultAttachmentStore.clear concurrency', () => {
  it('preserves attachments added after clear() starts while spooled files unlink', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-att-clear-race-'));
    try {
      const store = new DefaultAttachmentStore({ spoolDir: dir, spoolThresholdBytes: 16 });
      const oldRef = await store.add({ kind: 'text', data: 'x'.repeat(64) });
      const clearing = store.clear();
      const freshRef = await store.add({ kind: 'text', data: 'fresh' });
      await clearing;

      expect(await store.get(oldRef.id)).toBeUndefined();
      expect(await store.get(freshRef.id)).toBeDefined();
      expect(store.list()).toHaveLength(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
