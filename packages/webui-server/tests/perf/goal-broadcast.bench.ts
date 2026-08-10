import type { PhaseGraph, PhaseNode } from '@wrongstack/core/goal';
import type { TaskGraph, TaskNode } from '@wrongstack/core/types';
import { bench, describe } from 'vitest';
import { GoalWebSocketHandler } from '../../src/server/goal-ws-handler.js';

function task(id: string): TaskNode {
  return {
    id,
    title: `Task ${id}`,
    description: `Representative task ${id}`,
    type: 'feature',
    priority: 'medium',
    status: Number.parseInt(id.slice(id.lastIndexOf('-') + 1), 10) % 2 ? 'pending' : 'completed',
    tags: ['benchmark'],
    createdAt: 1,
    updatedAt: 1,
  };
}

function graph(phaseCount: number, tasksPerPhase: number): PhaseGraph {
  const phases = new Map<string, PhaseNode>();
  for (let phaseIndex = 0; phaseIndex < phaseCount; phaseIndex++) {
    const phaseId = `phase-${phaseIndex}`;
    const nodes = new Map<string, TaskNode>();
    for (let taskIndex = 0; taskIndex < tasksPerPhase; taskIndex++) {
      const node = task(`${phaseId}-${taskIndex}`);
      nodes.set(node.id, node);
    }
    const taskGraph: TaskGraph = {
      id: `tasks-${phaseId}`,
      specId: 'benchmark',
      title: phaseId,
      nodes,
      edges: [],
      rootNodes: [],
      createdAt: 1,
      updatedAt: 1,
    };
    phases.set(phaseId, {
      id: phaseId,
      name: `Phase ${phaseIndex}`,
      description: 'Representative phase',
      status: phaseIndex === 0 ? 'running' : 'pending',
      taskGraph,
      dependsOn: [],
      nextPhases: [],
      parallelizable: false,
      priority: 'medium',
      estimateHours: tasksPerPhase,
      assignedAgents: [],
      createdAt: 1,
      updatedAt: 1,
    });
  }
  return {
    id: 'benchmark-graph',
    title: 'Broadcast benchmark',
    description: 'Representative large goal graph',
    phases,
    rootPhaseIds: ['phase-0'],
    activePhaseIds: ['phase-0'],
    completedPhaseIds: [],
    failedPhaseIds: [],
    autonomous: true,
    stopOnComplete: true,
    createdAt: 1,
    updatedAt: 1,
  };
}

type BenchHandler = {
  graph: PhaseGraph;
  clients: Set<{ id: string; ws: { readyState: number; send(data: string): void } }>;
  buildState(): Record<string, unknown>;
  broadcastState(): void;
};

function handler(goalGraph: PhaseGraph, clientCount: number): BenchHandler {
  const instance = new GoalWebSocketHandler(
    {} as never,
    {} as never,
    { error: () => undefined } as never,
    '.',
  ) as unknown as BenchHandler;
  instance.graph = goalGraph;
  instance.clients = new Set(
    Array.from({ length: clientCount }, (_, index) => ({
      id: `client-${index}`,
      ws: { readyState: 1, send: () => undefined },
    })),
  );
  return instance;
}

const ONE_THOUSAND = graph(20, 50);
const TEN_THOUSAND = graph(100, 100);

describe('GoalWebSocketHandler state projection', () => {
  const medium = handler(ONE_THOUSAND, 0);
  const large = handler(TEN_THOUSAND, 0);

  bench('buildState — 1K tasks', () => {
    medium.buildState();
  });
  bench('buildState — 10K tasks', () => {
    large.buildState();
  });
});

describe('GoalWebSocketHandler broadcast fan-out', () => {
  const oneClient = handler(TEN_THOUSAND, 1);
  const oneHundredClients = handler(TEN_THOUSAND, 100);

  bench('broadcastState — 10K tasks / 1 client', () => oneClient.broadcastState());
  bench('broadcastState — 10K tasks / 100 clients', () => oneHundredClients.broadcastState());
});
