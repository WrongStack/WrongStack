import type { KanbanBoard, KanbanTask } from './types.js';
import type {
  KanbanContractGraph,
  KanbanContractGraphEnforcement,
  KanbanContractGraphEvaluation,
  KanbanContractGraphIssue,
  KanbanContractNode,
  KanbanContractNodeState,
  KanbanContractReadinessEvaluation,
} from './types-operations.js';

const TASK_ENDPOINT_PREFIX = 'task:';

export function taskContractEndpoint(taskId: string): string {
  return `${TASK_ENDPOINT_PREFIX}${taskId}`;
}

/** Compact human-readable closure used by terminal surfaces. */
export function summarizeContractGraph(board: KanbanBoard, taskId: string): string | null {
  if (!board.contractGraph) return null;
  const evaluation = evaluateContractGraph(board, taskId);
  return evaluation.issues.length === 0
    ? `Contract ${evaluation.enforcement}: closed`
    : `Contract ${evaluation.enforcement}: ${evaluation.issues.length} open`;
}

export function createEmptyContractGraph(
  enforcement: KanbanContractGraphEnforcement,
  at = new Date().toISOString(),
): KanbanContractGraph {
  return { version: 1, enforcement, nodes: [], edges: [], updatedAt: at };
}

/**
 * Validate that a card is safe to start implementing. Card details and
 * executable acceptance criteria are always required. Contract-map structure
 * is deliberately excluded: even a strict map is an operator review signal,
 * never work the model must perform before implementation.
 */
export function evaluateContractGraphReadiness(
  board: KanbanBoard,
  taskId: string,
): KanbanContractReadinessEvaluation {
  const issues: KanbanContractReadinessEvaluation['issues'] = [];
  const task = board.tasks.find((candidate) => candidate.id === taskId);
  if (!task) {
    return {
      taskId,
      ready: false,
      issues: [
        { code: 'task-not-found', field: 'taskId', message: `Kanban task not found: ${taskId}` },
      ],
    };
  }
  // The card contract belongs to managed boards. On a plain board these rules
  // describe nothing that is actually enforced, and treating their absence as
  // unreadiness had two visible consequences: `start_task` refused every card
  // on an ordinary board — its first stated reason being that the board was
  // not managed, a demand no card can satisfy — and the workbench reported
  // healthy cards as carrying "readiness gaps", so the surface meant to answer
  // "what should I do next?" contradicted `ready_tasks` on the same board.
  if (board.lifecycle?.mode !== 'managed') {
    return { taskId, ready: true, issues: [] };
  }
  if (!task.description?.trim()) {
    issues.push({
      code: 'task-description-missing',
      field: 'description',
      message: 'Add a complete task description.',
    });
  }
  if (
    ![task.assignee, task.assignedAgent, task.assignment?.agentId, task.assignment?.name].some(
      (value) => value?.trim(),
    )
  ) {
    issues.push({
      code: 'task-owner-missing',
      field: 'assignee',
      message: 'Assign an owner or agent.',
    });
  }
  // `dueDate` and `labels` are deliberately not required here either; see
  // validateRequiredCardDetails in manager/lifecycle.ts for the reasoning.
  if (
    !task.successCriteria?.length ||
    task.successCriteria.some((check) => !check.description.trim())
  ) {
    issues.push({
      code: 'success-criteria-missing',
      field: 'successCriteria',
      message: 'Add at least one explicit, executable acceptance criterion.',
    });
  }
  // A composite parent must have persisted children before anyone starts it.
  // This rule lived in `validateRequiredCardDetails` and in the queue
  // classifier but not here, and here is the gate `start_task` consults — so a
  // childless composite was reported "start ready", accepted by `start_task`,
  // and then thrown out by the lifecycle transition a moment later. The
  // workbench showed the same card as having no readiness gaps. Atomic LEAVES
  // (falsy `atomic`) are executable directly and are deliberately not forced
  // into recursive decomposition.
  if (task.atomic && !task.childTaskIds?.some((id) => id.trim())) {
    issues.push({
      code: 'task-child-tasks-missing',
      field: 'childTaskIds',
      message: 'Break the work into at least one persisted subtask.',
    });
  }

  return { taskId, ready: issues.length === 0, issues };
}

