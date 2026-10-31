import type { EventBus } from '@wrongstack/contracts/kernel';
import type { Config, SkillLoader } from '@wrongstack/contracts/types';
import type { AgentFactory, BrainArbiter } from '@wrongstack/coordination';
import type { Agent } from '@wrongstack/core/agent';
import {
  createKanbanRunStart,
  type GoalWebSocketHandler,
  type KanbanHostRouteHandlers,
  type KanbanRunMirror,
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
  /** Optional broadcast so every client sees sdd.run.started / kanban updates. */
  broadcast?: ((msg: WSServerMessage) => void) | undefined;
  goalHandler: GoalWebSocketHandler;
  kanbanSupervisor?: KanbanSupervisorPort | undefined;
  /** Bind launch-from-board SDD runs onto the existing kanban board. */
  kanbanRunMirror?: KanbanRunMirror | undefined;
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
    runStart: createKanbanRunStart({
      agent: opts.agent,
      events: opts.events,
      getProjectRoot: () => opts.projectRoot ?? '',
      goalHandler,
      kanbanRunMirror: deps.kanbanRunMirror,
      subagentFactory: opts.sddSubagentFactory,
      brain: opts.brain,
      send,
      broadcast: deps.broadcast,
    }),
  };
}
