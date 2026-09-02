import { describe, expect, it } from 'vitest';
import { DefaultTaskStore } from '@wrongstack/core/tasking';
import { TaskTracker } from '../src/task-tracker.js';
import { decomposeNonAtomicTasks, assessTaskNodeAtomicity } from '../src/plan-decompose.js';
import { splitGraphNode } from '../src/graph-split.js';
import type { SddSubtaskSpec } from '../src/sdd-parallel-run.js';

async function makeTracker() {
  const tracker = new TaskTracker({ store: new DefaultTaskStore() });
  await tracker.createGraph('spec-1', 'Test graph');
  return tracker;
}

const BIG = {
  title: 'Build auth and then billing; also migrate the database and then update docs',
  description: '1. login\n2. signup\n3. billing; after that migrate schema as well as docs',
  type: 'feature' as const,
  priority: 'high' as const,
  status: 'pending' as const,
  estimateHours: 40,
};

const SMALL = {
  title: 'Fix null check in parser',
  description:
    'Guard against undefined input.\n\n**Acceptance Criteria:**\n- verify: pnpm vitest run parser',
  type: 'bugfix' as const,
  priority: 'medium' as const,
  status: 'pending' as const,
  estimateHours: 1,
};

const SPECS: SddSubtaskSpec[] = [
  { title: 'Part A', description: 'Do A', successCriterion: '$ pnpm vitest run a' },
  { title: 'Part B', description: 'Do B', successCriterion: 'B works end to end' },
];

describe('assessTaskNodeAtomicity', () => {
  it('flags oversized vague nodes and passes small verifiable ones', async () => {
    const tracker = await makeTracker();
    const big = tracker.addNode(BIG);
    const small = tracker.addNode(SMALL);
    expect(assessTaskNodeAtomicity(tracker, tracker.getNode(big.id)!).verdict).toBe(
      'needs_decomposition',
    );
    const smallVerdict = assessTaskNodeAtomicity(tracker, tracker.getNode(small.id)!).verdict;
    expect(['atomic', 'borderline']).toContain(smallVerdict);
  });
});

describe('splitGraphNode', () => {
  it('inherits blockers, rewires dependents, completes the parent', async () => {
    const tracker = await makeTracker();
    const blocker = tracker.addNode({ ...SMALL, title: 'Blocker' });
    const parent = tracker.addNode(BIG);
    const dependent = tracker.addNode({ ...SMALL, title: 'Dependent' });
    tracker.addDependency(blocker.id, parent.id);
    tracker.addDependency(parent.id, dependent.id);

    const leafIds = splitGraphNode(tracker, parent.id, SPECS);
    expect(leafIds).toHaveLength(2);
    for (const leaf of leafIds) {
      expect(tracker.getBlockers(leaf)).toContain(blocker.id);
      expect(tracker.getDependents(leaf)).toContain(dependent.id);
    }
    expect(tracker.getNode(parent.id)?.status).toBe('completed');
  });

  it('does not auto-extract verificationCommand from command-marked criteria (security: prevents bypass of set_task_verification authorization)', async () => {
    const tracker = await makeTracker();
    const parent = tracker.addNode(BIG);
    const leafIds = splitGraphNode(tracker, parent.id, SPECS);
    const [a, b] = leafIds.map((id) => tracker.getNode(id)!);
    // Command markers must NOT be promoted to metadata.verificationCommand
    // — that field is later shell-executed by makeCommandVerifier and must
    // only be set through the authorized set_task_verification control path.
    expect(a!.metadata?.verificationCommand).toBeUndefined();
    expect(b!.metadata?.verificationCommand).toBeUndefined();
    // Free-text criteria are still folded into the description.
    expect(b!.description).toContain('**Acceptance Criteria:**');
    expect(b!.description).toContain('B works end to end');
  });

  it('refuses running/missing tasks and empty specs', async () => {
    const tracker = await makeTracker();
    const parent = tracker.addNode(BIG);
    expect(splitGraphNode(tracker, 'missing', SPECS)).toEqual([]);
    expect(splitGraphNode(tracker, parent.id, [])).toEqual([]);
    expect(splitGraphNode(tracker, parent.id, SPECS, { isRunning: () => true })).toEqual([]);
  });
});

describe('decomposeNonAtomicTasks', () => {
  it('auto mode splits flagged leaves via the LLM decomposer', async () => {
    const tracker = await makeTracker();
    const big = tracker.addNode(BIG);
    tracker.addNode(SMALL);
    const calls: string[] = [];
    const result = await decomposeNonAtomicTasks({
      tracker,
      mode: 'auto',
      decompose: async (info) => {
        calls.push(info.title);
        expect(info.reasons.length).toBeGreaterThan(0);
        return SPECS;
      },
    });
    expect(calls).toEqual([BIG.title]);
    expect(result.applied).toHaveLength(1);
    expect(result.applied[0]?.nodeId).toBe(big.id);
    expect(result.applied[0]?.subtaskIds).toHaveLength(2);
    expect(tracker.getNode(big.id)?.status).toBe('completed');
    // Children created by the pass are never re-decomposed (no recursion).
    expect(result.flagged).toEqual([big.id]);
  });

  it('propose mode returns proposals without mutating the graph', async () => {
    const tracker = await makeTracker();
    const big = tracker.addNode(BIG);
    const result = await decomposeNonAtomicTasks({
      tracker,
      mode: 'propose',
      decompose: async () => SPECS,
    });
    expect(result.applied).toHaveLength(0);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]?.nodeId).toBe(big.id);
    expect(tracker.getNode(big.id)?.status).toBe('pending');
    expect(tracker.getAllNodes()).toHaveLength(1);
  });

  it('respects the maxDecompositions budget', async () => {
    const tracker = await makeTracker();
    tracker.addNode(BIG);
    tracker.addNode({ ...BIG, title: `${BIG.title} v2 and then more; also extra` });
    let calls = 0;
    const result = await decomposeNonAtomicTasks({
      tracker,
      mode: 'propose',
      maxDecompositions: 1,
      decompose: async () => {
        calls += 1;
        return SPECS;
      },
    });
    expect(calls).toBe(1);
    expect(result.proposals).toHaveLength(1);
  });

  it('degrades safely when the decomposer returns nothing', async () => {
    const tracker = await makeTracker();
    const big = tracker.addNode(BIG);
    const result = await decomposeNonAtomicTasks({
      tracker,
      mode: 'auto',
      decompose: async () => [],
    });
    expect(result.applied).toHaveLength(0);
    expect(result.flagged).toEqual([big.id]);
    expect(tracker.getNode(big.id)?.status).toBe('pending');
  });

  it('stamps metadata.atomicity on every assessed leaf', async () => {
    const tracker = await makeTracker();
    const small = tracker.addNode(SMALL);
    await decomposeNonAtomicTasks({ tracker, mode: 'propose', decompose: async () => SPECS });
    const meta = tracker.getNode(small.id)?.metadata?.atomicity as
      | { verdict: string; score: number }
      | undefined;
    expect(meta).toBeDefined();
    expect(typeof meta!.score).toBe('number');
  });
});
