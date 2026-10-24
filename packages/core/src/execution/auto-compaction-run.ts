import type { EventBus } from '@wrongstack/contracts/kernel/events';
import type { Compactor, CompactReport } from '@wrongstack/contracts/types/compactor';
import { AgentError, ERROR_CODES } from '@wrongstack/contracts/types/errors';
import { type Context, resolveEventSessionId } from '../core/context.js';
import type { ContextWindowBudgetSnapshot } from '../utils/context-budget.js';
import { estimateRequestTokens } from '../utils/token-estimate.js';
import type { CompactionFailureMode } from './auto-compaction-run-contracts.js';
import { compactionReportStillCurrent } from './compaction-result-state.js';
import type { PressureLevel } from './compaction-thresholds.js';
import { contextWindowBudget } from './compaction-thresholds.js';
export interface AutoCompactionRunHost {
  compactor: Compactor;
  invalidateTokenCaches(ctx: Context): void;
  recordAttempt(ctx: Context, level: PressureLevel, tokens: number, report: CompactReport): void;
  reportCompaction(
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
  ): Promise<void>;
  estimateContextTokens(ctx: Context): { tokens: number; exact: boolean };
  pressureLoad(
    ctx: Context,
    measuredLoad: number,
    availableInputTokens: number,
    protectLoad: number,
    exactAnchor: boolean,
  ): number;
  emergencyTrim(
    ctx: Context,
    budget: ContextWindowBudgetSnapshot,
    hardThreshold: number,
  ): {
    saved: number;
    trimmedBlocks: number;
    droppedMessages: number;
    withinBudget: boolean;
  } | null;
  applySendGuard(
    ctx: Context,
    calibratedLoad: number,
    availableInputTokens: number,
    protectLoad: number,
  ): number;
  events: EventBus | undefined;
  failureMode: CompactionFailureMode;
}

export async function compact(
  host: AutoCompactionRunHost,
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
    const report = await host.compactor.compact(ctx, { aggressive });
    const revisionAfterCompactor = ctx.state.revision;
    if (revisionAfterCompactor !== revisionBefore) {
      host.invalidateTokenCaches(ctx);
    }
    // A stopped run must not trim. A stale summarizer/selector result must
    // not be logged as a successful compaction or used for the softer target
    // trim, but the current transcript still has to pass the hard ceiling.
    if (ctx.signal?.aborted) return;
    let reportUsable = compactionReportStillCurrent(report, ctx);
    // ...unless the transcript this pass measured no longer exists. A rewind,
    // a resume, or a queued edit that lands while the compactor is awaiting
    // its LLM replaces the history wholesale; the pressure numbers above
    // describe the transcript it displaced, and the replacement has never
    // been through a compaction pass at all. Trimming it here would shred a
    // fresh conversation on the strength of a measurement taken from a dead
    // one. `compactContextIfNeeded` runs again at the end of every iteration,
    // before the next provider call, so the replacement is measured from
    // scratch — and compacted properly rather than emergency-trimmed —
    // without any send going out in between.
    let historyReplaced = !reportUsable && revisionAfterCompactor !== revisionBefore;
    if (reportUsable) {
      host.recordAttempt(ctx, pressure.level, pressure.tokens, report);
      await host.reportCompaction(ctx, pressure, aggressive, report);
      if (ctx.signal?.aborted) return;
      reportUsable = compactionReportStillCurrent(report, ctx);
      // Awaiting the event listeners and the session-log bridge is another
      // suspension point a writer can land in.
      if (!reportUsable) historyReplaced = ctx.state.revision !== revisionAfterCompactor;
    }
    if (historyReplaced) return;

    if (reportUsable) {
      // Stale file-read metadata from before the compaction boundary is no
      // longer useful and would cause hasRead() to skip legitimate re-reads.
      ctx.clearFileTracking();
    }

    const fresh = reportUsable ? undefined : host.estimateContextTokens(ctx);
    const afterTokens = fresh ? fresh.tokens : (report.fullRequestTokensAfter ?? report.after);
    let afterBudget = contextWindowBudget(ctx, afterTokens, runtimeMaxContext);
    // Compactor reports are raw estimates. Dense content must pass the same
    // upper-bound guard after compaction as before it. An exact provider
    // anchor is already real and must not be inflated.
    let afterLoad = host.pressureLoad(
      ctx,
      afterBudget.load,
      afterBudget.availableInputTokens,
      Math.min(pressure.hardThreshold, pressure.targetLoad),
      fresh?.exact ?? false,
    );
    let stillHard = afterLoad >= pressure.hardThreshold;

    // Last-resort emergency trim — the no-overflow guarantee. When normal
    // compaction (preserveK protects everything, a single oversized message,
    // a >1.5× under-estimate) leaves the request above the hard line, trim
    // message CONTENT until it structurally fits rather than throwing a
    // terminal AGENT_CONTEXT_OVERFLOW. This runs in-band so recovery/retry is
    // never needed for a proactively-detected overflow.
    if (stillHard) {
      const trim = host.emergencyTrim(ctx, afterBudget, pressure.hardThreshold);
      if (trim) {
        const retryTokens = estimateRequestTokens(
          ctx.messages,
          ctx.systemPrompt,
          ctx.tools ?? [],
        ).total;
        afterBudget = contextWindowBudget(ctx, retryTokens, runtimeMaxContext);
        afterLoad = host.applySendGuard(
          ctx,
          afterBudget.load,
          afterBudget.availableInputTokens,
          Math.min(pressure.hardThreshold, pressure.targetLoad),
        );
        stillHard = afterLoad >= pressure.hardThreshold;
        ctx.clearFileTracking();
        host.events?.emit('compaction.emergency_trim', {
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

    if (reportUsable && !stillHard && afterLoad > pressure.targetLoad) {
      const trim = host.emergencyTrim(ctx, afterBudget, pressure.targetLoad);
      if (trim) {
        const retryTokens = estimateRequestTokens(
          ctx.messages,
          ctx.systemPrompt,
          ctx.tools ?? [],
        ).total;
        afterBudget = contextWindowBudget(ctx, retryTokens, runtimeMaxContext);
        afterLoad = host.applySendGuard(
          ctx,
          afterBudget.load,
          afterBudget.availableInputTokens,
          Math.min(pressure.hardThreshold, pressure.targetLoad),
        );
        stillHard = afterLoad >= pressure.hardThreshold;
        ctx.clearFileTracking();
        host.events?.emit('compaction.target_trim', {
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

    // The pass may have started at warn or soft and still finished over the
    // hard line (the compactor grew the transcript, or its after-count is
    // the first measurement that sees the overflow). `throw_on_hard` refuses
    // that send. A compactor *exception* at warn/soft stays non-fatal; that
    // path does not know the transcript is over the line.
    const fatal = stillHard && host.failureMode !== 'continue';
    if (stillHard) {
      const error = new Error(
        `Auto-compaction left context above the hard threshold after ${pressure.level} compaction`,
      );
      host.events?.emit('compaction.failed', {
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
    if (ctx.signal?.aborted) return;
    const error = err instanceof Error ? err : new Error(String(err));
    const fatal =
      host.failureMode === 'throw' ||
      (host.failureMode === 'throw_on_hard' && pressure.level === 'hard');
    host.events?.emit('compaction.failed', {
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
