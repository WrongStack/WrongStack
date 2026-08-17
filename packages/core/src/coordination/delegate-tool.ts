import { randomUUID } from 'node:crypto';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import type { EventBus } from '../kernel/events.js';
import { ToolCapabilities } from '../security/capabilities.js';
import type { SubagentConfig, TaskResult } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import { toErrorMessage } from '../utils/error.js';
import { safeParse } from '../utils/safe-json.js';
import type { Director } from './director.js';
import { applyRosterBudget, FLEET_ROSTER_BUDGETS } from './fleet.js';
import {
  composeBoundedTaskDescription,
  parseTaskBoundary,
  taskBoundarySchemaProperties,
} from './task-boundary.js';

/**
 * Opaque host interface so this factory doesn't have to depend on the
 * CLI's `MultiAgentHost`. Any caller that exposes the same methods
 * can wire `delegate` — including test doubles.
 *
 * Director Mode is permanently on, so `ensureDirector()` always succeeds.
 * The promotion fallback exists only for backward compatibility.
 */
export interface DelegateHost {
  /** True if a Director is already attached and running. */
  isDirectorMode(): boolean;
  /** Build (or return the cached) Director. */
  ensureDirector(): Promise<Director | null>;
  /**
   * Return the live Director. Since Director Mode is permanently on,
   * this always succeeds. Idempotent.
   */
  promoteToDirector(): Promise<Director | null>;
}

export interface CreateDelegateToolOptions {
  host: DelegateHost;
  /**
   * Roster used to resolve `role` strings into full `SubagentConfig`s.
   * Typically `FLEET_ROSTER`. When omitted, `delegate({ role })` calls
   * fail and only the explicit `name + provider + model` path works.
   */
  roster?: Record<string, SubagentConfig>;
  /**
   * Default await timeout in milliseconds. `delegate` blocks until the
   * subagent's task resolves; without a cap, a stuck worker would hang
   * the host indefinitely. Set generously (default: 4 hours) so the
   * orchestrator can run multi-step refactors / monorepo audits
   * without being killed for being slow — the orchestrator must
   * decide per-call when a task needs to be cut short.
   */
  defaultTimeoutMs?: number | undefined;
  /**
   * Absolute directory under which per-subagent JSONL transcripts live —
   * matches `MultiAgentHostOptions.sessionsRoot`. When set, the delegate
   * tool reads the subagent's transcript on timeout / budget-exhaustion
   * to extract partial output, so the host LLM gets *something* useful
   * back instead of just an error.
   */
  sessionsRoot?: string | undefined;
  /**
   * The directorRunId used to namespace transcripts (typically the host
   * session id). Combined with `sessionsRoot` to locate per-subagent
   * JSONLs at `<sessionsRoot>/<runId>/<subagentId>.jsonl`.
   */
  directorRunId?: string | undefined;
  /**
   * Buffer subtracted from the caller's `timeoutMs` before passing it
   * to the subagent. Gives the host a window to detect a subagent that
   * has gone silent and surface a partial result rather than a generic
   * timeout. Default: 60_000 ms (raised from 30s to give subagents
   * more headroom before the host kills them).
   */
  subagentTimeoutBufferMs?: number | undefined;
  /**
   * Host EventBus. When supplied, `delegate` emits `delegate.started`
   * (before it blocks on the subagent) and `delegate.completed` (once the
   * subagent settles) so UIs / the Telegram bridge can render readable
   * start/finish lines instead of inferring them from the truncated
   * `tool.executed` JSON preview. Optional — emits are best-effort and a
   * missing bus never affects delegation behaviour.
   */
  events?: EventBus | undefined;
}

/**
 * `delegate` — the compact multi-agent tool exposed after Director mode is
 * enabled. It bundles spawn + assign + await into a single call.
 *
 * The model never has to ask "are we in director mode?" — it just calls
 * `delegate({ role, task })` and gets back a `TaskResult`. The cost of
 * that ergonomic packaging is that `delegate` cannot be used for
 * parallel work as-is; the model must fire multiple `delegate` calls in
 * parallel through the provider's parallel-tool-call surface, or escalate
 * to the explicit `spawn_subagent` + `assign_task` + `await_tasks` flow
 * when it wants fan-out it controls itself.
 */
