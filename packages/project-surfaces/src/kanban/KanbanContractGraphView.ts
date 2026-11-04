import type {
  KanbanBoard,
  KanbanContractGraphEnforcement,
  KanbanContractNode,
  KanbanTask,
} from '@wrongstack/kanban';
import {
  evaluateContractGraph,
  evaluateContractGraphReadiness,
  taskContractEndpoint,
} from '@wrongstack/kanban/contract-graph';
import { type Edge, MarkerType, type Node } from '@xyflow/react';
import { scaledPx } from '../lib/fonts';

const X_BY_KIND: Record<KanbanContractNode['kind'], number> = {
  objective: 300,
  component: 590,
  artifact: 590,
  risk: 880,
  guardrail: 880,
  verification: 1170,
};

const COLOR_BY_KIND: Record<KanbanContractNode['kind'], string> = {
  objective: 'var(--color-viz-1)',
  component: 'var(--color-viz-2)',
  artifact: 'var(--color-viz-3)',
  risk: 'var(--color-viz-4)',
  guardrail: 'var(--color-viz-5)',
  verification: 'var(--color-viz-6)',
};

const BOARD_X_BY_KIND: Record<KanbanContractNode['kind'], number> = {
  objective: 320,
  component: 620,
  artifact: 620,
  risk: 920,
  guardrail: 920,
  verification: 1220,
};

const LANE_BY_KIND: Record<KanbanContractNode['kind'], number> = {
  objective: 0,
  component: 1,
  artifact: 1,
  risk: 2,
  guardrail: 2,
  verification: 3,
};

const EDGE_COLOR_BY_TYPE: Record<
  NonNullable<KanbanBoard['contractGraph']>['edges'][number]['type'],
  string
> = {
  targets: 'var(--color-viz-1)',
  affects: 'var(--color-viz-2)',
  must_preserve: 'var(--color-viz-5)',
  exposes: 'var(--color-viz-4)',
  verified_by: 'var(--color-viz-6)',
  conflicts_with: 'var(--color-viz-7)',
  derived_from: 'var(--color-viz-8)',
  relates_to: '#67e8f9',
};

interface ContractTaskHealth {
  taskId: string;
  title: string;
  contracted: boolean;
  ready: boolean;
  closed: boolean;
  nodeCount: number;
  issueCount: number;
  issueMessages: string[];
  readinessIssueCount: number;
  readinessIssueMessages: string[];
}

interface BoardContractHealth {
  enforcement: KanbanContractGraphEnforcement;
  totalTasks: number;
  contractedTasks: number;
  readyTasks: number;
  closedTasks: number;
  openTasks: number;
  openIssues: number;
  readinessIssues: number;
  blockingNodes: number;
  evidenceNodes: number;
  coveragePct: number;
  closurePct: number;
  tasks: ContractTaskHealth[];
  nodesByKind: Record<KanbanContractNode['kind'], number>;
}

