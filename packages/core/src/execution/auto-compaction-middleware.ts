import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { MiddlewareHandler } from '@wrongstack/contracts/kernel/pipeline';
import type { Compactor, CompactReport } from '@wrongstack/contracts/types/compactor';
import type { ContextWindowAggressiveOn, ContextWindowPolicy } from '@wrongstack/contracts/types';
import type { Context } from '../core/context.js';
import type { SessionEventBridge } from '../storage/session-event-bridge.js';
import type { ContextWindowBudgetSnapshot } from '../utils/context-budget.js';
import { repeatedReadPressure } from '../utils/context-evidence.js';
import {
  estimateRequestTokensCalibrated,
  estimateRequestTokensUpperBound,
  getCalibrationState,
  MAX_TOKEN_DENSITY_MULTIPLIER,
  MIN_CALIBRATION_MULTIPLIER,
  MIN_UNCALIBRATED_MULTIPLIER,
} from '../utils/token-estimate.js';
import { type AutoCompactionRunHost, compact as compactFromHost } from './auto-compaction-run.js';
import type { CompactionFailureMode } from './auto-compaction-run-contracts.js';
import { AutoCompactionState } from './auto-compaction-state.js';
import {
  collapseAcknowledgedToolReceipts,
  eliseAcknowledgedToolResults,
} from './compaction-core.js';
import { emergencyTrim } from './compaction-emergency-trim.js';
import type { CompactionHistoryPolicyHost } from './compaction-history-policy.js';
import {
  hygieneInterval as hygieneIntervalFromHost,
  invalidateTokenCaches as invalidateTokenCachesFromHost,
  recordAttempt as recordAttemptFromHost,
  resolvePreserveK as resolvePreserveKFromHost,
  resolveToolReceiptRetention as resolveToolReceiptRetentionFromHost,
  resolveToolResultRetention as resolveToolResultRetentionFromHost,
  shouldRunHygiene as shouldRunHygieneFromHost,
  shouldSkipNoopRetry as shouldSkipNoopRetryFromHost,
} from './compaction-history-policy.js';
import type { CompactionReportingHost } from './compaction-reporting.js';
import { reportCompaction as reportCompactionFromHost } from './compaction-reporting.js';
import type { PressureLevel } from './compaction-thresholds.js';
import {
  adaptThresholdsForSignals,
  contextWindowBudget,
  effectiveMaxContext,
  normalizeTargetLoad,
  pressureLevelFor,
  sanitizeThresholds,
} from './compaction-thresholds.js';
import {
  type CompactionTokenEstimationHost,
  estimateContextTokens as delegateEstimateContextTokens,
} from './compaction-token-estimation.js';

export type { ContextWindowBudgetSnapshot } from '../utils/context-budget.js';

interface AutoCompactionOptions {
  aggressiveOn?: ContextWindowAggressiveOn | undefined;
  events?: EventBus | undefined;
  failureMode?: CompactionFailureMode | undefined;
  policyProvider?: (
    ctx: Context,
  ) => Pick<ContextWindowPolicy, 'thresholds' | 'aggressiveOn' | 'targetLoad'> | null | undefined;
  /** Optional bridge for writing compaction events into the persistent session log. */
  sessionBridge?: SessionEventBridge | undefined;
  /**
   * Optional callback fired after successful compaction with the report.
   * Receives the CompactReport so callers can feed the collapsed digest
   * to memory consolidation, logging, or other side effects.
   */
  onCompact?: ((report: CompactReport) => void) | undefined;
}

/**
 * Pipeline middleware that monitors context token load and automatically
 * triggers compaction when the warn/soft/hard thresholds are crossed.
 * Runs before the next agent iteration.
 *
 * Uses `estimateRequestTokens` for accurate full-request token counting:
 * messages + systemPrompt + toolDefs. This replaces the previous pattern
 * of applying an OVERHEAD_FACTOR to a messages-only estimate.
 */
export class AutoCompactionMiddleware {
  readonly name = 'AutoCompaction';

