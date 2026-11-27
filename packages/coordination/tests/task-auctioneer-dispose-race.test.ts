import { describe, expect, it } from 'vitest';
import type { GoalNode, KnowledgeGraph } from '../src/knowledge-graph.js';
import { TaskAuctioneer } from '../src/task-auctioneer.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeGoal(id: string): GoalNode {
  return {
    id,
    type: 'goal',
    title: 'Test goal',
    description: 'Do something',
    status: 'pending',
    priority: 'medium',
    blockedBy: [],
    dependsOn: [],
    createdBy: 'auctioneer',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    tags: [],
    children: [],
  };
}

describe('TaskAuctioneer dispose() vs in-flight publishTask()', () => {
  it('does not arm a bid-window timer after dispose() runs while publishTask() is awaiting graph.add()', async () => {
    const addEntered = deferred<void>();
    const addGate = deferred<GoalNode>();
    const goal = makeGoal('g-race');
    const graph = {
      getGoals: () => [],
      add: async () => {
        addEntered.resolve();
        return addGate.promise;
      },
      get: () => goal,
      update: async () => goal,
    } as unknown as KnowledgeGraph;

    const auctioneer = new TaskAuctioneer({ graph, bidWindowMs: 60_000 });
    const publishPromise = auctioneer.publishTask({ title: 'Race', description: 'Race' });
    await addEntered.promise;

    auctioneer.dispose();
    addGate.resolve(goal);
    await publishPromise;

    const timers = (
      auctioneer as unknown as { bidTimers: Map<string, ReturnType<typeof setTimeout>> }
    ).bidTimers;
    try {
      expect(timers.size).toBe(0);
    } finally {
      for (const t of timers.values()) clearTimeout(t);
    }
  });
});
