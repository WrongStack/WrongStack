import type { Usage } from '../types/provider.js';
import type { EventBus } from '../kernel/events.js';

export type BudgetKind = 'tool_calls' | 'iterations' | 'tokens' | 'timeout' | 'idle_timeout' | 'cost';

/**
 * Fraction of the wall-clock `timeoutMs` window at which a PROACTIVE extension
 * is negotiated — BEFORE the deadline is actually crossed. The coordinator
 * watchdog (`executeWithTimeout`) arms at `timeoutMs * TIMEOUT_PREEMPT_FRACTION`
 * so a still-progressing subagent gets its ceiling raised while it is below the
 * limit, and never enters a "timed out" state. Reactive enforcement at the real
 * deadline still stands for the no-progress / denied case. Shared so the asking
 * side and any future caller agree on the same lead point.
 */
export const TIMEOUT_PREEMPT_FRACTION = 0.85;

/**
 * Hard safety net for budget negotiation decisions. If no listener responds to
 * `budget.threshold_reached` within this window the negotiation defaults to
 * `'stop'`. Exported so the coordinator's watchdog can reuse the same ceiling
 * without hardcoding a second copy.
 */
export const DECISION_TIMEOUT_MS = 60_000;

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

export type BudgetThresholdDecision =
  | 'stop'
  | { extend: Partial<BudgetLimits> };

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
}) => 'throw' | 'continue' | 'stop' | { extend: Partial<BudgetLimits> } | Promise<BudgetThresholdDecision>;

/**
 * Per-subagent budget enforcement. Each subagent gets its own instance so a
 * runaway agent can't drain the cost ceiling of its siblings. All record/check
 * methods are O(1) and safe to call from hot paths.
 *
 * Behavior without `onThreshold`: hard stops synchronously on every limit hit.
 *
 * Behavior with `onThreshold` and `_mode === 'auto'`: emits `budget.threshold_reached`
 * on the EventBus and throws `BudgetThresholdSignal`. The coordinator's verdict
 * (extend/stop) resolves the embedded promise. If no listener responds within
 * `DECISION_TIMEOUT_MS` the decision defaults to `'stop'`.
 *
 * Behavior with `onThreshold` and `_mode === 'sync'`: throws `BudgetExceededError`
 * synchronously regardless of EventBus state or listener presence. This is useful
 * for fire-and-forget subagents that have an `onThreshold` handler for logging/metrics
 * but are not wired into a coordinator — the `'sync'` mode makes the hard-stop
 * behavior explicit and means tests can use `expect().toThrow()` even without
 * a fully-wired EventBus.
 */
export class SubagentBudget {
  readonly limits: Readonly<BudgetLimits>;

  /** Patch one or more budget limits in-place after construction.
   * Used by the coordinator watchdog when granting an extension.
   * All fields are optional — only provided fields are updated.
   * This is the single write path for limit mutations so that future
   * validation or side-effects live in one place (M1). */
  patchLimits(ext: Partial<BudgetLimits>): void {
    if (ext.maxIterations !== undefined) {
      (this.limits as Record<string, unknown>).maxIterations = ext.maxIterations;
    }
    if (ext.maxToolCalls !== undefined) {
      (this.limits as Record<string, unknown>).maxToolCalls = ext.maxToolCalls;
    }
    if (ext.maxTokens !== undefined) {
      (this.limits as Record<string, unknown>).maxTokens = ext.maxTokens;
    }
    if (ext.maxCostUsd !== undefined) {
      (this.limits as Record<string, unknown>).maxCostUsd = ext.maxCostUsd;
    }
    if (ext.timeoutMs !== undefined) {
      (this.limits as Record<string, unknown>).timeoutMs = ext.timeoutMs;
    }
    if (ext.idleTimeoutMs !== undefined) {
      (this.limits as Record<string, unknown>).idleTimeoutMs = ext.idleTimeoutMs;
    }
  }
  private iterations = 0;
  private toolCalls = 0;
  private tokenInput = 0;
  private tokenOutput = 0;
  private costUsd = 0;
  private startTime: number | null = null;
  /**
   * Timestamp of the most recent activity (iteration / tool call / token
   * usage / streamed progress). Drives the idle timeout — reset by
   * `markActivity()`. Initialised to `start()` time so a never-active agent
   * still eventually trips its idle window.
   */
  private lastActivityTime: number | null = null;
  private _onThreshold: BudgetThresholdHandler | undefined;
  private readonly _sessionId: BudgetSessionIdSource | undefined;
  /**
   * Hard cap on how long `_negotiateExtension` waits for the coordinator to
   * respond before defaulting to 'stop'. Without this fallback an absent
   * or hung listener (Director not built / event filter detached mid-run)
   * leaves the budget over-limit and never enforces anything.
   */
  private static readonly DECISION_TIMEOUT_MS = DECISION_TIMEOUT_MS;
  /**
   * Injected by the runner when wiring the budget to its EventBus.
   * Used to emit `budget.threshold_reached` events in `'auto'` mode.
   */
  _events?: EventBus | undefined;

