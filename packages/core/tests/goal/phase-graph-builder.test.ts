import { describe, it, expect } from 'vitest';
import { PhaseGraphBuilder } from '../../src/goal/phase-graph-builder.js';

describe('PhaseGraphBuilder', () => {
  it('should build a phase graph with sequential dependencies', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Test Project',
      phases: [
        {
          name: 'Phase 1',
          description: 'First',
          priority: 'high',
          estimateHours: 2,
          parallelizable: false,
        },
        {
          name: 'Phase 2',
          description: 'Second',
          priority: 'critical',
          estimateHours: 4,
          parallelizable: false,
        },
        {
          name: 'Phase 3',
          description: 'Third',
          priority: 'medium',
          estimateHours: 1,
          parallelizable: true,
        },
      ],
    });

    const graph = await builder.build();

    expect(graph.id).toBeDefined();
    expect(graph.title).toBe('Test Project');
    expect(graph.phases.size).toBe(3);

    const phases = Array.from(graph.phases.values());
    expect(phases[0]!.name).toBe('Phase 1');
    expect(phases[1]!.name).toBe('Phase 2');
    expect(phases[2]!.name).toBe('Phase 3');

    // Sequential dependencies
    expect(phases[0]!.dependsOn).toEqual([]);
    expect(phases[0]!.nextPhases).toEqual([phases[1]!.id]);
    expect(phases[1]!.dependsOn).toEqual([phases[0]!.id]);
    expect(phases[1]!.nextPhases).toEqual([phases[2]!.id]);
    expect(phases[2]!.dependsOn).toEqual([phases[1]!.id]);
    expect(phases[2]!.nextPhases).toEqual([]);

    // Root phase
    expect(graph.rootPhaseIds).toEqual([phases[0]!.id]);

    // Initial status
    expect(phases.every((p) => p.status === 'pending')).toBe(true);
  });

  it('should create task graphs for each phase', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Test',
      phases: [
        {
          name: 'Dev',
          description: 'Development',
          priority: 'critical',
          estimateHours: 5,
          parallelizable: false,
          taskTemplates: [
            {
              title: 'Setup',
              description: 'Setup project',
              type: 'chore',
              priority: 'high',
              estimateHours: 1,
            },
            {
              title: 'Feature',
              description: 'Build feature',
              type: 'feature',
              priority: 'critical',
              estimateHours: 4,
            },
          ],
        },
      ],
    });

    const graph = await builder.build();
    const phase = Array.from(graph.phases.values())[0]!;

    expect(phase.taskGraph.nodes.size).toBe(2);
    expect(phase.taskGraph.title).toContain('Dev');
  });

  it('should support parallelizable phases', async () => {
    const builder = new PhaseGraphBuilder({
      title: 'Test',
      phases: [
        { name: 'A', description: 'A', priority: 'high', estimateHours: 1, parallelizable: false },
        { name: 'B', description: 'B', priority: 'medium', estimateHours: 2, parallelizable: true },
        { name: 'C', description: 'C', priority: 'low', estimateHours: 1, parallelizable: false },
      ],
    });

    const graph = await builder.build();
    const phases = Array.from(graph.phases.values());

    expect(phases[1]!.parallelizable).toBe(true);
    expect(phases[0]!.parallelizable).toBe(false);
  });
});
