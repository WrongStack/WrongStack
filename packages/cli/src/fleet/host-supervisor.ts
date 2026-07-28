import { randomUUID } from 'node:crypto';
import {
  dispatchAgent,
  FleetSupervisor,
  getSharedProjectMailbox,
  mailboxSessionTag,
  type Director,
} from '@wrongstack/core/coordination';
import type { EventBus } from '@wrongstack/core/kernel';
import type { Config, SubagentConfig } from '@wrongstack/core/types';
import { toErrorMessage } from '@wrongstack/core/utils/error';
import type { MultiAgentHostOptions } from './host-types.js';
import { setActiveFleetSupervisor } from './supervisor-registry.js';

export interface HostFleetSupervisorInput {
  director: Director | undefined;
  brain: MultiAgentHostOptions['brain'];
  supervisorConfig: NonNullable<Config['fleet']>['supervisor'] | undefined;
  events: EventBus;
  sessionId: string;
  mailboxProjectDir: string;
  roster: Record<string, SubagentConfig>;
  getLeaderMailboxId?: (() => string | undefined) | undefined;
}

export function createHostFleetSupervisor(input: HostFleetSupervisorInput): FleetSupervisor | null {
  const {
    director,
    brain,
    supervisorConfig,
    events,
    sessionId,
    mailboxProjectDir,
    roster,
    getLeaderMailboxId,
  } = input;
  if (!director || !brain || supervisorConfig?.enabled === false) return null;
  const supTag = () => mailboxSessionTag(sessionId);
  const mailbox = () => getSharedProjectMailbox(mailboxProjectDir, events);
  const supervisor = new FleetSupervisor({
    events,
    fleet: director.fleet,
    brain,
    sessionId: () => sessionId,
    config: supervisorConfig,
    source: {
      subagents: () => director.status().subagents,
      listPendingTasks: () => director.listPendingTasks(),
      isWorkComplete: () => director.isWorkComplete(),
    },
    actions: {
      retargetPendingTask: (taskId, subagentId) =>
        director.retargetPendingTask(taskId, subagentId),
      spawnHelper: async ({ reason, task }) => {
        try {
          const routed = await dispatchAgent(task?.description ?? reason, {
            classifier: director.dispatchClassifier,
          });
          const template = roster[routed.role] ?? roster['executor'];
          const helperPrompt = [
            template?.prompt,
            `You are a helper worker spawned by the fleet supervisor to drain a task backlog (${reason}). Complete the assigned task efficiently and report a concise, evidence-backed result.`,
          ]
            .filter((part): part is string => typeof part === 'string' && part.trim().length > 0)
            .join('\n\n');
          const subagentId = await director.spawn({
            ...(template ?? { name: 'fleet helper', role: 'executor' }),
            id: `helper-${randomUUID().slice(0, 8)}`,
            name: `fleet helper (${routed.role})`,
            role: routed.role,
            systemPromptOverride: helperPrompt,
          });
          return { subagentId };
        } catch (err) {
          return { error: toErrorMessage(err) };
        }
      },
      steerAgent: async (subagentId, subject, body) => {
        await mailbox().send({
          from: `supervisor@${supTag()}`,
          to: `${subagentId}@${supTag()}`,
          type: 'steer',
          subject,
          body,
          priority: 'high',
        });
      },
      notifyLeader: async (subject, body) => {
        const leaderId = getLeaderMailboxId?.() ?? `leader@${supTag()}`;
        await mailbox().send({
          from: `supervisor@${supTag()}`,
          to: leaderId,
          type: 'status',
          subject,
          body,
          priority: 'normal',
        });
      },
      terminate: (subagentId) => director.terminate(subagentId),
    },
  });
  supervisor.start();
  setActiveFleetSupervisor(supervisor);
  return supervisor;
}
