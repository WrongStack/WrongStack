import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { EventBus } from '../kernel/events.js';
import type { SubagentConfig, TaskResult } from '../types/multi-agent.js';
import type { JSONSchema, Tool } from '../types/tool.js';
import type { Director } from './director.js';
import { applyRosterBudget } from './fleet.js';
import { safeParse } from '../utils/safe-json.js';
import { toErrorMessage } from '../utils/error.js';

/**
 * Opaque host interface so this factory doesn't have to depend on the
 * CLI's `MultiAgentHost`. Any caller that exposes the same three
 * methods can wire `delegate` — including test doubles.
 */
export interface DelegateHost {
  /** True if a Director is already attached and running. */
  isDirectorMode(): boolean;
  /** Build (or return the cached) Director when director mode is on. */
  ensureDirector(): Promise<Director | null>;
  /**
   * Force-promote a non-director session into director mode at runtime.
   * Returns the Director, or null when promotion is impossible (e.g. a
   * non-director coordinator has already spawned subagents in the
   * legacy code path).
   */
  promoteToDirector(): Promise<Director | null>;
  /**
   * Optional: when promotion fails, return the human-readable reason.
   * Used to render an actionable error to the calling model instead of
   * the prior opaque "Director could not be activated" message.
   * Implementations may return null when they don't track the reason.
   */
  getPromotionBlockReason?(): string | null;
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
 * `delegate` — the only multi-agent tool a regular (non-director) agent
 * ever needs. It bundles spawn + assign + await into a single call and
 * transparently auto-promotes the host into director mode on first use.
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
  // Conservative default for the LLM's mental model.
  // The actual subagent budgets come from FLEET_ROSTER_BUDGETS (x10 higher)
  // and are applied in instantiateRosterConfig. This value only appears
  // in the schema to guide the LLM's delegation decisions — it does NOT
  // override the roster budget unless the caller explicitly passes it.
  const defaultTimeoutMs = opts.defaultTimeoutMs ?? 30 * 60 * 1000;
  const rosterIds = opts.roster ? Object.keys(opts.roster) : [];