export function summarizeBoardContractHealth(board: KanbanBoard): BoardContractHealth {
  const graph = board.contractGraph;
  const nodesByKind: BoardContractHealth['nodesByKind'] = {
    objective: 0,
    guardrail: 0,
    risk: 0,
    component: 0,
    artifact: 0,
    verification: 0,
  };
  for (const node of graph?.nodes ?? []) nodesByKind[node.kind] += 1;

  const tasks = board.tasks.map((task) => {
    const ownedNodes = graph?.nodes.filter((node) => node.taskId === task.id) ?? [];
    const evaluation = evaluateContractGraph(board, task.id);
    const readiness = evaluateContractGraphReadiness(board, task.id);
    return {
      taskId: task.id,
      title: task.title,
      contracted: ownedNodes.length > 0,
      ready: readiness.ready,
      closed: ownedNodes.length > 0 && evaluation.issues.length === 0,
      nodeCount: ownedNodes.length,
      issueCount: evaluation.issues.length,
      issueMessages: evaluation.issues.map((issue) => issue.message),
      readinessIssueCount: readiness.issues.length,
      readinessIssueMessages: readiness.issues.map((issue) => issue.message),
    };
  });
  const totalTasks = tasks.length;
  const contractedTasks = tasks.filter((task) => task.contracted).length;
  const readyTasks = tasks.filter((task) => task.ready).length;
  const closedTasks = tasks.filter((task) => task.closed).length;
  return {
    enforcement: graph?.enforcement ?? 'off',
    totalTasks,
    contractedTasks,
    readyTasks,
    closedTasks,
    openTasks: tasks.filter((task) => !task.closed).length,
    openIssues: tasks.reduce((sum, task) => sum + task.issueCount, 0),
    readinessIssues: tasks.reduce((sum, task) => sum + task.readinessIssueCount, 0),
    blockingNodes: graph?.nodes.filter((node) => node.enforcement === 'blocking').length ?? 0,
    evidenceNodes:
      graph?.nodes.filter(
        (node) => node.kind === 'verification' || Boolean(node.checkId || node.metricId),
      ).length ?? 0,
    coveragePct: totalTasks === 0 ? 100 : (contractedTasks / totalTasks) * 100,
    closurePct: totalTasks === 0 ? 100 : (closedTasks / totalTasks) * 100,
    tasks,
    nodesByKind,
  };
}

export function buildBoardContractGraphView(board: KanbanBoard): { nodes: Node[]; edges: Edge[] } {
  const graph = board.contractGraph;
  const taskHealth = new Map(
    summarizeBoardContractHealth(board).tasks.map((task) => [task.taskId, task]),
  );
  const issueNodeIds = new Set(
    board.tasks.flatMap((task) =>
      evaluateContractGraph(board, task.id).issues.flatMap((issue) =>
        issue.nodeId ? [issue.nodeId] : [],
      ),
    ),
  );
  const taskBands = new Map<string, { top: number; height: number }>();
  let nextBandTop = 0;
  for (const task of board.tasks) {
    const laneCounts = new Map<number, number>();
    for (const node of graph?.nodes.filter((candidate) => candidate.taskId === task.id) ?? []) {
      const lane = LANE_BY_KIND[node.kind];
      laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
    }
    const maxRows = Math.max(1, ...laneCounts.values());
    const height = Math.max(190, maxRows * 104 + 54);
    taskBands.set(task.id, { top: nextBandTop, height });
    nextBandTop += height;
  }
  const nodes: Node[] = board.tasks.map((task) => {
    const health = taskHealth.get(task.id);
    const color = !health?.contracted
      ? 'var(--color-viz-4)'
      : health.ready
        ? health.closed
          ? 'var(--color-viz-5)'
          : 'var(--color-viz-1)'
        : 'var(--color-viz-7)';
    const band = taskBands.get(task.id) ?? { top: 0, height: 190 };
    return {
      id: taskContractEndpoint(task.id),
      position: { x: 0, y: band.top + (band.height - 72) / 2 },
      data: {
        label: `${task.title}\n${health?.contracted ? `${health.ready ? 'START READY' : `${health.readinessIssueCount} setup gaps`} · ${health.issueCount} completion open` : 'contract missing'}`,
        color,
      },
      style: nodeStyle(color, true),
    };
  });
  const rowByLane = new Map<string, number>();
  for (const node of graph?.nodes ?? []) {
    const lane = `${node.taskId}:${LANE_BY_KIND[node.kind]}`;
    const row = rowByLane.get(lane) ?? 0;
    rowByLane.set(lane, row + 1);
    const color = issueNodeIds.has(node.id) ? 'var(--color-viz-7)' : COLOR_BY_KIND[node.kind];
    const band = taskBands.get(node.taskId) ?? { top: 0, height: 190 };
    nodes.push({
      id: node.id,
      position: { x: BOARD_X_BY_KIND[node.kind], y: band.top + 26 + row * 104 },
      data: {
        label: `${node.kind.toUpperCase()} · ${node.title}\n${node.state} · ${node.enforcement}`,
        color,
      },
      style: nodeStyle(color),
    });
  }
  const allowedEndpoints = new Set(nodes.map((node) => node.id));
  const edges: Edge[] =
    graph?.edges
      .filter((edge) => allowedEndpoints.has(edge.from) && allowedEndpoints.has(edge.to))
      .map((edge) => contractEdgeView(edge)) ?? [];
  return { nodes, edges };
}