export function createDelegateTool(opts: CreateDelegateToolOptions): Tool {
  // Keep the host-side silence window generous by default. This value is also
  // forwarded as the initial subagent wall-clock budget when the role does not
  // provide one; the Director can extend it while the worker makes progress.
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 4 * 60 * 60 * 1000;
  const rosterIds = opts.roster ? Object.keys(opts.roster) : [];

  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'The objective — what the subagent should do, natural language, complete sentence(s). Pair it with the required `scope` and `outOfScope` boundary fields.',
      },
      ...taskBoundarySchemaProperties,
      role: {
        type: 'string',
        description:
          rosterIds.length > 0
            ? 'Roster role id. Common: bug-hunter, security-scanner, refactor-planner, critic, audit-log, executor, shadow-agent, architect.'
            : 'No roster configured — pass `name` instead.',
      },
      name: {
        type: 'string',
        description:
          'Display name for free-form subagents (no roster role). Required when `role` is omitted.',
      },
      provider: {
        type: 'string',
        description: 'Provider id (e.g. "anthropic", "openai"). Defaults to host provider.',
      },
      model: {
        type: 'string',
        description: 'Model id within the provider. Defaults to host model.',
      },
      systemPromptOverride: {
        type: 'string',
        description: 'Extra prompt text appended to the role baseline.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1,
        description: `Wall-clock budget in ms (default ${Math.round(defaultTimeoutMs / 1000 / 60)} min). No hard cap — set as high as the task needs.`,
      },
      maxIterations: {
        type: 'number',
        minimum: 1,
        description:
          'Maximum LLM iterations. Unset = role default. Raise for deep multi-step tasks.',
      },
      maxToolCalls: {
        type: 'number',
        minimum: 1,
        description: 'Maximum tool invocations. Unset = role default. Raise for file-heavy tasks.',
      },
      idleTimeoutMs: {
        type: 'number',
        minimum: 1,
        description: 'Idle timeout in ms. Resets on activity. Unset = role default.',
      },
      maxTokens: {
        type: 'number',
        minimum: 1,
        description: 'Max total tokens (input+output). Unset = role default.',
      },
      maxCostUsd: {
        type: 'number',
        minimum: 0,
        description: 'Max estimated USD cost. Unset = role default.',
      },
      maxHandoffs: {
        type: 'number',
        minimum: 0,
        maximum: 8,
        description:
          'Max fresh-worker continuations after budget exhaustion. Default 1. Each gets the prior partial report.',
      },
    },
    required: ['task', 'scope', 'outOfScope'],
  };

  return {
    name: 'delegate',
    description:
      "Hand a piece of work to a subagent and block until it returns. This call is synchronous: the leader's iteration pauses for the full duration of the subagent's run. (Multiple `delegate` calls fired in the same assistant turn still parallelize through the provider's parallel-tool-call surface, but each one eats wall-clock time — so for fan-out you actually control, reach for the async path below.) Use `delegate` when your next step genuinely needs the subagent's verdict — a review, a fact-check, a sign-off. Has own context, own LLM call, auto-extending budget, and a partial-completion handoff path (maxHandoffs, default 1). Workers cannot recursively spawn.\n\n**Do NOT use `delegate` for long-running work.** While `delegate` is in flight, the leader is fully blocked — it cannot act on other tools, read mail, or react to the user. If the work might run for tens of minutes or hours (multi-file refactor, monorepo audit, long-running build/test, sweeping migration), the blocking call wastes the leader's time. Use the async tool family instead: `spawn_subagent` to create each worker (returns a `subagentId` immediately), `assign_task` to queue work on it (returns a `taskId` immediately), then `await_tasks` to retrieve results later. The leader keeps doing other work while the worker churns, and a worker that realizes its task will run long can mail the leader (type `steer` or `ask` via `mail_send`) saying *\"my task is going to run long, please spawn a subagent instead\"* so the leader re-dispatches asynchronously instead of waiting.\n\n**Do NOT use `delegate` for fan-out you control.** Multiple sequential `delegate` calls each block the leader, wasting wall-clock time. For independent investigations you want to run in parallel — security scan + bug hunt + perf review on the same PR — use the async tool family: `spawn_subagent` to create each worker (returns a `subagentId` immediately), `assign_task` to queue work on it (returns a `taskId` immediately), then the `await_tasks` tool with `{mode: 'any'}` to fold the first useful result into the next decision while the rest keep churning. Reach for `delegate` only when the result gates your next move AND the work is short enough that blocking the leader is acceptable.",
    usageHint:
      'Set `task` to the objective, then make the edges explicit: `scope` (what the work covers) and `outOfScope` (at least one concrete non-goal) are REQUIRED — the call is rejected without them, and the worker treats the rendered boundary block as a hard contract. Pick `role` from roster or pass `name` for free-form. Reach for `delegate` only when the result gates your next move AND the work is short enough that blocking the leader is acceptable (minutes, not hours). For long-running work or fan-out you control, use `spawn_subagent` + `assign_task` + `await_tasks` instead. Raise `maxHandoffs` (default 1, cap 8) for multi-day or multi-refactor tasks; pass larger `timeoutMs`/`maxIterations`/`maxToolCalls` only when needed.',
    permission: 'auto',
    mutating: false,
    managesOwnTimeout: true,
    capabilities: [ToolCapabilities.SUBAGENT_SPAWN],
    inputSchema,
    async execute(input: unknown, _ctx?: unknown, execOpts?: { signal?: AbortSignal }) {
      const sessionId = opts.directorRunId;
      // Executor-provided abort signal (leader interrupt, Esc, timeout).
      // Without honoring it, this tool blocks the whole agent loop until the
      // subagent finishes — /interrupt could never unwind a delegating run.
      const abortSignal = execOpts?.signal;
      const i = (input ?? {}) as {
        task?: string | undefined;
        scope?: unknown;
        outOfScope?: unknown;
        role?: string | undefined;
        name?: string | undefined;
        provider?: string | undefined;
        model?: string | undefined;
        systemPromptOverride?: string | undefined;
        timeoutMs?: number | undefined;
        maxIterations?: number | undefined;
        maxToolCalls?: number | undefined;
        idleTimeoutMs?: number | undefined;
        maxTokens?: number | undefined;
        maxCostUsd?: number | undefined;
        maxHandoffs?: number | undefined;
      };

      if (typeof i.task !== 'string' || !i.task.trim()) {
        return { ok: false, error: '`task` is required.' };
      }

      if (abortSignal?.aborted) {
        return {
          ok: false,
          stopReason: 'aborted' as const,
          error: 'Delegation cancelled before spawn — the run was interrupted.',
        };
      }

      // Hard boundary gate: a delegate without explicit edges produces a
      // worker that guesses its own scope. Reject before any spawn cost is
      // incurred, with an error that teaches the fix in one retry.
      const boundary = parseTaskBoundary(i);
      if (!boundary.ok) {
        return {
          ok: false,
          error: `delegate rejected — task boundary incomplete: ${boundary.error}`,
          hint: boundary.hint,
        };
      }

      // Human-friendly label for the subagent — surfaced in the
      // delegate.* events so UIs say "Delegating → bug-hunter" rather
      // than echoing an opaque generated id.
      const target = i.role ?? i.name ?? 'subagent';

      // Delegate-specific launch-mode preface. The leader is blocked on
      // this call for the full duration of the worker's run, so on the
      // first attempt we tell the worker that if it judges the task will
      // run for tens of minutes or hours, it should escalate to the
      // leader via the mailbox control-plane route (so the leader can
      // convert to the non-blocking `spawn_subagent` + `assign_task` path)
      // rather than silently grinding through a blocking call. This rule
      // is delegated-only on purpose: async workers spawned via
      // `spawn_subagent` + `assign_task` are the correct path for
      // long-running work and must not stop with a partial checkpoint
      // before they actually finish.
      //
      // IMPORTANT: do NOT prepend this preface to the task brief before
      // passing it to `dir.assign({ description })`. `TaskSpec.description`
      // is the canonical brief delivered to the runner; tests and downstream
      // consumers (e.g. `buildHandoffTask` -> `Original task:`) rely on it
      // staying the leader's brief (objective + boundary block, composed
      // below) rather than growing runtime guidance. Inject the preface into
      // the subagent prompt layer instead via `systemPromptOverride`,
      // which composes last and wins on conflict (see
      // director-prompts.ts:111-114) without rewriting the description.
      const launchModePreface = [
        'Launch-mode guidance (delegate): you were launched via the synchronous `delegate` tool, so the leader is blocked on this call for the full duration of your run.',
        'If, after inspecting the task, you judge it will run for tens of minutes or hours (multi-file refactor, monorepo audit, long-running build/test, sweeping migration), do NOT silently grind through it under the blocking call.',
        'Escalate to the leader using whatever mail-style tool your role exposes — `mail_send` if available, otherwise `mailbox action=send` (some inspect-only roles expose `mailbox` rather than `mail_send`). Send a `steer` or `ask`, e.g. *"my task is going to run long, please spawn a subagent instead"*, so the leader can re-dispatch asynchronously via `spawn_subagent` + `assign_task`.',
        'Then return a clean checkpoint with `completion:"partial"` and a concrete `remaining_work`.',
        'If the task is short and bounded, just do it end-to-end — do not over-trigger the escalation for normal work.',
      ].join('\n\n');
      // The preface above is delivered to the worker through
      // `systemPromptOverride` on the first attempt only (see the
      // `attemptConfig.systemPromptOverride` wiring below). `delegatedTask`
      // is declared inside the loop below and starts equal to `i.task`,
      // so `TaskSpec.description` stays faithful to the leader's brief.

      try {
        let director = await opts.host.ensureDirector();
        if (!director) {
          director = await opts.host.promoteToDirector();
        }
        if (!director) {
          return {
            ok: false,
            error: 'Director could not be activated — fleet orchestration is unavailable.',
          };
        }

        const timeoutMs = i.timeoutMs ?? defaultTimeoutMs;

        let cfg: SubagentConfig;
        if (i.role) {
          const base = opts.roster?.[i.role];
          if (!base) {
            const availableRoles = opts.roster ? Object.keys(opts.roster) : [];
            return {
              ok: false,
              error: `Unknown role "${i.role}". Available: ${availableRoles.join(', ') || '(no roster configured)'}.`,
            };
          }
          cfg = instantiateRosterConfig(i.role, base, i.timeoutMs, defaultTimeoutMs);
          // NOTE: do NOT write `i.systemPromptOverride` into
          // `cfg.systemPromptOverride` here — the roster config's own
          // override must survive until the launch-preface IIFE below
          // reads both the roster override and the caller override
          // separately and layers them in precedence order. Writing the
          // caller's value into `cfg.systemPromptOverride` would clobber
          // the roster value, defeating the layering contract. The IIFE
          // already reads `i.systemPromptOverride` directly from the
          // outer input, so the explicit assignment here is unnecessary.
          if (i.provider) cfg.provider = i.provider;
          if (i.model) cfg.model = i.model;
        } else {
          if (!i.name) {
            return {
              ok: false,
              error: 'Either `role` (from the roster) or `name` is required.',
            };
          }
          cfg = {
            name: i.name,
            provider: i.provider,
            model: i.model,
            systemPromptOverride: i.systemPromptOverride,
          };
          // Apply generic budget so free-form subagents get the x10
          // budget even without a roster role.
          cfg = applyRosterBudget({ ...cfg, name: i.name });
        }

        if (typeof i.maxIterations === 'number') {
          cfg.maxIterations = i.maxIterations;
        }
        if (typeof i.maxToolCalls === 'number') {
          cfg.maxToolCalls = i.maxToolCalls;
        }
        if (typeof i.idleTimeoutMs === 'number') {
          cfg.idleTimeoutMs = i.idleTimeoutMs;
        }
        if (typeof i.maxTokens === 'number') {
          cfg.maxTokens = i.maxTokens;
        }
        if (typeof i.maxCostUsd === 'number') {
          cfg.maxCostUsd = i.maxCostUsd;
        }

        const SUBAGENT_TIMEOUT_BUFFER_MS = opts.subagentTimeoutBufferMs ?? 60_000;
        // Only FILL IN a budget timeout when the config has none — never
        // clamp a generous roster/generic budget DOWN to the host's await
        // window. The old `cfg.timeoutMs > desiredSubTimeout` clamp is what
        // capped 10h roster agents at ~4 minutes. The host await below is
        // heartbeat-based, so the subagent's own (auto-extending) budget is
        // the real ceiling.
        if (!cfg.timeoutMs) {
          cfg.timeoutMs = Math.max(30_000, timeoutMs - SUBAGENT_TIMEOUT_BUFFER_MS);
        }

        const dir = director;
        const maxHandoffs = Math.min(8, Math.max(0, Math.floor(i.maxHandoffs ?? 1)));
        const handoffs: DelegateHandoff[] = [];
        // The leader's full brief is the objective plus its explicit
        // boundary block. Composing the boundary into `TaskSpec.description`
        // (rather than injecting it through prompt layers) means every
        // consumer of the canonical brief — runner input, session
        // transcripts, roll-ups, and the handoff continuations below —
        // carries the edges without extra plumbing.
        const baseBrief = composeBoundedTaskDescription(i.task, boundary.boundary);
        let delegatedTask = baseBrief;
        let handoffCount = 0;

        for (;;) {
          const attemptConfig = (() => {
            const base = handoffCount === 0 ? cfg : freshHandoffConfig(cfg, i.role, handoffCount);
            if (handoffCount !== 0) return base;
            // First attempt only: inject the delegate launch-mode preface
            // through the subagent prompt layer (`systemPromptOverride`),
            // composing last and winning on conflict per director-prompts.ts
            // layering. Build a fresh object so we don't mutate the
            // `cfg` aliased on attempt 0 (cfg is reused across attempts
            // only on handoff, but writing through the alias is a
            // dead-write-observable hazard if cfg is later read or if
            // the spawn fails and cfg is re-entered).
            //
            // IMPORTANT: layer in precedence order so we do NOT clobber
            // a `systemPromptOverride` that the roster config already
            // supplied (custom roster roles can ship their own override).
            // For role-based spawns, `cfg.systemPromptOverride` is already
            // equal to `i.systemPromptOverride` when the caller passed one
            // (see the role path above), so the second slot is a no-op in
            // that case — we still include the dedupe check to stay safe
            // against future refactors that decouple the two slots.
            const baseOverride = base.systemPromptOverride;
            const callerOverride = i.systemPromptOverride;
            const segments = [launchModePreface];
            if (baseOverride && baseOverride.trim().length > 0) {
              segments.push(baseOverride);
            }
            if (
              callerOverride &&
              callerOverride.trim().length > 0 &&
              callerOverride !== baseOverride
            ) {
              segments.push(callerOverride);
            }
            return {
              ...base,
              systemPromptOverride: segments.join('\n\n'),
            };
          })();
          // Handoffs use `buildHandoffTask` (which already carries its
          // own escalation language) and must NOT receive the
          // first-attempt preface — it would re-trigger escalation on a
          // worker that already escalated.
          const subagentId = await dir.spawn(attemptConfig);
          // Publish once the runtime identity exists. The WebUI can now add
          // this synchronous delegate to its live roster instead of keeping
          // only an unaddressable timeline line while the leader waits.
          if (handoffCount === 0) {
            opts.events?.emit('delegate.started', {
              sessionId,
              target,
              task: i.task,
              subagentId,
            });
          }
          // `delegatedTask` is the original leader brief (objective +
          // boundary block) on the first attempt and the
          // `buildHandoffTask` continuation text on later attempts. Both
          // preserve the verbatim original brief inside their bodies, so
          // `TaskSpec.description` stays faithful to the leader's brief
          // throughout the delegate loop.
          const description = delegatedTask;
          const taskId = await dir.assign({
            id: randomUUID(),
            description,
            subagentId,
          });
          const result = await awaitDelegateAttempt(
            dir,
            subagentId,
            taskId,
            timeoutMs,
            abortSignal,
          );

          if ('__aborted' in result) {
            try {
              await dir.terminate(subagentId);
            } catch {
              /* best-effort */
            }
            const partial = await readSubagentPartial(opts, subagentId);
            opts.events?.emit('delegate.completed', {
              sessionId,
              target,
              task: i.task,
              ok: false,
              status: 'aborted',
              summary: `[${target}] aborted — the run was interrupted`,
              durationMs: 0,
              iterations: partial?.events ?? 0,
              toolCalls: partial?.toolUsesObserved ?? 0,
              subagentId,
            });
            return {
              ok: false,
              stopReason: 'aborted' as const,
              error: 'Delegated task aborted — the run was interrupted.',
              subagentId,
              taskId,
              partial,
              ...(handoffs.length > 0 ? { handoffs } : {}),
            };
          }

          if ('__timeout' in result) {
            try {
              await dir.terminate(subagentId);
            } catch {
              /* best-effort */
            }
            const partial = await readSubagentPartial(opts, subagentId);
            opts.events?.emit('delegate.completed', {
              sessionId,
              target,
              task: i.task,
              ok: false,
              status: 'host_timeout',
              summary: `[${target}] timed out — no progress within ${Math.round(timeoutMs / 1000)}s`,
              durationMs: timeoutMs,
              iterations: partial?.events ?? 0,
              toolCalls: partial?.toolUsesObserved ?? 0,
              subagentId,
            });
            return {
              ok: false,
              stopReason: 'host_timeout' as const,
              error: `Subagent timed out: it did not finish or report progress within ${timeoutMs}ms.`,
              hint: 'Raise timeoutMs for unusually long single operations, or split the remaining work.',
              subagentId,
              taskId,
              partial,
              ...(handoffs.length > 0 ? { handoffs } : {}),
            };
          }

          if ('__emptyResult' in result) {
            const partial = await readSubagentPartial(opts, subagentId);
            opts.events?.emit('delegate.completed', {
              sessionId,
              target,
              task: i.task,
              ok: false,
              status: 'empty_result',
              summary: `[${target}] completed without a task result`,
              durationMs: 0,
              iterations: partial?.events ?? 0,
              toolCalls: partial?.toolUsesObserved ?? 0,
              subagentId,
            });
            return {
              ok: false,
              stopReason: 'error' as const,
              error: 'Director returned no task result for the delegated task.',
              hint: 'Check fleet state, then retry or reassign the task.',
              subagentId,
              taskId,
              partial,
              ...(handoffs.length > 0 ? { handoffs } : {}),
            };
          }

          const partial =
            result.status === 'success'
              ? undefined
              : result.partial
                ? {
                    lastAssistantText: result.partial.text,
                    toolUsesObserved: result.toolCalls,
                    events: result.iterations,
                  }
                : await readSubagentPartial(opts, subagentId);
          const continuation = continuationFor(result, partial, attemptConfig);
          if (continuation && handoffCount < maxHandoffs) {
            handoffs.push({
              fromSubagentId: result.subagentId,
              fromTaskId: result.taskId,
              status: result.status,
              errorKind: result.error?.kind,
              summary: continuation.summary,
              remainingWork: continuation.remainingWork,
            });
            handoffCount += 1;
            // Pass the bounded brief (not the raw objective) so the fresh
            // worker inherits the original scope/non-goals verbatim.
            delegatedTask = buildHandoffTask(baseBrief, continuation, handoffCount, maxHandoffs);
            continue;
          }

          const incomplete = result.report?.completion === 'partial';
          const baseStopReason: StopReason = incomplete
            ? 'handoff_limit'
            : result.status === 'success'
              ? 'end_turn'
              : result.status === 'timeout'
                ? 'subagent_timeout'
                : result.status === 'stopped'
                  ? 'aborted'
                  : 'budget_exhausted';
          const errorKind = result.error?.kind;
          const retryable = result.error?.retryable;
          const backoffMs = result.error?.backoffMs;
          const summary = incomplete
            ? `[${target}] partial checkpoint — handoff limit reached after ${handoffCount} continuation(s)`
            : buildDelegateSummary(i.role, result);
          let costUsd: number | undefined;
          try {
            costUsd = dir.snapshot().perSubagent[result.subagentId]?.cost;
          } catch {
            costUsd = undefined;
          }
          opts.events?.emit('delegate.completed', {
            sessionId,
            target,
            task: i.task,
            ok: result.status === 'success' && !incomplete,
            status: incomplete ? 'partial' : result.status,
            summary,
            durationMs: result.durationMs,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            costUsd,
            subagentId: result.subagentId,
          });

          return {
            ok: result.status === 'success' && !incomplete,
            status: incomplete ? 'partial' : result.status,
            stopReason: baseStopReason,
            errorKind,
            retryable,
            backoffMs,
            subagentId: result.subagentId,
            taskId: result.taskId,
            result: result.result,
            report: result.report,
            error: result.error,
            iterations: result.iterations,
            toolCalls: result.toolCalls,
            durationMs: result.durationMs,
            ...(partial ? { partial } : {}),
            ...(handoffs.length > 0 ? { handoffs } : {}),
            ...(incomplete
              ? {
                  hint: 'A clean partial checkpoint remains. Reinvoke delegate with a larger maxHandoffs or assign report.remaining_work explicitly.',
                }
              : hintForKind(errorKind, retryable, backoffMs, partial)
                ? { hint: hintForKind(errorKind, retryable, backoffMs, partial) }
                : {}),
            summary,
          };
        }
      } catch (err) {
        const message = toErrorMessage(err);
        // Resolve any "started" line the UI is showing — without this a
        // spawn/assign failure after delegate.started would leave a
        // dangling "Delegating…" entry with no outcome.
        opts.events?.emit('delegate.completed', {
          sessionId,
          target,
          task: i.task,
          ok: false,
          status: 'error',
          summary: `[${target}] failed — ${message}`,
          durationMs: 0,
          iterations: 0,
          toolCalls: 0,
        });
        return {
          ok: false,
          stopReason: 'error' as const,
          error: message,
        };
      }
    },
  };
}

