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
import type { EventBus } from '@wrongstack/contracts/kernel/events';
import { ToolValidationError } from '@wrongstack/contracts/types/errors';
import type { SubagentConfig } from '@wrongstack/contracts/types/multi-agent';
import type { DispatchLogEntry } from '../agents/dispatch-log.js';
import type { Director } from '../director.js';
import { readLeaderEffort, readSpawnSkills } from '../director-spawn-model.js';
import { dispatchAgent, rosterDispatchCatalog } from '../dispatcher.js';
import { isExternalAgentProvider } from '../external-agent-provider.js';
import { applyRosterBudget, FLEET_ROSTER_BUDGETS } from '../fleet.js';
import {
  composeBoundedTaskDescription,
  parseTaskBoundary,
  type TaskBoundary,
} from '../task-boundary.js';
import type {
  DelegateCompletedPayload,
  DelegateInput,
  DelegateMode,
  DelegateResult,
  DelegationRuntimeOptions,
} from './delegation-types.js';

/**
 * Publish one delegation outcome on both wire names.
 *
 * `delegate.completed` carries the full lifecycle payload the WebUI timeline
 * and the Telegram bridge render. `subagent.done` is the narrower kernel
 * event declared for exactly this moment (see `kernel/events/agent-events.ts`)
 * and has no other emitter anywhere: the agent run loop folds it into
 * `RunResult.delegateSummaries`, the bundled `agent-handoff` plugin posts its
 * mailbox note from it, and the collab mirror forwards it to observers. Both
 * emits must stay in this one helper — five separate call sites each raising
 * only `delegate.completed` is how those three consumers went silent.
 */
export function makeDelegateCompletedEmitter(
  events: EventBus | undefined,
): (payload: DelegateCompletedPayload) => void {
  return (payload) => {
    events?.emit('delegate.completed', payload);
    events?.emit('subagent.done', {
      sessionId: payload.sessionId,
      summary: payload.summary,
      ok: payload.ok,
    });
  };
}

// ── Phase 0: input validation ───────────────────────────────────────────────

export type ValidatedDelegation =
  | {
      kind: 'ok';
      input: DelegateInput & { task: string };
      boundary: TaskBoundary;
      target: string;
    }
  | { kind: 'result'; result: DelegateResult };

/**
 * Synchronous input gates. Throws `ToolValidationError` for bad input (the
 * executor marks those `is_error`); returns a data result only for the
 * "already interrupted" case, which is an outcome, not a caller mistake.
 */
export function validateDelegationInput(
  raw: unknown,
  abortSignal: AbortSignal | undefined,
): ValidatedDelegation {
  const i = (raw ?? {}) as DelegateInput;
  if (typeof i.task !== 'string' || !i.task.trim()) {
    throw new ToolValidationError({ message: '`task` is required.', field: 'task' });
  }
  if (abortSignal?.aborted) {
    return {
      kind: 'result',
      result: {
        ok: false,
        stopReason: 'aborted',
        error: 'Delegation cancelled before spawn — the run was interrupted.',
      },
    };
  }
  // Bad effort is a caller mistake: reject before any spawn cost, naming the levels.
  readLeaderEffort(i.effort);
  // Hard boundary gate: a delegate without explicit edges produces a worker
  // that guesses its own scope. Reject before any spawn cost is incurred,
  // with an error that teaches the fix in one retry.
  const boundary = parseTaskBoundary(i);
  if (!boundary.ok) {
    throw new ToolValidationError({
      message: `delegate rejected — task boundary incomplete: ${boundary.error}${boundary.hint ? `\n${boundary.hint}` : ''}`,
      field: 'scope',
    });
  }
  return {
    kind: 'ok',
    input: i as DelegateInput & { task: string },
    boundary: boundary.boundary,
    // Human-friendly label for the subagent — surfaced in the delegate.*
    // events so UIs say "Delegating → bug-hunter" rather than an opaque id.
    target: i.role ?? i.name ?? 'subagent',
  };
}

// ── Phase 1: prepare ────────────────────────────────────────────────────────

export interface PreparedDelegation {
  opts: DelegationRuntimeOptions;
  input: DelegateInput & { task: string };
  sessionId: string | undefined;
  target: string;
  mode: DelegateMode;
  director: Director;
  cfg: SubagentConfig;
  timeoutMs: number;
  maxHandoffs: number;
  /** Objective + boundary block — the canonical brief. */
  baseBrief: string;
  launchModePreface: string;
  emitCompleted: (payload: DelegateCompletedPayload) => void;
  /**
   * How this delegation chose its role, recorded once the first spawn is
   * admitted (see `startDelegationAttempt`). Without it `/fleet routing` saw
   * only `spawn_subagent`, which the leader rarely calls.
   */
  routing: DispatchLogEntry;
}

