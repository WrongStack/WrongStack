import {
  addCheckToTask,
  addContractEdge,
  addDependency,
  addGoalMetricToTask,
  addLinkToTask,
  addNoteToTask,
  configureContractGraph,
  evaluateTaskContractGraph,
  getContractGraph,
  getKanbanWorkbench,
  removeContractEdge,
  removeContractNode,
  updateCheckOnTask,
  updateGoalMetricOnTask,
  upsertContractNode,
} from '@wrongstack/kanban';
import { handleSplitTask } from './kanban-split-task-handler.js';
import { fail, okBoard } from './kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

export async function handleKanbanDetailAction(
  projectRoot: string,
  input: KanbanToolInput,
): Promise<KanbanToolOutput | undefined> {
  switch (input.action) {
    case 'workbench': {
      const workbench = await getKanbanWorkbench(projectRoot, {
        ...(input.limit !== undefined
          ? { limitPerLane: input.limit, alertLimit: input.limit }
          : {}),
      });
      return {
        ok: true,
        message: `${workbench.totals.now} now, ${workbench.totals.next} next, ${workbench.totals.blocked} blocked, ${workbench.totals.review} review; ${workbench.alertTotal} alert(s).`,
        workbench,
      };
    }
    case 'get_contract_graph': {
      if (!input.boardId) return fail('get_contract_graph requires boardId.');
      const result = await getContractGraph(projectRoot, input.boardId);
      return result
        ? {
            ok: true,
            message: result.graph
              ? `${result.graph.nodes.length} contract node(s), ${result.graph.edges.length} edge(s).`
              : 'Contract graph is not configured.',
            board: result.board,
            ...(result.graph ? { contractGraph: result.graph } : {}),
          }
        : fail('Board not found.');
    }
    case 'configure_contract_graph': {
      if (!input.boardId || !input.contractGraphEnforcement) {
        return fail('configure_contract_graph requires boardId and contractGraphEnforcement.');
      }
      const current = await getContractGraph(projectRoot, input.boardId);
      if (!current) return fail('Board not found.');
      if (input.contractGraphEnforcement === 'strict' && current.graph?.enforcement !== 'strict') {
        return fail(
          'Strict Contract Map enforcement is operator-owned. Autonomous agents may use advisory maps but may not turn them into an execution gate.',
        );
      }
      if (current.graph?.enforcement === 'strict' && input.contractGraphEnforcement !== 'strict') {
        return fail('An autonomous agent may not loosen a strict contract graph.');
      }
      const board = await configureContractGraph(
        projectRoot,
        input.boardId,
        input.contractGraphEnforcement,
      );
      return board ? okBoard(board, 'Contract graph configured.') : fail('Board not found.');
    }
    case 'upsert_contract_node': {
      if (!input.boardId || !input.taskId || !input.contractNodeKind || !input.title) {
        return fail('upsert_contract_node requires boardId, taskId, contractNodeKind, and title.');
      }
      if (input.contractNodeState === 'waived') {
        return fail(
          'The autonomous kanban tool may not waive contract nodes; a human-owned review surface must record that exception.',
        );
      }
      if (input.contractNodeId) {
        const current = await getContractGraph(projectRoot, input.boardId);
        const existing = current?.graph?.nodes.find((node) => node.id === input.contractNodeId);
        if (
          current?.graph?.enforcement === 'strict' &&
          existing &&
          (existing.kind !== input.contractNodeKind ||
            (input.contractEnforcement !== undefined &&
              input.contractEnforcement !== existing.enforcement))
        ) {
          return fail(
            'The autonomous kanban tool may not change the kind or enforcement of an existing strict contract node.',
          );
        }
      }
      const result = await upsertContractNode(projectRoot, input.boardId, {
        ...(input.contractNodeId ? { id: input.contractNodeId } : {}),
        taskId: input.taskId,
        kind: input.contractNodeKind,
        title: input.title,
        ...(input.description !== undefined ? { description: input.description } : {}),
        ...(input.contractEnforcement !== undefined
          ? { enforcement: input.contractEnforcement }
          : {}),
        ...(input.contractNodeState !== undefined ? { state: input.contractNodeState } : {}),
        ...(input.checkId !== undefined ? { checkId: input.checkId } : {}),
        ...(input.metricId !== undefined ? { metricId: input.metricId } : {}),
        ...(input.baseline !== undefined ? { baseline: input.baseline } : {}),
        ...(input.threshold !== undefined ? { threshold: input.threshold } : {}),
        ...(input.author !== undefined ? { createdBy: input.author } : {}),
      });
      return result
        ? {
            ...okBoard(result.board, 'Contract node saved.'),
            contractGraph: result.board.contractGraph,
          }
        : fail('Task not found.');
    }
    case 'link_contract_nodes': {
      if (!input.boardId || !input.fromNodeId || !input.toNodeId || !input.contractEdgeType) {
        return fail(
          'link_contract_nodes requires boardId, fromNodeId, toNodeId, and contractEdgeType.',
        );
      }
      const result = await addContractEdge(projectRoot, input.boardId, {
        from: input.fromNodeId,
        to: input.toNodeId,
        type: input.contractEdgeType,
        ...(input.contractEdgeId ? { id: input.contractEdgeId } : {}),
        ...(input.contractEnforcement ? { enforcement: input.contractEnforcement } : {}),
        ...(input.contractRationale ? { rationale: input.contractRationale } : {}),
        ...(input.author ? { createdBy: input.author } : {}),
      });
      return result
        ? {
            ...okBoard(result.board, 'Contract edge added.'),
            contractGraph: result.board.contractGraph,
          }
        : fail('Board not found.');
    }
    case 'remove_contract_node': {
      if (!input.boardId || !input.contractNodeId) {
        return fail('remove_contract_node requires boardId and contractNodeId.');
      }
      const current = await getContractGraph(projectRoot, input.boardId);
      const node = current?.graph?.nodes.find((candidate) => candidate.id === input.contractNodeId);
      if (current?.graph?.enforcement === 'strict' && node?.enforcement === 'blocking') {
        return fail('The autonomous kanban tool may not remove a blocking strict contract node.');
      }
      const board = await removeContractNode(projectRoot, input.boardId, input.contractNodeId);
      return board ? okBoard(board, 'Contract node removed.') : fail('Contract node not found.');
    }
    case 'remove_contract_edge': {
      if (!input.boardId || !input.contractEdgeId) {
        return fail('remove_contract_edge requires boardId and contractEdgeId.');
      }
      const current = await getContractGraph(projectRoot, input.boardId);
      const edge = current?.graph?.edges.find((candidate) => candidate.id === input.contractEdgeId);
      if (current?.graph?.enforcement === 'strict' && edge?.enforcement === 'blocking') {
        return fail('The autonomous kanban tool may not remove a blocking strict contract edge.');
      }
      const board = await removeContractEdge(projectRoot, input.boardId, input.contractEdgeId);
      return board ? okBoard(board, 'Contract edge removed.') : fail('Contract edge not found.');
    }
    case 'evaluate_contract_graph': {
      if (!input.boardId || !input.taskId) {
        return fail('evaluate_contract_graph requires boardId and taskId.');
      }
      const result = await evaluateTaskContractGraph(projectRoot, input.boardId, input.taskId);
      return result
        ? {
            ok: result.evaluation.allowed,
            message: result.evaluation.allowed
              ? 'Contract graph is closed.'
              : `Contract graph has ${result.evaluation.issues.length} unresolved issue(s).`,
            board: result.board,
            contractGraph: result.board.contractGraph,
            contractEvaluation: result.evaluation,
          }
        : fail('Task not found.');
    }
    case 'add_dependency': {
      if (!input.boardId || !input.taskId || !input.dependencyTaskId) {
        return fail('add_dependency requires boardId, taskId, and dependencyTaskId.');
      }
      const board = await addDependency(
        projectRoot,
        input.boardId,
        input.taskId,
        input.dependencyTaskId,
      );
      return board ? okBoard(board, 'Dependency added.') : fail('Task not found.');
    }
    case 'add_goal_metric': {
      if (!input.boardId || !input.taskId || !input.metricName) {
        return fail('add_goal_metric requires boardId, taskId, and metricName.');
      }
      const board = await addGoalMetricToTask(projectRoot, input.boardId, input.taskId, {
        name: input.metricName,
        ...(input.metricStatus !== undefined ? { status: input.metricStatus } : {}),
        ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
        ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
        ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
        ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
      });
      return board ? okBoard(board, 'Goal metric added.') : fail('Task not found.');
    }
    case 'update_goal_metric': {
      if (!input.boardId || !input.taskId || !input.metricId) {
        return fail('update_goal_metric requires boardId, taskId, and metricId.');
      }
      const board = await updateGoalMetricOnTask(
        projectRoot,
        input.boardId,
        input.taskId,
        input.metricId,
        {
          ...(input.metricName !== undefined ? { name: input.metricName } : {}),
          ...(input.metricStatus !== undefined ? { status: input.metricStatus } : {}),
          ...(input.metricTarget !== undefined ? { target: input.metricTarget } : {}),
          ...(input.metricCurrent !== undefined ? { current: input.metricCurrent } : {}),
          ...(input.metricUnit !== undefined ? { unit: input.metricUnit } : {}),
          ...(input.metricNotes !== undefined ? { notes: input.metricNotes } : {}),
        },
      );
      return board ? okBoard(board, 'Goal metric updated.') : fail('Metric not found.');
    }
    case 'add_check': {
      if (!input.boardId || !input.taskId || !input.checkDescription) {
        return fail('add_check requires boardId, taskId, and checkDescription.');
      }
      const board = await addCheckToTask(projectRoot, input.boardId, input.taskId, {
        description: input.checkDescription,
        type: 'manual',
        status: input.checkStatus,
      });
      return board ? okBoard(board, 'Check added.') : fail('Task not found.');
    }
    case 'update_check': {
      if (!input.boardId || !input.taskId || !input.checkId) {
        return fail('update_check requires boardId, taskId, and checkId.');
      }
      const board = await updateCheckOnTask(
        projectRoot,
        input.boardId,
        input.taskId,
        input.checkId,
        {
          ...(input.checkDescription !== undefined ? { description: input.checkDescription } : {}),
          ...(input.checkStatus !== undefined ? { status: input.checkStatus } : {}),
        },
      );
      return board ? okBoard(board, 'Check updated.') : fail('Check not found.');
    }
    case 'add_note': {
      if (!input.boardId || !input.taskId || !input.note)
        return fail('add_note requires boardId, taskId, and note.');
      const board = await addNoteToTask(projectRoot, input.boardId, input.taskId, {
        author: input.author ?? 'agent',
        content: input.note,
      });
      return board ? okBoard(board, 'Note added.') : fail('Task not found.');
    }
    case 'add_link': {
      if (!input.boardId || !input.taskId || !input.url)
        return fail('add_link requires boardId, taskId, and url.');
      const board = await addLinkToTask(projectRoot, input.boardId, input.taskId, {
        url: input.url,
        type: input.linkType ?? 'url',
        ...(input.linkTitle !== undefined ? { title: input.linkTitle } : {}),
      });
      return board ? okBoard(board, 'Link added.') : fail('Task not found.');
    }
    case 'split_atomic': {
      if (!input.boardId || !input.taskId || !input.childTitles?.length) {
        return fail('split_atomic requires boardId, taskId, and childTitles (at least one).');
      }
      return handleSplitTask(projectRoot, input, { atomic: true });
    }
    default:
      return undefined;
  }
}
