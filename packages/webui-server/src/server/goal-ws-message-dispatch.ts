import { PhaseOrchestrator } from '@wrongstack/goal';
import type { WebSocket } from 'ws';
import type { GoalWSMessage, GoalWsHandlerInternals } from './goal-ws-handler-internals.js';

/**
 * Per-Goal message dispatch for `GoalWebSocketHandler`: runs one `goal.*`
 * control message against the handler that owns the Goal (after the
 * multi-Goal router has resolved which handler that is).
 */
export async function dispatchGoalMessage(
  host: GoalWsHandlerInternals,
  ws: WebSocket,
  msg: GoalWSMessage,
): Promise<void> {
  switch (msg.type) {
    case 'goal.assess':
      await host.handleAssess(ws, msg.payload);
      break;
    case 'goal.start':
      await host.handleStart(msg.payload);
      break;
    case 'goal.pause':
      host.orchestrator?.pause();
      if (host.orchestrator) {
        host.runStatus = 'paused';
        if (host.graph) {
          host.graph.runState = 'paused';
          host.persistDetached(host.graph);
        }
      }
      host.broadcast({ type: 'goal.paused', payload: {} });
      if (host.orchestrator) host.broadcastState();
      break;
    case 'goal.resume':
      if (host.orchestrator && host.runStatus === 'paused') {
        host.orchestrator.resume();
        host.runStatus = 'running';
        if (host.graph) {
          host.graph.runState = 'running';
          host.persistDetached(host.graph);
        }
        host.broadcast({ type: 'goal.resumed', payload: {} });
        host.broadcastState();
      } else {
        const graphId =
          typeof msg.payload?.graphId === 'string' ? msg.payload.graphId : host.graph?.id;
        if (graphId) await host.handleResumeGraph(graphId);
        else
          host.broadcast({
            type: 'goal.error',
            payload: { message: 'No saved Goal to resume.' },
          });
      }
      break;
    case 'goal.stop':
      await host.handleStop();
      break;
    case 'goal.clear':
      await host.handleClear();
      break;
    case 'goal.revert':
      await host.handleRevert();
      break;
    case 'goal.status':
      host.broadcastState();
      break;
    case 'goal.selectPhase': {
      const phaseId = msg.payload?.phaseId as string;
      if (phaseId && host.graph) {
        host.broadcastState(phaseId);
      }
      break;
    }
    case 'goal.taskStatus': {
      // Coerce instead of destructuring `msg.payload` directly: a payload-less
      // frame must reach the handler's own validation/error framing (undefined
      // fields → "Invalid task status" error frame, no mutation) rather than
      // dying in a TypeError that the dispatch layer reports only as a
      // generic `message_handler_failed` log.
      const { taskId, status } = (msg.payload ?? {}) as { taskId: string; status: string };
      await handleTaskStatusChange(host, taskId, status);
      break;
    }
    case 'goal.moveTask': {
      const { taskId, toPhaseId } = (msg.payload ?? {}) as { taskId: string; toPhaseId: string };
      if (host.orchestrator?.moveTask(taskId, toPhaseId)) host.afterBoardMutation();
      break;
    }
    case 'goal.assignTask': {
      const { taskId, agentId, agentName } = (msg.payload ?? {}) as {
        taskId: string;
        agentId?: string;
        agentName?: string;
      };
      if (host.orchestrator?.setTaskAssignee(taskId, agentId, agentName)) host.afterBoardMutation();
      break;
    }
    case 'goal.addTask': {
      const { phaseId, title, description, type, priority } = (msg.payload ?? {}) as {
        phaseId: string;
        title: string;
        description?: string;
        type?: import('@wrongstack/contracts/types').TaskNode['type'];
        priority?: import('@wrongstack/contracts/types').TaskNode['priority'];
      };
      if (
        title?.trim() &&
        host.orchestrator?.addTask(phaseId, { title: title.trim(), description, type, priority })
      ) {
        host.afterBoardMutation();
      }
      break;
    }
    case 'goal.retryTask':
    case 'goal.runTask': {
      const { taskId } = (msg.payload ?? {}) as { taskId: string };
      const editor =
        host.orchestrator ??
        (host.graph
          ? new PhaseOrchestrator({ graph: host.graph, ctx: { executeTask: async () => {} } })
          : null);
      if (editor?.requeueTask(taskId)) host.afterBoardMutation();
      break;
    }
    case 'goal.save': {
      if (host.graph) {
        await host.persistence.save(host.graph);
        host.broadcast({ type: 'goal.saved', payload: { graphId: host.graph.id } });
      }
      break;
    }
    case 'goal.list': {
      const graphs = await host.store.list();
      host.broadcast({ type: 'goal.list', payload: { graphs } });
      break;
    }
    case 'goal.load':
      await handleLoad(host, msg);
      break;
  }
}

async function handleLoad(host: GoalWsHandlerInternals, msg: GoalWSMessage): Promise<void> {
  if (
    host.startInFlight ||
    host.runPromise ||
    host.runStatus === 'running' ||
    host.runStatus === 'paused'
  ) {
    host.broadcast({
      type: 'goal.error',
      payload: { message: 'Stop the active Goal run before loading another board.' },
    });
    return;
  }
  let graphId = msg.payload?.graphId as string | undefined;
  if (!graphId) {
    const query = typeof msg.payload?.query === 'string' ? msg.payload.query.trim() : '';
    const graphs = await host.store.list();
    graphId = query
      ? graphs.find((entry) => entry.title.toLowerCase().includes(query.toLowerCase()))?.id
      : graphs[0]?.id;
    if (!graphId) {
      host.broadcast({
        type: 'goal.error',
        payload: { message: query ? `No saved Goal matches "${query}".` : 'No saved Goals.' },
      });
      return;
    }
  }
  if (graphId) {
    const graph = await host.store.load(graphId);
    if (graph) {
      host.orchestrator = null;
      host.graph = graph;
      host.runStatus =
        graph.finalVerification?.status === 'failed' || graph.failedPhaseIds.length > 0
          ? 'failed'
          : graph.completedAt ||
              Array.from(graph.phases.values()).every(
                (phase) => phase.status === 'completed' || phase.status === 'skipped',
              )
            ? 'completed'
            : 'stopped';
      host.broadcast({ type: 'goal.state', payload: host.buildState() });
      if (msg.payload?.resume === true) await host.handleResumeGraph(graph.id);
    } else {
      host.broadcast({
        type: 'goal.error',
        payload: { message: `Graph not found: ${graphId}` },
      });
    }
  }
}

async function handleTaskStatusChange(
  host: GoalWsHandlerInternals,
  taskId: string,
  status: string,
): Promise<void> {
  if (!host.graph) return;
  const allowed = new Set(['pending', 'in_progress', 'blocked', 'failed', 'review', 'completed']);
  if (!allowed.has(status)) {
    host.broadcast({
      type: 'goal.error',
      payload: { message: `Invalid task status: ${status}` },
    });
    return;
  }

  for (const phase of host.graph.phases.values()) {
    const task = phase.taskGraph.nodes.get(taskId);
    if (task) {
      task.status = status as import('@wrongstack/contracts/types').TaskStatus;
      task.updatedAt = Date.now();
      host.graph.updatedAt = Date.now();
      await host.persistence.save(host.graph);
      host.broadcastState();
      return;
    }
  }
}
