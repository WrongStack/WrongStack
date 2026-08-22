import { randomUUID } from 'node:crypto';
import {
  createEmptyContractGraph,
  evaluateContractGraph,
  taskContractEndpoint,
} from '../contract-graph.js';
import { mutateBoard, readBoard } from '../storage.js';
import type { KanbanBoard, KanbanEvent, KanbanTask } from '../types.js';
import type {
  KanbanContractEdge,
  KanbanContractEdgeType,
  KanbanContractEnforcement,
  KanbanContractGraph,
  KanbanContractGraphEnforcement,
  KanbanContractGraphEvaluation,
  KanbanContractNode,
  KanbanContractNodeKind,
  KanbanContractNodeState,
  KanbanContractWaiver,
} from '../types-operations.js';
import {
  createKanbanEvent,
  emitKanbanEvent,
  findTask,
  nowIso,
  requireNonBlank,
} from './_internal.js';

const TASK_ENDPOINT_PREFIX = 'task:';

export interface UpsertKanbanContractNodeInput {
  id?: string | undefined;
  taskId: string;
  kind: KanbanContractNodeKind;
  title: string;
  description?: string | undefined;
  enforcement?: KanbanContractEnforcement | undefined;
  state?: KanbanContractNodeState | undefined;
  checkId?: string | undefined;
  metricId?: string | undefined;
  baseline?: string | number | undefined;
  threshold?: string | number | undefined;
  waiver?: KanbanContractWaiver | undefined;
  createdBy?: string | undefined;
  metadata?: Record<string, unknown> | undefined;
}

export interface AddKanbanContractEdgeInput {
  id?: string | undefined;
  from: string;
  to: string;
  type: KanbanContractEdgeType;
  enforcement?: KanbanContractEnforcement | undefined;
  rationale?: string | undefined;
  createdBy?: string | undefined;
}

export { createEmptyContractGraph, evaluateContractGraph, taskContractEndpoint };

export async function getContractGraph(
  projectRoot: string,
  boardId: string,
): Promise<{ board: KanbanBoard; graph: KanbanContractGraph | null } | null> {
  const board = await readBoard(projectRoot, boardId);
  return board ? { board, graph: board.contractGraph ?? null } : null;
}

export async function configureContractGraph(
  projectRoot: string,
  boardId: string,
  enforcement: KanbanContractGraphEnforcement,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const now = nowIso();
    board.contractGraph = board.contractGraph
      ? { ...board.contractGraph, enforcement, updatedAt: now }
      : createEmptyContractGraph(enforcement, now);
    board.updatedAt = now;
    event = {
      id: randomUUID(),
      boardId: board.id,
      type: 'contract.graph.configured',
      ts: now,
      after: { enforcement },
    };
    return true;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated?.board ?? null;
}

