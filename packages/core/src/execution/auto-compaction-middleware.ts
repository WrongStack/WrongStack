import type { Context } from '../core/context.js';
import type { EventBus } from '../kernel/events.js';
import type { MiddlewareHandler } from '../kernel/pipeline.js';
import type { SessionEventBridge } from '../storage/session-event-bridge.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { ContextWindowAggressiveOn, ContextWindowPolicy } from '../types/context-window.js';
import { AgentError, ERROR_CODES } from '../types/errors.js';
import {
  estimateRequestTokensCalibrated,
  getCalibrationState,
} from '../utils/token-estimate.js';

type PressureLevel = 'warn' | 'soft' | 'hard';
const LEVEL_RANK: Record<PressureLevel, number> = { warn: 0, soft: 1, hard: 2 };

/** Max chars of collapse digest persisted to the session log line. */
const MAX_DIGEST_LOG_CHARS = 4_000;

function truncateDigest(digest: string): string {
  if (digest.length <= MAX_DIGEST_LOG_CHARS) return digest;
  return `${digest.slice(0, MAX_DIGEST_LOG_CHARS)}… [+${digest.length - MAX_DIGEST_LOG_CHARS} chars; full turns in session log]`;
}

export type CompactionFailureMode = 'throw' | 'throw_on_hard' | 'continue';

export interface AutoCompactionOptions {
  aggressiveOn?: ContextWindowAggressiveOn | undefined;
  events?: EventBus | undefined;
  failureMode?: CompactionFailureMode | undefined;
  policyProvider?: (ctx: Context) => Pick<
    ContextWindowPolicy,
    'thresholds' | 'aggressiveOn'
  > | null | undefined;
  /** Optional bridge for writing compaction events into the persistent session log. */
  sessionBridge?: SessionEventBridge | undefined;
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
  private readonly _estimator?: (((ctx: Context) => number)) | undefined;
  private readonly warnThreshold: number;
  private readonly softThreshold: number;
  private readonly hardThreshold: number;
  /** Writable so model-switch can update the denominator without re-registering the middleware. */
  private _maxContext: number;
  private readonly aggressiveOn: ContextWindowAggressiveOn;
  private readonly events?: EventBus | undefined;
  private readonly failureMode: CompactionFailureMode;
  private readonly policyProvider?: AutoCompactionOptions['policyProvider'] | undefined;
  private readonly sessionBridge?: SessionEventBridge | undefined;

  /**
   * Once a compaction attempt reduces nothing (preserveK protects everything,
   * no oversized tool_results remain to elide), retrying on every iteration
   * just spams `compaction.fired` events without making progress. We remember
   * the no-op and skip until either the pressure level escalates or context
   * has grown by at least this many tokens since the failed attempt.
   */
  private static readonly NOOP_RETRY_DELTA_TOKENS = 2_000;

  /** Tracks the most recent no-op attempt so we can avoid re-firing per turn. */
  private lastNoopAttempt: { level: PressureLevel; tokens: number } | null = null;

