import type { Agent } from '@wrongstack/core/agent';
import type { AgentFactory, BrainArbiter } from '@wrongstack/core/coordination';
import type { Config, SkillLoader } from '@wrongstack/core/types';
import type { PhaseTemplate } from '@wrongstack/core/goal';
import type { EventBus } from '@wrongstack/core/kernel';
import { PhaseGraphBuilder } from '@wrongstack/core/goal';
import { resolveWstackPaths } from '@wrongstack/core/utils';
import { exportBoardToTaskGraph } from '@wrongstack/kanban';
import {
  type GoalWebSocketHandler,
  type KanbanHostRouteHandlers,
  startSddRunFromGraph,
  type WSServerMessage,
} from '@wrongstack/webui-server';
import type { WebSocket } from 'ws';
import type { KanbanSupervisor } from './kanban-supervisor.js';

export type KanbanSupervisorPort = KanbanSupervisor;

interface CliKanbanHostAdapterDeps {
  opts: {
    agent: Agent;
    events: EventBus;
    projectRoot?: string | undefined;
    appConfig?: Config | undefined;
    skillLoader?: SkillLoader | undefined;
    sddSubagentFactory?: AgentFactory | undefined;
    brain?: BrainArbiter | undefined;
  };
  send: (ws: WebSocket, msg: WSServerMessage) => void;
  goalHandler: GoalWebSocketHandler;
  kanbanSupervisor?: KanbanSupervisorPort | undefined;
}

export function createCliKanbanHostRoutes(deps: CliKanbanHostAdapterDeps): KanbanHostRouteHandlers {
  const { opts, send, goalHandler } = deps;
  return {
    meta: async (ws) => {
      const tools = (opts.agent.ctx.tools ?? []).map((tool) => ({
        name: tool.name,
        description: (tool as { description?: string }).description ?? '',
      }));
      const skills = opts.skillLoader
        ? (await opts.skillLoader.list()).map((skill) => ({
            name: skill.name,
            description: skill.description,
            source: skill.source,
          }))
        : [];
      send(ws, {
        type: 'kanban.meta',
        payload: {
          success: true,
          data: {
            tools,
            skills,
            fallbackProfiles: opts.appConfig?.fallbackProfiles ?? {},
            sessionProvider: opts.agent.ctx.provider,
            sessionModel: opts.agent.ctx.model,
          },
        },
      });
    },
    supervisorStatus: async (ws, msg) => {
      const boardId = (msg.payload as { boardId?: string } | undefined)?.boardId;
      if (!boardId || !deps.kanbanSupervisor) {
        send(ws, {
          type: 'kanban.supervisor.status',
          payload: { success: false, error: 'Kanban supervisor is unavailable.' },
        });
        return;
      }
      const snapshot =
        deps.kanbanSupervisor.getSnapshot(boardId) ??
        (await deps.kanbanSupervisor.auditNow(boardId))[0];
      send(ws, {
        type: 'kanban.supervisor.status',
        payload: { success: true, data: snapshot ?? null },
      });
    },
    supervisorAudit: async (ws, msg) => {
      const boardId = (msg.payload as { boardId?: string } | undefined)?.boardId;
      if (!deps.kanbanSupervisor) {
        send(ws, {
          type: 'kanban.supervisor.audit',
          payload: { success: false, error: 'Kanban supervisor is unavailable.' },
        });
        return;
      }
      const snapshots = await deps.kanbanSupervisor.auditNow(boardId);
      send(ws, {
        type: 'kanban.supervisor.audit',
        payload: { success: true, data: boardId ? (snapshots[0] ?? null) : snapshots },
      });
    },
    runStart: async (ws, msg) => {
      const payload = (msg.payload ?? {}) as {
        boardId?: string;
        engine?: string;
        autonomous?: boolean;
      };
      const boardId = payload.boardId;
      const engine =
        payload.engine === 'goal' ? 'goal' : payload.engine === 'sdd' ? 'sdd' : undefined;
      const projectRoot = opts.projectRoot ?? '';
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
          await goalHandler.handleMessage(ws, {
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
        if (!opts.sddSubagentFactory) {
          return failRun('SDD runs need the multi-agent host, which is not available here.');
        }
        const paths = resolveWstackPaths({ projectRoot });
        const handle = await startSddRunFromGraph(
          exported.graph,
          {
            agent: opts.agent,
            events: opts.events,
            projectRoot,
            subagentFactory: opts.sddSubagentFactory,
            projectSddBoards: paths.projectSddBoards,
            ...(opts.brain ? { brain: opts.brain } : {}),
          },
          { worktrees: true },
        );
        void handle.completion.catch(() => {});
        send(ws, {
          type: 'kanban.run.start',
          payload: { success: true, data: { engine: 'sdd', boardId, runId: handle.runId } },
        });
      } catch (err) {
        failRun(err instanceof Error ? err.message : String(err));
      }
    },
  };
}