type DelegateAttemptResult =
  | TaskResult
  | { __timeout: true }
  | { __emptyResult: true }
  | { __aborted: true };

interface DelegateHandoff {
  fromSubagentId: string;
  fromTaskId: string;
  status: TaskResult['status'];
  errorKind?: string | undefined;
  summary: string;
  remainingWork: string;
}

interface DelegateContinuation {
  summary: string;
  remainingWork: string;
  partialText?: string | undefined;
}

async function awaitDelegateAttempt(
  director: Director,
  subagentId: string,
  taskId: string,
  timeoutMs: number,
  abortSignal?: AbortSignal,
): Promise<DelegateAttemptResult> {
  return new Promise<DelegateAttemptResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offAbort = () => {};
    const finish = (value: DelegateAttemptResult) => {
      /* v8 ignore next -- race-only: timer and awaitTasks can settle together */
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      offTool();
      offIter();
      offProgress();
      offAbort();
      resolve(value);
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => finish({ __timeout: true }), timeoutMs);
    };
    const bump = (event: { subagentId: string }) => {
      if (event.subagentId === subagentId) arm();
    };
    const offTool = director.fleet.filter('tool.executed', bump);
    const offIter = director.fleet.filter('iteration.started', bump);
    const offProgress = director.fleet.filter('tool.progress', bump);
    if (abortSignal) {
      const onAbort = () => finish({ __aborted: true });
      abortSignal.addEventListener('abort', onAbort, { once: true });
      offAbort = () => abortSignal.removeEventListener('abort', onAbort);
      if (abortSignal.aborted) onAbort();
    }
    arm();
    director
      .awaitTasks([taskId])
      .then((results) => finish(results[0] ?? { __emptyResult: true }))
      .catch(() => finish({ __timeout: true }));
  });
}