  /**
   * Guard against dual-path races between the coordinator watchdog
   * (`executeWithTimeout`) and the budget's own `checkTimeout()`.
   * Both paths detect `elapsed >= timeoutMs` and can emit
   * `budget.threshold_reached` for kind `'timeout'` simultaneously.
   * Set to the current `timeoutMs` ceiling by the coordinator BEFORE
   * calling `onThreshold`, and cleared after the negotiation resolves.
   * `checkTimeout()` skips its wall-clock check while this is set so
   * the coordinator's watchdog is the sole source of wall-clock timeout
   * events — `checkTimeout()` focuses exclusively on `idle_timeout`.
   */
  private _watchdogActive: number | undefined;

  /** Returns the timeout ceiling currently being negotiated by the watchdog,
   * or `undefined` when no wall-clock negotiation is in flight.
   * Used by `executeWithTimeout` to detect a stale lock (M3). */
  get watchdogActive(): number | undefined { return this._watchdogActive; }

  /** Called by the coordinator watchdog BEFORE calling `onThreshold` so that
   * `checkTimeout()` skips its wall-clock check for this ceiling. Prevents
   * the budget's own `checkTimeout()` from emitting a second
   * `budget.threshold_reached` event while the watchdog is already
   * negotiating the same wall-clock deadline (C1). */
  setWatchdogNegotiation(timeoutMs: number): void { this._watchdogActive = timeoutMs; }

  /** Clears the watchdog guard after negotiation resolves. Called in the
   * `finally` block of both the pre-empt and deadline branches so it fires
   * on every exit path: grant, deny, throw, or error. */
  clearWatchdogNegotiation(): void { this._watchdogActive = undefined; }

  /**
   * Negotiation mode — controls whether a threshold hit tries to emit
   * `budget.threshold_reached` and wait for a coordinator decision, or
   * falls straight through to a synchronous hard stop.
   *
   * `'auto'` (default) — emit on the EventBus and wait; times out to 'stop'.
   * `'sync'` — throw `BudgetExceededError` immediately regardless of listeners.
   */
  private _mode: BudgetNegotiationMode;

  /**
   * Optional callback for soft-limit handling. When set, the budget will
   * invoke it rather than throw immediately. The handler decides whether to
   * throw synchronously, continue, or ask the coordinator for an extension.
   */
  get onThreshold(): BudgetThresholdHandler | undefined {
    return this._onThreshold;
  }
  set onThreshold(fn: BudgetThresholdHandler | undefined) {
    this._onThreshold = fn;
  }

  /** Returns the current negotiation mode. */
  get mode(): BudgetNegotiationMode {
    return this._mode;
  }

  constructor(
    limits: BudgetLimits = {},
    mode: BudgetNegotiationMode = 'auto',
    options: SubagentBudgetOptions = {},
  ) {
    this._mode = mode;
    this._sessionId = options.sessionId;
    // NOT frozen: `negotiateExtension` patches these limits in place when the
    // coordinator grants an auto-extension. Freezing made every granted
    // extension throw `TypeError: Cannot assign to read only property` in
    // strict mode, which the runner caught as a hard stop — so extensions
    // silently became kills. The `readonly limits: Readonly<BudgetLimits>`
    // typing still blocks external mutation at compile time.
    this.limits = { ...limits };
  }

  private currentSessionId(): string | undefined {
    const value = typeof this._sessionId === 'function' ? this._sessionId() : this._sessionId;
    return typeof value === 'string' && value.length > 0 ? value : undefined;
  }

  start(): void {
    this.startTime = Date.now();
    this.lastActivityTime = this.startTime;
  }

  /**
   * Reset the idle clock. Called on any sign of forward progress —
   * iterations, tool calls, token usage, and streamed tool/text progress —
   * so a long-but-productive subagent never trips its `idleTimeoutMs`.
   */
  markActivity(): void {
    this.lastActivityTime = Date.now();
  }