  private readonly compactor: Compactor;
  /** Deprecated. Kept for backward compat with tests that pass simpleEstimator. */
  private readonly _estimator?: ((ctx: Context) => number) | undefined;
  private readonly warnThreshold: number;
  private readonly softThreshold: number;
  private readonly hardThreshold: number;
  /** Writable so model-switch can update the denominator without re-registering the middleware. */
  private _maxContext: number;
  /**
   * Runtime on/off gate. The middleware is always installed in the pipeline so
   * auto-compaction can be toggled live from the TUI `/settings` picker; when
   * disabled the handler is a pass-through. Defaults to enabled.
   */
  private _enabled = true;
  private readonly aggressiveOn: ContextWindowAggressiveOn;
  private readonly events?: EventBus | undefined;
  private readonly failureMode: CompactionFailureMode;
  private readonly policyProvider?: AutoCompactionOptions['policyProvider'] | undefined;
  private readonly sessionBridge?: SessionEventBridge | undefined;
  private readonly onCompact?: ((report: CompactReport) => void) | undefined;

  /**
   * Once a compaction attempt reduces nothing (preserveK protects everything,
   * no oversized tool_results remain to elide), retrying on every iteration
   * just spams `compaction.fired` events without making progress. We remember
   * the no-op and skip until either the pressure level escalates or context
   * has grown by at least this many tokens since the failed attempt.
   */
  /** A tiny positive delta is operationally still a no-op at large context sizes. */

  /**
   * Ceiling for the derived send-guard gate. The stale note this replaces read
   * "even the maximum density under-count factor (2.5x) cannot push the real
   * token count past the window ... Equals 1 / 2.5 = 0.4" — true only when the
   * calibration multiplier is >= 1. The gate actually applied is computed per
   * calibration state in {@link guardGateLoad}; this value only caps it.
   */
  private static readonly GUARD_GATE_LOAD = 0.4;

  /**
   * How much the context must grow between two history-rewriting hygiene
   * passes, as a fraction of the available input window and as an absolute
   * floor. Every pass rewrites already-transmitted messages, which forces the
   * provider to re-cache the whole prompt; spacing the passes out is what lets
   * the conversation prefix stay cached for the turns in between.
   * The floor applies only when it fits between warn and hard. On a small
   * window it is wider than that gap, so a second pass could never run before
   * hard pressure already forces one.
   */

  /** Runtime bookkeeping belongs to the context, even when a pipeline is shared.
   * Weak keys also let closed conversations release their cached references.
   */
  private readonly contextStates = new WeakMap<Context, AutoCompactionState>();

  private stateFor(ctx: Context): AutoCompactionState {
    let state = this.contextStates.get(ctx);
    if (!state) {
      state = new AutoCompactionState();
      this.contextStates.set(ctx, state);
    }
    return state;
  }

  /**
   * @param compactor        Compactor to use for compaction.
   * @param maxContext Provider's max context window in tokens.
   * @param _estimator       Deprecated parameter kept for backward compatibility.
   *                         The middleware now uses `estimateRequestTokens` internally
   *                         for accurate full-request token counting (messages +
   *                         systemPrompt + toolDefs).
   * @param thresholds       Threshold fractions (0-1) of maxContext.
   * @param optsOrAggressiveOn
   *                         Optional behavior. Accepts either this options
   *                         object or the legacy ContextWindowAggressiveOn
   *                         string (e.g. '50pct'). By default, failures at the
   *                         hard threshold throw AGENT_CONTEXT_OVERFLOW so
   *                         the agent does not continue into a likely
   *                         provider context overflow. Warn/soft failures
   *                         still emit compaction.failed and continue.
   */
  constructor(
    compactor: Compactor,
    maxContext: number,
    /**
     * Optional custom estimator. When omitted (pass `undefined`), the
     * middleware uses its internal `estimateRequestTokensCalibrated` default —
     * the right choice for subagents, which want the same per-(provider,model)
     * calibration as the leader without threading an estimator through.
     */
    _estimator: ((ctx: Context) => number) | undefined,
    thresholds: { warn: number; soft: number; hard: number },
    optsOrAggressiveOn: AutoCompactionOptions | ContextWindowAggressiveOn = {},
    events?: EventBus | undefined,
  ) {
    const opts =
      typeof optsOrAggressiveOn === 'string'
        ? { aggressiveOn: optsOrAggressiveOn, events }
        : optsOrAggressiveOn;
    this.compactor = compactor;
    this._maxContext = maxContext;
    this._estimator = _estimator;
    this.warnThreshold = thresholds.warn;
    this.softThreshold = thresholds.soft;
    this.hardThreshold = thresholds.hard;
    this.aggressiveOn = opts.aggressiveOn ?? 'soft';
    this.events = opts.events;
    this.failureMode = opts.failureMode ?? 'throw_on_hard';
    this.policyProvider = opts.policyProvider;
    this.sessionBridge = opts.sessionBridge;
    this.onCompact = opts.onCompact;
  }

