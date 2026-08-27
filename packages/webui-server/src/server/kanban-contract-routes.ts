/**
 * WebSocket routes for the card contract map.
 *
 * The three WebUI contract panels (`KanbanContractGraphPanel`,
 * `KanbanContractGraphDashboard`, `KanbanContractGraphView`) render
 * `board.contractGraph` and have always shown the empty state, because no
 * surface could write one: the domain API existed and sat on the IPC wire
 * allowlist, but nothing called it. These routes are the human half of closing
 * that; `packages/tools/src/kanban-contract-actions.ts` is the agent half.
 *
 * Every mutation broadcasts the updated board so the open panels repaint,
 * matching how the other kanban write routes behave.
 */

import type { Context } from '@wrongstack/core/agent';
import {
  addContractEdge,
  configureContractGraph,
  evaluateTaskContractGraph,
  getContractGraph,
  type KanbanContractEdgeType,
  type KanbanContractEnforcement,
  type KanbanContractGraphEnforcement,
  type KanbanContractNodeKind,
  type KanbanContractNodeState,
  removeContractEdge,
  removeContractNode,
  upsertContractNode,
} from '@wrongstack/kanban';
import type { WebSocket } from 'ws';
import { publishKanbanBoard } from './kanban-broadcast.js';
import { activityContext, fail, ok } from './kanban-route-helpers.js';
import type { WSServerMessage } from './types.js';

export interface KanbanContractRouteContext {
  projectRoot: string;
  context?: Context | undefined;
  /** Tab that sent the request — the session every emitted event belongs to. */
  requestSessionId?: string | undefined;
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
}

export async function handleKanbanContractRoute(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanContractRouteContext,
): Promise<boolean> {
  switch (type) {
    case 'kanban.contract.get':
      await handleGet(ws, type, payload, ctx);
      return true;
    case 'kanban.contract.configure':
      await handleConfigure(ws, type, payload, ctx);
      return true;
    case 'kanban.contract.node.upsert':
      await handleNodeUpsert(ws, type, payload, ctx);
      return true;
    case 'kanban.contract.node.remove':
      await handleNodeRemove(ws, type, payload, ctx);
      return true;
    case 'kanban.contract.edge.add':
      await handleEdgeAdd(ws, type, payload, ctx);
      return true;
    case 'kanban.contract.edge.remove':
      await handleEdgeRemove(ws, type, payload, ctx);
      return true;
    default:
      return false;
  }
}

const str = (payload: Record<string, unknown> | undefined, key: string): string | undefined =>
  typeof payload?.[key] === 'string' ? (payload[key] as string) : undefined;

/**
 * Repaint every open panel after a map mutation. `broadcast` is optional on the
 * route context (the embedded host wires it, a bare test harness may not), so
 * the optional call is the contract rather than a missing dependency.
 */
async function publishBoard(
  ctx: KanbanContractRouteContext,
  board: Parameters<typeof publishKanbanBoard>[1],
): Promise<void> {
  await publishKanbanBoard((message) => ctx.broadcast?.(message), board);
}

async function handleGet(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanContractRouteContext,
): Promise<void> {
  const boardId = str(payload, 'boardId');
  if (!boardId) return fail(ws, type, 'boardId required');
  const found = await getContractGraph(ctx.projectRoot, boardId);
  if (!found) return fail(ws, type, 'Board not found');
  const taskId = str(payload, 'taskId');
  // A taskId narrows the answer to one card's closure, which is what the task
  // inspector panel asks for; without it the dashboard wants the whole map.
  const evaluated = taskId
    ? await evaluateTaskContractGraph(ctx.projectRoot, boardId, taskId)
    : null;
  if (taskId && !evaluated) return fail(ws, type, 'Task not found on this board');
  ok(ws, type, {
    boardId,
    graph: found.graph,
    ...(evaluated ? { evaluation: evaluated.evaluation } : {}),
  });
}

async function handleConfigure(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanContractRouteContext,
): Promise<void> {
  const boardId = str(payload, 'boardId');
  if (!boardId) return fail(ws, type, 'boardId required');
  const enforcement = (str(payload, 'enforcement') ?? 'advisory') as KanbanContractGraphEnforcement;
  const board = await configureContractGraph(
    ctx.projectRoot,
    boardId,
    enforcement,
    activityContext(ctx),
  );
  if (!board) return fail(ws, type, 'Board not found');
  await publishBoard(ctx, board);
  ok(ws, type, { boardId, graph: board.contractGraph ?? null });
}