export const WAIT_LAUNCH_PREFACE = [
  'Launch-mode guidance (delegate): you were launched via the synchronous `delegate` tool, so the leader is blocked on this call for the full duration of your run.',
  'If, after inspecting the task, you judge it will run for tens of minutes or hours (multi-file refactor, monorepo audit, long-running build/test, sweeping migration), do NOT silently grind through it under the blocking call.',
  'Escalate to the leader with `session_note to="leader"` when that tool is registered (same-session, next iteration). Fall back to `mail_send` or `mailbox action=send` only for cross-session mail. Send a `steer` or `ask`, e.g. *"my task is going to run long, please spawn a subagent instead"*, so the leader can re-dispatch asynchronously via `spawn_subagent` + `assign_task`.',
  'Then return a clean checkpoint with `completion:"partial"` and a concrete `remaining_work`.',
  'If the task is short and bounded, just do it end-to-end — do not over-trigger the escalation for normal work.',
].join('\n\n');

export const BACKGROUND_LAUNCH_PREFACE = [
  'Launch-mode guidance (delegate): you were launched via `delegate` in background mode. The leader is NOT blocked on you — it keeps working, and your final result is delivered to it automatically when you finish.',
  'Do the task end-to-end within its boundary. Do not stop early just because the work is long; if it genuinely outgrows one worker, return a clean checkpoint with `completion:"partial"` and a concrete `remaining_work` so a fresh worker can continue.',
  'If you need a decision or parallel help from the leader mid-task, use `session_note to="leader"` (kind `ask` or `steer`) when that tool is registered; fall back to `mail_send` only for cross-session mail. Do not send your final result by mail — submitting it is enough.',
].join('\n\n');

/** The worker-facing launch preface for a delegation mode. */
export function launchPrefaceFor(mode: DelegateMode): string {
  return mode === 'background' ? BACKGROUND_LAUNCH_PREFACE : WAIT_LAUNCH_PREFACE;
}

/**
 * Resolve the director and shape the subagent config. Throws
 * `ToolValidationError` for an unknown role / missing name. Other errors
 * (director construction failures) propagate to the caller's catch, which
 * resolves them through `failDelegation`.
 */
export async function prepareDelegation(
  validated: Extract<ValidatedDelegation, { kind: 'ok' }>,
  opts: DelegationRuntimeOptions,
  ctx: { sessionId: string | undefined; mode: DelegateMode },
): Promise<
  { kind: 'ready'; prepared: PreparedDelegation } | { kind: 'result'; result: DelegateResult }