  /**
   * Milliseconds since the last activity signal. Returns 0 before `start()`
   * (nothing to measure yet). Used by the coordinator watchdog to decide
   * whether to re-arm (still active) or reap (genuinely idle).
   */
  idleMs(): number {
    const since = this.lastActivityTime ?? this.startTime;
    return since === null ? 0 : Date.now() - since;
  }

  /** Returns true if we're within 10% of any limit — useful for pre-flight checks. */
  isNearLimit(): boolean {
    const { maxIterations, maxToolCalls, maxTokens, maxCostUsd } = this.limits;
    if (maxIterations && this.iterations >= maxIterations * 0.9) return true;
    if (maxToolCalls && this.toolCalls >= maxToolCalls * 0.9) return true;
    if (maxTokens && this.tokenInput + this.tokenOutput >= maxTokens * 0.9) return true;
    if (maxCostUsd && this.costUsd >= maxCostUsd * 0.9) return true;
    return false;
  }

  /**
   * Synchronous budget check. Always throws synchronously so callers (especially
   * test event handlers using `expect().toThrow()`) get an unhandled rejection
   * when the budget is exceeded without a handler.
   *
   * Decision table:
   * - no `onThreshold` handler         → throw `BudgetExceededError` (hard stop, always)
   * - `mode === 'sync'`               → throw `BudgetExceededError` (hard stop, always)
   * - `mode === 'auto'` + no listener  → throw `BudgetExceededError` (hard stop; no one to ask)
   * - `mode === 'auto'` + listener     → throw `BudgetThresholdSignal` with async decision promise
   */
  /**
   * Collects all exceeded budget kinds into a single NOOP-free negotiation.
   * Called by recordIteration / recordToolCall / recordUsage — each may call
   * this for its own kind. The first call starts the negotiation and stores
   * the Promise in _pendingNegotiation. Subsequent calls for DIFFERENT
   * kinds (while a negotiation is in flight) are NOOPs — they don't start
   * new conversations with the coordinator. This prevents an EventBus flood
   * when multiple budget kinds are exceeded simultaneously in one iteration.
   *
   * Returns the kinds that were found to be exceeded (for logging/debugging).
   */
  private checkLimits(elapsedMs?: number): { kind: BudgetKind; used: number; limit: number }[] {
    const exceeded: { kind: BudgetKind; used: number; limit: number }[] = [];

    if (this.limits.maxIterations !== undefined && this.iterations > this.limits.maxIterations) {
      exceeded.push({ kind: 'iterations', used: this.iterations, limit: this.limits.maxIterations });
    }
    if (this.limits.maxToolCalls !== undefined && this.toolCalls > this.limits.maxToolCalls) {
      exceeded.push({ kind: 'tool_calls', used: this.toolCalls, limit: this.limits.maxToolCalls });
    }
    const totalTokens = this.tokenInput + this.tokenOutput;
    if (this.limits.maxTokens !== undefined && totalTokens > this.limits.maxTokens) {
      exceeded.push({ kind: 'tokens', used: totalTokens, limit: this.limits.maxTokens });
    }
    if (this.limits.maxCostUsd !== undefined && this.costUsd > this.limits.maxCostUsd) {
      exceeded.push({ kind: 'cost', used: this.costUsd, limit: this.limits.maxCostUsd });
    }
    // Timeout: called from checkTimeout() with elapsedMs (wall-clock) and the
    // current idle gap. Either crossing its limit trips its own kind so the
    // coordinator and auto-extend policy can distinguish them.
    // Wall-clock (`timeoutMs`) is an explicit hard cap; idle (`idleTimeoutMs`)
    // is the default guard that resets on activity. Both can be exceeded in
    // the same call — we push both entries so all violated limits are reported.
    if (elapsedMs !== undefined) {
      const idle = this.idleMs();
      if (this.limits.idleTimeoutMs !== undefined && idle > this.limits.idleTimeoutMs) {
        exceeded.push({ kind: 'idle_timeout', used: idle, limit: this.limits.idleTimeoutMs });
      }
      // Skip the wall-clock 'timeout' kind while the coordinator watchdog is
      // negotiating this exact ceiling — it owns wall-clock; checkTimeout/here
      // own idle. Only suppress in the negotiation path (a handler is set); on
      // the no-handler hard-throw path the wall-clock must still trip. (Mirrors
      // the guard in checkTimeout, which previously was NOT applied here — so
      // an idle trip that called checkLimits re-added 'timeout' and defeated the
      // watchdog dedup.)
      const wallOwnedByWatchdog =
        this._onThreshold !== undefined && this._watchdogActive === this.limits.timeoutMs;
      if (
        this.limits.timeoutMs !== undefined &&
        elapsedMs > this.limits.timeoutMs &&
        !wallOwnedByWatchdog
      ) {
        exceeded.push({ kind: 'timeout', used: elapsedMs, limit: this.limits.timeoutMs });
      }
    }

    if (exceeded.length === 0) return [];

    if (!this._onThreshold) {
      // Hard stop — throw on the first exceeded kind.
      const first = exceeded[0] ?? { kind: 'iterations', limit: 0, used: 0 };
      throw new BudgetExceededError(first.kind, first.limit, first.used);
    }
    if (this._mode === 'sync') {
      // Hard stop in sync mode.
      const first = exceeded[0] ?? { kind: 'iterations', limit: 0, used: 0 };
      throw new BudgetExceededError(first.kind, first.limit, first.used);
    }
    const bus = this._events;
    if (!bus) {
      // No EventBus wired at all → nobody to negotiate with → hard stop.
      const first = exceeded[0] ?? { kind: 'iterations', limit: 0, used: 0 };
      throw new BudgetExceededError(first.kind, first.limit, first.used);
    }

    const first = exceeded[0] ?? { kind: 'iterations', limit: 0, used: 0 };

    // LISTENER-DRIVEN PATH. A registered `budget.threshold_reached` listener
    // (director / collab / auto-extend) negotiates asynchronously. Start one
    // negotiation PER exceeded kind — each reports its OWN kind/used/limit and
    // emits a single event (no O(N^2) re-emission, no cross-kind first-wins
    // drop). Throw `BudgetThresholdSignal` for the first kind so the runner
    // awaits the decision and enforces extend/stop.
    if (bus.hasListenerFor('budget.threshold_reached')) {
      for (const entry of exceeded) {
        if (this._pendingNegotiations.has(entry.kind)) continue; // already negotiating this kind
        this._pendingNegotiations.set(entry.kind, this._negotiateExtension(entry));
      }
      const decision = this._pendingNegotiations.get(first.kind);
      if (!decision) throw new Error(`No pending negotiation for ${first.kind}`);
      throw new BudgetThresholdSignal(first.kind, first.limit, first.used, decision);
    }

    // NO-LISTENER PATH. Invoke the handler synchronously to let an in-process
    // policy decide. Two outcomes:
    //   • SYNC handler (returns a string/decision — e.g. the coordinator
    //     watchdog / recording handlers) → its decision is honored in place
    //     (an `extend` patches limits); no throw. This is the path the
    //     watchdog drives while it owns wall-clock enforcement.
    //   • ASYNC handler (returns a Promise via `requestDecision()`) → there is
    //     no listener to resolve it and `requestDecision` resolves to 'stop',
    //     so this is a definite hard stop: throw `BudgetExceededError`. This is
    //     the documented "auto mode + no listener → hard stop" invariant that
    //     protects a bare `/spawn` (no director) from a runaway subagent.
    let hardStop: BudgetExceededError | null = null;
    for (const entry of exceeded) {
      // Dedup per kind across back-to-back overruns in the same tick — a still
      // exceeded kind (e.g. iterations stays over after a grant) must not
      // re-invoke the handler on every record* call. The marker clears on a
      // microtask so a genuinely fresh overrun later can re-negotiate.
      if (this._pendingNegotiations.has(entry.kind)) continue;
      const marker = Promise.resolve<BudgetThresholdDecision>('stop');
      this._pendingNegotiations.set(entry.kind, marker);
      void marker.finally(() => this._pendingNegotiations.delete(entry.kind));
      const sync = this._invokeHandlerSync(entry);
      if (!sync) hardStop ??= new BudgetExceededError(entry.kind, entry.limit, entry.used);
    }
    if (hardStop) throw hardStop;
    return exceeded;
  }

