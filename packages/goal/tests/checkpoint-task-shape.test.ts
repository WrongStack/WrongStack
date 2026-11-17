import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CheckpointManager } from '../src/checkpoint.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseStore } from '../src/phase-store.js';

it('skips malformed task snapshots while restoring valid checkpoints from the same file', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'checkpoint-shape-'));
  try {
    const store = new PhaseStore({ baseDir: dir });
    const graph = await new PhaseGraphBuilder({
      title: 'Restore',
      phases: [
        {
          name: 'Build',
          description: 'build',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    }).build();
    await store.save(graph);
    const baseDir = join(dir, '.checkpoints');
    await mkdir(baseDir);
    const valid = {
      id: 'valid',
      graphId: graph.id,
      phaseId: graph.rootPhaseIds[0],
      phaseStatus: 'pending',
      taskStatuses: [],
      timestamp: 1000,
    };
    const malformed = [
      undefined,
      null,
      {},
      [null],
      [{}],
      [{ taskId: 'task', title: 'Task', status: 'unknown' }],
    ];
    await writeFile(
      join(baseDir, `${graph.id}.json`),
      JSON.stringify([
        valid,
        ...malformed.map((taskStatuses, i) => ({ ...valid, id: `bad-${i}`, taskStatuses })),
      ]),
    );
    const manager = new CheckpointManager({ store, baseDir });
    await manager.initialize();
    expect(manager.listCheckpoints().map((checkpoint) => checkpoint.id)).toEqual(['valid']);
    expect(await manager.restoreCheckpoint('valid')).not.toBeNull();
    for (let i = 0; i < malformed.length; i++) {
      expect(await manager.restoreCheckpoint(`bad-${i}`)).toBeNull();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
