import { type Context, resolveEventSessionId } from '../core/context.js';
import type { EventBus } from '../kernel/events.js';
import type { MiddlewareHandler } from '../kernel/pipeline.js';
import type { SessionEventBridge } from '../storage/session-event-bridge.js';
import type { Compactor, CompactReport } from '../types/compactor.js';
import type { ContextWindowAggressiveOn, ContextWindowPolicy } from '../types/context-window.js';
import { AgentError, ERROR_CODES } from '../types/errors.js';
import { repeatedReadPressure } from '../utils/context-evidence.js';
import {
  estimateRequestTokens,
  estimateRequestTokensCalibrated,
  estimateRequestTokensUpperBound,
  getCalibrationState,
  realAnchoredInputTokens,
} from '../utils/token-estimate.js';
import {
  collapseAcknowledgedToolReceipts,
  eliseAcknowledgedToolResults,
  enforceHardBudget,
  estimateMessages,
} from './compaction-core.js';

import { type ContextWindowBudgetSnapshot, computeContextWindowBudget } from './context-budget.js';

type PressureLevel = 'warn' | 'soft' | 'hard';
const LEVEL_RANK: Record<PressureLevel, number> = { warn: 0, soft: 1, hard: 2 };

function pressureLevelFor(
  load: number,
  thresholds: { warn: number; soft: number; hard: number },
): PressureLevel | null {
  if (load >= thresholds.hard) return 'hard';
  if (load >= thresholds.soft) return 'soft';
  if (load >= thresholds.warn) return 'warn';
  return null;
}

export type { ContextWindowBudgetSnapshot } from './context-budget.js';

/** Max chars of collapse digest persisted to the session log line. */
const MAX_DIGEST_LOG_CHARS = 4_000;

function truncateDigest(digest: string): string {
  if (digest.length <= MAX_DIGEST_LOG_CHARS) return digest;
  return `${digest.slice(0, MAX_DIGEST_LOG_CHARS)}… [+${digest.length - MAX_DIGEST_LOG_CHARS} chars; full turns in session log]`;
}