  /** Allow callers (e.g. model-switch in WebUI) to update the context window
   *  denominator when the active model changes. */
  setMaxContext(maxContext: number): void {
    this._maxContext = maxContext;
  }

  /** Whether auto-compaction is currently active. */
  get enabled(): boolean {
    return this._enabled;
  }

  /** Toggle auto-compaction on a live session (TUI `/settings`). When disabled
   *  the middleware passes every iteration straight through without estimating
   *  tokens or compacting. */
  setEnabled(enabled: boolean): void {
    this._enabled = enabled;
  }

  /**
   * Is auto-compaction on for THIS conversation?
   *
   * `contextAutoCompact` is a per-tab preference, and a WebUI runs four tabs
   * through this one middleware instance. The host used to express "off" by
   * removing the middleware from the shared pipeline, which turned it off for
   * every tab at once; a session that sets its own value now decides for
   * itself, and `this._enabled` remains the answer for hosts that keep no
   * per-session value.
   */
  private enabledFor(ctx: Context): boolean {
    const scoped = (ctx.meta as Record<string, unknown> | undefined)?.['contextAutoCompact'];
    return typeof scoped === 'boolean' ? scoped : this._enabled;
  }

  handler(): MiddlewareHandler<Context> {
    return async (ctx, next) => {
      // Runtime gate — when auto-compaction is turned off via /settings the
      // middleware stays installed but does nothing, for the tab that turned
      // it off and no other.
      if (!this.enabledFor(ctx) || ctx.signal?.aborted) return next(ctx);

      let counted = this.estimateContextTokens(ctx);
      let tokens = counted.tokens;
      let exactAnchor = counted.exact;
      // A provider overflow can teach the session a route-specific effective
      // limit that is lower than the catalog/native-model value. Resolve it on
      // every pass so the next retry compacts against the learned denominator.
      const runtimeMaxContext = effectiveMaxContext(ctx, this._maxContext);
      // Unknown window (0): there is no budget to compact against. Measured
      // against 0 every request read as over the hard line and the send was
      // refused — the standalone WebUI installs this middleware before it
      // knows the model's window, and a tab can switch to a model without one.
      if (runtimeMaxContext <= 0) return next(ctx);
      let budget = contextWindowBudget(ctx, tokens, runtimeMaxContext);
      const calibratedLoad = budget.load;
      const policy = this.policyProvider?.(ctx);
      const thresholds = sanitizeThresholds(
        policy?.thresholds ?? {
          warn: this.warnThreshold,
          soft: this.softThreshold,
          hard: this.hardThreshold,
        },
      );
      const repetition = repeatedReadPressure(ctx);
      const adaptiveThresholds = adaptThresholdsForSignals(thresholds, {
        repeatedReadCount: repetition,
      });
      const aggressiveOn = policy?.aggressiveOn ?? this.aggressiveOn;
      const targetLoad = normalizeTargetLoad(policy?.targetLoad, adaptiveThresholds);

      // Escalate past a calibrated under-count before deciding pressure.
      // The protected line is warn: inflation that crosses warn, soft, or hard
      // has to be visible to pressureLevelFor, not only a load of 1.0.
      let load = this.pressureLoad(
        ctx,
        calibratedLoad,
        budget.availableInputTokens,
        adaptiveThresholds.warn,
        exactAnchor,
      );

      let level = pressureLevelFor(load, adaptiveThresholds);

      if (!level) {
        // Load dropped back below all thresholds — any previously stuck state
        // is no longer relevant.
        this.stateFor(ctx).lastNoopAttempt = null;
        return next(ctx);
      }

      // ── Budget hygiene, deliberately infrequent ──────────────────────────
      // Bounding raw tool I/O and folding old protocol pairs into the digest
      // both REWRITE already-transmitted history, which costs a full prompt
      // re-cache. Running them once per turn (the previous behavior) pinned the
      // provider's cache read at the static system+tools prefix for the rest of
      // the session. Gating on real pressure plus a growth interval turns that
      // into one rewrite per interval, leaving history append-only — and the
      // prompt prefix cacheable — for every turn in between.
      if (
        this.shouldRunHygiene(ctx, level, tokens, budget.availableInputTokens, adaptiveThresholds)
      ) {
        const changed = this.runHistoryHygiene(ctx);
        // Anchor the next interval on the post-hygiene size even when nothing
        // changed, so a session with nothing left to trim does not re-attempt
        // the full O(n) walk on every subsequent turn.
        if (changed) {
          counted = this.estimateContextTokens(ctx);
          tokens = counted.tokens;
          exactAnchor = counted.exact;
        }
        this.stateFor(ctx).lastHygieneTokens = tokens;
        if (changed) {
          budget = contextWindowBudget(ctx, tokens, runtimeMaxContext);
          load = this.pressureLoad(
            ctx,
            budget.load,
            budget.availableInputTokens,
            this.protectLoadForEstimate(
              ctx,
              budget.load,
              budget.availableInputTokens,
              adaptiveThresholds.warn,
            ),
            exactAnchor,
          );
          const relevelled = pressureLevelFor(load, adaptiveThresholds);
          if (!relevelled) {
            this.stateFor(ctx).lastNoopAttempt = null;
            return next(ctx);
          }
          level = relevelled;
        }
      }

      if (this.shouldSkipNoopRetry(ctx, level, tokens)) {
        return next(ctx);
      }

      const aggressive =
        level === 'hard'
          ? true
          : level === 'soft'
            ? aggressiveOn !== 'hard'
            : aggressiveOn === 'warn';

      await this.compact(ctx, aggressive, {
        level,
        tokens,
        load,
        hardThreshold: adaptiveThresholds.hard,
        targetLoad,
        budget,
        signals: { repeatedReadCount: repetition },
      });

      return next(ctx);
    };
  }

