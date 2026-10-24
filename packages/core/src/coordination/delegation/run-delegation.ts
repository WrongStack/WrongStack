/**
 * The `delegate` lifecycle, split into its three phases so the same code can
 * run blocking (the tool awaits `settleDelegation`) or in the background (a
 * `DelegationTracker` owns the settle promise and delivers the outcome to the
 * leader later).
 *
 *  - `validateDelegationInput` — synchronous input gates (throw on bad input).
 *  - `prepareDelegation`       — director resolution, config/budget shaping,
 *                                launch preface. No spawn yet.
 *  - `startDelegationAttempt`  — spawn + (attempt 0) `delegate.started` +
 *                                ownership + assign.
 *  - `settleDelegation`        — await, outcome table, handoff continuations,
 *                                `delegate.completed` + `subagent.done`.
 *
 * `makeDelegateCompletedEmitter` is the ONLY place `delegate.completed` and
 * `subagent.done` are raised. Keep every completion branch routed through it.
 *
 * @module coordination/delegation/run-delegation
 */
import { randomUUID } from 'node:crypto';
import type { EventMap } from '@wrongstack/contracts/kernel/events';
import type { SubagentConfig, TaskResult } from '@wrongstack/contracts/types/multi-agent';
import { toErrorMessage } from '../../utils/error.js';
import type { Director } from '../director.js';
import type { PreparedDelegation } from './delegation-preparation.js';
import { buildDelegateSummary, hintForKind, readSubagentPartial } from './delegation-results.js';
import type {
  DelegateCompletedPayload,
  DelegateContinuation,
  DelegateHandoff,
  DelegateResult,
  StopReason,
} from './delegation-types.js';

export {
  makeDelegateCompletedEmitter,
  prepareDelegation,
  validateDelegationInput,
} from './delegation-preparation.js';

// ── Phase 2: start one attempt ──────────────────────────────────────────────

export interface DelegationAttempt {
  subagentId: string;
  taskId: string;
  /** 0 = first worker; n = n-th handoff continuation. */
  handoffCount: number;
  attemptConfig: SubagentConfig;
}

export interface DelegationHooks {
  /**
   * Fired once the attempt's task id is known and BEFORE assign, so an owner
   * (the tracker) is current even when assign settles synchronously.
   */
  onAttempt?: ((attempt: DelegationAttempt) => void) | undefined;
  /** Extra fields stamped on `delegate.started` (attempt 0 only). */
  startedExtras?: ((info: { taskId: string }) => Partial<EventMap['delegate.started']>) | undefined;
  /** Extra fields stamped on `delegate.completed`. */
  completedExtras?:
    | ((outcome: {
        taskId?: string | undefined;
        stopReason: StopReason;
        result: DelegateResult;
      }) => Partial<DelegateCompletedPayload>)
    | undefined;
  /**
   * Await through `Director.observeTask` instead of `awaitTasks`, so the
   * delegation is not counted as a leader waiter (background mode).
   */
  observe?: boolean | undefined;
  /** A leader-side in-band waiter consumed this attempt's result. */
  onLeaderConsumed?: ((taskId: string) => void) | undefined;
}

type OwnershipPorts = {
  markTaskOwned?: ((taskId: string) => void) | undefined;
  observeTask?:
    | ((
        taskId: string,
        cb: (result: TaskResult, info: { leaderConsumed: boolean }) => void,
      ) => () => void)
    | undefined;
};

