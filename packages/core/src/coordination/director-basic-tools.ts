import { randomUUID } from 'node:crypto';
import { ToolCapabilities } from '../security/capabilities.js';
import type { TaskSpec } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { toErrorMessage } from '../utils/error.js';
import type * as Host from './director-host-contracts.js';
import {
  composeBoundedTaskDescription,
  parseTaskBoundary,
  taskBoundarySchemaProperties,
} from './task-boundary.js';

export function makeAssignTool(director: Pick<Host.DirectorAssignmentPort, 'assign'>): Tool {
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      subagentId: { type: 'string', minLength: 1, description: 'Target subagent id. Required.' },
      description: {
        type: 'string',
        minLength: 1,
        description:
          'The objective in natural language — what you want this subagent to do. Pair it with the required `scope` and `outOfScope` boundary fields.',
      },
      ...taskBoundarySchemaProperties,
      maxToolCalls: {
        type: 'number',
        minimum: 1,
        description: 'Optional per-task tool-call budget override.',
      },
      timeoutMs: { type: 'number', minimum: 1, description: 'Optional per-task timeout in ms.' },
    },
    required: ['subagentId', 'description', 'scope', 'outOfScope'],
  };
  return {
    name: 'assign_task',
    description:
      'Queue a task on a previously spawned subagent. NON-BLOCKING: returns a `taskId` IMMEDIATELY — the subagent processes the task on its next iteration with its own LLM budget. The `taskId` is the durable handle for retrieving the result later via `await_tasks`, `roll_up`, or `ask_result`. Every assignment MUST carry an explicit boundary: `scope` (what the work covers) and `outOfScope` (at least one concrete non-goal) — the call is rejected without them, and the worker treats the rendered boundary block as a hard contract. Many `assign_task` calls can be in flight in parallel against the same or different subagents. This is the primary tool for fan-out work; do NOT use `delegate` to spawn multiple investigations sequentially.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema,
    async execute(input: unknown) {
      const i = input as {
        subagentId: string;
        description: string;
        scope?: unknown;
        outOfScope?: unknown;
        maxToolCalls?: number | undefined;
        timeoutMs?: number | undefined;
      };
      // Hard boundary gate, identical to `delegate`: an assignment without
      // explicit edges lets the worker guess its own scope, and the drift
      // only surfaces at review time. Reject with a teaching error so the
      // leader retries with the boundary stated.
      const boundary = parseTaskBoundary(i);
      if (!boundary.ok) {
        return {
          ok: false,
          error: `assign_task rejected — task boundary incomplete: ${boundary.error}`,
          hint: boundary.hint,
        };
      }
      const task: TaskSpec = {
        id: randomUUID(),
        description: composeBoundedTaskDescription(i.description, boundary.boundary),
        subagentId: i.subagentId,
        maxToolCalls: i.maxToolCalls,
        timeoutMs: i.timeoutMs,
      };
      const taskId = await director.assign(task);
      return { taskId, subagentId: i.subagentId };
    },
  };
}

export function makeAwaitTasksTool(director: Host.DirectorAssignmentPort): Tool {
  return {
    name: 'await_tasks',
    description:
      'Block until one or more `taskId`s complete, then return their results. The subagents keep running in the background — only the leader\'s iteration pauses, which is the point: this is the correct tool to retrieve a result you started earlier with `assign_task`. mode:"all" (default) blocks until EVERY named task completes. mode:"any" returns as soon as AT LEAST ONE completes — use it for independent tasks so you can handle each finisher immediately (reassign work, spawn helpers) instead of idling on the slowest; call again with the returned `pending` ids to pick up the next finisher. The pattern "fan out via assign_task, then await_tasks({mode:\'any\'})" is the async replacement for serial `delegate` calls.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'One or more task ids returned by `assign_task`.',
        },
        mode: {
          type: 'string',
          enum: ['all', 'any'],
          description:
            '"all" (default): block until every task completes. "any": return on the first completion with the rest listed as pending.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description:
            'mode:"any" only — return {timedOut:true, completed:[]} if nothing completes within this window instead of blocking.',
        },
      },
      required: ['taskIds'],
    },
    async execute(input: unknown) {
      const i = input as {
        taskIds: string[];
        mode?: 'all' | 'any' | undefined;
        timeoutMs?: number | undefined;
      };
      if (i.mode === 'any') {
        const r = await director.awaitTasksAny(
          i.taskIds,
          i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : undefined,
        );
        return {
          mode: 'any',
          completed: r.completed,
          pending: r.pending,
          ...(r.timedOut ? { timedOut: true } : {}),
          ...(r.pending.length > 0
            ? {
                hint: 'Handle the completed results now. Re-call await_tasks with the pending ids (mode:"any") for the next finisher — or assign new work to the now-idle subagent first.',
              }
            : {}),
        };
      }
      const results = await director.awaitTasks(i.taskIds);
      return { results };
    },
  };
}