  /**
   * Full-request token total for the current context.
   *
   * Reuses the last estimate when the context hasn't grown since the previous
   * check — common in autonomous idle loops. The cached value is invalidated
   * whenever messages or tools change.
   *
   * IMPORTANT: the cache is only valid for the deterministic
   * `estimateRequestTokensCalibrated` path (messages+system+tools → fixed
   * output). When a custom `_estimator` is provided (e.g. in tests with a
   * mutable closure, or a dynamic policy provider), always call it fresh — the
   * estimator owns its own semantics and the middleware cannot safely cache its
   * result across calls.
   */
  private estimateContextTokens(ctx: Context): { tokens: number; exact: boolean } {
    return delegateEstimateContextTokens(this.compactionTokenEstimationHost(), ctx);
  }

  /**
   * Pressure load for one measurement. Exact provider usage is already real.
   * Estimates still pass through the density guard.
   */
  private pressureLoad(
    ctx: Context,
    measuredLoad: number,
    availableInputTokens: number,
    protectLoad: number,
    exactAnchor: boolean,
  ): number {
    if (exactAnchor) return measuredLoad;
    return this.applySendGuard(ctx, measuredLoad, availableInputTokens, protectLoad);
  }

  /**
   * Never-undercount send guard.
   *
   * The calibrated estimate can under-count dense content (CJK, base64,
   * minified). `guardGateLoad` is the calibrated load at which the upper bound
   * can reach 1.0. Pressure and the emergency trim treat `protectLoad` (the
   * warn line before compaction, the target line after it) as the decision
   * boundary, and that line is below 1.0. Skipping the rescan is safe only
   * while the inflated load is still under `protectLoad`, i.e. while the
   * calibrated load is under `protectLoad * guardGateLoad`.
   */
  private applySendGuard(
    ctx: Context,
    calibratedLoad: number,
    availableInputTokens: number,
    protectLoad: number,
  ): number {
    const calibrationKey = `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`;
    const windowGate = AutoCompactionMiddleware.guardGateLoad(calibrationKey);
    const ceiling = Number.isFinite(protectLoad) && protectLoad > 0 ? Math.min(1, protectLoad) : 1;
    if (calibratedLoad < ceiling * windowGate) {
      return calibratedLoad;
    }
    const guardTotal = estimateRequestTokensUpperBound(
      ctx.messages,
      ctx.systemPrompt,
      ctx.tools ?? [],
      calibrationKey,
    ).total;
    const guardLoad = guardTotal / availableInputTokens;
    return guardLoad > calibratedLoad ? guardLoad : calibratedLoad;
  }