  /**
   * Invoke `onThreshold` once for `entry` on the NO-LISTENER path and report
   * whether it decided synchronously. Returns `true` when the handler returned
   * a synchronous decision (already honored — an `extend` patched the limits),
   * or `false` when it returned a Promise (async; the caller hard-stops, since
   * there is no listener to resolve the negotiation). The handler is given the
   * full info shape (`requestDecision` plus direct `extend`/`deny`) so both
   * recording handlers and policy handlers work without a wired listener.
   */
  private _invokeHandlerSync(entry: { kind: BudgetKind; used: number; limit: number }): boolean {
    const handler = this._onThreshold;
    if (!handler) return false;
    let extendArg: Partial<BudgetLimits> | undefined;
    const result = handler({
      kind: entry.kind,
      used: entry.used,
      limit: entry.limit,
      requestDecision: (): Promise<BudgetThresholdDecision> => this._busRequestDecision(entry),
      // Direct hooks for synchronous policy/recording handlers.
      extend: (extra: Partial<BudgetLimits>) => {
        extendArg = extra;
      },
      deny: () => {},
    } as Parameters<BudgetThresholdHandler>[0]);
    // A thenable means the handler deferred to async negotiation — but there is
    // no listener here, so it can never be granted → hard stop.
    if (result && typeof (result as { then?: unknown }).then === 'function') return false;
    if (result === 'throw') return false; // explicit hard stop
    // 'continue' / 'stop' / a returned { extend } decision — honor in place.
    if (result && typeof result === 'object' && 'extend' in result) {
      extendArg = (result as { extend: Partial<BudgetLimits> }).extend;
    }
    if (extendArg) this.patchLimits(extendArg);
    return true;
  }