export function makeAskTool(
  director: Host.DirectorQuestionPort & Host.DirectorAnswerStorePort,
): Tool {
  return {
    name: 'ask_subagent',
    description:
      'Synchronously ask a subagent a question. Blocks until the subagent replies via the bridge.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        subagentId: {
          type: 'string',
          minLength: 1,
          description: 'Subagent to ask. Must be a previously spawned id.',
        },
        question: { type: 'string', minLength: 1, description: 'The question or instruction.' },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description: 'Optional timeout in ms (default 30s).',
        },
      },
      required: ['subagentId', 'question'],
    },
    async execute(input: unknown) {
      const i = input as { subagentId: string; question: string; timeoutMs?: number | undefined };
      try {
        const answer = await director.ask(i.subagentId, { question: i.question }, i.timeoutMs);
        const stored = director.largeAnswerStore.storeAnswer(answer);
        if (stored.inline) {
          return { ok: true, answer: stored.summary };
        }
        return {
          ok: true,
          answer: stored.summary,
          _answerKey: stored.key,
          _hint: 'Response was large and stored. Use ask_result with the key to retrieve it.',
        };
      } catch (err) {
        return { ok: false, error: toErrorMessage(err) };
      }
    },
  };
}

export function makeAskResultTool(director: Host.DirectorAnswerStorePort): Tool {
  return {
    name: 'ask_result',
    description:
      'Retrieve a large `ask_subagent` response that was stored out-of-context (>2K chars). Returns the full stored value.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        key: {
          type: 'string',
          minLength: 1,
          description: 'The `_answerKey` returned by `ask_subagent` for a large response.',
        },
      },
      required: ['key'],
    },
    async execute(input: unknown) {
      const i = input as { key: string };
      const value = director.largeAnswerStore.retrieveAnswer(i.key);
      if (value === undefined) {
        return {
          ok: false,
          error: `No stored answer found for key "${i.key}" — it may have been cleared or the key is invalid.`,
        };
      }
      return { ok: true, value };
    },
  };
}

export function makeRollUpTool(director: Pick<Host.DirectorQuestionPort, 'rollUp'>): Tool {
  return {
    name: 'roll_up',
    description: 'Aggregate completed task results into a single formatted summary.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        taskIds: {
          type: 'array',
          items: { type: 'string' },
          description: 'Completed task ids to aggregate.',
        },
        style: {
          type: 'string',
          enum: ['markdown', 'json'],
          description: 'Output flavor — markdown (default) or json.',
        },
      },
      required: ['taskIds'],
    },
    async execute(input: unknown) {
      const i = input as { taskIds: string[]; style?: 'markdown' | 'json' | undefined };
      const summary = director.rollUp(i.taskIds, i.style ?? 'markdown');
      return { summary, count: i.taskIds.length };
    },
  };
}

export function makeTerminateTool(director: Pick<Host.DirectorLifecyclePort, 'terminate'>): Tool {
  return {
    name: 'terminate_subagent',
    description:
      'Forcibly abort a subagent. The subagent finishes its current iteration then exits with status "stopped".',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: {
      type: 'object',
      properties: { subagentId: { type: 'string', description: 'Subagent to abort.' } },
      required: ['subagentId'],
    },
    async execute(input: unknown) {
      const i = input as { subagentId: string };
      await director.terminate(i.subagentId);
      return { ok: true };
    },
  };
}