  /**
   * Hygiene can drop a real usage anchor and leave a custom estimator in
   * charge. The density rescan is meaningful only when that number is the
   * calibrated chars/token total; a caller-supplied estimator is a different
   * scale and stays on the full-window skip gate.
   */
  private protectLoadForEstimate(
    ctx: Context,
    reportedLoad: number,
    availableInputTokens: number,
    protectLoad: number,
  ): number {
    if (!this._estimator) return protectLoad;
    const calibratedTokens = estimateRequestTokensCalibrated(
      ctx.messages,
      ctx.systemPrompt,
      ctx.tools ?? [],
      `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`,
    ).total;
    const reportedTokens = reportedLoad * availableInputTokens;
    return Math.abs(calibratedTokens - reportedTokens) <= 1 ? protectLoad : 1;
  }

  /**
   * Load below which the upper-bound rescan can be skipped without risking an
   * overflow.
   *
   * The number being compared is the CALIBRATED load, and calibration scales
   * that number DOWN — the EWMA ratio floor is 0.5, and even with no samples
   * the model-family fallback can apply 0.875. The true load can therefore
   * reach `calibratedLoad * (maxDensity / appliedRatio)`, so skipping is safe
   * only while `gate <= appliedRatio / maxDensity`.
   *
   * The previous fixed 0.4 was derived from `1 / maxDensity` alone, which holds
   * only when the applied ratio is >= 1. At the ratio floor that let a request
   * at ~1.8x the window reach the provider with no compaction and no
   * hard-budget pass — below the gate `pressureLevelFor` returns null, so
   * nothing else runs either. This helper still answers "when can inflation
   * reach a load of 1?". Callers scale it by the lower pressure line they
   * actually enforce.
   */
  private static guardGateLoad(calibrationKey: string): number {
    const cal = getCalibrationState(calibrationKey);
    const appliedRatio = cal.calibrated
      ? Math.min(1.5, Math.max(MIN_CALIBRATION_MULTIPLIER, cal.ratio))
      : MIN_UNCALIBRATED_MULTIPLIER;
    return Math.min(
      AutoCompactionMiddleware.GUARD_GATE_LOAD,
      appliedRatio / MAX_TOKEN_DENSITY_MULTIPLIER,
    );
  }