export async function upsertContractNode(
  projectRoot: string,
  boardId: string,
  input: UpsertKanbanContractNodeInput,
): Promise<{ board: KanbanBoard; node: KanbanContractNode } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const task = findTask(board, input.taskId);
    if (!task) return null;
    validateContractBinding(task, input.checkId, input.metricId);
    validateWaiver(input.state, input.waiver);

    const now = nowIso();
    const graph = ensureContractGraph(board, now);
    const existing = input.id
      ? graph.nodes.find((candidate) => candidate.id === input.id)
      : undefined;
    if (input.id?.startsWith(TASK_ENDPOINT_PREFIX)) {
      throw new Error(`Contract node ids may not start with "${TASK_ENDPOINT_PREFIX}".`);
    }
    if (existing && existing.taskId !== task.id) {
      throw new Error(
        'A contract node cannot be moved to another task; create a new node instead.',
      );
    }

    const node: KanbanContractNode = {
      id: existing?.id ?? input.id ?? randomUUID(),
      taskId: task.id,
      kind: input.kind,
      title: requireNonBlank(input.title, 'Kanban contract node title'),
      enforcement: input.enforcement ?? existing?.enforcement ?? defaultNodeEnforcement(input.kind),
      state: input.state ?? existing?.state ?? defaultNodeState(input.kind),
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      ...(input.description !== undefined
        ? { description: input.description }
        : existing?.description !== undefined
          ? { description: existing.description }
          : {}),
      ...(input.checkId !== undefined
        ? { checkId: input.checkId }
        : existing?.checkId !== undefined
          ? { checkId: existing.checkId }
          : {}),
      ...(input.metricId !== undefined
        ? { metricId: input.metricId }
        : existing?.metricId !== undefined
          ? { metricId: existing.metricId }
          : {}),
      ...(input.baseline !== undefined
        ? { baseline: input.baseline }
        : existing?.baseline !== undefined
          ? { baseline: existing.baseline }
          : {}),
      ...(input.threshold !== undefined
        ? { threshold: input.threshold }
        : existing?.threshold !== undefined
          ? { threshold: existing.threshold }
          : {}),
      ...(input.waiver !== undefined
        ? { waiver: { ...input.waiver } }
        : existing?.waiver !== undefined
          ? { waiver: { ...existing.waiver } }
          : {}),
      ...(input.createdBy !== undefined
        ? { createdBy: input.createdBy }
        : existing?.createdBy !== undefined
          ? { createdBy: existing.createdBy }
          : {}),
      ...(input.metadata !== undefined
        ? { metadata: { ...input.metadata } }
        : existing?.metadata !== undefined
          ? { metadata: { ...existing.metadata } }
          : {}),
    };
    validateWaiver(node.state, node.waiver);

    const before = existing ? { ...existing } : undefined;
    if (existing) Object.assign(existing, node);
    else graph.nodes.push(node);
    ensureTaskRelation(graph, node, input.createdBy, now);
    graph.updatedAt = now;
    board.updatedAt = now;
    event = createKanbanEvent(
      board.id,
      task,
      existing ? 'contract.node.updated' : 'contract.node.added',
      {
        ...(before ? { before } : {}),
        after: { ...node },
        ...(input.createdBy ? { actor: input.createdBy } : {}),
      },
    );
    return node;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? { board: updated.board, node: updated.result } : null;
}

export async function addContractEdge(
  projectRoot: string,
  boardId: string,
  input: AddKanbanContractEdgeInput,
): Promise<{ board: KanbanBoard; edge: KanbanContractEdge } | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const now = nowIso();
    const graph = ensureContractGraph(board, now);
    const from = normalizeEndpoint(board, graph, input.from);
    const to = normalizeEndpoint(board, graph, input.to);
    if (from === to) throw new Error('Contract graph self-edges are not allowed.');
    const duplicate = graph.edges.find(
      (edge) => edge.from === from && edge.to === to && edge.type === input.type,
    );
    if (duplicate) return duplicate;
    const edge: KanbanContractEdge = {
      id: input.id ?? randomUUID(),
      from,
      to,
      type: input.type,
      enforcement: input.enforcement ?? defaultEdgeEnforcement(input.type),
      createdAt: now,
      ...(input.rationale !== undefined ? { rationale: input.rationale } : {}),
      ...(input.createdBy !== undefined ? { createdBy: input.createdBy } : {}),
    };
    if (graph.edges.some((candidate) => candidate.id === edge.id)) {
      throw new Error(`Contract graph edge id already exists: ${edge.id}`);
    }
    graph.edges.push(edge);
    graph.updatedAt = now;
    board.updatedAt = now;
    const ownerTask = taskForEndpoint(board, graph, from) ?? taskForEndpoint(board, graph, to);
    if (ownerTask) {
      event = createKanbanEvent(board.id, ownerTask, 'contract.edge.added', {
        after: { ...edge },
        ...(input.createdBy ? { actor: input.createdBy } : {}),
      });
    }
    return edge;
  });
  if (updated && event) await emitKanbanEvent(projectRoot, event);
  return updated ? { board: updated.board, edge: updated.result } : null;
}