export function makeTerminateAllTool(
  director: Pick<Host.DirectorLifecyclePort, 'terminateAll'>,
): Tool {
  return {
    name: 'terminate_all',
    description:
      'Forcibly stop every subagent in the fleet and drain the pending task queue. ' +
      'In-flight tasks are terminated mid-execution; pending tasks receive ' +
      '"aborted_by_parent" completion immediately. ' +
      'Use this when the fleet is wedged, looping, or you need a clean slate. ' +
      'Compare: work_complete stops spawning but lets running agents finish naturally.',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema: { type: 'object', properties: {}, required: [] },
    async execute() {
      await director.terminateAll();
      return {
        ok: true,
        message: `Fleet shutdown complete — all subagents stopped, pending tasks drained.`,
      };
    },
  };
}

export function makeFleetTool(director: Host.DirectorReadModelPort): Tool {
  return {
    name: 'fleet',
    description:
      'Fleet observation tool. Use `action` to select what you need: ' +
      '"status" — snapshot of all subagents + coordinator counts + pending tasks; ' +
      '"usage" — token + cost breakdown per subagent and totals; ' +
      '"health" — per-subagent budget pressure, last activity, and status; ' +
      '"session" — read a subagent\'s JSONL transcript (requires subagentId).',
    usageHint:
      'action: "status" (default) | "usage" | "health" | "session".\n' +
      'For "session", pass subagentId (required) and optional tail (trailing JSONL lines).',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.COORDINATION_FLEET_READ],
    inputSchema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['status', 'usage', 'health', 'session'],
          description: 'Observation to retrieve (default: status).',
        },
        subagentId: {
          type: 'string',
          description: 'Subagent id (required for action: "session").',
        },
        tail: {
          type: 'number',
          description:
            'Number of trailing JSONL lines (action: "session" only). Omit for the full transcript.',
        },
      },
    },
    async execute(input: unknown) {
      const i = (input ?? {}) as {
        action?: string | undefined;
        subagentId?: string | undefined;
        tail?: number | undefined;
      };
      const action = i.action ?? 'status';

      switch (action) {
        case 'status': {
          const base = director.status();
          const fm = director.fleetManager;
          const stats = fm?.getFleetStats();
          const fleetStatus = fm?.getFleetStatus();
          return {
            action: 'status',
            subagents: base.subagents,
            coordinatorStats: stats
              ? {
                  total: stats.total,
                  running: stats.running,
                  idle: stats.idle,
                  stopped: stats.stopped,
                }
              : undefined,
            pending: fleetStatus?.pending ?? [],
            usage: fm?.snapshot(),
          };
        }

        case 'usage': {
          return { action: 'usage', ...director.snapshot() };
        }

        case 'health': {
          const status = director.status();
          const snapshot = director.snapshot();
          const subagents = status.subagents ?? [];
          const perSubagent = snapshot.perSubagent ?? {};
          return {
            action: 'health',
            subagents: subagents.map((s) => {
              const usage = perSubagent[s.id];
              return {
                id: s.id,
                status: s.status,
                lastEventAt: usage?.lastEventAt,
                budgetPressure: {
                  iterations: usage?.iterations,
                  toolCalls: usage?.toolCalls,
                  costUsd: usage?.cost,
                },
              };
            }),
          };
        }

        case 'session': {
          const subagentId = i.subagentId;
          if (!subagentId) {
            return {
              action: 'session',
              error: 'fleet: subagentId is required for action: "session"',
            };
          }
          const result = await director.readSession(subagentId, i.tail);
          if (!result) {
            return {
              action: 'session',
              error: `fleet: transcript unavailable for "${subagentId}". Is sessionsRoot configured?`,
            };
          }
          return { action: 'session', ...result };
        }

        default:
          return {
            error: `fleet: unknown action "${action}". Valid: status, usage, health, session.`,
          };
      }
    },
  };
}