  /**
   * Cached token estimate from the last handler() invocation. When the
   * message count and tool count haven't changed since the last estimate
   * (autonomous idle loops), we skip the expensive O(n) token estimation
   * and reuse this value. Reset to -1 when the context changes.
   */
  private _cachedTokens = -1;
  private _cachedMsgCount = -1;
  private _cachedToolCount = -1;

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
    _estimator: (ctx: Context) => number,
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
  }

  /** Allow callers (e.g. model-switch in WebUI) to update the context window
   *  denominator when the active model changes. */
  setMaxContext(maxContext: number): void {
    this._maxContext = maxContext;
  }

  handler(): MiddlewareHandler<Context> {
    return async (ctx, next) => {
      // Reuse the last token estimate when the context hasn't grown since
      // the previous check — common in autonomous idle loops. The cached
      // value is invalidated whenever messages or tools change.
      //
      // IMPORTANT: the cache is only valid for the deterministic
      // estimateRequestTokensCalibrated path (messages+system+tools → fixed
      // output). When a custom _estimator is provided (e.g. in tests with
      // a mutable closure, or a dynamic policy provider), always call it
      // fresh — the estimator owns its own semantics and the middleware
      // cannot safely cache its result across calls.
      const msgCount = ctx.messages.length;
      const toolCount = (ctx.tools ?? []).length;

      let tokens: number;
      if (this._estimator) {
        // Custom estimator — never cache; call fresh every invocation.
        tokens = this._estimator(ctx);
      } else if (
        msgCount === this._cachedMsgCount &&
        toolCount === this._cachedToolCount &&
        this._cachedTokens >= 0
      ) {
        // Default estimator, context unchanged — reuse cached value.
        tokens = this._cachedTokens;
      } else if (this.tryStashedTokens(ctx, msgCount, toolCount) !== null) {
        // H1: the agent loop's pre-flight (or its restash in emitContextPct)
        // populated `ctx.lastRequestTokens` this iteration. Apply the
        // per-(provider,model) calibration ratio and use it. This avoids
        // a third redundant O(n) walk per iteration.
        const stashed = this.tryStashedTokens(ctx, msgCount, toolCount) as number;
        const cal = getCalibrationState(`${ctx.provider?.id ?? 'unknown'}/${ctx.model}`);
        tokens = cal.calibrated
          ? Math.round(stashed * Math.min(1.5, Math.max(0.5, cal.ratio)))
          : stashed;
        this._cachedTokens = tokens;
        this._cachedMsgCount = msgCount;
        this._cachedToolCount = toolCount;
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
        this._cachedTokens = tokens;
        this._cachedMsgCount = msgCount;
        this._cachedToolCount = toolCount;
      }
      const load = tokens / this._maxContext;
      const policy = this.policyProvider?.(ctx);
      const thresholds = policy?.thresholds ?? {
        warn: this.warnThreshold,
        soft: this.softThreshold,
        hard: this.hardThreshold,
      };
      const aggressiveOn = policy?.aggressiveOn ?? this.aggressiveOn;

      const level: PressureLevel | null =
        load >= thresholds.hard
          ? 'hard'
          : load >= thresholds.soft
            ? 'soft'
            : load >= thresholds.warn
              ? 'warn'
              : null;

      if (!level) {
        // Load dropped back below all thresholds — any previously stuck state
        // is no longer relevant.
        this.lastNoopAttempt = null;
        return next(ctx);
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

      await this.compact(ctx, aggressive, { level, tokens, load });

      return next(ctx);
    };
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
  private tryStashedTokens(ctx: Context, msgCount: number, toolCount: number): number | null {
    const stashed = ctx.lastRequestTokens;
    if (typeof stashed !== 'number' || stashed <= 0) return null;
    // The agent loop writes the (msg, tool) count it computed the stash at
    // into ctx.meta['lastRequestTokensAt']. When the counts disagree the
    // caller has already recomputed and refreshed the stash, but we verify
    // the meta key exists for safety — older code paths and tests may set
    // lastRequestTokens without the companion entry.
    const stashedAt = ctx.meta?.['lastRequestTokensAt'];
    if (typeof stashedAt !== 'object' || stashedAt === null) return null;
    const meta = stashedAt as { msgCount?: unknown; toolCount?: unknown };
    if (meta.msgCount !== msgCount) return null;
    if (typeof meta.toolCount === 'number' && meta.toolCount !== toolCount) return null;
    return stashed;
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
    const reduced =
      (report.fullRequestTokensBefore ?? report.before) > (report.fullRequestTokensAfter ?? report.after);
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
    pressure: { level: PressureLevel; tokens: number; load: number },
  ): Promise<void> {
    try {
      const report = await this.compactor.compact(ctx, { aggressive });
      this.recordAttempt(pressure.level, pressure.tokens, report);
      this.events?.emit('compaction.fired', {
        level: pressure.level,
        tokens: pressure.tokens,
        load: pressure.load,
        maxContext: this._maxContext,
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
        // Record what was collapsed so the audit trail shows the preserved
        // content, not just token counts. Bounded to keep the log line small;
        // the full original turns are already in the session JSONL.
        ...(report.collapsedDigest
          ? { digest: truncateDigest(report.collapsedDigest) }
          : {}),
      });

      // Stale file-read metadata from before the compaction boundary is no
      // longer useful and would cause hasRead() to skip legitimate re-reads.
      ctx.clearFileTracking();
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const fatal =
        this.failureMode === 'throw' ||
        (this.failureMode === 'throw_on_hard' && pressure.level === 'hard');
      this.events?.emit('compaction.failed', {
        err: error,
        aggressive,
        level: pressure.level,
        tokens: pressure.tokens,
        maxContext: this._maxContext,
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
            maxContext: this._maxContext,
          },
          cause: err,
        });
      }
    }
  }
}