  /**
   * Rewrite acknowledged tool protocol in place.
   *
   * Tool results are protocol inputs for the immediately following model
   * response, not unlimited durable prompt memory. Once a later assistant
   * message proves the provider consumed them, keep a mode-sized raw window and
   * replace the rest with semantic head/tail receipts, then fold fully-aged
   * pairs into the history digest.
   *
   * Every one of those edits touches a message the provider has already seen,
   * so each call costs a full prompt re-cache — it belongs behind
   * {@link shouldRunHygiene}, never on the per-turn path. Content staleness is
   * not a reason to bypass that gate: the edit/replace tools guard against
   * acting on an out-of-date read with their own mtime + sha-256 check.
   *
   * @returns whether the conversation was rewritten.
   */
  private runHistoryHygiene(ctx: Context): boolean {
    const raw = eliseAcknowledgedToolResults(ctx.messages, {
      maxRetainedTokens: this.resolveToolResultRetention(ctx),
    });
    const receipts = collapseAcknowledgedToolReceipts(raw.messages, {
      maxPairs: this.resolveToolReceiptRetention(ctx),
    });
    if (!raw.changed && !receipts.changed) return false;
    ctx.state.replaceMessages(receipts.messages);
    ctx.clearFileTracking();
    // Both token stashes describe the pre-hygiene array. Message count can
    // stay unchanged, so count-based invalidation alone is insufficient.
    this.invalidateTokenCaches(ctx);
    return true;
  }

  /**
   * Whether the history-rewriting hygiene pass may run this turn.
   *
   * Hard pressure always runs it — staying under the window outranks caching.
   * Otherwise it runs at most once per growth interval, so the conversation
   * stays append-only (and therefore cacheable by the provider) in between.
   */
  private shouldRunHygiene(
    ctx: Context,
    level: PressureLevel,
    tokens: number,
    availableInputTokens: number,
    thresholds: { warn: number; hard: number },
  ): boolean {
    return shouldRunHygieneFromHost.call(
      this.compactionHistoryPolicyHost(),
      ctx,
      level,
      tokens,
      availableInputTokens,
      thresholds,
    );
  }

  /**
   * Growth required before another warn/soft hygiene pass.
   * Large windows keep the 20k floor. Small windows use the 15% fraction,
   * because the floor is wider than the warn→hard gap and would never fire.
   */
  private hygieneInterval(
    availableInputTokens: number,
    thresholds: { warn: number; hard: number },
  ): number {
    return hygieneIntervalFromHost.call(
      this.compactionHistoryPolicyHost(),
      availableInputTokens,
      thresholds,
    );
  }

  /** Invalidate every token view derived from the pre-rewrite conversation. */
  private invalidateTokenCaches(ctx: Context): void {
    invalidateTokenCachesFromHost.call(this.compactionHistoryPolicyHost(), ctx);
  }

  /**
   * Returns true when the previous compaction at the same or higher pressure
   * level reduced nothing and the token count is still about that same
   * transcript. A material shrink is a different transcript (rewind, branch,
   * or a replacement), not the stuck window. Prevents a stuck preserveK
   * window from spamming compaction events every iteration.
   */
  private shouldSkipNoopRetry(ctx: Context, level: PressureLevel, tokens: number): boolean {
    return shouldSkipNoopRetryFromHost.call(this.compactionHistoryPolicyHost(), ctx, level, tokens);
  }

  private recordAttempt(
    ctx: Context,
    level: PressureLevel,
    tokens: number,
    report: CompactReport,
  ): void {
    recordAttemptFromHost.call(this.compactionHistoryPolicyHost(), ctx, level, tokens, report);
  }

  /**
   * Success notifications are not part of the no-overflow guarantee.
   * A throwing callback or session log must not become AGENT_CONTEXT_OVERFLOW
   * and must not skip the hard-ceiling trim that follows.
   */
  private async reportCompaction(
    ctx: Context,
    pressure: {
      level: PressureLevel;
      tokens: number;
      load: number;
      budget: ContextWindowBudgetSnapshot;
      signals: { repeatedReadCount: number };
    },
    aggressive: boolean,
    report: CompactReport,
  ): Promise<void> {
    return reportCompactionFromHost.call(
      this.compactionReportingHost(),
      ctx,
      pressure,
      aggressive,
      report,
    );
  }

  private async compact(
    ctx: Context,
    aggressive: boolean,
    pressure: {
      level: PressureLevel;
      tokens: number;
      load: number;
      hardThreshold: number;
      targetLoad: number;
      budget: ContextWindowBudgetSnapshot;
      signals: { repeatedReadCount: number };
    },
  ): Promise<void> {
    return compactFromHost(this.autoCompactionRunHost(), ctx, aggressive, pressure);
  }