function freshHandoffConfig(
  cfg: SubagentConfig,
  role: string | undefined,
  handoffCount: number,
): SubagentConfig {
  return {
    ...cfg,
    id: role
      ? `${role}-${randomUUID().slice(0, 8)}`
      : `${cfg.name.toLowerCase().replace(/[^a-z0-9]+/g, '-') || 'subagent'}-handoff-${handoffCount}-${randomUUID().slice(0, 6)}`,
  };
}

function continuationFor(
  result: TaskResult,
  partial: { lastAssistantText?: string | undefined } | undefined,
  config: SubagentConfig,
): DelegateContinuation | undefined {
  if (result.report?.completion === 'partial' && result.report.remaining_work) {
    return {
      summary: result.report.summary,
      remainingWork: result.report.remaining_work,
      partialText: typeof result.result === 'string' ? result.result : partial?.lastAssistantText,
    };
  }
  const budgetKinds = new Set([
    'budget_iterations',
    'budget_tool_calls',
    'budget_tokens',
    'budget_cost',
    'budget_timeout',
  ]);
  const partialText = result.partial?.text ?? partial?.lastAssistantText;
  const mayHaveIsolatedWrites =
    config.worktree !== false &&
    config.worktree !== 'off' &&
    (!config.tools ||
      config.tools.some((tool) =>
        ['write', 'edit', 'replace', 'patch', 'bash', 'exec', 'install', 'format'].includes(tool),
      ));
  if (
    !mayHaveIsolatedWrites &&
    result.status !== 'success' &&
    result.error?.kind &&
    budgetKinds.has(result.error.kind) &&
    partialText
  ) {
    return {
      summary: `Prior worker stopped at ${result.error.kind} after ${result.iterations} iterations and ${result.toolCalls} tool calls.`,
      remainingWork:
        'Inspect the existing workspace and finish only the work that remains from the original task.',
      partialText,
    };
  }
  return undefined;
}