export function buildContractGraphView(
  board: KanbanBoard,
  task: KanbanTask,
  evaluatedNodeIds: readonly string[],
): { nodes: Node[]; edges: Edge[] } {
  const contract = board.contractGraph;
  const included = new Set(evaluatedNodeIds);
  const relevant = contract?.nodes.filter((node) => included.has(node.id)) ?? [];
  const rowByLane = new Map<number, number>();
  const laneCounts = new Map<number, number>();
  for (const node of relevant) {
    const lane = LANE_BY_KIND[node.kind];
    laneCounts.set(lane, (laneCounts.get(lane) ?? 0) + 1);
  }
  const maxRows = Math.max(1, ...laneCounts.values());
  const rootId = taskContractEndpoint(task.id);
  const nodes: Node[] = [
    {
      id: rootId,
      position: { x: 0, y: Math.max(36, ((maxRows - 1) * 108) / 2) },
      data: { label: task.title, color: 'var(--color-viz-1)' },
      style: nodeStyle('var(--color-viz-1)', true),
    },
  ];
  for (const node of relevant) {
    const lane = LANE_BY_KIND[node.kind];
    const row = rowByLane.get(lane) ?? 0;
    rowByLane.set(lane, row + 1);
    nodes.push({
      id: node.id,
      position: { x: X_BY_KIND[node.kind], y: row * 108 },
      data: {
        label: `${node.kind.toUpperCase()} · ${node.title}\n${node.state} · ${node.enforcement}`,
        color: COLOR_BY_KIND[node.kind],
      },
      style: nodeStyle(COLOR_BY_KIND[node.kind]),
    });
  }
  const allowedEndpoints = new Set(nodes.map((node) => node.id));
  const edges: Edge[] =
    contract?.edges
      .filter((edge) => allowedEndpoints.has(edge.from) && allowedEndpoints.has(edge.to))
      .map((edge) => contractEdgeView(edge)) ?? [];
  return { nodes, edges };
}

function contractEdgeView(edge: NonNullable<KanbanBoard['contractGraph']>['edges'][number]): Edge {
  const color = EDGE_COLOR_BY_TYPE[edge.type];
  return {
    id: edge.id,
    source: edge.from,
    target: edge.to,
    label: edge.type.replaceAll('_', ' '),
    animated: edge.type === 'verified_by',
    style: {
      stroke: color,
      strokeWidth: edge.enforcement === 'blocking' ? 2.4 : 1.5,
      opacity: edge.enforcement === 'blocking' ? 1 : 0.72,
    },
    markerEnd: { type: MarkerType.ArrowClosed, color, width: 16, height: 16 },
    labelStyle: { fontSize: scaledPx(10), fontWeight: 600, fill: 'var(--color-viz-label)' },
    labelBgStyle: { fill: 'var(--color-viz-surface)', fillOpacity: 0.9 },
    labelBgPadding: [5, 3],
    labelBgBorderRadius: 5,
  };
}

function nodeStyle(color: string, root = false): NonNullable<Node['style']> {
  return {
    width: 220,
    minHeight: 64,
    border: `1.5px solid ${color}`,
    borderRadius: 12,
    background: root
      ? `linear-gradient(135deg, ${color}, var(--color-viz-1-deep))`
      : `color-mix(in srgb, ${color} 14%, transparent)`,
    color: 'var(--color-viz-ink)',
    boxShadow: `0 10px 30px ${color}18, inset 0 1px 0 rgba(255,255,255,0.08)`,
    fontSize: scaledPx(11),
    fontWeight: 650,
    lineHeight: 1.45,
    whiteSpace: 'pre-line',
    padding: 11,
  };
}