  /**
   * Last-resort trim that makes the request structurally fit the window.
   * Converts the calibrated context budget into a raw message-token budget
   * (the estimator scale `enforceHardBudget` works in) by subtracting the
   * system-prompt + tool-definition overhead, then trims message content until
   * it fits. Targets 95% of the hard line so re-estimation jitter does not
   * leave it exactly on the boundary. Returns the trim result, or null when
   * nothing needed trimming.
   */
  private emergencyTrim(
    ctx: Context,
    budget: ContextWindowBudgetSnapshot,
    hardThreshold: number,
  ): {
    saved: number;
    trimmedBlocks: number;
    droppedMessages: number;
    withinBudget: boolean;
  } | null {
    return emergencyTrim(ctx, budget, hardThreshold, this.resolvePreserveK(ctx), (ctx) =>
      this.invalidateTokenCaches(ctx),
    );
  }

  /** Preserve-window size from the active policy, defaulting to 6 recent pairs. */
  private resolvePreserveK(ctx: Context): number {
    return resolvePreserveKFromHost.call(this.compactionHistoryPolicyHost(), ctx);
  }

  /**
   * Aggregate raw acknowledged tool-I/O budget from the active mode.
   *
   * `eliseThreshold` remains the per-result baseline. Multiplying it by the
   * preserve window gives recent multi-tool investigations breathing room;
   * the 12% context cap prevents deep mode or huge custom thresholds from
   * turning that room into another unbounded prompt owner.
   */
  private resolveToolResultRetention(ctx: Context): number {
    return resolveToolResultRetentionFromHost.call(this.compactionHistoryPolicyHost(), ctx);
  }

  /**
   * Number of recent completed tool exchanges kept as semantic receipts.
   * Four receipts per preserve slot retains a useful investigation trail; the
   * absolute bounds keep frugal mode useful and deep mode finite.
   */
  private resolveToolReceiptRetention(ctx: Context): number {
    return resolveToolReceiptRetentionFromHost.call(this.compactionHistoryPolicyHost(), ctx);
  }

  private compactionTokenEstimationHost(): CompactionTokenEstimationHost {
    return {
      stateFor: (...args) => this.stateFor(...args),
      _estimator: this._estimator,
    };
  }

  private compactionReportingHost(): CompactionReportingHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.events satisfies CompactionReportingHost['events']);
    void (this.onCompact satisfies CompactionReportingHost['onCompact']);
    void (this.sessionBridge satisfies CompactionReportingHost['sessionBridge']);
    return this as unknown as CompactionReportingHost;
  }

  private compactionHistoryPolicyHost(): CompactionHistoryPolicyHost {
    // Preserve the owner's instance and check each member against the helper contract.
    void (this.stateFor satisfies CompactionHistoryPolicyHost['stateFor']);
    void (this.hygieneInterval satisfies CompactionHistoryPolicyHost['hygieneInterval']);
    void (this.resolvePreserveK satisfies CompactionHistoryPolicyHost['resolvePreserveK']);
    void (this._maxContext satisfies CompactionHistoryPolicyHost['_maxContext']);
    return this as unknown as CompactionHistoryPolicyHost;
  }

  private autoCompactionRunHost(): AutoCompactionRunHost {
    // Check the complete helper contract while preserving the owner's identity and receivers.
    void ({
      compactor: this.compactor,
      invalidateTokenCaches: this.invalidateTokenCaches,
      recordAttempt: this.recordAttempt,
      reportCompaction: this.reportCompaction,
      estimateContextTokens: this.estimateContextTokens,
      pressureLoad: this.pressureLoad,
      emergencyTrim: this.emergencyTrim,
      applySendGuard: this.applySendGuard,
      events: this.events,
      failureMode: this.failureMode,
    } satisfies AutoCompactionRunHost);
    return this as unknown as AutoCompactionRunHost;
  }
}