export async function removeContractNode(
  projectRoot: string,
  boardId: string,
  nodeId: string,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const graph = board.contractGraph;
    if (!graph) return false;
    const index = graph.nodes.findIndex((node) => node.id === nodeId);
    if (index === -1) return false;
    const node = graph.nodes[index]!;
    const task = findTask(board, node.taskId);
    graph.nodes.splice(index, 1);
    graph.edges = graph.edges.filter((edge) => edge.from !== nodeId && edge.to !== nodeId);
    graph.updatedAt = nowIso();
    board.updatedAt = graph.updatedAt;
    if (task) event = createKanbanEvent(board.id, task, 'contract.node.removed', { before: node });
    return true;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function removeContractEdge(
  projectRoot: string,
  boardId: string,
  edgeId: string,
): Promise<KanbanBoard | null> {
  let event: KanbanEvent | undefined;
  const updated = await mutateBoard(projectRoot, boardId, (board) => {
    const graph = board.contractGraph;
    if (!graph) return false;
    const removed = graph.edges.find((edge) => edge.id === edgeId);
    const before = graph.edges.length;
    graph.edges = graph.edges.filter((edge) => edge.id !== edgeId);
    if (graph.edges.length === before) return false;
    graph.updatedAt = nowIso();
    board.updatedAt = graph.updatedAt;
    const task = removed
      ? (taskForEndpoint(board, graph, removed.from) ?? taskForEndpoint(board, graph, removed.to))
      : undefined;
    if (task && removed) {
      event = createKanbanEvent(board.id, task, 'contract.edge.removed', { before: removed });
    }
    return true;
  });
  if (updated?.result && event) await emitKanbanEvent(projectRoot, event);
  return updated?.result ? updated.board : null;
}

export async function evaluateTaskContractGraph(
  projectRoot: string,
  boardId: string,
  taskId: string,
): Promise<{ board: KanbanBoard; evaluation: KanbanContractGraphEvaluation } | null> {
  const board = await readBoard(projectRoot, boardId);
  if (!board || !findTask(board, taskId)) return null;
  return { board, evaluation: evaluateContractGraph(board, taskId) };
}

/** Remove task-owned nodes and every incident edge when a task is deleted. */
export function removeTaskContractGraphState(board: KanbanBoard, taskId: string): void {
  const graph = board.contractGraph;
  if (!graph) return;
  const removed = new Set(
    graph.nodes.filter((node) => node.taskId === taskId).map((node) => node.id),
  );
  const endpoint = taskContractEndpoint(taskId);
  graph.nodes = graph.nodes.filter((node) => !removed.has(node.id));
  graph.edges = graph.edges.filter(
    (edge) =>
      edge.from !== endpoint &&
      edge.to !== endpoint &&
      !removed.has(edge.from) &&
      !removed.has(edge.to),
  );
  graph.updatedAt = nowIso();
}

/** Clone the self-contained contract subgraph for remapped tasks on a duplicated board. */
export function cloneContractGraphForBoard(
  source: KanbanBoard,
  target: KanbanBoard,
  taskIdMap: ReadonlyMap<string, string>,
): void {
  const sourceGraph = source.contractGraph;
  if (!sourceGraph) return;
  const now = nowIso();
  const nodeIdMap = new Map<string, string>();
  const nodes: KanbanContractNode[] = [];
  for (const node of sourceGraph.nodes) {
    const targetTaskId = taskIdMap.get(node.taskId);
    if (!targetTaskId) continue;
    const sourceTask = findTask(source, node.taskId);
    const targetTask = findTask(target, targetTaskId);
    if (!sourceTask || !targetTask) continue;
    const id = randomUUID();
    nodeIdMap.set(node.id, id);
    const checkId = remapBoundId(
      sourceTask.successCriteria,
      targetTask.successCriteria,
      node.checkId,
    );
    const metricId = remapBoundId(sourceTask.goalMetrics, targetTask.goalMetrics, node.metricId);
    nodes.push({
      ...node,
      id,
      taskId: targetTaskId,
      createdAt: now,
      updatedAt: now,
      ...(checkId ? { checkId } : { checkId: undefined }),
      ...(metricId ? { metricId } : { metricId: undefined }),
      ...(node.waiver ? { waiver: { ...node.waiver } } : {}),
      ...(node.metadata ? { metadata: { ...node.metadata } } : {}),
    });
  }
  const remapEndpoint = (endpoint: string): string | undefined => {
    if (endpoint.startsWith(TASK_ENDPOINT_PREFIX)) {
      const mapped = taskIdMap.get(endpoint.slice(TASK_ENDPOINT_PREFIX.length));
      return mapped ? taskContractEndpoint(mapped) : undefined;
    }
    return nodeIdMap.get(endpoint);
  };
  const edges: KanbanContractEdge[] = [];
  for (const edge of sourceGraph.edges) {
    const from = remapEndpoint(edge.from);
    const to = remapEndpoint(edge.to);
    if (!from || !to) continue;
    edges.push({ ...edge, id: randomUUID(), from, to, createdAt: now });
  }
  const existing = target.contractGraph;
  target.contractGraph = {
    version: 1,
    enforcement: existing?.enforcement ?? sourceGraph.enforcement,
    nodes: [...(existing?.nodes ?? []), ...nodes],
    edges: [...(existing?.edges ?? []), ...edges],
    updatedAt: now,
  };
}

function ensureContractGraph(board: KanbanBoard, now: string): KanbanContractGraph {
  board.contractGraph ??= createEmptyContractGraph('advisory', now);
  return board.contractGraph;
}

function ensureTaskRelation(
  graph: KanbanContractGraph,
  node: KanbanContractNode,
  createdBy: string | undefined,
  at: string,
): void {
  if (node.kind === 'verification') return;
  const type = relationForNodeKind(node.kind);
  const from = taskContractEndpoint(node.taskId);
  if (graph.edges.some((edge) => edge.from === from && edge.to === node.id && edge.type === type)) {
    return;
  }
  graph.edges.push({
    id: randomUUID(),
    from,
    to: node.id,
    type,
    enforcement: node.enforcement,
    createdAt: at,
    ...(createdBy !== undefined ? { createdBy } : {}),
  });
}

function relationForNodeKind(
  kind: Exclude<KanbanContractNodeKind, 'verification'>,
): KanbanContractEdgeType {
  if (kind === 'objective') return 'targets';
  if (kind === 'guardrail') return 'must_preserve';
  if (kind === 'risk') return 'exposes';
  return 'affects';
}

function normalizeEndpoint(
  board: KanbanBoard,
  graph: KanbanContractGraph,
  endpoint: string,
): string {
  const value = requireNonBlank(endpoint, 'Kanban contract graph endpoint');
  const explicitTaskId = value.startsWith(TASK_ENDPOINT_PREFIX)
    ? value.slice(TASK_ENDPOINT_PREFIX.length)
    : undefined;
  const task = findTask(board, explicitTaskId ?? value);
  if (task) return taskContractEndpoint(task.id);
  if (graph.nodes.some((node) => node.id === value)) return value;
  throw new Error(`Contract graph endpoint not found: ${value}`);
}

function taskForEndpoint(
  board: KanbanBoard,
  graph: KanbanContractGraph,
  endpoint: string,
): KanbanTask | undefined {
  if (endpoint.startsWith(TASK_ENDPOINT_PREFIX)) {
    return findTask(board, endpoint.slice(TASK_ENDPOINT_PREFIX.length));
  }
  const node = graph.nodes.find((candidate) => candidate.id === endpoint);
  return node ? findTask(board, node.taskId) : undefined;
}

function validateContractBinding(
  task: KanbanTask,
  checkId: string | undefined,
  metricId: string | undefined,
): void {
  if (checkId && !task.successCriteria?.some((check) => check.id === checkId)) {
    throw new Error(`Contract check binding not found on task: ${checkId}`);
  }
  if (metricId && !task.goalMetrics?.some((metric) => metric.id === metricId)) {
    throw new Error(`Contract metric binding not found on task: ${metricId}`);
  }
}

function validateWaiver(
  state: KanbanContractNodeState | undefined,
  waiver: KanbanContractWaiver | undefined,
): void {
  if (state !== 'waived') return;
  if (!waiver?.actor.trim() || !waiver.reason.trim() || !waiver.at.trim()) {
    throw new Error('A waived contract node requires actor, reason, and timestamp.');
  }
}

function defaultNodeEnforcement(kind: KanbanContractNodeKind): KanbanContractEnforcement {
  return kind === 'component' || kind === 'artifact' ? 'informational' : 'blocking';
}

function defaultNodeState(kind: KanbanContractNodeKind): KanbanContractNodeState {
  return kind === 'component' || kind === 'artifact' ? 'unknown' : 'active';
}

function defaultEdgeEnforcement(type: KanbanContractEdgeType): KanbanContractEnforcement {
  return type === 'affects' || type === 'relates_to' || type === 'derived_from'
    ? 'informational'
    : 'blocking';
}

function remapBoundId<T extends { id: string }>(
  source: readonly T[] | undefined,
  target: readonly T[] | undefined,
  sourceId: string | undefined,
): string | undefined {
  if (!sourceId) return undefined;
  const index = source?.findIndex((entry) => entry.id === sourceId) ?? -1;
  return index >= 0 ? target?.[index]?.id : undefined;
}
