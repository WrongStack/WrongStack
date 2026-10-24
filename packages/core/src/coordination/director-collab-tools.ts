import { promises as fsp } from 'node:fs';
import * as path from 'node:path';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { Tool } from '@wrongstack/contracts/types/tool';
import { ToolCapabilities } from '../security/capabilities.js';
import { toErrorMessage } from '../utils/error.js';
import { expandGlob } from '../utils/glob-expand.js';
import { type CollabSessionOptions, resolveCollabTargetInsideRoot } from './collab-debug.js';
import type * as Host from './director-host-contracts.js';
import { validateFleetEventEmission } from './fleet-event-validation.js';

/**
 * Whether any target is a readable file the session is allowed to read, plus
 * the targets refused by project-root confinement.
 *
 * The confinement check runs here as well as at the read site: without it this
 * probe still answers "does this out-of-root file exist?" for any path the
 * model names — an existence oracle that survives refusing the read itself.
 */
async function anyReadableTarget(
  targetPaths: readonly string[],
  projectRoot: string | undefined,
  allowOutsideProjectRoot: boolean | undefined,
): Promise<{ readable: boolean; refused: string[] }> {
  let readable = false;
  const refused: string[] = [];
  for (const pattern of targetPaths) {
    for (const file of await expandGlob(pattern)) {
      const resolved = await resolveCollabTargetInsideRoot(
        file,
        projectRoot,
        allowOutsideProjectRoot,
      );
      if (resolved === null) {
        refused.push(file);
        continue;
      }
      if (readable) continue;
      const stat = await fsp.stat(resolved).catch(() => undefined);
      if (stat?.isFile()) readable = true;
    }
  }
  return { readable, refused };
}

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
    // FS_READ is declared alongside SUBAGENT_SPAWN because this tool really does
    // read files. Without it, capability allowlists and `isSensitiveReadCall`
    // (which gates on FS_READ or a read-tool name) could not see the read at all
    // (WS-2026-09-17-01).
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN, ToolCapabilities.FS_READ],
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
    async execute(input: unknown, ctx) {
      const i = input as {
        targetPaths?: string[] | undefined;
        timeoutMs?: number | undefined;
        maxTargetFiles?: number | undefined;
        contextWindow?: number | undefined;
      };
      if (!i.targetPaths?.length) {
        throw new ToolValidationError({
          message: 'collab_debug: targetPaths is required and must be non-empty.',
          field: 'targetPaths',
        });
      }
      // Carried into the session so the confinement is enforced at the read
      // site too; this tool never saw `ctx` at all before (WS-2026-09-17-01).
      const projectRoot = ctx?.projectRoot;
      const allowOutsideProjectRoot = ctx?.allowOutsideProjectRoot;
      // Relative targets mean what they mean to every other file tool: the
      // session's working directory, not this process's cwd (they differ
      // after a `cd`, in a worktree subagent, or in a multi-session host).
      const base = ctx?.workingDir ?? ctx?.cwd ?? projectRoot;
      const targetPaths = base
        ? i.targetPaths.map((p) => (path.isAbsolute(p) ? p : path.join(base, p)))
        : i.targetPaths;
      const { readable, refused } = await anyReadableTarget(
        targetPaths,
        projectRoot,
        allowOutsideProjectRoot,
      );
      if (refused.length > 0) {
        const shown = refused.slice(0, 3).join(', ');
        throw new ToolValidationError({
          message:
            `collab_debug: refusing ${refused.length} target(s) outside the project root ` +
            `(${shown}${refused.length > 3 ? ', …' : ''}). Targets must stay inside ` +
            `${projectRoot} while tools.restrictToProjectRoot is enabled.`,
          field: 'targetPaths',
        });
      }
      // Unreadable targets enter the snapshot as empty files, so a session
      // over nothing but missing paths reported `approve` with zero bugs.
      if (!readable) {
        throw new ToolValidationError({
          message: `collab_debug: no readable file matches targetPaths (${i.targetPaths.join(', ')}).`,
          field: 'targetPaths',
        });
      }
      const options: CollabSessionOptions = {
        targetPaths,
        timeoutMs: i.timeoutMs,
        maxTargetFiles: i.maxTargetFiles,
        contextWindow: i.contextWindow,
        projectRoot,
        allowOutsideProjectRoot,
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
        throw new Error(`collab_debug failed: ${toErrorMessage(err)}`, { cause: err });
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
      if (validationError) {
        throw new ToolValidationError({ message: validationError, field: 'payload' });
      }
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
      'Until the next user request, spawn_subagent and delegate refuse and assign_task ' +
      'instantly completes any queued tasks as aborted. Running subagents finish naturally. ' +
      'Call it last: the fleet reopens only when a new request starts. ' +
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
