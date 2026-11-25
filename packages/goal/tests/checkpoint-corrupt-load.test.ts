import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CheckpointManager } from '../src/checkpoint.js';
import type { PhaseStore } from '../src/phase-store.js';

describe('CheckpointManager loadFromDisk validation', () => {
  it('skips persisted checkpoints with non-finite timestamp or invalid metadata', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-cp-corrupt-'));
    try {
      const cpDir = join(dir, '.checkpoints');
      mkdirSync(cpDir, { recursive: true });
      writeFileSync(
        join(cpDir, 'g1.json'),
        JSON.stringify([
          {
            id: 'valid-cp',
            graphId: 'g1',
            phaseId: 'p1',
            phaseStatus: 'running',
            taskStatuses: [],
            timestamp: 1_750_000_000_000,
          },
          {
            id: 'corrupt-ts',
            graphId: 'g1',
            phaseId: 'p1',
            phaseStatus: 'running',
            taskStatuses: [],
            timestamp: null,
          },
          {
            id: 'corrupt-status',
            graphId: 'g1',
            phaseId: 'p1',
            phaseStatus: 'bogus',
            taskStatuses: [],
            timestamp: 1_750_000_000_001,
          },
        ]),
        'utf8',
      );

      const cm = new CheckpointManager({
        store: { baseDir: dir } as unknown as PhaseStore,
        baseDir: cpDir,
      });
      await cm.initialize();

      expect(cm.listCheckpoints('g1').map((c) => c.id)).toEqual(['valid-cp']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