/** Browser-safe deterministic evaluator shared by the gate, TUI, and WebUI. */
export function evaluateContractGraph(
  board: KanbanBoard,
  taskId: string,
  taskOverride?: KanbanTask,
): KanbanContractGraphEvaluation {
  const graph = board.contractGraph;
  const enforcement = graph?.enforcement ?? 'off';
  if (!graph || enforcement === 'off') {
    return { taskId, enforcement, allowed: true, evaluatedNodeIds: [], issues: [] };
  }

  const root = taskContractEndpoint(taskId);
  const reachable = reachableNodeIds(graph, root, taskId);
  const nodes = graph.nodes.filter((node) => reachable.has(node.id));
  const issues: KanbanContractGraphIssue[] = [];
  const taskLookup = (ownerId: string): KanbanTask | undefined =>
    ownerId === taskId && taskOverride
      ? taskOverride
      : board.tasks.find((task) => task.id === ownerId);

  const objectives = nodes.filter((node) => node.kind === 'objective');
  const guardrails = nodes.filter((node) => node.kind === 'guardrail');
  if (objectives.length === 0) {
    issues.push({ code: 'objective-missing', message: 'Contract graph requires an objective.' });
  }
  if (guardrails.length === 0) {
    issues.push({
      code: 'guardrail-missing',
      message: 'Contract graph requires at least one guardrail.',
    });
  }

  const stateByNode = new Map<string, KanbanContractNodeState>();
  for (const node of nodes) {
    const owner = taskLookup(node.taskId);
    const state = effectiveNodeState(node, owner, issues);
    stateByNode.set(node.id, state);
    if (node.enforcement !== 'blocking') continue;
    if (node.kind === 'component' || node.kind === 'artifact') continue;
    const acceptable =
      state === 'satisfied' || state === 'resolved' || (state === 'waived' && validWaiver(node));
    if (!acceptable) {
      issues.push({
        code: state === 'waived' ? 'waiver-invalid' : 'node-unresolved',
        nodeId: node.id,
        message: `Blocking ${node.kind} "${node.title}" is ${state}.`,
      });
    }
  }

  const risks = nodes.filter((node) => node.kind === 'risk');
  for (const subject of [...objectives, ...guardrails, ...risks].filter(
    (node) => node.enforcement === 'blocking',
  )) {
    const hasBoundEvidence = Boolean(subject.checkId || subject.metricId);
    const hasVerificationEdge = graph.edges.some((edge) => {
      if (edge.from !== subject.id || edge.type !== 'verified_by' || !reachable.has(edge.to)) {
        return false;
      }
      const evidence = graph.nodes.find(
        (node) => node.id === edge.to && node.kind === 'verification',
      );
      const evidenceState = evidence ? stateByNode.get(evidence.id) : undefined;
      return Boolean(
        evidence &&
          (evidence.checkId || evidence.metricId) &&
          (evidenceState === 'satisfied' ||
            evidenceState === 'resolved' ||
            (evidenceState === 'waived' && validWaiver(evidence))),
      );
    });
    if (!hasBoundEvidence && !hasVerificationEdge) {
      issues.push({
        code: 'verification-missing',
        nodeId: subject.id,
        message: `Blocking ${subject.kind} "${subject.title}" has no check, metric, or verified_by evidence.`,
      });
    }
  }

  for (const edge of graph.edges) {
    if (edge.type !== 'conflicts_with' || edge.enforcement !== 'blocking') continue;
    if (!reachable.has(edge.from) && !reachable.has(edge.to)) continue;
    const fromState = stateByNode.get(edge.from);
    const toState = stateByNode.get(edge.to);
    const settled = [fromState, toState].every(
      (state) => state === 'satisfied' || state === 'resolved' || state === 'waived',
    );
    if (!settled) {
      issues.push({
        code: 'conflict-unresolved',
        edgeId: edge.id,
        message: `Blocking conflict ${edge.from} -> ${edge.to} is unresolved.`,
      });
    }
  }

  return {
    taskId,
    enforcement,
    allowed: enforcement !== 'strict' || issues.length === 0,
    evaluatedNodeIds: nodes.map((node) => node.id),
    issues,
  };
}

function validWaiver(node: KanbanContractNode): boolean {
  const waiver = node.waiver;
  if (!waiver?.actor.trim() || !waiver.reason.trim() || !waiver.at.trim()) return false;
  return !waiver.expiresAt || Date.parse(waiver.expiresAt) > Date.now();
}

function effectiveNodeState(
  node: KanbanContractNode,
  task: KanbanTask | undefined,
  issues: KanbanContractGraphIssue[],
): KanbanContractNodeState {
  if (!task) {
    issues.push({
      code: 'binding-invalid',
      nodeId: node.id,
      message: `Contract node owner task not found: ${node.taskId}`,
    });
    return 'violated';
  }
  if (node.checkId) {
    const check = task.successCriteria?.find((candidate) => candidate.id === node.checkId);
    if (!check) {
      issues.push({
        code: 'binding-invalid',
        nodeId: node.id,
        message: `Bound check not found: ${node.checkId}`,
      });
      return 'violated';
    }
    if (check.status === 'passed') return 'satisfied';
    if (check.status === 'failed') return 'violated';
    return node.state === 'waived' ? 'waived' : 'active';
  }
  if (node.metricId) {
    const metric = task.goalMetrics?.find((candidate) => candidate.id === node.metricId);
    if (!metric) {
      issues.push({
        code: 'binding-invalid',
        nodeId: node.id,
        message: `Bound metric not found: ${node.metricId}`,
      });
      return 'violated';
    }
    if (metric.status === 'met') return 'satisfied';
    if (metric.status === 'missed') return 'violated';
    if (metric.status === 'waived') return node.waiver ? 'waived' : 'violated';
    return 'active';
  }
  if (node.kind === 'verification' && node.enforcement === 'blocking') {
    issues.push({
      code: 'verification-missing',
      nodeId: node.id,
      message: `Blocking verification "${node.title}" is not bound to an executable check.`,
    });
  }
  return node.state;
}

function reachableNodeIds(
  graph: KanbanContractGraph,
  root: string,
  ownerTaskId: string,
): Set<string> {
  const reachable = new Set(
    graph.nodes.filter((node) => node.taskId === ownerTaskId).map((node) => node.id),
  );
  const queue = [root, ...reachable];
  const seen = new Set(queue);
  while (queue.length) {
    const endpoint = queue.shift();
    if (!endpoint) continue;
    for (const edge of graph.edges) {
      const next =
        edge.from === endpoint
          ? edge.to
          : edge.type === 'conflicts_with' || edge.type === 'relates_to'
            ? edge.to === endpoint
              ? edge.from
              : undefined
            : undefined;
      if (!next || seen.has(next)) continue;
      seen.add(next);
      queue.push(next);
      if (!next.startsWith(TASK_ENDPOINT_PREFIX)) reachable.add(next);
    }
  }
  return reachable;
}
