import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CheckpointManager } from '../src/checkpoint.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';
import { PhaseStore } from '../src/phase-store.js';

describe('CheckpointManager', () => {
  let tmpDir: string;
  let store: PhaseStore;
  let manager: CheckpointManager;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-test-'));
    store = new PhaseStore({ baseDir: tmpDir });
    manager = new CheckpointManager({ store, maxCheckpoints: 3 });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should save and restore a checkpoint', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Checkpoint Test',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 2,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Task 1',
              description: 'First',
              type: 'feature',
              priority: 'high',
              estimateHours: 1,
            },
          ],
        },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    const checkpoint = await manager.saveCheckpoint(graph, 'Before risky task');
    expect(checkpoint.id).toBeDefined();
    expect(checkpoint.graphId).toBe(graph.id);
    expect(checkpoint.label).toBe('Before risky task');
    expect(checkpoint.taskStatuses).toHaveLength(1);

    const rootPhase = graph.phases.get(graph.rootPhaseIds[0]!)!;
    const firstTask = Array.from(rootPhase.taskGraph.nodes.values())[0]!;
    firstTask.status = 'failed';
    rootPhase.status = 'failed';
    await store.save(graph);

    // Restore
    const restored = await manager.restoreCheckpoint(checkpoint.id);
    expect(restored).not.toBeNull();
    expect(restored!.id).toBe(graph.id);
    expect(
      restored!.phases.get(graph.rootPhaseIds[0]!)?.taskGraph.nodes.get(firstTask.id)?.status,
    ).toBe('pending');
  });

  it('should list checkpoints sorted by timestamp', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'List Test',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    await manager.saveCheckpoint(graph, 'First checkpoint');
    await manager.saveCheckpoint(graph, 'Second checkpoint');

    const checkpoints = manager.listCheckpoints();
    expect(checkpoints.length).toBe(2);
    expect(checkpoints[0]!.label).toBe('Second checkpoint');
  });

  it('should prune old checkpoints per graph when max exceeded', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Prune Test',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    });

    const graph = await builder.build();
    const otherGraph = await new PhaseGraphBuilder({
      title: 'Other Prune Test',
      phases: [
        {
          name: 'Phase B',
          description: 'B',
          priority: 'medium',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    }).build();
    await store.save(graph);
    await store.save(otherGraph);

    let timestamp = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => timestamp++);

    await manager.saveCheckpoint(otherGraph, 'Other checkpoint 1');
    await manager.saveCheckpoint(otherGraph, 'Other checkpoint 2');

    // Save 5 checkpoints for one graph (max is 3)
    for (let i = 1; i <= 5; i++) {
      await manager.saveCheckpoint(graph, `Checkpoint ${i}`);
    }

    const checkpoints = manager.listCheckpoints(graph.id);
    expect(checkpoints.length).toBe(3);
    expect(checkpoints[0]!.label).toBe('Checkpoint 5');
    expect(manager.listCheckpoints(otherGraph.id).map((checkpoint) => checkpoint.label)).toEqual([
      'Other checkpoint 2',
      'Other checkpoint 1',
    ]);

    const reloaded = new CheckpointManager({ store, maxCheckpoints: 3 });
    await reloaded.initialize();

    expect(reloaded.listCheckpoints(graph.id).map((checkpoint) => checkpoint.label)).toEqual([
      'Checkpoint 5',
      'Checkpoint 4',
      'Checkpoint 3',
    ]);
    expect(reloaded.listCheckpoints(otherGraph.id).map((checkpoint) => checkpoint.label)).toEqual([
      'Other checkpoint 2',
      'Other checkpoint 1',
    ]);
  });

  it('should delete a checkpoint', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Delete Test',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    const checkpoint = await manager.saveCheckpoint(graph, 'To be deleted');
    const deleted = await manager.deleteCheckpoint(checkpoint.id);
    expect(deleted).toBe(true);

    const list = manager.listCheckpoints();
    expect(list.length).toBe(0);
  });

  it('should preserve concurrent checkpoints for the same graph', async () => {
    manager = new CheckpointManager({ store, maxCheckpoints: 10 });
    const builder = new PhaseGraphBuilder({
      title: 'Concurrent Test',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
        },
      ],
    });

    const graph = await builder.build();
    await store.save(graph);

    await Promise.all(
      Array.from({ length: 8 }, (_, i) => manager.saveCheckpoint(graph, `Checkpoint ${i + 1}`)),
    );

    const reloaded = new CheckpointManager({ store, maxCheckpoints: 10 });
    await reloaded.initialize();

    expect(reloaded.listCheckpoints(graph.id)).toHaveLength(8);
  });

  it('should return null for non-existent checkpoint', async () => {
    const restored = await manager.restoreCheckpoint('non-existent-id');
    expect(restored).toBeNull();
  });
});
