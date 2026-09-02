import * as os from 'node:os';
import * as path from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { SddInterviewDriver } from '../src/sdd-interview-driver.js';
import { SpecStore } from '../src/spec-store.js';
import { TaskGraphStore } from '../src/task-graph-store.js';

function tmp(prefix: string): string {
  return path.join(os.tmpdir(), `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2)}`);
}

function makeDriver(over?: { sessionPath?: string }) {
  const dir = tmp('sdd-interview');
  const specStore = new SpecStore({ baseDir: path.join(dir, 'specs') });
  const graphStore = new TaskGraphStore({ baseDir: path.join(dir, 'graphs') });
  const driver = new SddInterviewDriver({
    specStore,
    graphStore,
    sessionPath: over?.sessionPath,
    minQuestions: 1,
    maxQuestions: 3,
  });
  return { driver, specStore, graphStore, dir };
}

const SPEC_OUTPUT = [
  'Here is the spec:',
  '```json',
  JSON.stringify({
    title: 'OAuth login',
    overview: 'Add OAuth-based login with session management.',
    sections: [{ type: 'overview', title: 'Overview', content: 'OAuth login flow', level: 1 }],
    requirements: [
      {
        id: 'REQ-1',
        type: 'security',
        priority: 'critical',
        description: 'Verify OAuth tokens',
        acceptanceCriteria: ['tokens validated'],
      },
      {
        id: 'REQ-2',
        type: 'functional',
        priority: 'high',
        description: 'Persist sessions',
        acceptanceCriteria: [],
      },
    ],
  }),
  '```',
].join('\n');

const TASKS_OUTPUT = [
  'Implementation plan: build the middleware first.',
  '```json',
  JSON.stringify([
    {
      title: 'Create auth middleware',
      description: 'JWT verify',
      type: 'feature',
      priority: 'critical',
    },
    { title: 'Write auth tests', description: 'tests', type: 'test', priority: 'high' },
  ]),
  '```',
].join('\n');

