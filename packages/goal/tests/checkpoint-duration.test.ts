import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { CheckpointManager } from '../src/checkpoint.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseStore } from '../src/phase-store.js';

let baseDir: string;

beforeEach(async () => {
  baseDir = await mkdtemp(join(tmpdir(), 'checkpoint-duration-'));
});

afterEach(async () => {
  await rm(baseDir, { recursive: true, force: true });
});

const startedAt = 1_700_000_000_000;
const durationMs = 3_600_000;
const completedAt = startedAt + durationMs;

it.each(['running', 'paused', 'pending', 'completed'] as const)(
  'persists the correct timing when restoring a %s checkpoint',
  async (status) => {
    const store = new PhaseStore({ baseDir });
    const manager = new CheckpointManager({ store });
    const graph = await new PhaseGraphBuilder({
      title: 'Checkpoint timing',
      phases: [
        {
          name: 'Implementation',
          description: '',
          priority: 'medium',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    }).build();
    const [phase] = graph.phases.values();
    if (!phase) throw new Error('Fixture requires one phase');
    phase.status = status;
    if (status !== 'pending') phase.startedAt = startedAt;
    if (status === 'completed') {
      phase.completedAt = completedAt;
      phase.actualDurationMs = durationMs;
    }
    const checkpoint = await manager.saveCheckpoint(graph);

    phase.status = 'completed';
    phase.startedAt = startedAt;
    phase.completedAt = completedAt;
    phase.actualDurationMs = durationMs;
    await store.save(graph);

    const reloaded = new CheckpointManager({ store });
    expect(await reloaded.restoreCheckpoint(checkpoint.id)).not.toBeNull();
    const persistedPhase = (await store.load(graph.id))?.phases.get(phase.id);
    expect(persistedPhase?.status).toBe(status);
    expect(persistedPhase?.startedAt).toBe(status === 'pending' ? undefined : startedAt);
    expect(persistedPhase?.completedAt).toBe(status === 'completed' ? completedAt : undefined);
    expect(persistedPhase?.actualDurationMs).toBe(status === 'completed' ? durationMs : undefined);
  },
);