export async function startDelegationAttempt(
  prepared: PreparedDelegation,
  handoffCount: number,
  description: string,
  hooks?: DelegationHooks,
): Promise<DelegationAttempt> {
  const { director: dir, cfg, input: i, sessionId, target } = prepared;
  const attemptConfig = (() => {
    const base = handoffCount === 0 ? cfg : freshHandoffConfig(cfg, i.role, handoffCount);
    // Handoffs use `buildHandoffTask` (which carries its own escalation
    // language) and must NOT receive the first-attempt preface.
    if (handoffCount !== 0) return base;
    // First attempt only: inject the launch-mode preface through the subagent
    // prompt layer (`systemPromptOverride`), composing last per
    // director-prompts.ts layering. Layer in precedence order so a roster
    // override is not clobbered: [preface] + [roster] + [caller if distinct].
    const baseOverride = base.systemPromptOverride;
    const callerOverride = i.systemPromptOverride;
    const segments = [prepared.launchModePreface];
    if (baseOverride && baseOverride.trim().length > 0) segments.push(baseOverride);
    if (callerOverride && callerOverride.trim().length > 0 && callerOverride !== baseOverride) {
      segments.push(callerOverride);
    }
    return { ...base, systemPromptOverride: segments.join('\n\n') };
  })();
  // Stamp the worker with the conversation that asked for it, so lifecycle,
  // budget and spend events file under the delegating conversation.
  const subagentId = await dir.spawn({ ...attemptConfig, originSessionId: sessionId });
  const plannedTaskId = randomUUID();
  if (handoffCount === 0) {
    // Recorded only once the spawn is admitted, as `spawn_subagent` does: a
    // worker refused by a budget cap never ran.
    dir.onSpawnRouted?.({ ...prepared.routing, subagentId, ...(sessionId ? { sessionId } : {}) });
    prepared.opts.events?.emit('delegate.started', {
      sessionId,
      target,
      task: i.task,
      subagentId,
      ...(hooks?.startedExtras?.({ taskId: plannedTaskId }) ?? {}),
    });
  }
  // Ownership BEFORE assign: `assign` settles a `stopped` result synchronously
  // when work_complete was already called, and that settlement must already
  // see this task as delegate-owned (no leader notifier mail).
  (dir as OwnershipPorts).markTaskOwned?.(plannedTaskId);
  const planned: DelegationAttempt = {
    subagentId,
    taskId: plannedTaskId,
    handoffCount,
    attemptConfig,
  };
  hooks?.onAttempt?.(planned);
  const taskId = await dir.assign({ id: plannedTaskId, description, subagentId });
  if (taskId === plannedTaskId) return planned;
  const actual: DelegationAttempt = { ...planned, taskId };
  hooks?.onAttempt?.(actual);
  return actual;
}

// ── Phase 3: settle ─────────────────────────────────────────────────────────

/**
 * Resolve a start/prepare failure: resolve any "started" line the UI is
 * showing, and return the structured error result.
 */
export function failDelegation(
  info: {
    sessionId: string | undefined;
    target: string;
    task: string;
    emitCompleted: (payload: DelegateCompletedPayload) => void;
    extras?: Partial<DelegateCompletedPayload> | undefined;
  },
  err: unknown,
): DelegateResult {
  const message = toErrorMessage(err);
  info.emitCompleted({
    sessionId: info.sessionId,
    target: info.target,
    task: info.task,
    ok: false,
    status: 'error',
    summary: `[${info.target}] failed — ${message}`,
    durationMs: 0,
    iterations: 0,
    toolCalls: 0,
    ...(info.extras ?? {}),
  });
  return { ok: false, stopReason: 'error', error: message };
}

/**
 * Await the attempt (and any handoff continuations) to a final outcome and
 * publish it. Never throws: failures resolve to the structured error result.
 */
