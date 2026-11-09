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

  it('reconciles failedPhaseIds/activePhaseIds/completedAt and persists on restoreCheckpoint and preserves intra-phase task dependencies (F676)', async () => {
    const { createGoalRunnerFromTaskGraph } = await import('../src/goal-runner.js');
    const { prepareGoalGraphForResume } = await import('../src/goal-run-lifecycle.js');
    const builder = new PhaseGraphBuilder({
      title: 'Restore Reconciliation',
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
              description: 'T1',
              type: 'feature',
              priority: 'high',
              estimateHours: 1,
            },
            {
              title: 'Task 2',
              description: 'T2',
              type: 'feature',
              priority: 'high',
              estimateHours: 1,
              dependsOn: [0],
            },
          ],
        },
      ],
    });

    const graph = await builder.build();
    const phaseId = graph.rootPhaseIds[0]!;
    const phase = graph.phases.get(phaseId)!;
    const tasks = Array.from(phase.taskGraph.nodes.values());
    expect(phase.taskGraph.edges).toEqual([
      expect.objectContaining({ from: tasks[0]!.id, to: tasks[1]!.id, type: 'depends_on' }),
    ]);

    phase.status = 'running';
    tasks[0]!.status = 'completed';
    graph.activePhaseIds = [phaseId];
    const cp = await manager.saveCheckpoint(graph, 'Before failure');

    phase.status = 'failed';
    phase.completedAt = Date.now();
    tasks[1]!.status = 'failed';
    graph.activePhaseIds = [];
    graph.failedPhaseIds = [phaseId];
    graph.runState = 'failed';
    graph.runError = 'Task 2 failed';
    graph.completedAt = Date.now();
    await store.save(graph);

    const restored = await manager.restoreCheckpoint(cp.id);
    expect(restored?.failedPhaseIds).toEqual([]);
    expect(restored?.activePhaseIds).toEqual([phaseId]);
    expect(restored?.completedAt).toBeUndefined();
    expect(restored?.runState).toBe('running');
    expect(restored?.runError).toBeUndefined();
    expect((await store.load(graph.id))?.phases.get(phaseId)?.status).toBe('running');
    await expect(prepareGoalGraphForResume(restored!)).resolves.toBeUndefined();

    const now = Date.now();
    const runner = await createGoalRunnerFromTaskGraph(
      {
        id: 'tg-f676',
        specId: 'spec-f676',
        title: 'TaskGraph Runner',
        nodes: new Map([
          [
            't1',
            {
              id: 't1',
              title: 'First',
              description: 'First',
              type: 'feature',
              status: 'pending',
              priority: 'high',
              estimateHours: 1,
              tags: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
          [
            't2',
            {
              id: 't2',
              title: 'Second',
              description: 'Second',
              type: 'feature',
              status: 'pending',
              priority: 'high',
              estimateHours: 1,
              tags: [],
              createdAt: now,
              updatedAt: now,
            },
          ],
        ]),
        edges: [{ id: 'e1', from: 't1', to: 't2', type: 'blocks' }],
        rootNodes: ['t1'],
        createdAt: now,
        updatedAt: now,
      },
      {
        tasksPerPhase: 5,
        maxConcurrentTasks: 2,
        autonomous: true,
        executeTask: async () => {},
      },
    );
    const runnerGraph = await runner.start();
    const runnerPhase = Array.from(runnerGraph.phases.values())[0]!;
    expect(runnerPhase.taskGraph.edges).toHaveLength(1);
    expect(runnerPhase.taskGraph.edges[0]?.type).toBe('depends_on');
  });

  it('lazy-loads on-disk checkpoints during save/delete and removes post-checkpoint tasks on restore (F766)', async () => {
    const graph = await new PhaseGraphBuilder({
      title: 'F766 Regression',
      phases: [
        {
          name: 'Phase A',
          description: 'A',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Original Task',
              description: 'T1',
              type: 'feature',
              priority: 'high',
              estimateHours: 1,
            },
          ],
        },
      ],
    }).build();

    const firstManager = new CheckpointManager({ store, maxCheckpoints: 2 });
    const cp1 = await firstManager.saveCheckpoint(graph, 'cp-1');
    const cp2 = await firstManager.saveCheckpoint(graph, 'cp-2');

    // Fresh manager without explicit initialize() must delete and prune existing on-disk checkpoints
    const secondManager = new CheckpointManager({ store, maxCheckpoints: 2 });
    expect(await secondManager.deleteCheckpoint(cp1.id)).toBe(true);
    await secondManager.saveCheckpoint(graph, 'cp-3');
    const cp4 = await secondManager.saveCheckpoint(graph, 'cp-4');

    const verifier = new CheckpointManager({ store, maxCheckpoints: 2 });
    await verifier.initialize();
    expect(verifier.listCheckpoints(graph.id).map((c) => c.label)).toEqual(['cp-4', 'cp-3']);
    expect(await verifier.restoreCheckpoint(cp2.id)).toBeNull();

    const phase = graph.phases.get(graph.rootPhaseIds[0]!)!;
    phase.status = 'running';
    phase.startedAt = 99_999;
    phase.taskGraph.nodes.set('added-after', {
      id: 'added-after',
      title: 'Added After',
      description: '',
      type: 'chore',
      priority: 'low',
      status: 'completed',
      createdAt: 1,
      updatedAt: 1,
    });
    phase.taskGraph.rootNodes.push('added-after');
    await store.save(graph);

    const restored = await verifier.restoreCheckpoint(cp4.id);
    const restoredPhase = restored?.phases.get(phase.id);
    expect(restoredPhase?.status).toBe('pending');
    expect(restoredPhase?.startedAt).toBeUndefined();
    expect(restoredPhase?.taskGraph.nodes.has('added-after')).toBe(false);
  });

  it('cleans dangling task children, resets dependent downstream phases, clears stale integrationStatus, and clears finalVerification on restoreCheckpoint (F43)', async () => {
    const twoPhaseGraph = await new PhaseGraphBuilder({
      title: 'Two Phase Checkpoint',
      phases: [
        {
          name: 'Phase 1',
          description: 'First',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'T1', description: 'd', type: 'feature', priority: 'high', estimateHours: 1 },
          ],
        },
        {
          name: 'Phase 2',
          description: 'Second',
          priority: 'medium',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'T2',
              description: 'd',
              type: 'feature',
              priority: 'medium',
              estimateHours: 1,
            },
          ],
        },
      ],
    }).build();
    const [p1, p2] = Array.from(twoPhaseGraph.phases.values());
    const t1 = Array.from(p1!.taskGraph.nodes.values())[0]!;
    const t2 = Array.from(p2!.taskGraph.nodes.values())[0]!;

    const cp = await manager.saveCheckpoint(twoPhaseGraph, 'before-completion');

    p1!.taskGraph.nodes.set('late-child', {
      id: 'late-child',
      title: 'Late Child',
      description: '',
      type: 'chore',
      priority: 'low',
      status: 'completed',
      parentId: t1.id,
      createdAt: 1,
      updatedAt: 1,
    });
    t1.children = ['late-child'];
    t1.status = 'completed';
    p1!.status = 'completed';
    p1!.metadata = { integrationStatus: 'merged' };
    t2.status = 'completed';
    p2!.status = 'completed';
    p2!.metadata = { integrationStatus: 'merged' };
    twoPhaseGraph.completedPhaseIds = [p1!.id, p2!.id];
    twoPhaseGraph.completedAt = Date.now();
    twoPhaseGraph.finalVerification = { status: 'passed', checkedAt: Date.now() };
    await store.save(twoPhaseGraph);

    const restored = await manager.restoreCheckpoint(cp.id);
    const rp1 = restored?.phases.get(p1!.id);
    const rp2 = restored?.phases.get(p2!.id);
    const rt1 = rp1?.taskGraph.nodes.get(t1.id);

    expect(rt1?.children).toBeUndefined();
    expect(restored?.finalVerification).toBeUndefined();
    expect(rp2?.status).toBe('pending');
    expect(restored?.completedPhaseIds).toEqual([]);
    expect(rp1?.metadata?.['integrationStatus']).toBeUndefined();
    expect(rp2?.metadata?.['integrationStatus']).toBeUndefined();
  });

  it('reopens completed runState on restoreCheckpoint and clears integrationStatus on requeuePhaseTask (F123)', async () => {
    const { requeuePhaseTask } = await import('../src/phase-board-mutations.js');
    const { summarizeGoal } = await import('../src/goal-summary.js');
    const { DefaultTaskStore, TaskTracker } = await import('@wrongstack/core/tasking');

    const graph = await new PhaseGraphBuilder({
      title: 'F123 Checkpoint & Board',
      phases: [
        {
          name: 'Phase 1',
          description: 'First',
          priority: 'high',
          estimateHours: 1,
          parallelizable: false,
          taskTemplates: [
            { title: 'T1', description: 'd', type: 'feature', priority: 'high', estimateHours: 1 },
          ],
        },
      ],
    }).build();
    const phase = Array.from(graph.phases.values())[0]!;
    phase.status = 'running';
    graph.runState = 'running';
    const cp = await manager.saveCheckpoint(graph, 'running-cp');

    phase.status = 'completed';
    for (const t of phase.taskGraph.nodes.values()) t.status = 'completed';
    graph.completedPhaseIds = [phase.id];
    graph.completedAt = Date.now();
    graph.runState = 'completed';
    await store.save(graph);

    const restored = await manager.restoreCheckpoint(cp.id);
    expect(restored?.runState).toBe('running');
    expect(restored?.completedAt).toBeUndefined();

    phase.status = 'completed';
    phase.metadata = { integrationStatus: 'merge_failed', keepMe: true };
    const taskId = Array.from(phase.taskGraph.nodes.keys())[0]!;
    requeuePhaseTask(
      {
        graph,
        trackerCache: new Map(),
        taskRetryCounts: new Map(),
        phaseWorktrees: new Map(),
        getTrackerForPhase: (p) => {
          const ts = new DefaultTaskStore();
          const tr = new TaskTracker({ store: ts });
          (tr as unknown as { graph: typeof p.taskGraph }).graph = p.taskGraph;
          return tr;
        },
        updatePhaseStatus: (p, st) => {
          p.status = st;
        },
        emit: () => {},
      },
      taskId,
    );
    expect(phase.metadata).toEqual({ keepMe: true });
    expect(summarizeGoal(graph).blockers.some((b) => b.includes('integration needs review'))).toBe(
      false,
    );
  });
});
