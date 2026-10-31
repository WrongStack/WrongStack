/**
 * `kanban.run.start` — launch a board as a Goal or an SDD run. Shared by the CLI-hosted WebUI
 * and the standalone engine (the desktop's process), which answered "unavailable" before.
 *
 * The board is exported to a task graph that keeps the board's task ids, so the run mirror can
 * project the run back onto THIS board instead of creating a new one.
 */

import type { EventBus } from '@wrongstack/contracts/kernel';
import type { AgentFactory, BrainArbiter } from '@wrongstack/coordination';
import type { Agent } from '@wrongstack/core/agent';
import { resolveWstackPaths, toErrorMessage } from '@wrongstack/core/utils';
import { PhaseGraphBuilder, type PhaseTemplate } from '@wrongstack/goal';
import { exportBoardToTaskGraph } from '@wrongstack/kanban';
import { TaskGraphStore } from '@wrongstack/sdd';
import type { WebSocket } from 'ws';
import type { GoalWebSocketHandler } from './goal-ws-handler.js';
import type { KanbanRunMirror } from './kanban-run-mirror.js';
import { startSddRunFromGraph } from './sdd-wizard-wiring.js';
import type { WSClientMessage, WSServerMessage } from './types.js';

export interface KanbanRunStartDeps {
  agent: Agent;
  events: EventBus;
  /** The project the boards belong to; a run cannot start without one. */
  getProjectRoot: () => string;
  goalHandler: Pick<GoalWebSocketHandler, 'handleMessage'>;
  /** Binds the launched run onto the board it came from. */
  kanbanRunMirror?: Pick<KanbanRunMirror, 'bind' | 'bindGoalNext'> | undefined;
  /** SDD runs need worker agents; without a factory only Goal runs can start. */
  subagentFactory?: AgentFactory | undefined;
  brain?: BrainArbiter | undefined;
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  /** Every client sees `sdd.run.started` (the SDD hub switches tabs on it). */
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
}

export function createKanbanRunStart(
  deps: KanbanRunStartDeps,
): (ws: WebSocket, msg: WSClientMessage) => Promise<void> {
  const { send } = deps;
  let isolatedSeq = 0;
  /** Isolated read-only turn for the acceptance verifier and the supervisor splitter. */
  const factory = deps.subagentFactory;
  const runIsolatedTurn = factory
    ? async (prompt: string, name: string): Promise<string> => {
        const result = await factory({
          id: `sdd-kanban-${name.toLowerCase().replace(/\s+/g, '-')}-${isolatedSeq++}`,
          role: 'executor',
          name,
          disabledTools: ['delegate', 'write', 'edit', 'patch', 'bash', 'exec'],
          allowedCapabilities: ['fs.read', 'net.outbound'],
        });
        try {
          const res = await result.agent.run([{ type: 'text', text: prompt }]);
          return res.finalText ?? '';
        } finally {
          await result.dispose?.();
        }
      }
    : undefined;

  return async (ws, msg) => {
    const payload = (msg.payload ?? {}) as {
      boardId?: string;
      engine?: string;
      autonomous?: boolean;
    };
    const boardId = payload.boardId;
    const engine =
      payload.engine === 'goal' ? 'goal' : payload.engine === 'sdd' ? 'sdd' : undefined;
    const projectRoot = deps.getProjectRoot();
    const failRun = (error: string) =>
      send(ws, { type: 'kanban.run.start', payload: { success: false, error } });
    if (!boardId || !engine) return failRun('boardId and engine required');
    if (!projectRoot) return failRun('No project root');
    try {
      const exported = await exportBoardToTaskGraph(projectRoot, boardId, {
        preserveOriginTaskIds: true,
      });
      if (!exported) return failRun(`Board not found: ${boardId}`);
      if (exported.graph.nodes.size === 0) return failRun('Board has no tasks to run');
      if (engine === 'goal') {
        // Launch-from-board: the next Goal projection reuses THIS board for phase 0.
        deps.kanbanRunMirror?.bindGoalNext(boardId);
        const graph = await PhaseGraphBuilder.fromTaskGraph(exported.graph, {
          title: exported.board.title,
          description: exported.board.description ?? exported.board.title,
        });
        const phases: PhaseTemplate[] = Array.from(graph.phases.values()).map((phase) => ({
          name: phase.name,
          description: phase.description,
          priority: phase.priority,
          estimateHours: phase.estimateHours,
          parallelizable: phase.parallelizable,
          taskTemplates: Array.from(phase.taskGraph.nodes.values()).map((task) => ({
            title: task.title,
            description: task.description,
            type: task.type,
            priority: task.priority,
            estimateHours: task.estimateHours ?? 0,
            ...(task.tags ? { tags: task.tags } : {}),
          })),
        }));
        await deps.goalHandler.handleMessage(ws, {
          type: 'goal.start',
          payload: {
            title: exported.board.title,
            phases,
            autonomous: payload.autonomous ?? false,
          },
        });
        send(ws, {
          type: 'kanban.run.start',
          payload: { success: true, data: { engine: 'goal', boardId } },
        });
        return;
      }
      if (!factory) {
        return failRun('SDD runs need the multi-agent host, which is not available here.');
      }
      const paths = resolveWstackPaths({ projectRoot });
      const taskStore = new TaskGraphStore({ baseDir: paths.projectTaskGraphs });
      await taskStore.save(exported.graph);
      const handle = await startSddRunFromGraph(
        exported.graph,
        {
          agent: deps.agent,
          events: deps.events,
          projectRoot,
          subagentFactory: factory,
          projectSddBoards: paths.projectSddBoards,
          taskStore,
          ...(deps.brain ? { brain: deps.brain } : {}),
          ...(runIsolatedTurn ? { runIsolatedTurn } : {}),
        },
        { worktrees: true },
      );
      // The runId is known only now; the mirror binds it before the first snapshot lands.
      deps.kanbanRunMirror?.bind('sdd', handle.runId, boardId);
      void handle.completion.catch(() => {});
      const started = {
        type: 'sdd.run.started' as const,
        payload: { runId: handle.runId, graphId: exported.graph.id },
      };
      send(ws, started);
      deps.broadcast?.(started);
      send(ws, {
        type: 'kanban.run.start',
        payload: { success: true, data: { engine: 'sdd', boardId, runId: handle.runId } },
      });
    } catch (err) {
      failRun(toErrorMessage(err));
    }
  };
}