type CompactionFailureMode = 'throw' | 'throw_on_hard' | 'continue';

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
  private static readonly NOOP_RETRY_DELTA_TOKENS = 2_000;
  /** A tiny positive delta is operationally still a no-op at large context sizes. */
  private static readonly MIN_EFFECTIVE_REDUCTION_TOKENS = 1_000;
  private static readonly MIN_EFFECTIVE_REDUCTION_RATIO = 0.005;

  /**
   * Calibrated-load floor above which the upper-bound send guard runs. Below
   * this, even the maximum density under-count factor (2.5×) cannot push the
   * real token count past the window, so the extra scan is pure waste. Equals
   * 1 / 2.5 = 0.4.
   */
  private static readonly GUARD_GATE_LOAD = 0.4;

  /**
   * How much the context must grow between two history-rewriting hygiene
   * passes, as a fraction of the available input window and as an absolute
   * floor. Every pass rewrites already-transmitted messages, which forces the
   * provider to re-cache the whole prompt; spacing the passes out is what lets
   * the conversation prefix stay cached for the turns in between.
   */
  private static readonly HYGIENE_GROWTH_RATIO = 0.15;
  private static readonly HYGIENE_MIN_GROWTH_TOKENS = 20_000;

  /** Tracks the most recent no-op attempt so we can avoid re-firing per turn. */
  private lastNoopAttempt: { level: PressureLevel; tokens: number } | null = null;

  /** Context size at the last hygiene pass; anchors the growth interval. */
  private lastHygieneTokens: number | null = null;

  /**
   * Cached token estimate from the last handler() invocation. When the
   * message count and tool count haven't changed since the last estimate
   * (autonomous idle loops), we skip the expensive O(n) token estimation
   * and reuse this value. Reset to -1 when the context changes.
   */
  private _cachedTokens = -1;
  private _cachedMsgCount = -1;
  private _cachedToolCount = -1;
  private _cachedRevision = -1;
  private _cachedSystemRef: unknown = null;
  private _cachedToolsRef: unknown = null;

  /**
   * @param compactor        Compactor to use for compaction.
   * @param maxContext Provider's max context window in tokens.
   * @param _estimator       Deprecated parameter kept for backward compatibility.
   *                         The middleware now uses `estimateRequestTokens` internally
   *                         for accurate full-request token counting (messages +
   *                         systemPrompt + toolDefs).
   * @param thresholds       Threshold fractions (0-1) of maxContext.
   * @param opts             Optional behavior. By default, failures at the
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
      if (!this.enabledFor(ctx)) return next(ctx);

      let tokens = this.estimateContextTokens(ctx);
      // A provider overflow can teach the session a route-specific effective
      // limit that is lower than the catalog/native-model value. Resolve it on
      // every pass so the next retry compacts against the learned denominator.
      const runtimeMaxContext = effectiveMaxContext(ctx, this._maxContext);
      let budget = contextWindowBudget(ctx, tokens, runtimeMaxContext);
      const calibratedLoad = budget.load;
      const policy = this.policyProvider?.(ctx);
      const thresholds = policy?.thresholds ?? {
        warn: this.warnThreshold,
        soft: this.softThreshold,
        hard: this.hardThreshold,
      };
      const repetition = repeatedReadPressure(ctx);
      const adaptiveThresholds = adaptThresholdsForSignals(thresholds, {
        repeatedReadCount: repetition,
      });
      const aggressiveOn = policy?.aggressiveOn ?? this.aggressiveOn;
      const targetLoad = normalizeTargetLoad(policy?.targetLoad, adaptiveThresholds);

      // Escalate past a calibrated under-count before deciding pressure.
      let load = this.applySendGuard(ctx, calibratedLoad, budget.availableInputTokens);

      let level = pressureLevelFor(load, adaptiveThresholds);

      if (!level) {
        // Load dropped back below all thresholds — any previously stuck state
        // is no longer relevant.
        this.lastNoopAttempt = null;
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
      if (this.shouldRunHygiene(level, tokens, budget.availableInputTokens)) {
        const changed = this.runHistoryHygiene(ctx);
        // Anchor the next interval on the post-hygiene size even when nothing
        // changed, so a session with nothing left to trim does not re-attempt
        // the full O(n) walk on every subsequent turn.
        tokens = changed ? this.estimateContextTokens(ctx) : tokens;
        this.lastHygieneTokens = tokens;
        if (changed) {
          budget = contextWindowBudget(ctx, tokens, runtimeMaxContext);
          load = this.applySendGuard(ctx, budget.load, budget.availableInputTokens);
          const relevelled = pressureLevelFor(load, adaptiveThresholds);
          if (!relevelled) {
            this.lastNoopAttempt = null;
            return next(ctx);
          }
          level = relevelled;
        }
      }

      if (this.shouldSkipNoopRetry(level, tokens)) {
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
  private estimateContextTokens(ctx: Context): number {
    const msgCount = ctx.messages.length;
    const toolCount = (ctx.tools ?? []).length;
    const revision = ctx.state?.revision ?? -1;

    // Prefer the REAL usage anchor: compaction decisions run against the
    // provider's authoritative prompt-token count (+ the delta of unsent
    // messages), not a scaled estimate. Only the newest turn is estimated;
    // everything else is exact. Falls through to the estimate paths before
    // the first response or right after compaction shrank the array.
    const anchorAt =
      typeof ctx.meta?.['realAnchorMsgCount'] === 'number'
        ? (ctx.meta['realAnchorMsgCount'] as number)
        : undefined;
    const anchored = realAnchoredInputTokens(ctx.messages, ctx.lastRealInputTokens, anchorAt);
    if (anchored !== null) return anchored;
    // Custom estimator — never cache; call fresh every invocation.
    if (this._estimator) return this._estimator(ctx);
    if (
      msgCount === this._cachedMsgCount &&
      toolCount === this._cachedToolCount &&
      revision === this._cachedRevision &&
      ctx.systemPrompt === this._cachedSystemRef &&
      ctx.tools === this._cachedToolsRef &&
      this._cachedTokens >= 0
    ) {
      // Default estimator, context unchanged — reuse cached value.
      return this._cachedTokens;
    }

    const stashed = this.tryStashedTokens(ctx, msgCount, toolCount, revision);
    let tokens: number;
    if (stashed !== null) {
      // H1: the agent loop's pre-flight (or its restash in emitContextPct)
      // populated `ctx.lastRequestTokens` this iteration. Apply the
      // per-(provider,model) calibration ratio and use it. This avoids
      // a third redundant O(n) walk per iteration.
      const cal = getCalibrationState(`${ctx.provider?.id ?? 'unknown'}/${ctx.model}`);
      tokens = cal.calibrated
        ? Math.round(stashed * Math.min(1.5, Math.max(0.5, cal.ratio)))
        : stashed;
    } else {
      // Default estimator, context changed and no stash — compute fresh
      // and cache. Cold-start path: very first iteration, or the
      // middleware is being driven from somewhere that didn't run the
      // agent loop's pre-flight (tests, manual compaction trigger).
      tokens = estimateRequestTokensCalibrated(
        ctx.messages,
        ctx.systemPrompt,
        ctx.tools ?? [],
        `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`,
      ).total;
    }
    this._cachedTokens = tokens;
    this._cachedMsgCount = msgCount;
    this._cachedToolCount = toolCount;
    this._cachedRevision = revision;
    this._cachedSystemRef = ctx.systemPrompt;
    this._cachedToolsRef = ctx.tools;
    return tokens;
  }

  /**
   * Never-undercount send guard.
   *
   * The calibrated estimate can under-count dense content (CJK, base64,
   * minified) by >1.5×, which would let an over-limit request slip past the
   * thresholds and reach the provider. Once the calibrated load is high enough
   * that even the max density factor (2.5×) *could* overflow (load ≥ 1/2.5 =
   * 0.4), re-check with the upper-bound estimator and escalate to whichever
   * load is larger. Below 0.4 an overflow is arithmetically impossible, so the
   * extra scan is skipped.
   */
  private applySendGuard(
    ctx: Context,
    calibratedLoad: number,
    availableInputTokens: number,
  ): number {
    if (calibratedLoad < AutoCompactionMiddleware.GUARD_GATE_LOAD) return calibratedLoad;
    const guardTotal = estimateRequestTokensUpperBound(
      ctx.messages,
      ctx.systemPrompt,
      ctx.tools ?? [],
      `${ctx.provider?.id ?? 'unknown'}/${ctx.model}`,
    ).total;
    const guardLoad = guardTotal / availableInputTokens;
    return guardLoad > calibratedLoad ? guardLoad : calibratedLoad;
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
    level: PressureLevel,
    tokens: number,
    availableInputTokens: number,
  ): boolean {
    if (level === 'hard') return true;
    const last = this.lastHygieneTokens;
    if (last === null) return true;
    // Compaction or a rewind can shrink the context below the last anchor.
    // Re-anchor on the smaller size instead of banking the drop as growth
    // that has already been spent.
    const anchor = Math.min(last, tokens);
    this.lastHygieneTokens = anchor;
    const interval = Math.max(
      AutoCompactionMiddleware.HYGIENE_MIN_GROWTH_TOKENS,
      Math.floor(availableInputTokens * AutoCompactionMiddleware.HYGIENE_GROWTH_RATIO),
    );
    return tokens - anchor >= interval;
  }

  /**
   * H1: try to read a pre-computed token total from `ctx.lastRequestTokens`
   * (set by the agent loop's pre-flight or its restash in emitContextPct).
   * Returns the uncalibrated total when the stash is valid for the current
   * context shape (positive number, and the message count it was computed
   * at matches the current one — otherwise tool results have been appended
   * since and the value is stale). Returns null when missing or stale so
   * the caller falls back to a fresh walk.
   */
  private tryStashedTokens(
    ctx: Context,
    msgCount: number,
    toolCount: number,
    revision: number,
  ): number | null {
    const stashed = ctx.lastRequestTokens;
    if (typeof stashed !== 'number' || stashed <= 0) return null;
    // The agent loop writes the (msg, tool) count it computed the stash at
    // into ctx.meta['lastRequestTokensAt']. When the counts disagree the
    // caller has already recomputed and refreshed the stash, but we verify
    // the meta key exists for safety — older code paths and tests may set
    // lastRequestTokens without the companion entry.
    const stashedAt = ctx.meta?.['lastRequestTokensAt'];
    if (typeof stashedAt !== 'object' || stashedAt === null) return null;
    const meta = stashedAt as { msgCount?: unknown; toolCount?: unknown; revision?: unknown };
    if (meta.msgCount !== msgCount) return null;
    if (typeof meta.toolCount === 'number' && meta.toolCount !== toolCount) return null;
    // A same-length replaceMessages() rewrite is invisible to count-only
    // stamps. Require the ConversationState revision that produced the stash;
    // legacy stamps without it are treated as untrusted and recomputed once.
    if (meta.revision !== revision) return null;
    return stashed;
  }

  /** Invalidate every token view derived from the pre-rewrite conversation. */
  private invalidateTokenCaches(ctx: Context): void {
    ctx.lastRequestTokens = undefined;
    ctx.lastRealInputTokens = undefined;
    delete ctx.meta['lastRequestTokensAt'];
    delete ctx.meta['realAnchorMsgCount'];
    this._cachedTokens = -1;
    this._cachedMsgCount = -1;
    this._cachedToolCount = -1;
    this._cachedRevision = -1;
    this._cachedSystemRef = null;
    this._cachedToolsRef = null;
  }

  /**
   * Returns true when the previous compaction at the same or higher pressure
   * level reduced nothing and context has not grown materially since. Prevents
   * a stuck preserveK window from spamming compaction events every iteration.
   */
  private shouldSkipNoopRetry(level: PressureLevel, tokens: number): boolean {
    const stuck = this.lastNoopAttempt;
    if (!stuck) return false;
    // Escalation always retries — soft → hard might be reducible aggressively.
    if (LEVEL_RANK[level] > LEVEL_RANK[stuck.level]) return false;
    const delta = tokens - stuck.tokens;
    return delta < AutoCompactionMiddleware.NOOP_RETRY_DELTA_TOKENS;
  }

  private recordAttempt(level: PressureLevel, tokens: number, report: CompactReport): void {
    // Prefer full-request tokens (accurate); fall back to message-only before/after.
    const before = report.fullRequestTokensBefore ?? report.before;
    const after = report.fullRequestTokensAfter ?? report.after;
    const saved = before - after;
    const minimumUsefulSaving = Math.max(
      AutoCompactionMiddleware.MIN_EFFECTIVE_REDUCTION_TOKENS,
      Math.ceil(before * AutoCompactionMiddleware.MIN_EFFECTIVE_REDUCTION_RATIO),
    );
    const reduced = saved >= minimumUsefulSaving;
    const repaired = !!report.repaired;
    if (reduced || repaired) {
      this.lastNoopAttempt = null;
    } else {
      this.lastNoopAttempt = { level, tokens };
    }
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
    const runtimeMaxContext = pressure.budget.maxContext;
    let postCompactionOverflow: AgentError | null = null;
    try {
      const revisionBefore = ctx.state.revision;
      const report = await this.compactor.compact(ctx, { aggressive });
      if (ctx.state.revision !== revisionBefore) {
        this.invalidateTokenCaches(ctx);
      }
      this.recordAttempt(pressure.level, pressure.tokens, report);
      this.onCompact?.(report);
      this.events?.emit('compaction.fired', {
        sessionId: resolveEventSessionId(ctx),
        level: pressure.level,
        tokens: pressure.tokens,
        load: pressure.load,
        maxContext: runtimeMaxContext,
        budget: pressure.budget,
        signals: pressure.signals,
        report,
        aggressive,
      });

      // Persist a compaction event to the session log (if a bridge was provided).
      // This is one of the highest-value audit events for understanding context
      // window behavior over long runs.
      await this.sessionBridge?.append({
        type: 'compaction',
        ts: new Date().toISOString(),
        before: report.before,
        after: report.after,
        level: pressure.level,
        aggressive,
        reductions: report.reductions?.map((r) => ({ phase: r.phase, saved: r.saved })),
        budget: pressure.budget,
        signals: pressure.signals,
        // Record what was collapsed so the audit trail shows the preserved
        // content, not just token counts. Bounded to keep the log line small;
        // the full original turns are already in the session JSONL.
        ...(report.collapsedDigest ? { digest: truncateDigest(report.collapsedDigest) } : {}),
      });

      // Stale file-read metadata from before the compaction boundary is no
      // longer useful and would cause hasRead() to skip legitimate re-reads.
      ctx.clearFileTracking();

      const afterTokens = report.fullRequestTokensAfter ?? report.after;
      let afterBudget = contextWindowBudget(ctx, afterTokens, runtimeMaxContext);
      let afterLoad = afterBudget.load;
      let stillHard = afterLoad >= pressure.hardThreshold;

      // Last-resort emergency trim — the no-overflow guarantee. When normal
      // compaction (preserveK protects everything, a single oversized message,
      // a >1.5× under-estimate) leaves the request above the hard line, trim
      // message CONTENT until it structurally fits rather than throwing a
      // terminal AGENT_CONTEXT_OVERFLOW. This runs in-band so recovery/retry is
      // never needed for a proactively-detected overflow.
      if (stillHard) {
        const trim = this.emergencyTrim(ctx, afterBudget, pressure.hardThreshold);
        if (trim) {
          const retryTokens = estimateRequestTokens(
            ctx.messages,
            ctx.systemPrompt,
            ctx.tools ?? [],
          ).total;
          afterBudget = contextWindowBudget(ctx, retryTokens, runtimeMaxContext);
          afterLoad = afterBudget.load;
          stillHard = afterLoad >= pressure.hardThreshold;
          ctx.clearFileTracking();
          this.events?.emit('compaction.emergency_trim', {
            sessionId: resolveEventSessionId(ctx),
            level: pressure.level,
            saved: trim.saved,
            trimmedBlocks: trim.trimmedBlocks,
            droppedMessages: trim.droppedMessages,
            tokens: retryTokens,
            load: afterLoad,
            maxContext: runtimeMaxContext,
            budget: afterBudget,
            withinBudget: trim.withinBudget,
          });
        }
      }

      if (!stillHard && afterLoad > pressure.targetLoad) {
        const trim = this.emergencyTrim(ctx, afterBudget, pressure.targetLoad);
        if (trim) {
          const retryTokens = estimateRequestTokens(
            ctx.messages,
            ctx.systemPrompt,
            ctx.tools ?? [],
          ).total;
          afterBudget = contextWindowBudget(ctx, retryTokens, runtimeMaxContext);
          afterLoad = afterBudget.load;
          stillHard = afterLoad >= pressure.hardThreshold;
          ctx.clearFileTracking();
          this.events?.emit('compaction.target_trim', {
            sessionId: resolveEventSessionId(ctx),
            level: pressure.level,
            targetLoad: pressure.targetLoad,
            saved: trim.saved,
            trimmedBlocks: trim.trimmedBlocks,
            droppedMessages: trim.droppedMessages,
            tokens: retryTokens,
            load: afterLoad,
            maxContext: runtimeMaxContext,
            budget: afterBudget,
            withinBudget: trim.withinBudget,
          });
        }
      }

      // Only reachable if the emergency trim somehow could not fit the request
      // (e.g. a budget smaller than a single floored message — not achievable in
      // practice). Preserve the original fail-safe so nothing is silently sent.
      const fatal =
        stillHard &&
        (this.failureMode === 'throw' ||
          (this.failureMode === 'throw_on_hard' && pressure.level === 'hard'));
      if (stillHard) {
        const error = new Error(
          `Auto-compaction left context above the hard threshold after ${pressure.level} compaction`,
        );
        this.events?.emit('compaction.failed', {
          sessionId: resolveEventSessionId(ctx),
          err: error,
          aggressive,
          level: pressure.level,
          tokens: afterBudget.inputTokens,
          maxContext: runtimeMaxContext,
          budget: afterBudget,
          signals: pressure.signals,
          load: afterLoad,
          fatal,
        });
        if (fatal) {
          postCompactionOverflow = new AgentError({
            message: `Auto-compaction did not reduce context below hard threshold`,
            code: ERROR_CODES.AGENT_CONTEXT_OVERFLOW,
            recoverable: true,
            context: {
              level: pressure.level,
              tokens: afterBudget.inputTokens,
              maxContext: runtimeMaxContext,
            },
          });
        }
      }
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const fatal =
        this.failureMode === 'throw' ||
        (this.failureMode === 'throw_on_hard' && pressure.level === 'hard');
      this.events?.emit('compaction.failed', {
        sessionId: resolveEventSessionId(ctx),
        err: error,
        aggressive,
        level: pressure.level,
        tokens: pressure.tokens,
        maxContext: runtimeMaxContext,
        budget: pressure.budget,
        signals: pressure.signals,
        load: pressure.load,
        fatal,
      });
      if (fatal) {
        throw new AgentError({
          message: `Auto-compaction failed at ${pressure.level} threshold`,
          code: ERROR_CODES.AGENT_CONTEXT_OVERFLOW,
          recoverable: true,
          context: {
            level: pressure.level,
            tokens: pressure.tokens,
            maxContext: runtimeMaxContext,
          },
          cause: err,
        });
      }
    }
    if (postCompactionOverflow) throw postCompactionOverflow;
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
    const rawMessageTokens = estimateMessages(ctx.messages);
    const rawFull = estimateRequestTokens(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total;
    const rawOverhead = Math.max(0, rawFull - rawMessageTokens);
    // Target 95% of the hard line, expressed in the estimator's raw scale.
    const targetGuardFull = Math.floor(hardThreshold * budget.availableInputTokens * 0.95);
    // `enforceHardBudget` counts raw tokens, but the request is measured by the
    // upper-bound guard. Deflate the raw message budget by the current density
    // inflation so the trimmed request fits the guard, not just the raw
    // estimate — over-trimming slightly is the safe direction here.
    const guardFull = estimateRequestTokensUpperBound(
      ctx.messages,
      ctx.systemPrompt,
      ctx.tools ?? [],
    ).total;
    const inflation = rawFull > 0 ? Math.max(1, guardFull / rawFull) : 1;
    const messageBudget = Math.max(1, Math.floor(targetGuardFull / inflation) - rawOverhead);
    const result = enforceHardBudget(ctx.messages, messageBudget, {
      preserveK: this.resolvePreserveK(ctx),
    });
    if (!result.changed) return null;
    ctx.state.replaceMessages(result.messages);
    this.invalidateTokenCaches(ctx);
    return {
      saved: result.saved,
      trimmedBlocks: result.trimmedBlocks,
      droppedMessages: result.droppedMessages,
      withinBudget: result.withinBudget,
    };
  }

  /** Preserve-window size from the active policy, defaulting to 6 recent pairs. */
  private resolvePreserveK(ctx: Context): number {
    const policy = ctx.meta?.['contextWindowPolicy'];
    const k =
      policy && typeof policy === 'object'
        ? (policy as { preserveK?: unknown }).preserveK
        : undefined;
    return typeof k === 'number' && k > 0 ? Math.floor(k) : 6;
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
    const policy = ctx.meta?.['contextWindowPolicy'];
    const threshold =
      policy && typeof policy === 'object'
        ? (policy as { eliseThreshold?: unknown }).eliseThreshold
        : undefined;
    const perResultBaseline =
      typeof threshold === 'number' && Number.isFinite(threshold) && threshold >= 0
        ? Math.floor(threshold)
        : 1_200;
    const desired = perResultBaseline * this.resolvePreserveK(ctx);
    const contextCap = Math.max(
      perResultBaseline,
      Math.floor(effectiveMaxContext(ctx, this._maxContext) * 0.12),
    );
    return Math.max(perResultBaseline, Math.min(desired, contextCap));
  }

  /**
   * Number of recent completed tool exchanges kept as semantic receipts.
   * Four receipts per preserve slot retains a useful investigation trail; the
   * absolute bounds keep frugal mode useful and deep mode finite.
   */
  private resolveToolReceiptRetention(ctx: Context): number {
    return Math.min(96, Math.max(16, this.resolvePreserveK(ctx) * 4));
  }
}