  /**
   * Emit `budget.threshold_reached` and resolve to the listener's verdict.
   * Resolves to `'stop'` immediately when there is no listener (or no bus) so
   * no negotiation can hang and no fallback timer leaks. Mirrors the
   * coordinator watchdog's own request path so both agree on the no-listener
   * default.
   */
  private _busRequestDecision(entry: {
    kind: BudgetKind;
    used: number;
    limit: number;
  }): Promise<BudgetThresholdDecision> {
    const bus = this._events;
    if (!bus?.hasListenerFor('budget.threshold_reached')) {
      return Promise.resolve('stop');
    }
    return new Promise<BudgetThresholdDecision>((resolve) => {
      let resolved = false;
      const respond = (d: BudgetThresholdDecision) => {
        if (resolved) return;
        resolved = true;
        clearTimeout(fallback);
        resolve(d);
      };
      const fallback = setTimeout(() => respond('stop'), SubagentBudget.DECISION_TIMEOUT_MS);
      const sessionId = this.currentSessionId();
      bus.emit('budget.threshold_reached', {
        ...(sessionId ? { sessionId } : {}),
        kind: entry.kind as
          | 'iterations'
          | 'tool_calls'
          | 'tokens'
          | 'cost'
          | 'timeout'
          | 'idle_timeout',
        used: entry.used,
        limit: entry.limit,
        timeoutMs: SubagentBudget.DECISION_TIMEOUT_MS,
        // deny() wins over a same-dispatch extend(): a listener that both grants
        // and denies (or two listeners disagreeing) is resolved as a stop. The
        // grant is deferred a microtask so a synchronous deny in the same emit
        // pre-empts it; async grants still resolve normally.
        extend: (extra: Partial<BudgetLimits>) => queueMicrotask(() => respond({ extend: extra })),
        deny: () => respond('stop'),
      });
    });
  }

  /**
   * Per-kind in-flight negotiation Promises. Each budget kind can have its
   * own concurrent negotiation — e.g. iterations and timeout can both
   * be exceeded simultaneously without blocking each other. The same kind
   * cannot start two concurrent negotiations (dedup guard).
   * Cleared in `_negotiateExtension`'s `finally` block.
   */
  private _pendingNegotiations = new Map<BudgetKind, Promise<BudgetThresholdDecision>>();

