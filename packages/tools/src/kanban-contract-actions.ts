/**
 * Contract-map actions for the `kanban` tool.
 *
 * The card contract answers four questions about a piece of work: what it is
 * FOR (objective), what it must not break (guardrail), what could go wrong
 * (risk), and what settles it (verification), plus the components and artifacts
 * it touches. Nodes hang off a task; edges connect nodes to each other and to
 * the card endpoint (`task:<id>`).
 *
 * The domain API for all of this already existed and was already on the IPC
 * wire allowlist — `configureContractGraph`, `upsertContractNode`,
 * `addContractEdge`, `removeContractNode`, `removeContractEdge`,
 * `getContractGraph`, `evaluateTaskContractGraph` — but nothing anywhere
 * called it: no tool action, no WebSocket route, no CLI subcommand. So the
 * three WebUI panels that render `board.contractGraph` always showed the empty
 * state, and the map could not be populated by any means. This module is the
 * agent-facing half of closing that.
 *
 * Deliberately advisory: `evaluateContractGraphReadiness` (the gate that
 * decides whether a card may be implemented) does NOT require map structure,
 * so nothing here becomes work the model must finish before it can start. A
 * map is an operator review aid.
 */
import {
  addContractEdge,
  configureContractGraph,
  evaluateTaskContractGraph,
  getContractGraph,
  removeContractEdge,
  removeContractNode,
  upsertContractNode,
} from '@wrongstack/kanban';
import { fail, okBoard } from './kanban-tool-results.js';
import type { KanbanToolInput, KanbanToolOutput } from './kanban-tool-types.js';

/**
 * Handle a contract-map action, or return `undefined` when the action belongs
 * to another handler. Mirrors the shape of `handleKanbanDetailAction`.
 */
export async function handleKanbanContractAction(
  projectRoot: string,
  input: KanbanToolInput,
  actor: string | undefined,
  sessionId: string,
): Promise<KanbanToolOutput | undefined> {
  const eventContext = { sessionId, ...(actor !== undefined ? { actor } : {}) };
  switch (input.action) {
    case 'get_contract_graph': {
      if (!input.boardId) return fail('get_contract_graph requires boardId.');
      const found = await getContractGraph(projectRoot, input.boardId);
      if (!found) return fail('Board not found.');
      // A taskId narrows the answer to "is THIS card's contract closed?",
      // which is what a worker actually wants before claiming a card.
      const evaluated = input.taskId
        ? await evaluateTaskContractGraph(projectRoot, input.boardId, input.taskId)
        : null;
      if (input.taskId && !evaluated) return fail('Task not found on this board.');
      return {
        ok: true,
        message: found.graph
          ? `Contract map: ${found.graph.nodes.length} node(s), ${found.graph.edges.length} edge(s), enforcement ${found.graph.enforcement}.`
          : 'No contract map on this board yet. Call configure_contract_graph to start one.',
        board: found.board,
        contractGraph: found.graph,
        ...(evaluated ? { contractEvaluation: evaluated.evaluation } : {}),
      };
    }

    case 'configure_contract_graph': {
      if (!input.boardId) return fail('configure_contract_graph requires boardId.');
      // Creating the map and setting its enforcement are the same call: an
      // enforcement level is the only thing an empty map has to say.
      const enforcement = input.contractEnforcement ?? 'advisory';
      const board = await configureContractGraph(
        projectRoot,
        input.boardId,
        enforcement,
        eventContext,
      );
      return board
        ? okBoard(board, `Contract map enforcement set to ${enforcement}.`)
        : fail('Board not found.');
    }

    case 'upsert_contract_node': {
      if (!input.boardId || !input.taskId) {
        return fail('upsert_contract_node requires boardId and taskId.');
      }
      if (!input.contractNodeKind || !input.contractNodeTitle) {
        return fail('upsert_contract_node requires contractNodeKind and contractNodeTitle.');
      }
      // A waiver is an accountable act, so it carries who and why. The domain
      // layer rejects a waived node without them; supply the actor from the
      // call rather than making the model repeat it.
      const waiver =
        input.contractNodeState === 'waived'
          ? {
              actor: actor ?? 'agent',
              reason: input.contractWaiverReason ?? '',
              at: new Date().toISOString(),
            }
          : undefined;
      if (waiver && !waiver.reason.trim()) {
        return fail('A waived contract node requires contractWaiverReason.');
      }
      const result = await upsertContractNode(
        projectRoot,
        input.boardId,
        {
          taskId: input.taskId,
          kind: input.contractNodeKind,
          title: input.contractNodeTitle,
          ...(input.contractNodeId !== undefined ? { id: input.contractNodeId } : {}),
          ...(input.contractNodeDescription !== undefined
            ? { description: input.contractNodeDescription }
            : {}),
          ...(input.contractNodeState !== undefined ? { state: input.contractNodeState } : {}),
          ...(input.contractNodeEnforcement !== undefined
            ? { enforcement: input.contractNodeEnforcement }
            : {}),
          ...(input.contractCheckId !== undefined ? { checkId: input.contractCheckId } : {}),
          ...(input.contractMetricId !== undefined ? { metricId: input.contractMetricId } : {}),
          ...(waiver ? { waiver } : {}),
          ...(actor !== undefined ? { createdBy: actor } : {}),
        },
        eventContext,
      );
      if (!result) return fail('Board or task not found.');
      return {
        ok: true,
        message: `Contract node ${result.node.kind} "${result.node.title}" saved (${result.node.id}).`,
        board: result.board,
        contractGraph: result.board.contractGraph ?? null,
      };
    }

    case 'remove_contract_node': {
      if (!input.boardId || !input.contractNodeId) {
        return fail('remove_contract_node requires boardId and contractNodeId.');
      }
      const board = await removeContractNode(
        projectRoot,
        input.boardId,
        input.contractNodeId,
        eventContext,
      );
      return board
        ? okBoard(board, 'Contract node removed, along with every edge that touched it.')
        : fail('Contract node not found.');
    }

    case 'add_contract_edge': {
      if (!input.boardId || !input.contractEdgeFrom || !input.contractEdgeTo) {
        return fail('add_contract_edge requires boardId, contractEdgeFrom, and contractEdgeTo.');
      }
      if (!input.contractEdgeType) return fail('add_contract_edge requires contractEdgeType.');
      const result = await addContractEdge(
        projectRoot,
        input.boardId,
        {
          from: input.contractEdgeFrom,
          to: input.contractEdgeTo,
          type: input.contractEdgeType,
          ...(input.contractEdgeId !== undefined ? { id: input.contractEdgeId } : {}),
          ...(input.contractNodeEnforcement !== undefined
            ? { enforcement: input.contractNodeEnforcement }
            : {}),
          ...(input.contractEdgeRationale !== undefined
            ? { rationale: input.contractEdgeRationale }
            : {}),
          ...(actor !== undefined ? { createdBy: actor } : {}),
        },
        eventContext,
      );
      if (!result) return fail('Board not found.');
      return {
        ok: true,
        message: `Contract edge ${result.edge.type}: ${result.edge.from} → ${result.edge.to}.`,
        board: result.board,
        contractGraph: result.board.contractGraph ?? null,
      };
    }

    case 'remove_contract_edge': {
      if (!input.boardId || !input.contractEdgeId) {
        return fail('remove_contract_edge requires boardId and contractEdgeId.');
      }
      const board = await removeContractEdge(
        projectRoot,
        input.boardId,
        input.contractEdgeId,
        eventContext,
      );
      return board ? okBoard(board, 'Contract edge removed.') : fail('Contract edge not found.');
    }

    default:
      return undefined;
  }
}