function effectiveMaxContext(ctx: Context, configured: number): number {
  const learned = ctx.meta?.['effectiveMaxContext'];
  if (typeof learned === 'number' && Number.isFinite(learned) && learned > 0) {
    return Math.floor(learned);
  }
  const providerMax = ctx.provider?.capabilities?.maxContext;
  if (typeof providerMax === 'number' && Number.isFinite(providerMax) && providerMax > 0) {
    return Math.floor(providerMax);
  }
  return configured;
}

function contextWindowBudget(
  ctx: Context,
  inputTokens: number,
  maxContext: number,
): ContextWindowBudgetSnapshot {
  return computeContextWindowBudget({
    maxContext,
    inputTokens,
    maxOutput: ctx.provider?.capabilities?.maxOutput,
    outputReserveTokens: readPositiveMetaNumber(ctx, 'contextOutputReserveTokens'),
    safetyBufferTokens: readPositiveMetaNumber(ctx, 'contextSafetyBufferTokens'),
  });
}

function readPositiveMetaNumber(ctx: Context, key: string): number | undefined {
  const value = ctx.meta?.[key];
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined;
}

function adaptThresholdsForSignals(
  thresholds: { warn: number; soft: number; hard: number },
  signals: { repeatedReadCount: number },
): { warn: number; soft: number; hard: number } {
  if (signals.repeatedReadCount < 3) return thresholds;
  // Re-reading the same file repeatedly is a strong sign of shrinking-spiral
  // behavior. Lower only warn/soft a little so compaction can refresh anchors
  // before the hard overflow path, but keep hard fixed as the safety boundary.
  return {
    warn: Math.max(0.25, thresholds.warn - 0.08),
    soft: Math.max(0.35, thresholds.soft - 0.04),
    hard: thresholds.hard,
  };
}

function normalizeTargetLoad(
  targetLoad: number | null | undefined,
  thresholds: { warn: number; soft: number; hard: number },
): number {
  if (typeof targetLoad === 'number' && Number.isFinite(targetLoad) && targetLoad > 0) {
    return Math.min(Math.max(0.05, targetLoad), Math.max(0.05, thresholds.hard - 0.01));
  }
  return Math.max(0.05, thresholds.warn);
}