> {
  const { boundary } = validated;
  let { input: i, target } = validated;
  let director = await opts.host.ensureDirector();
  if (!director) {
    director = await opts.host.promoteToDirector();
  }
  if (!director) {
    return {
      kind: 'result',
      result: {
        ok: false,
        error: 'Director could not be activated — fleet orchestration is unavailable.',
      },
    };
  }

  const defaultTimeoutMs = opts.defaultTimeoutMs;
  const timeoutMs = i.timeoutMs ?? defaultTimeoutMs;

  // Neither a role nor a free-form name: the leader described the work and
  // left the pick to us. Route the task text the same way `spawn_subagent`
  // routes `description`, so the leader never has to recall one of ~80 ids.
  let routing: DispatchLogEntry;
  if (!i.role && !i.name && opts.roster && Object.keys(opts.roster).length > 0) {
    const dispatched = await dispatchAgent(i.task, {
      classifier: director.dispatchClassifier,
      catalog: rosterDispatchCatalog(opts.roster),
    });
    i = { ...i, role: dispatched.role };
    target = dispatched.role;
    routing = {
      at: new Date().toISOString(),
      role: dispatched.role,
      source: 'description',
      tool: 'delegate',
      method: dispatched.method,
      confidence: dispatched.confidence,
      alternatives: dispatched.alternatives.map((candidate) => candidate.role),
      matched: dispatched.matched,
    };
  } else {
    routing = {
      at: new Date().toISOString(),
      role: i.role ?? i.name ?? 'subagent',
      source: i.role ? 'explicit-role' : 'name-only',
      tool: 'delegate',
    };
  }

  let cfg: SubagentConfig;
  if (i.role) {
    const base = opts.roster?.[i.role];
    if (!base) {
      const availableRoles = opts.roster ? Object.keys(opts.roster) : [];
      throw new ToolValidationError({
        message: `Unknown role "${i.role}". Available: ${availableRoles.join(', ') || '(no roster configured)'}.`,
        field: 'role',
      });
    }
    cfg = instantiateRosterConfig(
      i.role,
      i.provider ? { ...base, provider: i.provider } : base,
      i.timeoutMs,
      defaultTimeoutMs,
    );
    // NOTE: do NOT write `i.systemPromptOverride` into `cfg.systemPromptOverride`
    // here — the roster override must survive until `startDelegationAttempt`
    // layers roster + caller overrides in precedence order.
    // Leader-chosen, so the session plan's lock may override it.
    if (i.provider) {
      cfg.provider = i.provider;
      cfg.modelChosenByLeader = true;
    }
    if (i.model) {
      cfg.model = i.model;
      cfg.modelChosenByLeader = true;
    }
  } else {
    if (!i.name) {
      throw new ToolValidationError({
        message:
          'Either `role` (from the roster) or `name` is required when no roster is configured.',
        field: 'role',
      });
    }
    cfg = {
      name: i.name,
      provider: i.provider,
      model: i.model,
      systemPromptOverride: i.systemPromptOverride,
      ...(i.provider || i.model ? { modelChosenByLeader: true } : {}),
    };
    // Apply generic budget so free-form subagents get the x10 budget even
    // without a roster role.
    cfg = applyRosterBudget({ ...cfg, name: i.name });
  }

  // Record the tier and which budgets the caller pinned, so the spawn-time
  // tier layer can tighten roster defaults without ever overriding a number
  // the caller typed here.
  // Leader-chosen effort travels apart from the provider/model pin so a locked
  // session lane, which takes the model back, still leaves the effort decision
  // with the leader (see `SubagentConfig.leaderEffort`).
  const effort = readLeaderEffort(i.effort);
  if (effort) cfg.leaderEffort = effort;
  const skills = readSpawnSkills(i.skills);
  if (skills) cfg.requestedSkills = skills;
  if (i.tier) cfg.tier = i.tier;
  else if (!cfg.model && !cfg.provider && opts.suggestTier) {
    const suggested = await opts.suggestTier({ task: i.task, role: i.role });
    if (suggested) {
      cfg.tier = suggested;
      cfg.tierSuggested = true;
    }
  }
  const budgetPins: string[] = [];
  if (typeof i.maxIterations === 'number') budgetPins.push('maxIterations');
  if (typeof i.maxToolCalls === 'number') budgetPins.push('maxToolCalls');
  if (typeof i.maxTokens === 'number') budgetPins.push('maxTokens');
  if (typeof i.maxCostUsd === 'number') budgetPins.push('maxCostUsd');
  if (budgetPins.length) cfg.budgetPins = budgetPins;
  if (typeof i.maxIterations === 'number') cfg.maxIterations = i.maxIterations;
  if (typeof i.maxToolCalls === 'number') cfg.maxToolCalls = i.maxToolCalls;
  if (typeof i.idleTimeoutMs === 'number') cfg.idleTimeoutMs = i.idleTimeoutMs;
  if (typeof i.maxTokens === 'number') cfg.maxTokens = i.maxTokens;
  if (typeof i.maxCostUsd === 'number') cfg.maxCostUsd = i.maxCostUsd;

  const bufferMs = opts.subagentTimeoutBufferMs ?? 60_000;
  // Only FILL IN a budget timeout when the config has none — never clamp a
  // generous roster/generic budget DOWN to the host's await window. The host
  // await is heartbeat-based, so the subagent's own (auto-extending) budget is
  // the real ceiling.
  if (isExternalAgentProvider(cfg.provider)) {
    // Waiting for a delegation is distinct from limiting the external turn.
    // Do not convert the host wait window into a 30s child cap. A supplied
    // task deadline is honored exactly, without the internal worker buffer.
    cfg.timeoutMs = i.timeoutMs ?? cfg.timeoutMs;
  } else if (!cfg.timeoutMs) {
    cfg.timeoutMs = Math.max(30_000, timeoutMs - bufferMs);
  }

  return {
    kind: 'ready',
    prepared: {
      opts,
      input: i,
      sessionId: ctx.sessionId,
      target,
      mode: ctx.mode,
      director,
      cfg,
      timeoutMs,
      maxHandoffs: Math.min(8, Math.max(0, Math.floor(i.maxHandoffs ?? 1))),
      // Composing the boundary into `TaskSpec.description` means every
      // consumer of the canonical brief — runner input, transcripts, roll-ups,
      // handoff continuations — carries the edges without extra plumbing.
      baseBrief: composeBoundedTaskDescription(i.task, boundary),
      launchModePreface: launchPrefaceFor(ctx.mode),
      emitCompleted: makeDelegateCompletedEmitter(opts.events),
      routing,
    },
  };
}

export function instantiateRosterConfig(
  role: string,
  base: SubagentConfig,
  requestedTimeoutMs: number | undefined,
  defaultTimeoutMs: number,
): SubagentConfig {
  const withBudget = applyRosterBudget({ ...base, role });
  const rosterTimeoutMs = FLEET_ROSTER_BUDGETS[role]?.timeoutMs;
  return {
    ...withBudget,
    // ACP only uses a supplied deadline. Internal workers without an explicit
    // host wait use the role's tuned budget; with one, the buffer logic below
    // derives a slightly shorter child budget.
    timeoutMs: isExternalAgentProvider(base.provider)
      ? (requestedTimeoutMs ?? base.timeoutMs)
      : requestedTimeoutMs === undefined
        ? (rosterTimeoutMs ?? defaultTimeoutMs)
        : undefined,
    // Fresh id per spawn so parallel or repeated delegates can share a role.
    id: `${role}-${randomUUID().slice(0, 8)}`,
  };
}
