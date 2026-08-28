import { randomUUID } from 'node:crypto';
import {
  type Director,
  dispatchAgent,
  FleetSupervisor,
  mailboxSessionTag,
  postSessionNote,
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
  /**
   * The conversation a worker belongs to, from the coordinator's spawn-time
   * stamp. The supervisor watches ONE fleet — that part is genuinely
   * process-wide — but everything it SAYS is addressed: a steer is delivered
   * through the session-note hub, which routes strictly by session, so a note
   * posted under the host's own session never reached a worker spawned by any
   * other tab, and the leader told about it was the wrong one.
   */
  sessionFor?: ((subagentId: string) => string) | undefined;
  mailboxProjectDir: string;
  roster: Record<string, SubagentConfig>;
  getLeaderMailboxId?: (() => string | undefined) | undefined;
}

export function createHostFleetSupervisor(input: HostFleetSupervisorInput): FleetSupervisor | null {
  const { director, brain, supervisorConfig, events, sessionId, roster } = input;
  if (!director || !brain || supervisorConfig?.enabled === false) return null;
  /** Owning conversation of a worker; the host session for fleet-wide notes. */
  const sessionOf = (subagentId?: string): string =>
    (subagentId ? input.sessionFor?.(subagentId) : undefined) ?? sessionId;
  const supTag = (sid: string) => mailboxSessionTag(sid);
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
      retargetPendingTask: (taskId, subagentId) => director.retargetPendingTask(taskId, subagentId),
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
            // The helper drains a specific backlog, so it belongs to whoever
            // owns that work — not to the tab this host booted with.
            originSessionId: sessionOf(task?.subagentId),
          });
          return { subagentId };
        } catch (err) {
          return { error: toErrorMessage(err) };
        }
      },
      steerAgent: async (subagentId, subject, body) => {
        const sid = sessionOf(subagentId);
        postSessionNote({
          sessionId: sid,
          from: `supervisor@${supTag(sid)}`,
          to: subagentId,
          kind: 'steer',
          subject,
          body,
          events,
        });
      },
      notifyLeader: async (subject, body, subagentId) => {
        const sid = sessionOf(subagentId);
        postSessionNote({
          sessionId: sid,
          from: `supervisor@${supTag(sid)}`,
          to: 'leader',
          kind: 'note',
          subject,
          body,
          events,
        });
      },
      terminate: (subagentId) => director.terminate(subagentId),
    },
  });
  supervisor.start();
  setActiveFleetSupervisor(supervisor);
  return supervisor;
}