export async function settleDelegation(
  prepared: PreparedDelegation,
  first: DelegationAttempt,
  abortSignal: AbortSignal | undefined,
  hooks?: DelegationHooks,
): Promise<DelegateResult> {
  const { director: dir, opts, input: i, sessionId, target, timeoutMs, maxHandoffs } = prepared;
  const emit = (
    payload: DelegateCompletedPayload,
    outcome: { taskId?: string | undefined; stopReason: StopReason; result: DelegateResult },
  ): DelegateResult => {
    prepared.emitCompleted({ ...payload, ...(hooks?.completedExtras?.(outcome) ?? {}) });
    return outcome.result;
  };
  const handoffs: DelegateHandoff[] = [];
  let attempt = first;
  try {
    for (;;) {
      const { subagentId, taskId, handoffCount, attemptConfig } = attempt;
      const result = await awaitDelegateAttempt(
        dir,
        subagentId,
        taskId,
        timeoutMs,
        abortSignal,
        hooks,
      );

      if ('__aborted' in result) {
        try {
          await dir.terminate(subagentId);
        } catch {
          /* best-effort */
        }
        const partial = await readSubagentPartial(opts, subagentId);
        return emit(
          {
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
          },
          {
            taskId,
            stopReason: 'aborted',
            result: {
              ok: false,
              stopReason: 'aborted',
              error: 'Delegated task aborted — the run was interrupted.',
              subagentId,
              taskId,
              partial,
              ...(handoffs.length > 0 ? { handoffs } : {}),
            },
          },
        );
      }

      if ('__timeout' in result) {
        try {
          await dir.terminate(subagentId);
        } catch {
          /* best-effort */
        }
        const partial = await readSubagentPartial(opts, subagentId);
        return emit(
          {
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
          },
          {
            taskId,
            stopReason: 'host_timeout',
            result: {
              ok: false,
              stopReason: 'host_timeout',
              error: `Subagent timed out: it did not finish or report progress within ${timeoutMs}ms.`,
              hint: 'Raise timeoutMs for unusually long single operations, or split the remaining work.',
              subagentId,
              taskId,
              partial,
              ...(handoffs.length > 0 ? { handoffs } : {}),
            },
          },
        );
      }

      if ('__emptyResult' in result) {
        const partial = await readSubagentPartial(opts, subagentId);
        return emit(
          {
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
          },
          {
            taskId,
            stopReason: 'error',
            result: {
              ok: false,
              stopReason: 'error',
              error: 'Director returned no task result for the delegated task.',
              hint: 'Check fleet state, then retry or reassign the task.',
              subagentId,
              taskId,
              partial,
              ...(handoffs.length > 0 ? { handoffs } : {}),
            },
          },
        );
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
        const next = handoffCount + 1;
        // Pass the bounded brief (not the raw objective) so the fresh worker
        // inherits the original scope/non-goals verbatim.
        const delegatedTask = buildHandoffTask(prepared.baseBrief, continuation, next, maxHandoffs);
        attempt = await startDelegationAttempt(prepared, next, delegatedTask, hooks);
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
              : // Every other failure used to read "budget_exhausted", so a worker
                // that crashed told the leader to raise a budget instead.
                result.error?.kind?.startsWith('budget_')
                ? 'budget_exhausted'
                : 'error';
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
      const hint = incomplete
        ? 'A clean partial checkpoint remains. Reinvoke delegate with a larger maxHandoffs or assign report.remaining_work explicitly.'
        : hintForKind(errorKind, retryable, backoffMs, partial);
      return emit(
        {
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
        },
        {
          taskId: result.taskId,
          stopReason: baseStopReason,
          result: {
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
            ...(hint ? { hint } : {}),
            summary,
          },
        },
      );
    }
  } catch (err) {
    const message = toErrorMessage(err);
    const failed: DelegateResult = { ok: false, stopReason: 'error', error: message };
    return failDelegation(
      {
        sessionId,
        target,
        task: i.task,
        emitCompleted: prepared.emitCompleted,
        extras: hooks?.completedExtras?.({
          taskId: attempt.taskId,
          stopReason: 'error',
          result: failed,
        }),
      },
      err,
    );
  }
}

// ── Helpers (moved verbatim from delegate-tool.ts) ──────────────────────────

type DelegateAttemptResult =
  | TaskResult
  | { __timeout: true }
  | { __emptyResult: true }
  | { __aborted: true };

async function awaitDelegateAttempt(
  director: Director,
  subagentId: string,
  taskId: string,
  timeoutMs: number,
  abortSignal: AbortSignal | undefined,
  hooks: DelegationHooks | undefined,
): Promise<DelegateAttemptResult> {
  return new Promise<DelegateAttemptResult>((resolve) => {
    let settled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let offAbort = () => {};
    let offObserve = () => {};
    const finish = (value: DelegateAttemptResult) => {
      /* v8 ignore next -- race-only: timer and awaitTasks can settle together */
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      offTool();
      offIter();
      offProgress();
      offAbort();
      offObserve();
      resolve(value);
    };
    // Above 2^31-1 ms setTimeout fires after ~1 ms (Node and Bun), which
    // terminated a worker given a very long timeoutMs: wait in capped steps.
    let deadline = 0;
    const wait = () => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return finish({ __timeout: true });
      timer = setTimeout(wait, Math.min(remaining, 2_147_483_647));
    };
    const arm = () => {
      if (timer) clearTimeout(timer);
      deadline = Date.now() + timeoutMs;
      timer = setTimeout(wait, Math.min(timeoutMs, 2_147_483_647));
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
      if (abortSignal.aborted) {
        onAbort();
        return;
      }
    }
    arm();
    const observeTask = (director as OwnershipPorts).observeTask;
    if (hooks?.observe && typeof observeTask === 'function') {
      // Not a waiter: a leader `await_tasks` on this id stays distinguishable.
      const off = observeTask.call(director, taskId, (result, info) => {
        if (info.leaderConsumed) hooks.onLeaderConsumed?.(result.taskId);
        finish(result);
      });
      if (settled) off();
      else offObserve = off;
      return;
    }
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

export function buildHandoffTask(
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
    'If parallel help would materially improve the outcome, `session_note to="leader" kind="ask"` (or `mail_send` if you must reach another session) naming the exact helper task; do not spawn agents yourself.',
    `Original task:\n${originalTask}`,
    `Prior checkpoint summary:\n${continuation.summary}`,
    `Remaining work:\n${continuation.remainingWork}`,
    partial ? `Prior worker's last useful output:\n${partial}` : '',
  ]
    .filter(Boolean)
    .join('\n\n');
}

export {
  buildDelegationResultExcerpt,
  hintForKind,
} from './delegation-results.js';
export type {
  DelegateHost,
  DelegateInput,
  DelegateMode,
  DelegateResult,
  DelegationRuntimeOptions,
} from './delegation-types.js';
