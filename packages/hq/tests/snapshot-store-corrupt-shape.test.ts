import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it } from 'vitest';
import { HqSnapshotStore } from '../src/persistence/snapshot-store.js';
import type { HqSnapshot } from '../src/protocol.js';

describe('HqSnapshotStore.load corrupt shape validation (F1852)', () => {
  it('returns null for non-object or structurally invalid snapshot JSON', async () => {
    const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'hq-snapshot-shape-'));
    try {
      const store = new HqSnapshotStore({ dataDir: tmpDir });
      const filePath = path.join(tmpDir, 'snapshot.json');

      for (const payload of [
        'null',
        '[]',
        '"str"',
        '42',
        '{}',
        '{"totals":[],"machines":[],"projects":[]}',
      ]) {
        await fs.writeFile(filePath, payload, 'utf8');
        expect(await store.load()).toBeNull();
      }

      const valid = {
        type: 'hq.snapshot',
        generatedAt: '2026-11-25T12:00:00.000Z',
        totals: { machines: 0, projects: 0, activeAgents: 0, totalCostUsd: 0 },
        machines: [],
        projects: [],
      } as unknown as HqSnapshot;
      store.save(valid);
      await store.drain();
      expect(await store.load()).toEqual(valid);
    } finally {
      await fs.rm(tmpDir, { recursive: true, force: true });
    }
  });
});
