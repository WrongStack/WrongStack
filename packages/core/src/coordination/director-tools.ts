import { randomUUID } from 'node:crypto';
import { ToolCapabilities } from '../security/capabilities.js';
import type { SubagentConfig, TaskResult } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { toErrorMessage } from '../utils/error.js';
import { type AgentDefinition, getAgentDefinition } from './agents/index.js';
import {
  FleetCostCapError,
  FleetSpawnBudgetError,
  FleetTokenCapError,
} from './director/director-errors.js';
import type * as Host from './director-host-contracts.js';
import { instantiateRosterConfig } from './director-input-helpers.js';
import {
  buildKanbanFleetTaskPrompt,
  buildKanbanSubagentConfig,
  matchesKanbanQueueQuery,
  normalizeKanbanQueueInput,
  resultErrorText,
  resultToText,
} from './director-kanban-queue-helpers.js';
import { dispatchAgent } from './dispatcher.js';
import { kanbanDispatch } from './kanban-dispatch-port.js';
import { callerSessionId } from './origin-session.js';

export {
  makeAskResultTool,
  makeAskTool,
  makeAssignTool,
  makeAwaitTasksTool,
  makeFleetTool,
  makeRollUpTool,
  makeTerminateAllTool,
  makeTerminateTool,
} from './director-basic-tools.js';
export {
  makeCollabDebugTool,
  makeFleetEmitTool,
  makeWorkCompleteTool,
} from './director-collab-tools.js';
export { makeMutationTestTool } from './director-mutation-test-tool.js';
export { makeQualityGateTool } from './director-quality-gate-tool.js';
export { applyMutation, parseMutationReport, planMutations } from './mutation-engine.js';

// ---------------------------------------------------------------------------
// Director-facing tool factories.
//
// Each tool's input schema is intentionally minimal — the director model
// reads the descriptions and gets clean structured shapes. We avoid deep
// nested schemas because they confuse smaller models.