async function handleNodeUpsert(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanContractRouteContext,
): Promise<void> {
  const boardId = str(payload, 'boardId');
  const taskId = str(payload, 'taskId');
  const kind = str(payload, 'kind') as KanbanContractNodeKind | undefined;
  const title = str(payload, 'title');
  if (!boardId || !taskId || !kind || !title) {
    return fail(ws, type, 'boardId, taskId, kind, and title required');
  }
  const state = str(payload, 'state') as KanbanContractNodeState | undefined;
  const waiverActor = str(payload, 'waiverActor');
  const waiverReason = str(payload, 'waiverReason');
  // The domain layer rejects a waived node without actor and reason; catch it
  // here so the panel gets a field-level message instead of a thrown error.
  if (state === 'waived' && (!waiverActor?.trim() || !waiverReason?.trim())) {
    return fail(ws, type, 'A waived contract node requires waiverActor and waiverReason');
  }
  try {
    const result = await upsertContractNode(
      ctx.projectRoot,
      boardId,
      {
        taskId,
        kind,
        title,
        ...(str(payload, 'nodeId') !== undefined ? { id: str(payload, 'nodeId')! } : {}),
        ...(str(payload, 'description') !== undefined
          ? { description: str(payload, 'description')! }
          : {}),
        ...(state !== undefined ? { state } : {}),
        ...(str(payload, 'enforcement') !== undefined
          ? { enforcement: str(payload, 'enforcement') as KanbanContractEnforcement }
          : {}),
        ...(str(payload, 'checkId') !== undefined ? { checkId: str(payload, 'checkId')! } : {}),
        ...(str(payload, 'metricId') !== undefined ? { metricId: str(payload, 'metricId')! } : {}),
        ...(state === 'waived'
          ? {
              waiver: {
                actor: waiverActor!,
                reason: waiverReason!,
                at: new Date().toISOString(),
              },
            }
          : {}),
        ...(str(payload, 'createdBy') !== undefined
          ? { createdBy: str(payload, 'createdBy')! }
          : { createdBy: 'webui' }),
      },
      activityContext(ctx),
    );
    if (!result) return fail(ws, type, 'Board or task not found');
    await publishBoard(ctx, result.board);
    ok(ws, type, { boardId, node: result.node, graph: result.board.contractGraph ?? null });
  } catch (err) {
    // Binding and waiver validation throw with an actionable message
    // (unknown checkId, node moved to another task, …) — pass it through
    // rather than flattening it to a generic failure.
    fail(ws, type, err instanceof Error ? err.message : String(err));
  }
}

async function handleNodeRemove(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanContractRouteContext,
): Promise<void> {
  const boardId = str(payload, 'boardId');
  const nodeId = str(payload, 'nodeId');
  if (!boardId || !nodeId) return fail(ws, type, 'boardId and nodeId required');
  const board = await removeContractNode(ctx.projectRoot, boardId, nodeId, activityContext(ctx));
  if (!board) return fail(ws, type, 'Contract node not found');
  await publishBoard(ctx, board);
  ok(ws, type, { boardId, graph: board.contractGraph ?? null });
}

async function handleEdgeAdd(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanContractRouteContext,
): Promise<void> {
  const boardId = str(payload, 'boardId');
  const from = str(payload, 'from');
  const to = str(payload, 'to');
  const edgeType = str(payload, 'edgeType') as KanbanContractEdgeType | undefined;
  if (!boardId || !from || !to || !edgeType) {
    return fail(ws, type, 'boardId, from, to, and edgeType required');
  }
  try {
    const result = await addContractEdge(
      ctx.projectRoot,
      boardId,
      {
        from,
        to,
        type: edgeType,
        ...(str(payload, 'enforcement') !== undefined
          ? { enforcement: str(payload, 'enforcement') as KanbanContractEnforcement }
          : {}),
        ...(str(payload, 'rationale') !== undefined
          ? { rationale: str(payload, 'rationale')! }
          : {}),
        createdBy: str(payload, 'createdBy') ?? 'webui',
      },
      activityContext(ctx),
    );
    if (!result) return fail(ws, type, 'Board not found');
    await publishBoard(ctx, result.board);
    ok(ws, type, { boardId, edge: result.edge, graph: result.board.contractGraph ?? null });
  } catch (err) {
    // Unknown endpoint and self-edge are user-fixable; say which.
    fail(ws, type, err instanceof Error ? err.message : String(err));
  }
}

async function handleEdgeRemove(
  ws: WebSocket,
  type: string,
  payload: Record<string, unknown> | undefined,
  ctx: KanbanContractRouteContext,
): Promise<void> {
  const boardId = str(payload, 'boardId');
  const edgeId = str(payload, 'edgeId');
  if (!boardId || !edgeId) return fail(ws, type, 'boardId and edgeId required');
  const board = await removeContractEdge(ctx.projectRoot, boardId, edgeId, activityContext(ctx));
  if (!board) return fail(ws, type, 'Contract edge not found');
  await publishBoard(ctx, board);
  ok(ws, type, { boardId, graph: board.contractGraph ?? null });
}
