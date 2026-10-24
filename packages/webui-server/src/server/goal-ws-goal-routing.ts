import { summarizeGoal } from '@wrongstack/goal';
import { toErrorMessage } from '@wrongstack/core/utils';
import type { WebSocket } from 'ws';
import type { GoalWSMessage, GoalWsHandlerInternals } from './goal-ws-handler-internals.js';

/**
 * Multi-Goal routing for the root (catalog) `GoalWebSocketHandler`: resolves
 * the Goal a message targets (explicit `goalId` or the socket's selection),
 * lazily creates/loads its per-Goal handler, enforces the ownership and
 * concurrency guards, and forwards the message. Returns `true` when the
 * message was routed (or rejected) here, `false` when the root handler
 * should dispatch it itself.
 */
export async function routeToSelectedGoal(
  host: GoalWsHandlerInternals,
  ws: WebSocket,
  msg: GoalWSMessage,
  createGoal: (goalId: string) => GoalWsHandlerInternals,
): Promise<boolean> {
  const requestedId = typeof msg.payload?.goalId === 'string' ? msg.payload.goalId : undefined;
  const selectedId = requestedId ?? host.selections.get(ws);
  if (!selectedId || msg.type === 'goal.assess') return false;
  if (!/^[a-zA-Z0-9_-]{1,200}$/.test(selectedId)) throw new Error('Invalid Goal id.');
  let goal = host.goals.get(selectedId);
  let requestGeneration = goal?.stopGeneration ?? 0;
  if (!goal) {
    if (host.goals.size >= 64) {
      const unused = [...host.goals].find(([, entry]) => !entry.startInFlight && !entry.runPromise);
      if (unused) {
        unused[1].dispose();
        host.goals.delete(unused[0]);
      }
    }
    if (msg.type === 'goal.start' && !host.taskAgentFactory)
      throw new Error('Concurrent Goals require isolated worker agents.');
    const live = [...host.goals.values()].filter(
      (entry) => entry.startInFlight || entry.runPromise || !entry.graph,
    );
    if (msg.type === 'goal.start' && live.length >= 8)
      throw new Error(
        'Eight Goals are already active in this server. Stop one before starting another.',
      );
    goal = createGoal(selectedId);
    host.goals.set(selectedId, goal);
    requestGeneration = goal.stopGeneration;
    for (const client of host.clients) goal.addClient(client.ws);
    if (msg.type !== 'goal.start') {
      const graph = await host.store.load(selectedId);
      if (!graph) throw new Error(`Goal not found: ${selectedId}`);
      goal.graph = graph;
      goal.runStatus = graph.completedAt
        ? 'completed'
        : graph.runState === 'failed'
          ? 'failed'
          : 'stopped';
    } else if (await host.store.load(selectedId)) {
      host.goals.delete(selectedId);
      goal.dispose();
      throw new Error('This Goal id already exists. Resume it or start a new id.');
    }
  }
  if (msg.type === 'goal.start' && goal.stopGeneration !== requestGeneration) {
    goal.broadcast({ type: 'goal.stopped', payload: {} });
    return true;
  }
  host.selections.set(ws, selectedId);
  if (msg.type === 'goal.start' && goal.graph) {
    goal.broadcast({
      type: 'goal.error',
      payload: {
        message: 'This Goal already exists. Resume it or start a new id.',
        controlOnly: true,
      },
    });
    return true;
  }
  if (
    goal.graph &&
    !goal.releaseRunLease &&
    ['goal.status', 'goal.selectPhase'].includes(msg.type)
  ) {
    const latest = await host.store.load(selectedId);
    if (latest) goal.graph = latest;
    const owner = await host.store.goalRunOwner(goal.graph);
    goal.readOnly = Boolean(owner);
    const status = summarizeGoal(goal.graph, owner).status;
    goal.runStatus = status === 'pending' || status === 'planning' ? 'stopped' : status;
  }
  if (
    goal.graph &&
    !goal.releaseRunLease &&
    !['goal.status', 'goal.list', 'goal.selectPhase'].includes(msg.type)
  ) {
    const owner = await host.store.goalRunOwner(goal.graph);
    if (owner) {
      goal.broadcast({
        type: 'goal.error',
        payload: {
          message: `This Goal is owned by ${owner}. Control it in its owning terminal.`,
          controlOnly: true,
        },
      });
      return true;
    }
  }
  await goal.handleMessage(ws, msg);
  await host.broadcastCatalog();
  return true;
}

/** Broadcast the saved-graph list plus live Goal summaries to every client. */
export async function broadcastGoalCatalog(host: GoalWsHandlerInternals): Promise<void> {
  if (host.catalogInFlight) return;
  host.catalogInFlight = true;
  try {
    const graphs = await host.store.list();
    const goals = await host.store.listGoals();
    for (const [id, handler] of host.goals) {
      if (!handler.graph || (!handler.runPromise && !handler.startInFlight)) continue;
      const summary = summarizeGoal(
        handler.graph,
        handler.runPromise || handler.startInFlight ? `webui:${process.pid}:${id}` : null,
      );
      const index = goals.findIndex((entry) => entry.id === id);
      if (index >= 0) goals[index] = summary;
      else goals.unshift(summary);
    }
    host.broadcast({ type: 'goal.list', payload: { graphs, goals } });
  } catch (err) {
    host.logger.warn(`[Goal] Catalog refresh failed: ${toErrorMessage(err)}`);
  } finally {
    host.catalogInFlight = false;
  }
}