export function makeSpawnTool(
  director: Host.DirectorAdmissionPort,
  roster?: Record<string, SubagentConfig>,
): Tool {
  const dispatchCatalog = (): Record<string, AgentDefinition> | undefined => {
    if (!roster) return undefined;
    return Object.fromEntries(
      Object.entries(roster).map(([role, config]) => {
        const builtIn = getAgentDefinition(role);
        if (builtIn) return [role, builtIn];
        return [
          role,
          {
            config,
            budget: {
              timeoutMs: config.timeoutMs,
              maxIterations: config.maxIterations,
              maxToolCalls: config.maxToolCalls,
              maxTokens: config.maxTokens,
              maxCostUsd: config.maxCostUsd,
            },
            capability: {
              phase: 'meta',
              summary: config.dispatch?.summary ?? config.prompt ?? config.name,
              keywords: config.dispatch?.keywords ?? [],
            },
          } satisfies AgentDefinition,
        ];
      }),
    );
  };
  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      description: {
        type: 'string',
        description:
          'What the subagent has to do, in free form. PREFER THIS over `role`: the dispatcher scores it against the capability metadata of every agent in the roster and picks the specialist, which is more reliable than recalling a role id from a list of 77. Only reach for `role` when you are certain which one you want.',
      },
      role: {
        type: 'string',
        description:
          'Roster role id. When set, the spawn uses the matching config from the roster, ignores other fields, and SKIPS DISPATCH ENTIRELY — so a half-remembered id silently costs you the specialist. Prefer `description` unless the id is certain.',
      },
      name: {
        type: 'string',
        description:
          'Display name for the subagent. Used as a fallback when description-based dispatch does not resolve a role.',
      },
      provider: {
        type: 'string',
        description:
          'Provider id (e.g. "anthropic", "openai"). Defaults to the leader provider when omitted.',
      },
      model: {
        type: 'string',
        description: 'Model id within the provider. Defaults to the leader model when omitted.',
      },
      tier: {
        type: 'string',
        description:
          "Cost/capability level for this worker: 'budget' (cheap + fast, for mechanical or well-specified work), 'standard' (the default), or 'premium' (expensive + most capable, for work where being wrong is costly). Resolved deterministically into a model, a failover chain, and a spend budget from `modelTiers` config, so you do NOT need to know any model id. Omit to let the routing table decide by role. An explicit `model` always wins over the tier.\n\nThis is the RIGHT place to spend a cheap tier. Because this spawn is non-blocking, a budget-tier worker being slower costs you nothing — you keep working while it runs. The same tier on `delegate` would just make you wait longer.",
      },
      systemPromptOverride: {
        type: 'string',
        description: 'Extra prompt text appended after the role-base prompt.',
      },
      maxIterations: { type: 'number', minimum: 1 },
      maxToolCalls: { type: 'number', minimum: 1 },
      maxCostUsd: { type: 'number', minimum: 0 },
      timeoutMs: {
        type: 'number',
        minimum: 1,
        description:
          'Hard wall-clock cap in milliseconds. Defaults to none (idle timeout is the default reaper).',
      },
      idleTimeoutMs: {
        type: 'number',
        minimum: 1,
        description:
          'Idle timeout in ms: reap the subagent after this long with no activity. Resets on every iteration/tool call. Default is role/coordinator-specific.',
      },
      maxTokens: {
        type: 'number',
        minimum: 1,
        description: 'Maximum total tokens (input + output) the subagent may use.',
      },
      worktree: {
        anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'required', 'off'] }],
        description:
          'Git-worktree isolation override. true/"required" requires an isolated worktree; false/"off" disables it; "auto" follows fleet policy.',
      },
    },
    required: [],
  };
  return {
    name: 'spawn_subagent',
    description:
      'Create a new subagent under this director (own LLM context, own budget). NON-BLOCKING: returns a `subagentId` immediately without triggering any model call. Pair with `assign_task` to send work and `await_tasks` to retrieve the result later — this is the async-delegation pattern that lets the leader keep working while the subagent runs in its own context.',
    usageHint:
      'Pass `description` (what the work is — dispatched to the best-matching specialist), or `role` when you are certain of the id, or `name` + `provider`/`model`. Returns `{ subagentId }`. The roster is deep and specialised: there is very likely an agent built for this exact job, so describe the work rather than defaulting to a generalist. Use this instead of `delegate` when you want to fan out to multiple subagents or keep the leader unblocked while work runs in parallel.',
    permission: 'auto',
    mutating: false,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema,
    async execute(input: unknown, ctx?: unknown) {
      const i = (input ?? {}) as Record<string, unknown>;
      const role = typeof i.role === 'string' ? i.role : undefined;
      const description = typeof i.description === 'string' ? i.description : undefined;

      // Resolve base config from roster, explicit role, or dispatch-by-description
      let cfg: SubagentConfig | undefined;

      if (role && roster) {
        const base = roster[role];
        if (!base)
          return { error: `unknown role "${role}". roster has: ${Object.keys(roster).join(', ')}` };
        cfg = instantiateRosterConfig(role, base);
      } else if (description && !role) {
        // Smart dispatch: route description to best catalog agent using dispatcher
        const dispatchResult = await dispatchAgent(description, {
          classifier: director.dispatchClassifier,
          catalog: dispatchCatalog(),
        });
        const dispatchRole = dispatchResult.role;
        // If we have a matching roster entry for the dispatched role, use it
        if (roster?.[dispatchRole]) {
          cfg = instantiateRosterConfig(dispatchRole, roster[dispatchRole] ?? {});
        } else {
          // Dispatch found a catalog agent but there's no roster entry — use the
          // catalog definition's config as a base template (role name + defaults).
          // We must not mutate the original definition, so spread it.
          const def = dispatchResult.definition;
          cfg = {
            name: def.config.name ?? dispatchRole,
            role: dispatchRole,
            provider: def.config.provider,
            model: def.config.model,
          };
        }
      }

      // Fall back to name-only config when neither role nor description dispatch resolved
      cfg ??= { name: (i.name as string) ?? 'subagent' };

      if (typeof i.name === 'string') cfg.name = i.name;
      if (typeof i.provider === 'string') cfg.provider = i.provider;
      if (typeof i.model === 'string') cfg.model = i.model;
      if (typeof i.systemPromptOverride === 'string')
        cfg.systemPromptOverride = i.systemPromptOverride;
      if (typeof i.maxIterations === 'number') cfg.maxIterations = i.maxIterations;
      if (typeof i.maxToolCalls === 'number') cfg.maxToolCalls = i.maxToolCalls;
      if (typeof i.maxCostUsd === 'number') cfg.maxCostUsd = i.maxCostUsd;
      if (typeof i.timeoutMs === 'number') cfg.timeoutMs = i.timeoutMs;
      if (typeof i.idleTimeoutMs === 'number') cfg.idleTimeoutMs = i.idleTimeoutMs;
      if (typeof i.maxTokens === 'number') cfg.maxTokens = i.maxTokens;

      // Tier + the caller's explicit budget pins. The spawn-time tier layer may
      // tighten a roster default but must never override a number typed here.
      if (typeof i.tier === 'string' && i.tier) cfg.tier = i.tier;
      const budgetPins: string[] = [];
      if (typeof i.maxIterations === 'number') budgetPins.push('maxIterations');
      if (typeof i.maxToolCalls === 'number') budgetPins.push('maxToolCalls');
      if (typeof i.maxCostUsd === 'number') budgetPins.push('maxCostUsd');
      if (typeof i.maxTokens === 'number') budgetPins.push('maxTokens');
      if (typeof i.timeoutMs === 'number') budgetPins.push('timeoutMs');
      if (budgetPins.length) cfg.budgetPins = budgetPins;
      if (
        typeof i.worktree === 'boolean' ||
        i.worktree === 'auto' ||
        i.worktree === 'required' ||
        i.worktree === 'off'
      ) {
        cfg.worktree = i.worktree;
      }
      try {
        // The worker belongs to the conversation that asked for it, which the
        // coordinator cannot read for itself once several tabs share one
        // process — its own session names the boot tab. See
        // `SubagentConfig.originSessionId`.
        const origin = callerSessionId(ctx);
        const subagentId = await director.spawn(origin ? { ...cfg, originSessionId: origin } : cfg);
        return {
          subagentId,
          provider: cfg.provider,
          model: cfg.model,
          name: cfg.name,
          role: cfg.role,
        };
      } catch (err) {
        if (err instanceof FleetSpawnBudgetError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        if (err instanceof FleetCostCapError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        if (err instanceof FleetTokenCapError) {
          return { error: err.message, kind: err.kind, limit: err.limit, observed: err.observed };
        }
        return { error: toErrorMessage(err) };
      }
    },
  };
}

export function makeKanbanQueueTool(
  director: Host.DirectorLeaseRecoveryPort,
  roster?: Record<string, SubagentConfig>,
): Tool {
  return {
    name: 'kanban_queue',
    description:
      'Claim dependency-ready Kanban tasks and dispatch them into the Director fleet. Preserves per-task provider/model/role/tool routing metadata, seeds lease metadata (claimedAt, leaseExpiresAt, heartbeatAt), assigns each claimed task to a spawned subagent, instructs workers to call kanban heartbeat_assignment periodically, and can await results while writing completion back to Kanban.',
    usageHint:
      'Use action:"dispatch_ready" with optional boardId/taskId/maxTasks. Set heartbeatIntervalMs (default 60s) and leaseTtlMs (default 5m) to size stale-recovery windows. Set awaitCompletion:true when you want this call to update Kanban to completed/failed before returning; otherwise use await_tasks and kanban mark_assignment later.',
    permission: 'auto',
    mutating: true,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN, ToolCapabilities.FS_WRITE],
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['dispatch_ready'] },
        boardId: { type: 'string', description: 'Optional board id/prefix to claim from.' },
        taskId: { type: 'string', description: 'Optional exact task id/prefix to claim.' },
        query: { type: 'string', description: 'Optional natural-language filter for ready tasks.' },
        maxTasks: {
          type: 'number',
          minimum: 1,
          maximum: 20,
          description: 'Maximum number of ready tasks to claim and dispatch. Default 1.',
        },
        awaitCompletion: {
          type: 'boolean',
          description:
            'When true, waits for assigned fleet task results and writes completed/failed back to Kanban.',
        },
        timeoutMs: {
          type: 'number',
          minimum: 1,
          description: 'Optional per-assigned-task timeout in ms.',
        },
        maxToolCalls: {
          type: 'number',
          minimum: 1,
          description: 'Optional per-assigned-task tool-call cap.',
        },
        heartbeatIntervalMs: {
          type: 'number',
          minimum: 1000,
          description:
            'Suggested heartbeat interval for the worker. Default 60000 (60s). Workers are instructed to call kanban heartbeat_assignment at this cadence.',
        },
        leaseTtlMs: {
          type: 'number',
          minimum: 1000,
          description:
            'Lease time-to-live seeded on dispatch. Default 300000 (5m). Workers should refresh via heartbeat_assignment before expiry.',
        },
        agentId: { type: 'string' },
        name: { type: 'string' },
        role: { type: 'string' },
        provider: { type: 'string' },
        model: { type: 'string' },
        tier: {
          type: 'string',
          description:
            "Cost level for the dispatched workers ('budget' | 'standard' | 'premium'). Resolved from `modelTiers`; an explicit provider/model still wins.",
        },
        fallbackModels: { type: 'array', items: { type: 'string' } },
        tools: { type: 'array', items: { type: 'string' } },
        allowedCapabilities: { type: 'array', items: { type: 'string' } },
        worktree: {
          anyOf: [{ type: 'boolean' }, { type: 'string', enum: ['auto', 'required', 'off'] }],
        },
      },
    } satisfies JSONSchema,
    async execute(input: unknown, ctx) {
      const i = normalizeKanbanQueueInput(input);
      const rawAction = (input as { action?: unknown } | null | undefined)?.action;
      if (rawAction !== undefined && rawAction !== 'dispatch_ready') {
        return { error: `Unknown kanban_queue action: ${String(rawAction)}` };
      }
      const projectRoot = ctx.projectRoot;
      if (!projectRoot) return { error: 'kanban_queue requires ctx.projectRoot.' };
      // The session that ran kanban_queue owns every board event this dispatch
      // pass emits — claims, starts, completions and failures alike — so a tab
      // can find (and stop) the queue work it started.
      const sessionId = ctx.eventSessionId();
      const maxTasks = Math.max(1, Math.min(20, Math.floor(i.maxTasks ?? 1)));
      const baseLeaseTtlMs = Math.max(1000, Math.floor(i.leaseTtlMs ?? 5 * 60 * 1000));
      // When awaitCompletion is true, the lease must survive until the task timeout
      // (plus a 1-minute buffer) so the supervisor never reclaims a task whose
      // worker is still running and being awaited.
      const leaseTtlMs =
        i.awaitCompletion === true && i.timeoutMs !== undefined
          ? Math.max(baseLeaseTtlMs, i.timeoutMs + 60_000)
          : baseLeaseTtlMs;
      // Heartbeat at half the lease TTL so renewal always lands before expiry.
      // The 5s minimum heartbeat interval can exceed the schema-supported lease
      // TTL range (1000–4999 ms), which would let such a lease expire before
      // its first renewal. effectiveLeaseTtlMs raises the actual lease window
      // to at least 2x the heartbeat interval so the first heartbeat is always
      // in-flight before expiry. This single effective TTL governs the initial
      // lease seeding, the dispatch-time stamp, and every heartbeat refresh so
      // all three agree.
      // Use the caller's explicit heartbeat interval when provided, otherwise
      // derive a safe interval from the lease TTL (at most half so the first
      // renewal always lands before expiry). Clamp to at least 5 seconds to
      // avoid busy-looping the heartbeat timer.
      const heartbeatIntervalMs = Math.max(
        5_000,
        i.heartbeatIntervalMs ?? Math.floor(leaseTtlMs / 2),
      );
      const effectiveLeaseTtlMs = Math.max(leaseTtlMs, heartbeatIntervalMs * 2);
      const candidateTaskIds =
        i.taskId !== undefined
          ? [i.taskId]
          : i.query
            ? (
                await kanbanDispatch().listReadyTasks(projectRoot, {
                  ...(i.boardId !== undefined ? { boardId: i.boardId } : {}),
                })
              )
                .filter((candidate) => matchesKanbanQueueQuery(candidate.task, i.query ?? ''))
                .slice(0, maxTasks)
                .map((candidate) => candidate.task.id)
            : undefined;
      const dispatches: Array<{
        boardId: string;
        taskId: string;
        title: string;
        subagentId: string;
        runTaskId: string;
        leaseId: string;
        provider?: string | undefined;
        model?: string | undefined;
        tier?: string | undefined;
      }> = [];
      const errors: Array<{ taskId?: string | undefined; error: string }> = [];
      const resultFailures: Array<{
        taskId: string;
        runTaskId: string;
        status: TaskResult['status'];
        error: string;
      }> = [];
      // Budget-rejected task IDs for this dispatch pass. When the cost gate
      // releases an unaffordable task back to pending, the exclusion set
      // prevents re-claiming the same task on every iteration and starving
      // affordable ready work. Cleared when this dispatch_ready call returns.
      const budgetRejectedTaskIds = new Set<string>();

      for (let index = 0; index < maxTasks; index++) {
        const candidateTaskId = candidateTaskIds?.[index];
        if (candidateTaskIds && !candidateTaskId) break;
        // Skip tasks that were budget-rejected earlier in this dispatch pass
        // so they cannot starve affordable ready work in the same pass.
        if (candidateTaskId && budgetRejectedTaskIds.has(candidateTaskId)) continue;

        // ── Reserve: claim a ready task and seed lease via the shared dispatch service.
        const reserved = await kanbanDispatch().reserveKanbanDispatch(projectRoot, {
          sessionId,
          ...(i.boardId !== undefined ? { boardId: i.boardId } : {}),
          ...(candidateTaskId !== undefined ? { taskId: candidateTaskId } : {}),
          routing: {
            ...(i.agentId !== undefined ? { agentId: i.agentId } : {}),
            ...(i.name !== undefined ? { name: i.name } : {}),
            ...(i.role !== undefined ? { role: i.role } : {}),
            ...(i.provider !== undefined ? { provider: i.provider } : {}),
            ...(i.model !== undefined ? { model: i.model } : {}),
            ...(i.tier !== undefined ? { tier: i.tier } : {}),
            ...(i.fallbackModels !== undefined ? { fallbackModels: i.fallbackModels } : {}),
            ...(i.tools !== undefined ? { tools: i.tools } : {}),
            ...(i.allowedCapabilities !== undefined
              ? { allowedCapabilities: i.allowedCapabilities }
              : {}),
          },
          leaseTtlMs: effectiveLeaseTtlMs,
          heartbeatIntervalMs,
        });
        if (!reserved) {
          if (candidateTaskIds) continue;
          break;
        }
        // Use the dispatch service's lease (not the pre-computed leaseSeeding)
        // so the claim, start, and heartbeat all agree on the same leaseId.
        const ourLeaseId = reserved.lease.leaseId;
        const claim = reserved;
        let subagentId: string | undefined;
        let runTaskId: string | undefined;

        // Sprint 3: cost-ceiling budget check before spawning. A rejected
        // dispatch is a terminal assignment failure for this queue attempt;
        // preserve the assignment and its diagnostic so callers can inspect
        // why no worker was started.
        const costCeiling = claim.task.assignment?.costCeilingUsd;
        if (costCeiling !== undefined) {
          const remaining = director.getRemainingBudgetUsd();
          if (remaining !== undefined && remaining < costCeiling) {
            budgetRejectedTaskIds.add(claim.task.id);
            const budgetError = `Cost ceiling ${costCeiling} exceeds remaining budget ${remaining.toFixed(4)}`;
            await kanbanDispatch().updateTaskAssignment(
              projectRoot,
              claim.board.id,
              claim.task.id,
              {
                ...(claim.task.assignment ?? {}),
                status: 'failed',
                error: budgetError,
              },
              { sessionId, expectedLeaseId: ourLeaseId },
            );
            errors.push({
              taskId: claim.task.id,
              error: budgetError,
            });
            continue;
          }
        }

        try {
          const config = buildKanbanSubagentConfig(claim.task, i, roster, instantiateRosterConfig);
          subagentId = await director.spawn(config);
          const dispatchTaskId = randomUUID();
          const taskSpec = {
            id: dispatchTaskId,
            subagentId,
            description: buildKanbanFleetTaskPrompt(claim.board, claim.task, {
              // The worker must heartbeat against the lease it actually holds.
              // effectiveLeaseTtlMs is the real lease window (raised from the
              // requested TTL when needed so the first heartbeat always lands
              // before expiry), and the computed heartbeatIntervalMs is always
              // strictly shorter than that window. Passing the raw requested
              // values here would give the worker a 60s cadence against a
              // 10s lease, letting the lease expire before its first renewal.
              heartbeatIntervalMs,
              leaseTtlMs: effectiveLeaseTtlMs,
              leaseId: ourLeaseId,
              leaseExpiresAt: reserved.lease.leaseExpiresAt,
            }),
            ...(i.maxToolCalls !== undefined ? { maxToolCalls: i.maxToolCalls } : {}),
            ...(i.timeoutMs !== undefined ? { timeoutMs: i.timeoutMs } : {}),
            context: {
              ...(claim.task.type !== undefined ? { taskType: claim.task.type } : {}),
              kanban: {
                boardId: claim.board.id,
                taskId: claim.task.id,
                origin: claim.task.origin,
                projectRoot,
                leaseId: ourLeaseId,
              },
            },
          };
          // ── Start: transition the task to Running via the shared dispatch service.
          // The service fences by leaseId, stamps the running assignment with
          // subagent/run metadata, and advances managed lifecycle todo → running.
          const started = await kanbanDispatch().startKanbanDispatch(projectRoot, {
            sessionId,
            boardId: claim.board.id,
            taskId: claim.task.id,
            leaseId: ourLeaseId,
            actor: i.agentId ?? 'director-agent',
            subagentId,
            runTaskId: dispatchTaskId,
          });
          if (started === null) {
            // Ownership was lost before dispatch: recover_stale already
            // reclaimed and reassigned the task. Because assign() has not been
            // called yet, terminating the idle spawned agent guarantees this
            // orphan never begins executing the reassigned task.
            try {
              await director.terminate(subagentId);
            } catch (cleanupErr) {
              // Best-effort: the successor owns the assignment now; a failure
              // to terminate our orphan is surfaced but must not block.
              errors.push({
                taskId: claim.task.id,
                error: `Lease lost during dispatch; orphan subagent ${subagentId} termination failed: ${toErrorMessage(cleanupErr)}`,
              });
              continue;
            }
            errors.push({
              taskId: claim.task.id,
              error: `Lease lost during dispatch (reassigned by recovery); subagent ${subagentId} terminated.`,
            });
            continue;
          }
          await director.assign(taskSpec);
          runTaskId = dispatchTaskId;
          dispatches.push({
            boardId: claim.board.id,
            taskId: claim.task.id,
            title: claim.task.title,
            subagentId,
            runTaskId,
            leaseId: ourLeaseId,
            ...(config.provider !== undefined ? { provider: config.provider } : {}),
            ...(config.model !== undefined ? { model: config.model } : {}),
          });
        } catch (err) {
          let message = toErrorMessage(err);
          if (subagentId && !runTaskId) {
            try {
              await director.terminate(subagentId);
            } catch (cleanupErr) {
              message = `${message}; cleanup failed for spawned subagent ${subagentId}: ${toErrorMessage(cleanupErr)}`;
            }
          }
          // ── Fail: record the dispatch failure via the shared dispatch service.
          // The service fences by leaseId so a stale failure write is a no-op
          // when ownership was lost during spawn/assign.
          await kanbanDispatch().failKanbanDispatch(projectRoot, {
            sessionId,
            boardId: claim.board.id,
            taskId: claim.task.id,
            leaseId: ourLeaseId,
            actor: 'kanban-queue',
            error: message,
          });
          errors.push({ taskId: claim.task.id, error: message });
        }
      }

      // Extension-driven lease renewal for fire-and-forget dispatches.
      // The awaitCompletion branch below renews leases while awaiting
      // results, but a non-awaited dispatch returns immediately — nothing
      // would renew the lease when the coordinator's auto-extend policy
      // (auto-extend.ts) grants timeout extensions past the dispatch-time
      // lease window, letting recover_stale reclaim a live task. This
      // detached supervisor renews each dispatched lease (fenced with
      // expectedLeaseId, so a reassigned task is never touched) until the
      // worker reaches a terminal fleet event (subagent.completed /
      // subagent.stopped), with a hard ceiling matching the 24h auto-extend
      // timeout cap so a missed terminal event cannot leak the timer forever.
      if (
        !i.awaitCompletion &&
        dispatches.length > 0 &&
        typeof director.fleet?.subscribe === 'function'
      ) {
        // Each dispatch carries its own leaseId from reserveKanbanDispatch.
        const disposers = new Map<string, () => void>();
        const renewalStartedAt = Date.now();
        const maxRenewalWindowMs = 24 * 60 * 60_000;
        const stopAll = (): void => {
          clearInterval(renewalTimer);
          for (const dispose of disposers.values()) dispose();
          disposers.clear();
        };
        const renewalTimer = setInterval(() => {
          if (disposers.size === 0 || Date.now() - renewalStartedAt > maxRenewalWindowMs) {
            stopAll();
            return;
          }
          const refreshedExpiry = new Date(Date.now() + effectiveLeaseTtlMs).toISOString();
          for (const dispatch of dispatches) {
            if (!disposers.has(dispatch.runTaskId)) continue;
            // Fire-and-forget renewal: the expectedLeaseId fence inside
            // heartbeatTaskAssignment's mutateBoard lock makes a stale
            // renewal a no-op; transient write errors simply retry next tick.
            void renewAndRevokeLease({
              sessionId,
              projectRoot,
              boardId: dispatch.boardId,
              taskId: dispatch.taskId,
              subagentId: dispatch.subagentId,
              runTaskId: dispatch.runTaskId,
              ourLeaseId: dispatch.leaseId,
              refreshedExpiry,
              director,
              disposers,
            });
          }
        }, heartbeatIntervalMs);
        renewalTimer.unref?.();
        for (const dispatch of dispatches) {
          const dispose = director.fleet.subscribe(dispatch.subagentId, (event) => {
            const isTerminalEvent =
              event.type === 'subagent.completed' ||
              event.type === 'subagent.stopped' ||
              event.type === 'subagent.failed' ||
              event.type === 'subagent.error' ||
              event.type === 'subagent.killed';
            if (!isTerminalEvent) return;
            if (event.type === 'subagent.completed' && event.taskId !== dispatch.runTaskId) return;
            disposers.get(dispatch.runTaskId)?.();
            disposers.delete(dispatch.runTaskId);
            if (disposers.size === 0) stopAll();
          });
          disposers.set(dispatch.runTaskId, dispose);
        }
      }

      let results: TaskResult[] | undefined;
      if (i.awaitCompletion && dispatches.length > 0) {
        // The dispatch-time lease covers the original timeoutMs, but the
        // coordinator's auto-extend policy (auto-extend.ts) can grant timeout
        // extensions while the worker makes progress — up to a 24h ceiling.
        // Without supervisor-side renewal, the lease can expire while the
        // awaited worker is still legitimately running, letting recover_stale
        // reclaim and duplicate the assignment. heartbeatIntervalMs and
        // effectiveLeaseTtlMs were computed above (before lease seeding) so
        // the initial lease, dispatch stamp, and every refresh agree.
        // Each dispatch carries its own leaseId from reserveKanbanDispatch.
        const runTaskIds = new Set(dispatches.map((dispatch) => dispatch.runTaskId));
        let heartbeatRunning = false;
        let heartbeatInFlight: Promise<void> = Promise.resolve();
        const runHeartbeat = async (): Promise<void> => {
          const refreshedExpiry = new Date(Date.now() + effectiveLeaseTtlMs).toISOString();
          for (const dispatch of dispatches) {
            // Only heartbeat tasks still in flight; resolved ones are
            // finalized below after awaitTasks settles.
            if (!runTaskIds.has(dispatch.runTaskId)) continue;
            // Atomic lease revocation check before heartbeating. If the
            // supervisor reclaimed and reassigned this task (changing its
            // leaseId), terminate the stale subagent immediately so it stops
            // writing files. The awaitTasks below will pick up the stopped
            // result and write it back (fenced, so a no-op vs the successor).
            try {
              const board = await kanbanDispatch().getBoard(projectRoot, dispatch.boardId);
              const liveTask = board?.tasks.find((t) => t.id === dispatch.taskId);
              // Defensive guard: no assignment means the task was
              // released or recovered (e.g. mode='release') — the
              // subagent no longer owns it. Terminate immediately.
              // Capture the lease id explicitly so we don't mis-fire
              // when the task exists but has no assignment yet
              // (transient race during assignment removal): a literal
              // `undefined !== dispatch.leaseId` would terminate a legitimate
              // worker because undefined is not equal to any UUID.
              const liveLeaseId = liveTask?.assignment?.leaseId;
              if (liveLeaseId !== undefined && liveLeaseId !== dispatch.leaseId) {
                await director.terminate(dispatch.subagentId).catch(() => {});
                runTaskIds.delete(dispatch.runTaskId);
                continue;
              }
            } catch {
              // Board read is best-effort; on transient error the next
              // heartbeat interval tick retries. The heartbeat below is
              // fenced with expectedLeaseId so it's safe even without
              // the revocation check passing this cycle.
            }
            try {
              // Atomic ownership fence: expectedLeaseId is checked inside
              // heartbeatTaskAssignment's mutateBoard lock, so if the
              // supervisor recovered and reassigned the task (changing its
              // leaseId), the heartbeat is a no-op rather than a TOCTOU gap
              // that could renew the successor's lease.
              await kanbanDispatch().heartbeatTaskAssignment(
                projectRoot,
                dispatch.boardId,
                dispatch.taskId,
                {
                  leaseExpiresAt: refreshedExpiry,
                  expectedLeaseId: dispatch.leaseId,
                },
                { sessionId, expectedLeaseId: dispatch.leaseId },
              );
            } catch {
              // Heartbeat failure is non-fatal: the next tick retries, and
              // the final status write is the source of truth. We must not
              // tear down the awaited dispatch over a transient write error.
            }
          }
        };
        const heartbeatTimer = setInterval(() => {
          // setInterval does not await async callbacks. Without this guard a
          // slow board store can accumulate overlapping heartbeat batches.
          if (heartbeatRunning) return;
          heartbeatRunning = true;
          heartbeatInFlight = runHeartbeat().finally(() => {
            heartbeatRunning = false;
          });
        }, heartbeatIntervalMs);

        try {
          results = await director.awaitTasks(dispatches.map((dispatch) => dispatch.runTaskId));
        } finally {
          clearInterval(heartbeatTimer);
          await heartbeatInFlight.catch(() => undefined);
        }
        for (const result of results) {
          const dispatch = dispatches.find((candidate) => candidate.runTaskId === result.taskId);
          if (!dispatch) continue;
          runTaskIds.delete(dispatch.runTaskId);
          // ── Complete/Fail: record the result via the shared dispatch service.
          // The service fences by leaseId, writes the terminal assignment
          // status, runs the legacy completion gate or transitions managed
          // lifecycle running → review, and never auto-advances to Done.
          if (result.status === 'success') {
            const completed = await kanbanDispatch().completeKanbanDispatch(projectRoot, {
              sessionId,
              boardId: dispatch.boardId,
              taskId: dispatch.taskId,
              leaseId: dispatch.leaseId,
              actor: 'kanban-queue',
              result: resultToText(result),
            });
            if (!completed) {
              // Lease was lost during completion — the successor owns the task.
              resultFailures.push({
                taskId: dispatch.taskId,
                runTaskId: result.taskId,
                status: 'failed',
                error: 'Lease lost during completion write (reassigned by recovery).',
              });
            }
          } else {
            const failed = await kanbanDispatch().failKanbanDispatch(projectRoot, {
              sessionId,
              boardId: dispatch.boardId,
              taskId: dispatch.taskId,
              leaseId: dispatch.leaseId,
              actor: 'kanban-queue',
              error: resultErrorText(result),
            });
            if (!failed) {
              resultFailures.push({
                taskId: dispatch.taskId,
                runTaskId: result.taskId,
                status: 'failed',
                error: 'Lease lost during failure write (reassigned by recovery).',
              });
            }
          }
          if (result.status !== 'success') {
            resultFailures.push({
              taskId: dispatch.taskId,
              runTaskId: result.taskId,
              status: result.status,
              error: resultErrorText(result),
            });
          }
        }
      }

      return {
        ok: errors.length === 0 && resultFailures.length === 0,
        dispatched: dispatches,
        count: dispatches.length,
        ...(results !== undefined ? { results } : {}),
        ...(errors.length > 0 ? { errors } : {}),
        ...(resultFailures.length > 0 ? { resultFailures } : {}),
        message:
          dispatches.length > 0
            ? `Dispatched ${dispatches.length} kanban task(s).`
            : 'No ready kanban task matched.',
      };
    },
  };
}