describe('SddInterviewDriver', () => {
  let h: ReturnType<typeof makeDriver>;
  beforeEach(() => {
    h = makeDriver();
  });

  it('starts in questioning and returns a prompt', () => {
    const prompt = h.driver.start('OAuth login');
    expect(h.driver.phase()).toBe('questioning');
    expect(prompt).toContain('SDD Spec Builder');
    expect(h.driver.snapshot().title).toBe('OAuth login');
  });

  it('records answers from the Q&A loop', () => {
    h.driver.start('OAuth login');
    h.driver.submitAnswer('Which providers?', 'Google and GitHub');
    const snap = h.driver.snapshot();
    expect(snap.questionCount).toBe(1);
    expect(snap.answers[0]).toEqual({ question: 'Which providers?', answer: 'Google and GitHub' });
  });

  it('detects a spec in agent output and advances to spec_review + persists it', async () => {
    h.driver.start('OAuth login');
    const res = await h.driver.ingestAgentOutput(SPEC_OUTPUT);
    expect(res.specDetected).toBe(true);
    expect(h.driver.phase()).toBe('spec_review');
    const snap = h.driver.snapshot();
    expect(snap.spec?.title).toBe('OAuth login');
    expect(snap.spec?.requirements).toHaveLength(2);
    // Persisted to the SpecStore.
    const list = await h.specStore.list();
    expect(list.length).toBe(1);
  });

  it('detects a task array and persists a graph to disk', async () => {
    h.driver.start('OAuth login');
    await h.driver.ingestAgentOutput(SPEC_OUTPUT);
    const res = await h.driver.ingestAgentOutput(TASKS_OUTPUT);
    expect(res.tasksDetected).toBe(true);
    expect(res.graphId).toBeTruthy();
    const graph = h.driver.getGraph();
    // The two model-proposed tasks are retained, and the two approved
    // requirements receive deterministic traceable tasks because the proposal
    // did not map itself to requirement ids.
    expect(graph?.nodes.size).toBe(4);
    expect(graph?.requiredRequirementIds).toEqual(['REQ-1', 'REQ-2']);
    expect(
      [...(graph?.nodes.values() ?? [])]
        .flatMap((node) => (node.specRequirementId ? [node.specRequirementId] : []))
        .sort(),
    ).toEqual(['REQ-1', 'REQ-2']);
    // Loadable from disk by id.
    const loaded = await h.graphStore.load(res.graphId as string);
    expect(loaded?.nodes.size).toBe(4);
  });

  it('wires dependsOn references into real dependency edges', async () => {
    const TASKS_WITH_DEPS = [
      'Plan:',
      '```json',
      JSON.stringify([
        {
          id: 't1',
          title: 'Create auth middleware',
          description: 'JWT verify',
          type: 'feature',
          priority: 'critical',
          dependsOn: [],
        },
        {
          id: 't2',
          title: 'Write auth tests',
          description: 'tests',
          type: 'test',
          priority: 'high',
          dependsOn: ['t1'],
        },
      ]),
      '```',
    ].join('\n');
    h.driver.start('OAuth login');
    await h.driver.ingestAgentOutput(SPEC_OUTPUT);
    await h.driver.ingestAgentOutput(TASKS_WITH_DEPS);
    const tracker = h.driver.getTracker();
    const graph = h.driver.getGraph();
    expect(graph?.nodes.size).toBe(4);
    const nodes = [...(graph?.nodes.values() ?? [])];
    const mw = nodes.find((n) => n.title === 'Create auth middleware');
    const tests = nodes.find((n) => n.title === 'Write auth tests');
    expect(mw && tests).toBeTruthy();
    // The test task is blocked by the middleware task; the reverse is not true.
    expect(tracker?.getBlockers(tests!.id)).toEqual([mw!.id]);
    expect(tracker?.getBlockers(mw!.id)).toEqual([]);
    expect(tracker?.canStart(tests!.id)).toBe(false); // mw not done yet
    expect(tracker?.canStart(mw!.id)).toBe(true);
  });

  it('drops a self/cyclic dependsOn reference rather than creating a cycle', async () => {
    const CYCLIC = [
      '```json',
      JSON.stringify([
        {
          id: 'a',
          title: 'Task A',
          description: 'a',
          type: 'feature',
          priority: 'high',
          dependsOn: ['b'],
        },
        {
          id: 'b',
          title: 'Task B',
          description: 'b',
          type: 'feature',
          priority: 'high',
          dependsOn: ['a'],
        },
      ]),
      '```',
    ].join('\n');
    h.driver.start('Cyclic');
    await h.driver.ingestAgentOutput(SPEC_OUTPUT);
    await h.driver.ingestAgentOutput(CYCLIC);
    const tracker = h.driver.getTracker();
    const graph = h.driver.getGraph();
    const nodes = [...(graph?.nodes.values() ?? [])];
    const a = nodes.find((n) => n.title === 'Task A')!;
    const b = nodes.find((n) => n.title === 'Task B')!;
    // Exactly one edge survives the cycle guard — at least one task must be runnable.
    const aRunnable = tracker!.canStart(a.id);
    const bRunnable = tracker!.canStart(b.id);
    expect(aRunnable || bRunnable).toBe(true);
    expect(graph!.edges.length).toBe(1);
  });

  it('deterministically generates a graph on approve→executing when no task array was emitted', async () => {
    h.driver.start('OAuth login');
    await h.driver.ingestAgentOutput(SPEC_OUTPUT); // → spec_review
    expect(h.driver.getGraph()).toBeNull();
    await h.driver.approve(); // spec_review → implementation
    await h.driver.approve(); // implementation → task_review
    const { phase } = await h.driver.approve(); // task_review → executing (ensureTaskGraph)
    expect(phase).toBe('executing');
    const graph = h.driver.getGraph();
    expect(graph).not.toBeNull();
    // TaskGenerator emits at least one task per requirement + tests/docs.
    expect(graph?.nodes.size ?? 0).toBeGreaterThanOrEqual(2);
  });

  it('ignores malformed agent output without throwing', async () => {
    h.driver.start('OAuth login');
    const res = await h.driver.ingestAgentOutput('I will now think about this. No JSON here.');
    expect(res.specDetected).toBe(false);
    expect(res.tasksDetected).toBe(false);
    expect(h.driver.phase()).toBe('questioning');
  });

  it('resumes a persisted interview with its graph via loadExisting', async () => {
    const sessionPath = path.join(h.dir, 'session.json');
    const a = makeDriver({ sessionPath });
    a.driver.start('OAuth login');
    await a.driver.ingestAgentOutput(SPEC_OUTPUT);
    await a.driver.ingestAgentOutput(TASKS_OUTPUT);
    await a.driver.setLastAgentText('Which providers?');
    await a.driver.setLastRunId('run-99');
    await a.driver.builder.saveSession();
    const graphId = a.driver.getGraph()?.id;
    const firstTaskId = a.driver.getGraph()?.nodes.keys().next().value as string;
    a.driver.getTracker()?.updateNodeStatus(firstTaskId, 'completed', 'before process restart');
    await expect
      .poll(async () => (await a.graphStore.load(graphId!))?.nodes.get(firstTaskId)?.status)
      .toBe('completed');

    // Fresh driver over the same session + graph store → resumes.
    const b = new SddInterviewDriver({
      specStore: a.specStore,
      graphStore: a.graphStore,
      sessionPath,
    });
    const loaded = await b.loadExisting();
    expect(loaded).toBe(true);
    expect(b.phase()).toBe('spec_review');
    expect(b.getGraph()?.id).toBe(graphId);
    expect(b.getGraph()?.nodes.get(firstTaskId)?.status).toBe('completed');
    expect(b.getLastAgentText()).toBe('Which providers?');
    expect(b.getLastRunId()).toBe('run-99');
    expect(b.wasResumed()).toBe(true);
    expect(b.snapshot().resumed).toBe(true);
    expect(b.snapshot().lastAgentText).toBe('Which providers?');
  });

  it('discard clears the session file and in-memory state', async () => {
    const sessionPath = path.join(h.dir, 'session-discard.json');
    const a = makeDriver({ sessionPath });
    a.driver.start('OAuth login');
    await a.driver.ingestAgentOutput(SPEC_OUTPUT);
    await a.driver.builder.saveSession();
    await a.driver.discard();
    const b = new SddInterviewDriver({
      specStore: a.specStore,
      graphStore: a.graphStore,
      sessionPath,
    });
    expect(await b.loadExisting()).toBe(false);
  });

  it('resumes sessions without a graph and tolerates a missing persisted graph', async () => {
    const noGraphPath = path.join(h.dir, 'session-no-graph.json');
    const noGraph = makeDriver({ sessionPath: noGraphPath });
    noGraph.driver.start('No graph');
    await noGraph.driver.ingestAgentOutput(SPEC_OUTPUT);
    await noGraph.driver.builder.saveSession();
    const resumedWithoutGraph = new SddInterviewDriver({
      specStore: noGraph.specStore,
      graphStore: noGraph.graphStore,
      sessionPath: noGraphPath,
    });
    expect(await resumedWithoutGraph.loadExisting()).toBe(true);
    expect(resumedWithoutGraph.getGraph()).toBeNull();

    const missingGraphPath = path.join(h.dir, 'session-missing-graph.json');
    const missingGraph = makeDriver({ sessionPath: missingGraphPath });
    missingGraph.driver.start('Missing graph');
    await missingGraph.driver.ingestAgentOutput(SPEC_OUTPUT);
    const built = await missingGraph.driver.ingestAgentOutput(TASKS_OUTPUT);
    await missingGraph.driver.builder.saveSession();
    await missingGraph.graphStore.delete(built.graphId!);
    const resumedMissingGraph = new SddInterviewDriver({
      specStore: missingGraph.specStore,
      graphStore: missingGraph.graphStore,
      sessionPath: missingGraphPath,
    });
    expect(await resumedMissingGraph.loadExisting()).toBe(true);
    expect(resumedMissingGraph.getGraph()).toBeNull();
  });

  it('keeps an existing tracker and rejects a too-short plan before task JSON', async () => {
    h.driver.start('OAuth login');
    await h.driver.ingestAgentOutput(SPEC_OUTPUT);
    await h.driver.approve();
    const shortPlanAndTasks = `Short plan
\`\`\`json
[{"title":"Third","description":"d"}]
\`\`\``;
    const first = await h.driver.ingestAgentOutput(shortPlanAndTasks);
    expect(first.implementationDetected).toBe(false);
    const firstGraph = h.driver.getGraph();
    const second = await h.driver.ingestAgentOutput(TASKS_OUTPUT);
    expect(second.tasksDetected).toBe(true);
    expect(h.driver.getGraph()).toBe(firstGraph);
  });

  it('allows revising the specification during spec_review', async () => {
    h.driver.start('OAuth login');
    await h.driver.ingestAgentOutput(SPEC_OUTPUT);
    expect(h.driver.snapshot().spec?.title).toBe('OAuth login');

    const REVISED_SPEC = `Here is the updated spec:
\`\`\`json
{
  "title": "OAuth login (GitHub only)",
  "overview": "Single-provider auth",
  "requirements": [
    { "id": "REQ-1", "type": "functional", "priority": "critical", "description": "GitHub OAuth" }
  ]
}
\`\`\``;
    const res = await h.driver.ingestAgentOutput(REVISED_SPEC);
    expect(res.specDetected).toBe(true);
    expect(h.driver.snapshot().spec?.title).toBe('OAuth login (GitHub only)');
    expect(h.driver.snapshot().spec?.requirements).toHaveLength(1);
  });

  it('supports rewinding phases from task_review back to spec_review and questioning', async () => {
    h.driver.start('OAuth login');
    await h.driver.ingestAgentOutput(SPEC_OUTPUT);
    await h.driver.approve(); // moves to implementation
    await h.driver.ingestAgentOutput(
      `Here is the implementation plan:\nArchitecture decisions...\n\`\`\`json\n[{"id":"t1","title":"Task 1","description":"desc"}]\n\`\`\``,
    );
    expect(h.driver.phase()).toBe('task_review');

    // Rewind back to spec_review
    const rewoundToSpec = await h.driver.rewind('spec_review');
    expect(rewoundToSpec.phase).toBe('spec_review');
    expect(h.driver.phase()).toBe('spec_review');

    // Rewind back to questioning
    const rewoundToQ = await h.driver.rewind('questioning');
    expect(rewoundToQ.phase).toBe('questioning');
    expect(h.driver.phase()).toBe('questioning');
    expect(h.driver.snapshot().spec).toBeUndefined();
  });
});
