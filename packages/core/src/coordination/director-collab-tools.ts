import { ToolCapabilities } from '../security/capabilities.js';
import type { Tool } from '../types/tool.js';
import { toErrorMessage } from '../utils/error.js';
import type { CollabSessionOptions } from './collab-debug.js';
import type * as Host from './director-host-contracts.js';
import { validateFleetEventEmission } from './fleet-event-validation.js';

export function makeCollabDebugTool(director: Host.DirectorCollabPort): Tool {
  return {
    name: 'collab_debug',
    description:
      'Start a collaborative debugging session: BugHunter, RefactorPlanner, and Critic ' +
      'run in parallel on the same target files. BugHunter finds bugs and emits bug.found events. ' +
      'RefactorPlanner listens for bug.found and emits refactor.plan events. ' +
      'Critic evaluates both and emits critic.evaluation events. ' +
      'Returns a structured report with overall verdict (approve / needs_revision / reject).',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: {
      type: 'object',
      properties: {
        targetPaths: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths / glob patterns to scan for bugs.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description: 'Timeout in ms. Default: 600000 (10 minutes).',
        },
        maxTargetFiles: {
          type: 'number',
          minimum: 1,
          description:
            'Maximum number of files to include in the snapshot. ' +
            'If not set, the limit is computed dynamically from contextWindow ' +
            'or falls back to the default (30).',
        },
        contextWindow: {
          type: 'number',
          minimum: 1,
          description:
            'Context window size (tokens) of the model. When provided and ' +
            'maxTargetFiles is not set, the file limit is computed dynamically ' +
            'as floor((contextWindow * 0.4) / 2000).',
        },
      },
      required: ['targetPaths'],
    },
    async execute(input: unknown) {
      const i = input as {
        targetPaths?: string[] | undefined;
        timeoutMs?: number | undefined;
        maxTargetFiles?: number | undefined;
        contextWindow?: number | undefined;
      };
      if (!i.targetPaths?.length) {
        return { error: 'collab_debug: targetPaths is required and must be non-empty.' };
      }
      const options: CollabSessionOptions = {
        targetPaths: i.targetPaths,
        timeoutMs: i.timeoutMs,
        maxTargetFiles: i.maxTargetFiles,
        contextWindow: i.contextWindow,
      };
      try {
        const report = await director.spawnCollab(options);
        return {
          sessionId: report.sessionId,
          overallVerdict: report.overallVerdict,
          bugCount: report.bugs.length,
          planCount: report.refactorPlans.length,
          evaluationCount: report.evaluations.length,
          summary: report.summary,
          bugs: report.bugs,
          refactorPlans: report.refactorPlans,
          evaluations: report.evaluations,
        };
      } catch (err) {
        return { error: 'collab_debug failed: ' + toErrorMessage(err) };
      }
    },
  };
}

export function makeFleetEmitTool(director: Host.DirectorPublishingPort): Tool {
  return {
    name: 'fleet_emit',
    description:
      'Emit a structured event on the FleetBus. Known collaboration events are schema-validated and role-bound; custom event types remain extensible. Use it to stream findings, progress updates, or final results to other agents in real time.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_EMIT],
    inputSchema: {
      type: 'object',
      properties: {
        type: {
          type: 'string',
          description:
            'Event type string (e.g. bug.found, refactor.plan, critic.evaluation, progress, result).',
        },
        payload: {
          type: 'object',
          description: 'Event payload. Structure depends on event type. Use null if no payload.',
        },
      },
      required: ['type'],
    },
    async execute(input: unknown, ctx) {
      const i = input as { type: string; payload?: Record<string, unknown> | null };
      const role = ctx.meta['agentRole'] as string | undefined;
      const validationError = validateFleetEventEmission(i.type, i.payload ?? {}, role);
      if (validationError) return { ok: false, error: validationError };
      const callerId = ctx.agentId && ctx.agentId !== 'unknown' ? ctx.agentId : director.id;
      const taskId = ctx.meta['subagentTaskId'] as string | undefined;
      director.fleet.emit({
        subagentId: callerId,
        taskId,
        ts: Date.now(),
        type: i.type,
        payload: i.payload ?? {},
      });
      return { ok: true, event: i.type };
    },
  };
}

export function makeWorkCompleteTool(
  director: Pick<Host.DirectorLifecyclePort, 'workComplete'>,
): Tool {
  return {
    name: 'work_complete',
    description:
      'Signal that the director is satisfied with the results and the fleet should wind down. ' +
      'After calling this, spawn_subagent will refuse with a budget error and assign_task ' +
      'will instantly complete any queued tasks as aborted. Running subagents finish naturally. ' +
      'Call terminate_subagent separately to stop specific subagents immediately.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      director.workComplete();
      return { ok: true, message: 'Fleet wind-down signaled. No new spawns or task dispatches.' };
    },
  };
}