/**
 * Renew a kanban lease OR revoke it if the task was reassigned.
 *
 * Reads the live board to compare the task's current leaseId against the
 * frozen leaseId this supervisor was seeded with. When they differ, the
 * supervisor (or recover_stale) reclaimed and reassigned the task — this
 * subagent is stale and must be terminated to stop it from writing files.
 *
 * Fire-and-forget mode only (awaitCompletion uses its own inline check
 * inside `runHeartbeat`).
 */
async function renewAndRevokeLease(opts: {
  projectRoot: string;
  boardId: string;
  taskId: string;
  subagentId: string;
  runTaskId: string;
  ourLeaseId: string;
  refreshedExpiry: string;
  /** Session that owns the dispatch this lease belongs to. */
  sessionId: string;
  director: Host.DirectorLeaseRecoveryPort;
  disposers: Map<string, () => void>;
}): Promise<void> {
  const {
    projectRoot,
    boardId,
    taskId,
    subagentId,
    runTaskId,
    ourLeaseId,
    refreshedExpiry,
    sessionId,
    director,
    disposers,
  } = opts;

  // Lease revocation check: read the live board and verify our leaseId
  // still matches. If recover_stale reclaimed the task, terminate the
  // stale subagent immediately to stop it from doing more work.
  let revoked = false;
  try {
    const board = await kanbanDispatch().getBoard(projectRoot, boardId);
    const liveTask = board?.tasks.find((t) => t.id === taskId);
    // Defensive guard: no assignment means the task was
    // released or recovered (e.g. mode='release') — the
    // subagent no longer owns it. Terminate immediately.
    // Capture the lease id explicitly so we don't mis-fire
    // when the task exists but has no assignment yet
    // (transient race during assignment removal): a literal
    // `undefined !== ourLeaseId` would terminate a legitimate
    // worker because undefined is not equal to any UUID.
    const liveLeaseId = liveTask?.assignment?.leaseId;
    if (liveLeaseId !== undefined && liveLeaseId !== ourLeaseId) {
      await director.terminate(subagentId).catch(() => {});
      disposers.get(runTaskId)?.();
      disposers.delete(runTaskId);
      revoked = true;
    }
  } catch {
    // Board read is best-effort; on transient error the next interval tick
    // retries. The heartbeat below is fenced with expectedLeaseId so it's
    // safe even without the revocation check passing.
  }
  if (!revoked) {
    await kanbanDispatch()
      .heartbeatTaskAssignment(
        projectRoot,
        boardId,
        taskId,
        { leaseExpiresAt: refreshedExpiry, expectedLeaseId: ourLeaseId },
        { sessionId, expectedLeaseId: ourLeaseId },
      )
      .catch(() => {});
  }
}
