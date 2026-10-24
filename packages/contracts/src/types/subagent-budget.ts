import type { EventBus } from '../kernel/events.js';
import type { Usage } from './provider.js';

export type BudgetKind =
  | 'tool_calls'
  | 'iterations'
  | 'tokens'
  | 'timeout'
  | 'idle_timeout'
  | 'cost';

export class BudgetExceededError extends Error {
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly observed: number;

  constructor(kind: BudgetKind, limit: number, observed: number) {
    super(`Budget exceeded: ${kind} (limit=${limit}, observed=${observed})`);
    this.name = 'BudgetExceededError';
    this.kind = kind;
    this.limit = limit;
    this.observed = observed;
  }
}

export interface BudgetLimits {
  maxIterations?: number | undefined;
  maxToolCalls?: number | undefined;
  maxTokens?: number | undefined;
  /** Estimated USD cost ceiling. */
  maxCostUsd?: number | undefined;
  /**
   * Hard wall-clock timeout measured from `start()`. Off by default — set it
   * explicitly only when a task must finish within an absolute window. For
   * the everyday "don't kill an agent that's still working" guard, prefer
   * `idleTimeoutMs`, which resets on activity.
   */
  timeoutMs?: number | undefined;
  /**
   * Idle timeout: the maximum gap (ms) between activity signals (iterations,
   * tool calls, token usage, streamed progress) before the subagent is
   * considered hung and reaped. Unlike `timeoutMs`, an actively-working
   * agent continuously resets this clock via `markActivity()`, so it never
   * trips on a long-but-productive run — only on a genuine stall.
   */
  idleTimeoutMs?: number | undefined;
}

/**
 * Controls how the budget behaves when `onThreshold` is set and a limit is hit.
 *
 * `'auto'` — emit `budget.threshold_reached` on the EventBus and wait for a
 * coordinator response (extend/stop). If no listener responds within
 * `DECISION_TIMEOUT_MS` the decision defaults to `'stop'`.
 * `'sync'` — do not emit any event; treat the threshold as a hard stop and
 * throw `BudgetExceededError` synchronously. Useful for fire-and-forget
 * subagents that have an `onThreshold` handler for logging/metrics but are
 * not wired into a coordinator.
 *
 * @default 'auto'
 */
export type BudgetNegotiationMode = 'auto' | 'sync';

export type BudgetSessionIdSource = string | (() => string | undefined);

export interface SubagentBudgetOptions {
  sessionId?: BudgetSessionIdSource | undefined;
  /** Owning subagent id — used to address the graceful-finish event. */
  subagentId?: string | undefined;
  /**
   * Wall-clock enforcement is owned EXCLUSIVELY by the coordinator watchdog
   * (`executeSubagentWithTimeout`). Set for `gracefulFinish` runs: their
   * notify-then-bound lifecycle must not be raced by `checkTimeout()` calls
   * from `tool.progress` heartbeats, which can fire in the window between a
   * deadline crossing and the watchdog's own tick — starting legacy
   * negotiation that either aborts before `subagent.finish_requested` is
   * delivered or grants an extension past the grace deadline (violating the
   * bounded maximum lifetime). Idle-timeout checks still run.
   */
  wallClockWatchdogOwned?: boolean | undefined;
}

export interface BudgetUsage {
  iterations: number;
  toolCalls: number;
  tokens: { input: number; output: number; total: number };
  costUsd: number;
  elapsedMs: number;
}

/**
 * Thrown by `SubagentBudget.record*` when a soft limit is hit and
 * an `onThreshold` handler is configured that wants to ask the
 * coordinator (via `budget.threshold_reached` event). The runner
 * catches this and awaits the embedded `decision` promise to get
 * the coordinator's extend/stop decision.
 *
 * Distinct from `BudgetExceededError` which is a hard stop.
 */
export class BudgetThresholdSignal extends Error {
  readonly kind: BudgetKind;
  readonly limit: number;
  readonly used: number;
  /** Resolves to 'extend' (with optional new limits) or 'stop' */
  readonly decision: Promise<BudgetThresholdDecision>;

  constructor(
    kind: BudgetKind,
    limit: number,
    used: number,
    decision: Promise<BudgetThresholdDecision>,
  ) {
    super(`Budget soft limit: ${kind} (limit=${limit}, used=${used})`);
    this.name = 'BudgetThresholdSignal';
    this.kind = kind;
    this.limit = limit;
    this.used = used;
    this.decision = decision;
  }
}

export type BudgetThresholdDecision = 'stop' | { extend: Partial<BudgetLimits> };

/**
 * Callback invoked when a budget limit is about to be exceeded.
 * Return 'throw' for hard stop (default — throws BudgetExceededError).
 * Return 'continue' to allow one more unit and re-check next time.
 * Return a Promise to ask the coordinator via `budget.threshold_reached`
 * event (uses the same grant/deny pattern as `iteration.limit_reached`).
 */
export type BudgetThresholdHandler = (info: {
  kind: BudgetKind;
  used: number;
  limit: number;
  requestDecision: () => Promise<BudgetThresholdDecision>;
  /**
   * Direct grant/deny hooks for SYNCHRONOUS policy or recording handlers that
   * decide in-process without a wired `budget.threshold_reached` listener
   * (e.g. the coordinator watchdog). `extend` patches the limits in place;
   * `deny` records the intent to stop. Production listener-driven handlers use
   * `requestDecision()` instead and can ignore these.
   */
  extend?: (extra: Partial<BudgetLimits>) => void;
  deny?: () => void;
}) =>
  | 'throw'
  | 'continue'
  | 'stop'
  | { extend: Partial<BudgetLimits> }
  | Promise<BudgetThresholdDecision>;

/**
 * What a subagent runner touches on its budget (`SubagentRunContext.budget`).
 * Implementation: `coordination/subagent-budget.ts`.
 */
export interface SubagentBudgetPort {
  /** Effective limits for this subagent (after coordinator defaults and extensions). */
  readonly limits: Readonly<BudgetLimits>;
  /** Bus threshold / finish signals are emitted on; the runner binds the agent's bus. */
  _events?: EventBus | undefined;
  /** Decides whether a crossed threshold stops the run or extends the limits. */
  onThreshold: BudgetThresholdHandler | undefined;
  markActivity(): void;
  recordIteration(): void;
  recordToolCall(): void;
  recordUsage(usage: Usage, costUsd?: number): void;
  usage(): BudgetUsage;
  /** Throws `BudgetExceededError` / `BudgetThresholdSignal` past the wall-clock limit. */
  checkTimeout(): void;
}