function buildHandoffTask(
  originalTask: string,
  continuation: DelegateContinuation,
  handoffCount: number,
  maxHandoffs: number,
): string {
  const partial = continuation.partialText?.trim().slice(-6_000);
  return [
    `Continue an oversized delegated task as fresh worker ${handoffCount} of ${maxHandoffs}.`,
    'Do not blindly repeat completed actions. Inspect the current workspace, git diff, tests, and any files named below before changing anything.',
    'If the remaining work is still too large, stop at a clean checkpoint and call submit_result with completion="partial" plus concrete remaining_work.',
    'If parallel help would materially improve the outcome and mail_send is available, send the leader an `ask` that names the exact helper task; do not spawn agents yourself.',
    `Original task:\n${originalTask}`,
    `Prior checkpoint summary:\n${continuation.summary}`,
    `Remaining work:\n${continuation.remainingWork}`,
    partial ? `Prior worker's last useful output:\n${partial}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

function instantiateRosterConfig(
  role: string,
  base: SubagentConfig,
  requestedTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
): SubagentConfig {
  const withBudget = applyRosterBudget({ ...base, role });
  const rosterTimeoutMs = FLEET_ROSTER_BUDGETS[role]?.timeoutMs;
  return {
    ...withBudget,
    // Without an explicit host wait, apply the role's tuned multi-hour
    // wall-clock budget. With an explicit wait, leave this unset so the buffer
    // logic above derives a slightly shorter child budget without clamping the
    // role defaults used by ordinary calls.
    timeoutMs: requestedTimeoutMs === undefined ? (rosterTimeoutMs ?? defaultTimeoutMs) : undefined,
    // Give each spawn a fresh id so parallel or repeated delegates
    // can use the same role safely.
    id: `${role}-${randomUUID().slice(0, 8)}`,
  };
}

type StopReason =
  | 'end_turn'
  | 'budget_exhausted'
  | 'subagent_timeout'
  | 'host_timeout'
  | 'handoff_limit'
  | 'aborted'
  | 'error';

/**
 * Per-kind orchestrator hint. Returned alongside the structured error
 * so the calling model has a concrete next step instead of "task
 * failed, good luck". Returns undefined for success / unknown kinds —
 * the caller checks for presence before including in output.
 */
export function hintForKind(
  kind: string | undefined,
  retryable: boolean | undefined,
  backoffMs: number | undefined,
  partial?: { lastAssistantText?: string | undefined } | undefined,
): string | undefined {
  if (!kind) return undefined;
  switch (kind) {
    case 'provider_rate_limit':
      return `Provider rate-limited. Retry safe after ${backoffMs ?? 5000}ms backoff. Consider a smaller model or fewer parallel delegates.`;
    case 'provider_5xx':
      return `Provider server error. Retry safe after ${backoffMs ?? 3000}ms backoff — usually transient.`;
    case 'provider_timeout':
      return 'Provider network timeout. Retry safe; reduce input size if it persists.';
    case 'provider_auth':
      return 'Provider rejected credentials. Cannot retry — fix the API key / config and re-invoke.';
    case 'context_overflow':
      return 'Subagent context exceeded the model limit. Narrow the task, use a larger-context model, or split into multiple delegates.';
    case 'budget_iterations':
    case 'budget_tool_calls':
    case 'budget_tokens':
    case 'budget_cost': {
      const base =
        'Subagent exhausted its budget. The coordinator may auto-extend; otherwise raise the matching `max*` field (e.g. maxToolCalls: 600) on the next delegate, or split the task.';
      if (partial?.lastAssistantText) {
        return `${base}\n\nPartial output produced before budget hit:\n${partial.lastAssistantText}`;
      }
      return base;
    }
    case 'budget_timeout': {
      const base =
        'Subagent hit its wall-clock budget. Raise `timeoutMs` on the next delegate or split the task.';
      if (partial?.lastAssistantText) {
        return `${base}\n\nPartial output produced before timeout:\n${partial.lastAssistantText}`;
      }
      return base;
    }
    case 'aborted_by_parent':
      return 'Subagent was aborted (user Ctrl+C, parent unwound, or sibling failure cascade). Not retryable until the abort condition is resolved.';
    case 'empty_response':
      return 'Subagent ended its turn with no text and no tool calls. Almost always a prompt / config issue — clarify the task or check the model.';
    case 'tool_failed': {
      const base = 'A tool inside the subagent returned ok:false. Retry with corrected inputs.';
      if (partial?.lastAssistantText) {
        return `${base}\n\nAgent reasoning before failure:\n${partial.lastAssistantText}`;
      }
      return base;
    }
    case 'bridge_failed':
      return 'Parent-child bridge transport failed. This is rare — restart the session and retry.';
    default:
      return retryable
        ? 'Failure classified as retryable. Try again with the same input.'
        : undefined;
  }
}

/**
 * Compact summary of what a subagent did — shown in chat history so
 * the user immediately sees the outcome without parsing the full result.
 */
function buildDelegateSummary(role: string | undefined, result: TaskResult): string {
  const roleLabel = role ?? 'subagent';
  const ms = result.durationMs;
  const duration =
    ms < 60_000
      ? `${Math.round(ms / 1000)}s`
      : ms < 3_600_000
        ? `${Math.round(ms / 60_000)}m`
        : `${(ms / 3_600_000).toFixed(1)}h`;

  if (result.status === 'success') {
    const preview = result.report?.summary
      ? result.report.summary.trim().slice(0, 120).replace(/\n+/g, ' ')
      : typeof result.result === 'string'
        ? result.result.trim().slice(0, 120).replace(/\n+/g, ' ')
        : null;
    const tail = preview ? ` — ${preview}` : '';
    return `[${roleLabel}] done in ${duration} (${result.iterations} iter, ${result.toolCalls} tools)${tail}`;
  }

  const errLabel = result.error?.kind ?? result.status;
  return `[${roleLabel}] ${result.status} after ${duration} (${result.iterations} iter, ${result.toolCalls} tools) — ${errLabel}`;
}

/**
 * Parse the per-subagent JSONL at `<sessionsRoot>/<runId>/<subagentId>.jsonl`
 * and pull out the last few useful pieces — the most recent assistant
 * text response, the stop reason, and a count of tool calls. Used by
 * `delegate` when the subagent timed out or exhausted budget without
 * returning a clean `finalText`, so the host LLM still sees what work
 * actually happened.
 */
async function readSubagentPartial(
  opts: CreateDelegateToolOptions,
  subagentId: string,
): Promise<
  | {
      lastAssistantText?: string | undefined;
      lastStopReason?: string | undefined;
      toolUsesObserved: number;
      events: number;
    }
  | undefined
> {
  if (!opts.sessionsRoot) return undefined;
  // Locate the JSONL. When `directorRunId` is provided we know the
  // exact path; otherwise scan the sessionsRoot for any subdir
  // containing this subagent id.
  const candidates: string[] = [];
  if (opts.directorRunId) {
    candidates.push(path.join(opts.sessionsRoot, opts.directorRunId, `${subagentId}.jsonl`));
  } else {
    try {
      const entries = await fsp.readdir(opts.sessionsRoot, { withFileTypes: true });
      for (const entry of entries) {
        if (entry.isDirectory()) {
          candidates.push(path.join(opts.sessionsRoot, entry.name, `${subagentId}.jsonl`));
        }
      }
    } catch {
      return undefined;
    }
  }
  for (const file of candidates) {
    let raw: string;
    try {
      raw = await fsp.readFile(file, 'utf8');
    } catch {
      continue;
    }
    const lines = raw.split('\n').filter((l) => l.trim());
    let lastAssistantText: string | undefined;
    let lastStopReason: string | undefined;
    let toolUses = 0;
    for (const line of lines) {
      try {
        const parsed = safeParse<{
          type: string;
          content?: unknown | undefined;
          stopReason?: string | undefined;
          name?: string | undefined;
        }>(line);
        if (!parsed.ok || !parsed.value) continue;
        const ev = parsed.value;
        if (ev.type === 'tool_use') toolUses += 1;
        if (ev.type === 'llm_response') {
          if (typeof ev.stopReason === 'string') lastStopReason = ev.stopReason;
          if (Array.isArray(ev.content)) {
            const txt = (
              ev.content as Array<{ type?: string | undefined; text?: string | undefined }>
            )
              .filter((b) => b.type === 'text')
              .map((b) => b.text ?? '')
              .join('\n')
              .trim();
            if (txt) lastAssistantText = txt;
          }
        }
      } catch {
        // best-effort: a single corrupt JSONL line or unexpected content
        // shape should not invalidate the entire session transcript
      }
    }
    return {
      lastAssistantText,
      lastStopReason,
      toolUsesObserved: toolUses,
      events: lines.length,
    };
  }
  return undefined;
}
