import { describe, expect, it } from 'vitest';
import {
  AutoPhasePlanner,
  extractJSONArray as extractAutoPhaseJSONArray,
} from '../../src/autophase/auto-phase-planner.js';
import { PhaseGraphBuilder } from '../../src/autophase/phase-graph-builder.js';

const VALID_PLAN = JSON.stringify([
  {
    name: 'Discovery',
    description: 'Understand the requirements',
    priority: 'high',
    estimateHours: 2,
    parallelizable: false,
    tasks: [
      { title: 'Read the existing code', description: 'survey modules', type: 'chore', priority: 'high', estimateHours: 1, tags: ['recon'] },
      { title: 'List open questions', description: 'gaps', type: 'docs', priority: 'medium', estimateHours: 1 },
    ],
  },
  {
    name: 'Implementation',
    description: 'Build it',
    priority: 'critical',
    estimateHours: 8,
    parallelizable: false,
    tasks: [
      { title: 'Add the endpoint', description: 'POST /things', type: 'feature', priority: 'critical', estimateHours: 4 },
    ],
  },
]);

describe('AutoPhasePlanner', () => {
  it('parses a fenced JSON plan into phase templates with todos', async () => {
    const planner = new AutoPhasePlanner({
      goal: 'Build a thing',
      runOnce: async () => '```json\n' + VALID_PLAN + '\n```',
    });
    const result = await planner.plan();

    expect(result.parseFailed).toBe(false);
    expect(result.phases).toHaveLength(2);
    expect(result.phases[0]!.name).toBe('Discovery');
    expect(result.phases[0]!.taskTemplates).toHaveLength(2);
    expect(result.phases[0]!.taskTemplates![0]!.title).toBe('Read the existing code');
    expect(result.phases[1]!.priority).toBe('critical');
  });

  it('coerces invalid priority/type to safe defaults and keeps titled tasks', async () => {
    const plan = JSON.stringify([
      {
        name: 'P1',
        priority: 'bogus',
        tasks: [
          { title: 'Good task', type: 'nonsense', priority: 'also-bad' },
          { description: 'no title — dropped' },
        ],
      },
    ]);
    const planner = new AutoPhasePlanner({ goal: 'x', runOnce: async () => plan });
    const { phases } = await planner.plan();

    expect(phases).toHaveLength(1);
    expect(phases[0]!.priority).toBe('medium'); // invalid → medium
    expect(phases[0]!.taskTemplates).toHaveLength(1); // untitled dropped
    expect(phases[0]!.taskTemplates![0]!.type).toBe('feature'); // invalid → feature
    expect(phases[0]!.taskTemplates![0]!.priority).toBe('medium');
  });

  it('flags parseFailed when the model returns no JSON array', async () => {
    const planner = new AutoPhasePlanner({ goal: 'x', runOnce: async () => 'Sorry, I cannot help.' });
    const result = await planner.plan();
    expect(result.parseFailed).toBe(true);
    expect(result.phases).toHaveLength(0);
  });

  it('produces templates a PhaseGraphBuilder can materialize into a populated graph', async () => {
    const planner = new AutoPhasePlanner({ goal: 'Build a thing', runOnce: async () => VALID_PLAN });
    const { phases } = await planner.plan();

    const graph = await new PhaseGraphBuilder({ title: 'Build a thing', phases }).build();
    expect(graph.phases.size).toBe(2);
    const first = Array.from(graph.phases.values())[0]!;
    expect(first.taskGraph.nodes.size).toBe(2);
    // Phases are chained: phase 2 depends on phase 1.
    const second = Array.from(graph.phases.values())[1]!;
    expect(second.dependsOn).toContain(first.id);
  });
});

describe('extractAutoPhaseJSONArray', () => {
  it('extracts from a ```json fence', () => {
    const out = extractAutoPhaseJSONArray('blah\n```json\n[1,2,3]\n```\ntrailing');
    expect(out).toBe('[1,2,3]');
  });

  it('extracts the first balanced array even with brackets inside strings', () => {
    const out = extractAutoPhaseJSONArray('noise [{"t":"a [nested] ]bracket"}] more');
    expect(out).toBe('[{"t":"a [nested] ]bracket"}]');
  });

  it('returns null when there is no array', () => {
    expect(extractAutoPhaseJSONArray('just prose')).toBeNull();
  });
});
