import type { KanbanBoard, KanbanTask } from '@wrongstack/kanban';
import { describe, expect, it } from 'vitest';
import {
  buildBoardContractGraphView,
  buildContractGraphView,
  summarizeBoardContractHealth,
} from '../../src/components/KanbanContractGraphView.js';

const now = '2026-08-09T00:00:00.000Z';

describe('Kanban contract graph view', () => {
  it('projects the task endpoint, typed nodes, and verification edges', () => {
    const task: KanbanTask = {
      id: 'task-1',
      title: 'Optimize startup',
      columnId: 'review',
      order: 0,
      priority: 'high',
      status: 'review',
      createdAt: now,
      updatedAt: now,
    };
    const board = {
      id: 'board-1',
      title: 'Autonomous work',
      columns: [{ id: 'review', title: 'Review', order: 0 }],
      tasks: [task],
      createdAt: now,
      updatedAt: now,
      version: 1,
      contractGraph: {
        version: 1,
        enforcement: 'strict',
        updatedAt: now,
        nodes: [
          {
            id: 'objective-1',
            taskId: task.id,
            kind: 'objective',
            title: 'p95 under one second',
            enforcement: 'blocking',
            state: 'satisfied',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'verification-1',
            taskId: task.id,
            kind: 'verification',
            title: 'Benchmark',
            enforcement: 'advisory',
            state: 'satisfied',
            createdAt: now,
            updatedAt: now,
          },
        ],
        edges: [
          {
            id: 'target-edge',
            from: `task:${task.id}`,
            to: 'objective-1',
            type: 'targets',
            enforcement: 'blocking',
            createdAt: now,
          },
          {
            id: 'verify-edge',
            from: 'objective-1',
            to: 'verification-1',
            type: 'verified_by',
            enforcement: 'blocking',
            createdAt: now,
          },
        ],
      },
    } satisfies KanbanBoard;

    const view = buildContractGraphView(board, task, ['objective-1', 'verification-1']);
    expect(view.nodes.map((node) => node.id)).toEqual([
      'task:task-1',
      'objective-1',
      'verification-1',
    ]);
    expect(view.edges.map((edge) => edge.id)).toEqual(['target-edge', 'verify-edge']);
    expect(view.edges.find((edge) => edge.id === 'verify-edge')?.animated).toBe(true);
    expect(view.edges.find((edge) => edge.id === 'verify-edge')?.markerEnd).toMatchObject({
      type: 'arrowclosed',
      color: '#c084fc',
    });
  });

  it('stacks node kinds that share a lane instead of overlapping them', () => {
    const task: KanbanTask = {
      id: 'task-layout',
      title: 'Lay out the contract',
      columnId: 'todo',
      order: 0,
      priority: 'medium',
      status: 'pending',
      createdAt: now,
      updatedAt: now,
    };
    const kinds = ['component', 'artifact', 'risk', 'guardrail'] as const;
    const board: KanbanBoard = {
      id: 'board-layout',
      title: 'Layout board',
      columns: [{ id: 'todo', title: 'Todo', order: 0 }],
      tasks: [task],
      createdAt: now,
      updatedAt: now,
      version: 1,
      contractGraph: {
        version: 1,
        enforcement: 'strict',
        updatedAt: now,
        nodes: kinds.map((kind) => ({
          id: kind,
          taskId: task.id,
          kind,
          title: kind,
          enforcement: 'advisory' as const,
          state: 'active' as const,
          createdAt: now,
          updatedAt: now,
        })),
        edges: [],
      },
    };

    const view = buildContractGraphView(board, task, kinds);
    const byId = new Map(view.nodes.map((node) => [node.id, node]));
    expect(byId.get('component')?.position.x).toBe(byId.get('artifact')?.position.x);
    expect(byId.get('component')?.position.y).not.toBe(byId.get('artifact')?.position.y);
    expect(byId.get('risk')?.position.x).toBe(byId.get('guardrail')?.position.x);
    expect(byId.get('risk')?.position.y).not.toBe(byId.get('guardrail')?.position.y);
    expect(new Set(view.nodes.map((node) => `${node.position.x}:${node.position.y}`)).size).toBe(
      view.nodes.length,
    );
  });

  it('summarizes board coverage and projects every task into the contract map', () => {
    const covered: KanbanTask = {
      id: 'covered',
      title: 'Covered task',
      columnId: 'review',
      order: 0,
      priority: 'high',
      status: 'review',
      successCriteria: [
        { id: 'guard-check', description: 'No regression', type: 'manual', status: 'passed' },
      ],
      goalMetrics: [{ id: 'goal', name: 'Latency', status: 'met' }],
      createdAt: now,
      updatedAt: now,
    };
    const uncovered: KanbanTask = {
      ...covered,
      id: 'uncovered',
      title: 'Uncovered task',
      order: 1,
      successCriteria: [],
      goalMetrics: [],
    };
    const board: KanbanBoard = {
      id: 'board-map',
      title: 'Contract map',
      columns: [{ id: 'review', title: 'Review', order: 0 }],
      tasks: [covered, uncovered],
      createdAt: now,
      updatedAt: now,
      version: 1,
      contractGraph: {
        version: 1,
        enforcement: 'strict',
        updatedAt: now,
        nodes: [
          {
            id: 'objective',
            taskId: covered.id,
            kind: 'objective',
            title: 'Meet latency target',
            enforcement: 'blocking',
            state: 'active',
            metricId: 'goal',
            createdAt: now,
            updatedAt: now,
          },
          {
            id: 'guardrail',
            taskId: covered.id,
            kind: 'guardrail',
            title: 'Preserve behavior',
            enforcement: 'blocking',
            state: 'active',
            checkId: 'guard-check',
            createdAt: now,
            updatedAt: now,
          },
        ],
        edges: [
          {
            id: 'objective-edge',
            from: 'task:covered',
            to: 'objective',
            type: 'targets',
            enforcement: 'blocking',
            createdAt: now,
          },
          {
            id: 'guardrail-edge',
            from: 'task:covered',
            to: 'guardrail',
            type: 'must_preserve',
            enforcement: 'blocking',
            createdAt: now,
          },
        ],
      },
    };

    const health = summarizeBoardContractHealth(board);
    expect(health).toMatchObject({
      enforcement: 'strict',
      totalTasks: 2,
      contractedTasks: 1,
      closedTasks: 1,
      openTasks: 1,
      openIssues: 2,
      coveragePct: 50,
      closurePct: 50,
    });
    expect(health.nodesByKind).toMatchObject({ objective: 1, guardrail: 1 });

    const map = buildBoardContractGraphView(board);
    expect(map.nodes.map((node) => node.id)).toEqual([
      'task:covered',
      'task:uncovered',
      'objective',
      'guardrail',
    ]);
    expect(map.edges.map((edge) => edge.id)).toEqual(['objective-edge', 'guardrail-edge']);
  });
});