  const inputSchema: JSONSchema = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description:
          'What the subagent should do — natural language, complete sentence(s). The subagent has its own tool slice, its own LLM call, and returns when its task is done.',
      },
      role: {
        type: 'string',
        description:
          rosterIds.length > 0
            ? `Roster role (preferred). One of: ${rosterIds.join(', ')}. Picks a pre-tuned config (prompt, budgets, tools) for that role.`
            : 'No roster is configured — pass `name` instead.',
        enum: rosterIds.length > 0 ? rosterIds : undefined,
      },
      name: {
        type: 'string',
        description:
          'Display name for free-form subagents (not using a roster role). The subagent gets a large default budget (3h, 5000 iter, 15000 tool calls). Required when `role` is omitted.',
      },
      provider: {
        type: 'string',
        description:
          'Provider id (e.g. "anthropic", "openai"). Defaults to the host provider when omitted.',
      },
      model: {
        type: 'string',
        description: 'Model id within the provider. Defaults to the host model when omitted.',
      },
      systemPromptOverride: {
        type: 'string',
        description: 'Optional extra prompt text appended to the role baseline.',
      },
      timeoutMs: {
        type: 'number',
        minimum: 1,
        description: `Wall-clock budget for this delegate in milliseconds. No hard cap — set as high as the task realistically needs (a monorepo audit can take hours, a single-file lint takes seconds). Default ${Math.round(defaultTimeoutMs / 1000 / 60)} minutes.`,
      },
      maxIterations: {
        type: 'number',
        minimum: 1,
        description:
          'Maximum LLM iterations the subagent may take. Unset = use the role/coordinator default. Raise this for tasks with many tool-think-tool cycles (deep code analysis, multi-file refactors).',
      },
      maxToolCalls: {
        type: 'number',
        minimum: 1,
        description:
          'Maximum number of tool invocations the subagent may make. Unset = use the role/coordinator default. Raise this for tasks that touch many files (large grep + read + report).',
      },
      idleTimeoutMs: {
        type: 'number',
        minimum: 1,
        description:
          'Idle timeout in ms: reap the subagent after this long with no activity. Resets on every iteration/tool call. Unset = use the role/coordinator default.',
      },
      maxTokens: {
        type: 'number',
        minimum: 1,
        description:
          'Maximum total tokens (input + output) the subagent may use. Unset = use the role/coordinator default.',
      },
      maxCostUsd: {
        type: 'number',
        minimum: 0,
        description:
          'Maximum estimated USD cost the subagent may incur. Unset = use the role/coordinator default.',
      },
    },
    required: ['task'],
  };

  return {
    name: 'delegate',
    description:
      "Hand a discrete piece of work to a dedicated subagent and wait for its result. The subagent has its own context, its own LLM call, and its own budget — use this when a task is self-contained, would otherwise blow up your context, or benefits from a specialized role (bug-hunter, security-scanner, refactor-planner, audit-log). For free-form coding tasks (not tied to a pre-defined role), pass `name` + `task` — the subagent runs as a general-purpose coding agent with a large default budget. YOU decide how big the budget is: pass `timeoutMs`, `maxIterations`, and `maxToolCalls` sized to the actual work. There is no hidden cap forcing a 3-minute / 80-iteration limit — if a monorepo audit needs 2 hours and 500 tool calls, ask for that. Call multiple delegates in parallel through the provider's parallel-tool-call surface to fan work out across roles.",
    usageHint:
      "Set `task` to a complete instruction. Either pick `role` from the roster (audit-log, bug-hunter, refactor-planner, security-scanner) or pass `name` to run a free-form coding agent. For non-trivial work, also pass `timeoutMs`, `maxIterations`, and `maxToolCalls`. Returns the subagent's `TaskResult` — including the textual `result`, iteration count, tool count, and duration. Auto-promotes the host into director mode on first call.",
    permission: 'auto',
    mutating: false,
    inputSchema,
    async execute(input: unknown) {
      const sessionId = opts.directorRunId;
      const i = (input ?? {}) as {
        task?: string | undefined;
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
      };

      if (typeof i.task !== 'string' || !i.task.trim()) {
        return { ok: false, error: '`task` is required.' };
      }

      // Human-friendly label for the subagent — surfaced in the
      // delegate.* events so UIs say "Delegating → bug-hunter" rather
      // than echoing an opaque generated id.
      const target = i.role ?? i.name ?? 'subagent';

      try {
        let director = await opts.host.ensureDirector();
        if (!director) {
          director = await opts.host.promoteToDirector();
        }
        if (!director) {
          const reason = opts.host.getPromotionBlockReason?.();
          return {
            ok: false,
            error:
              reason ??
              'Director could not be activated — multi-agent host already running in legacy non-director mode. Restart with `--director` for fleet support.',
          };
        }

        const timeoutMs = i.timeoutMs ?? defaultTimeoutMs;

        let cfg: SubagentConfig;
        if (i.role) {
          const base = opts.roster?.[i.role];
          if (!base) {
            return {
              ok: false,
              error: `Unknown role "${i.role}". Available: ${rosterIds.join(', ') || '(no roster configured)'}.`,
            };
          }
          cfg = instantiateRosterConfig(i.role, base);
          if (i.systemPromptOverride) cfg.systemPromptOverride = i.systemPromptOverride;
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

        // Announce the delegation before we block — UIs render a
        // "started" line immediately so the (often minutes-long) wait
        // doesn't look idle.
        opts.events?.emit('delegate.started', { sessionId, target, task: i.task });

        const subagentId = await director.spawn(cfg);
        const taskId = await director.assign({
          id: `${randomUUID()}`,
          description: i.task,
          subagentId,
        });
        // Heartbeat-aware host await: `timeoutMs` is treated as a SILENCE
        // tolerance, not a hard wall-clock cap. The deadline resets every
        // time the subagent emits a tool/iteration event, so a subagent
        // that keeps making progress is never killed for being slow —
        // only a genuinely stalled one (no events for `timeoutMs`) trips
        // the host timeout. Mirrors the budget's heartbeat auto-extend.
        const dir = director;
        const result = await new Promise<
          TaskResult | { __timeout: true } | { __emptyResult: true }
        >((resolve) => {
          let settled = false;
          let timer: ReturnType<typeof setTimeout> | undefined;
          const finish = (value: TaskResult | { __timeout: true } | { __emptyResult: true }) => {
            if (settled) return;
            settled = true;
            if (timer) clearTimeout(timer);
            offTool();
            offIter();
            offProgress();
            resolve(value);
          };
          const arm = () => {
            if (timer) clearTimeout(timer);
            timer = setTimeout(() => finish({ __timeout: true }), timeoutMs);
          };
          const bump = (e: { subagentId: string }) => {
            if (e.subagentId === subagentId) arm();
          };
          const offTool = dir.fleet.filter('tool.executed', bump);
          const offIter = dir.fleet.filter('iteration.started', bump);
          // tool.progress fires for streamed bash output, fetch byte progress,
          // and other long-duration tools — these are forward motion events
          // that should reset the idle timer just like iteration.started does.
          const offProgress = dir.fleet.filter('tool.progress', bump);
          arm();
          dir
            .awaitTasks([taskId])
            .then((r) => finish(r[0] ?? { __emptyResult: true }))
            .catch(() => finish({ __timeout: true }));
        });

        if ('__timeout' in result) {
          const partial = await readSubagentPartial(opts, subagentId);
          opts.events?.emit('delegate.completed', {
            sessionId,
            target,
            task: i.task,
            ok: false,
            status: 'host_timeout',
            summary: `[${target}] timed out — no result within ${Math.round(timeoutMs / 1000)}s`,
            durationMs: timeoutMs,
            iterations: partial?.events ?? 0,
            toolCalls: partial?.toolUsesObserved ?? 0,
            subagentId,
          });
          return {
            ok: false,
            stopReason: 'host_timeout',
            error: `Subagent did not finish within ${timeoutMs}ms.`,
            hint: 'Reduce scope of the next delegate, raise timeoutMs, or use spawn_subagent + await_tasks for long-running work.',
            subagentId,
            taskId,
            partial,
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
            hint: 'Check fleet state with /fleet status, then retry or reassign the task.',
            subagentId,
            taskId,
            partial,
          };
        }

        const baseStopReason: StopReason =
          result.status === 'success'
            ? 'end_turn'
            : result.status === 'timeout'
              ? 'subagent_timeout'
              : result.status === 'stopped'
                ? 'aborted'
                : 'budget_exhausted';
        const partial =
          result.status === 'success' ? undefined : await readSubagentPartial(opts, subagentId);

        const errorKind = result.error?.kind;
        const retryable = result.error?.retryable;
        const backoffMs = result.error?.backoffMs;

        // Build a short summary for the chat history so the user sees
        // what the subagent accomplished without digging into the full result.
        const summary = buildDelegateSummary(i.role, result);

        // Per-subagent cost from the director's usage aggregator, when it
        // tracks one. Best-effort: undefined if pricing isn't wired.
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
          ok: result.status === 'success',
          status: result.status,
          summary,
          durationMs: result.durationMs,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          costUsd,
          subagentId: result.subagentId,
        });

        return {
          ok: result.status === 'success',
          status: result.status,
          stopReason: baseStopReason,
          errorKind,
          retryable,
          backoffMs,
          subagentId: result.subagentId,
          taskId: result.taskId,
          result: result.result,
          error: result.error,
          iterations: result.iterations,
          toolCalls: result.toolCalls,
          durationMs: result.durationMs,
          ...(partial ? { partial } : {}),
          ...(hintForKind(errorKind, retryable, backoffMs, partial)
            ? { hint: hintForKind(errorKind, retryable, backoffMs, partial) }
            : {}),
          // Summary is included so callers (TUI, CLI renderer) can surface
          // it as a chat history line — the LLM also sees it for continuity.
          summary,
        };
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

function instantiateRosterConfig(role: string, base: SubagentConfig): SubagentConfig {
  // Apply the x10 roster budget so subagents get far more running time
  // and iterations than the LLM is told about in the schema.
  // The LLM sees a conservative 30-min default; the subagent actually
  // gets 7.5–10 hours depending on role.
  const withBudget = applyRosterBudget({ ...base, role });
  return {
    ...withBudget,
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
    const preview =
      typeof result.result === 'string'
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