  /**
   * Drive the threshold handler to a decision. Resolves with `'stop'`
   * (signal the runner to abort) or `{ extend: ... }` (limits already
   * patched in-place; the runner should not abort). Clears the
   * per-kind slot in `_pendingNegotiations` in `finally`.
   *
   * The 'continue' return from a sync handler is treated as
   * `{ extend: {} }` — keep going without patching; next overrun fires
   * a fresh signal.
   */
  private async _negotiateExtension(
    entry: { kind: BudgetKind; used: number; limit: number },
  ): Promise<BudgetThresholdDecision> {
    if (!this._onThreshold) {
      // Should never reach here — caller should have thrown already
      return 'stop';
    }
    try {
      const result = this._onThreshold({
        kind: entry.kind,
        used: entry.used,
        limit: entry.limit,
        // One event for THIS kind only — each exceeded kind has its own
        // negotiation (and its own resolve), so there is no cross-kind
        // first-wins drop and no O(N^2) re-emission.
        requestDecision: (): Promise<BudgetThresholdDecision> => this._busRequestDecision(entry),
        extend: (extra: Partial<BudgetLimits>) => {
          this.patchLimits(extra);
        },
        deny: () => {},
      } as Parameters<BudgetThresholdHandler>[0]);

      if (result === 'throw') return 'stop';
      if (result === 'continue') return { extend: {} };

      const decision = await result;
      if (decision === 'stop') return 'stop';

      // 'extend' — patch in-place limits BEFORE resolving (single write path).
      this.patchLimits(decision.extend);
      return decision;
    } finally {
      this._pendingNegotiations.delete(entry.kind);
    }
  }

  recordIteration(): void {
    this.iterations++;
    this.markActivity();
    void this.checkLimits();
  }

  recordToolCall(): void {
    this.toolCalls++;
    this.markActivity();
    void this.checkLimits();
  }

  recordUsage(usage: Usage, costUsd = 0): void {
    this.tokenInput += usage.input;
    this.tokenOutput += usage.output;
    this.costUsd += costUsd;
    this.markActivity();
    void this.checkLimits();
  }

  /**
   * Wall-clock / idle budget check. Delegates to `checkLimits(elapsed)`, so
   * `timeout` and `idle_timeout` follow the SAME negotiation path as the other
   * kinds — they are NOT a special-cased hard stop. This is deliberate: a
   * heartbeat-aware policy (see `attachAutoExtend` and `CollabSession`) grants
   * a timeout extension only while the agent is making progress and denies it
   * once the agent is genuinely stuck, which is safer than an unconditional
   * hard kill of a long-but-working agent. The runner translates the resulting
   * `BudgetThresholdSignal` decision (`extend` → patch limits in place,
   * `stop` → abort) just like every other kind.
   *
   * Decision table (same as `checkLimits`):
   * - no `onThreshold` handler        → throw `BudgetExceededError` (hard stop)
   * - `mode === 'sync'`               → throw `BudgetExceededError` (hard stop)
   * - `mode === 'auto'` + no listener → throw `BudgetExceededError` (no one to ask)
   * - `mode === 'auto'` + listener    → throw `BudgetThresholdSignal` (negotiated;
   *                                     a heartbeat-aware policy may extend the timeout)
   */
  checkTimeout(): void {
    if (this.startTime === null) return;
    const { timeoutMs, idleTimeoutMs } = this.limits;
    if (timeoutMs === undefined && idleTimeoutMs === undefined) return;
    const elapsed = Date.now() - this.startTime;
    // Skip wall-clock timeout if the coordinator watchdog is already in the middle
    // of negotiating this exact ceiling — tool.progress is too frequent and creates
    // a race where both paths emit budget.threshold_reached for the same kind.
    // The watchdog owns wall-clock; checkTimeout focuses exclusively on idle.
    const wallSkipped =
      this._onThreshold !== undefined &&
      this._watchdogActive !== undefined &&
      timeoutMs !== undefined &&
      this._watchdogActive === timeoutMs;
    const wallTripped = wallSkipped ? false : timeoutMs !== undefined && elapsed > timeoutMs;
    const idleTripped = idleTimeoutMs !== undefined && this.idleMs() > idleTimeoutMs;
    if (!wallTripped && !idleTripped) return;
    void this.checkLimits(elapsed);
  }

  /** Returns true if a wall-clock or idle timeout has occurred without throwing. */
  isTimedOut(): boolean {
    if (this.startTime === null) return false;
    const { timeoutMs, idleTimeoutMs } = this.limits;
    if (timeoutMs !== undefined && Date.now() - this.startTime > timeoutMs) return true;
    if (idleTimeoutMs !== undefined && this.idleMs() > idleTimeoutMs) return true;
    return false;
  }

  usage(): BudgetUsage {
    return {
      iterations: this.iterations,
      toolCalls: this.toolCalls,
      tokens: {
        input: this.tokenInput,
        output: this.tokenOutput,
        total: this.tokenInput + this.tokenOutput,
      },
      costUsd: this.costUsd,
      elapsedMs: this.startTime === null ? 0 : Date.now() - this.startTime,
    };
  }
}
