import { describe, expect, it } from 'vitest';
import { extractJSONArray as extractGoalJSONArray, GoalPlanner } from '../src/goal-planner.js';
import { PhaseGraphBuilder } from '../src/phase-graph-builder.js';

const VALID_PLAN = JSON.stringify([
  {
    name: 'Discovery',
    description: 'Understand the requirements',
    priority: 'high',
    estimateHours: 2,
    parallelizable: false,
    tasks: [
      {
        title: 'Read the existing code',
        description: 'survey modules',
        type: 'chore',
        priority: 'high',
        estimateHours: 1,
        tags: ['recon'],
      },
      {
        title: 'List open questions',
        description: 'gaps',
        type: 'docs',
        priority: 'medium',
        estimateHours: 1,
      },
    ],
  },
  {
    name: 'Implementation',
    description: 'Build it',
    priority: 'critical',
    estimateHours: 8,
    parallelizable: false,
    tasks: [
      {
        title: 'Add the endpoint',
        description: 'POST /things',
        type: 'feature',
        priority: 'critical',
        estimateHours: 4,
      },
    ],
  },
]);

describe('GoalPlanner', () => {
  it('parses a fenced JSON plan into phase templates with todos', async () => {
    const planner = new GoalPlanner({
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
    const planner = new GoalPlanner({ goal: 'x', runOnce: async () => plan });
    const { phases } = await planner.plan();

    expect(phases).toHaveLength(1);
    expect(phases[0]!.priority).toBe('medium'); // invalid → medium
    expect(phases[0]!.taskTemplates).toHaveLength(1); // untitled dropped
    expect(phases[0]!.taskTemplates![0]!.type).toBe('feature'); // invalid → feature
    expect(phases[0]!.taskTemplates![0]!.priority).toBe('medium');
  });

  it('flags parseFailed when the model returns no JSON array', async () => {
    const planner = new GoalPlanner({ goal: 'x', runOnce: async () => 'Sorry, I cannot help.' });
    const result = await planner.plan();
    expect(result.parseFailed).toBe(true);
    expect(result.phases).toHaveLength(0);
  });

  it('rejects phases with no executable tasks instead of creating instant-complete work', async () => {
    const planner = new GoalPlanner({
      goal: 'x',
      runOnce: async () => JSON.stringify([{ name: 'Later remediation', tasks: [] }]),
    });
    const result = await planner.plan();

    expect(result.parseFailed).toBe(true);
    expect(result.phases).toEqual([]);
    expect(result.warnings).toContain(
      'Phase "Later remediation" has no executable tasks and was rejected.',
    );
  });

  // #416: a planner that followed Markdown plan guidance (from role skills)
  // returned no JSON, and the goal failed with zero phases on the first try.
  it('asks the model once to convert a Markdown plan into the JSON schema', async () => {
    const markdownPlan = '## Plan Summary\n\n| Step | Task |\n|---|---|\n| 1 | Read the code |';
    const prompts: string[] = [];
    const planner = new GoalPlanner({
      goal: 'Build a thing',
      runOnce: async (prompt) => {
        prompts.push(prompt);
        return prompts.length === 1 ? markdownPlan : '```json\n' + VALID_PLAN + '\n```';
      },
    });
    const result = await planner.plan();

    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain(markdownPlan);
    expect(prompts[1]).toContain('```json');
    expect(result.parseFailed).toBe(false);
    expect(result.repaired).toBe(true);
    expect(result.phases.map((p) => p.name)).toEqual(['Discovery', 'Implementation']);
  });

  it('does not ask for a conversion when the planner returned nothing', async () => {
    let calls = 0;
    const planner = new GoalPlanner({
      goal: 'x',
      runOnce: async () => {
        calls++;
        return '   ';
      },
    });
    const result = await planner.plan();
    expect(calls).toBe(1);
    expect(result.parseFailed).toBe(true);
  });

  it('stops after the configured number of conversion attempts', async () => {
    let calls = 0;
    const planner = new GoalPlanner({
      goal: 'x',
      repairAttempts: 0,
      runOnce: async () => {
        calls++;
        return 'Still prose.';
      },
    });
    expect((await planner.plan()).parseFailed).toBe(true);
    expect(calls).toBe(1);
  });

  it('states that the JSON format overrides other formatting guidance', () => {
    const prompt = new GoalPlanner({ goal: 'x', runOnce: async () => '' }).buildPrompt();
    expect(prompt).toMatch(/overrides any other formatting guidance/i);
  });

  it('produces templates a PhaseGraphBuilder can materialize into a populated graph', async () => {
    const planner = new GoalPlanner({ goal: 'Build a thing', runOnce: async () => VALID_PLAN });
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

describe('extractGoalJSONArray', () => {
  it('extracts from a ```json fence', () => {
    const out = extractGoalJSONArray('blah\n```json\n[1,2,3]\n```\ntrailing');
    expect(out).toBe('[1,2,3]');
  });

  it('extracts the first balanced array even with brackets inside strings', () => {
    const out = extractGoalJSONArray('noise [{"t":"a [nested] ]bracket"}] more');
    expect(out).toBe('[{"t":"a [nested] ]bracket"}]');
  });

  it('finds the JSON fence when an earlier fence holds something else (#416)', () => {
    const text = 'Run:\n```bash\nls\n```\nPlan:\n```json\n[{"name":"P"}]\n```';
    expect(extractGoalJSONArray(text)).toBe('[{"name":"P"}]');
  });

  it('skips bracketed prose that is not JSON (#416)', () => {
    const text = 'See [the docs](https://x.test) and [ ] todo.\n[{"name":"P"}]';
    expect(extractGoalJSONArray(text)).toBe('[{"name":"P"}]');
  });

  it('returns null when there is no array', () => {
    expect(extractGoalJSONArray('just prose')).toBeNull();
  });
});
