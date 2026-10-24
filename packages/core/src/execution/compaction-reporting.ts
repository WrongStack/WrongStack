import type { CompactReport } from '@wrongstack/contracts/types/compactor';
import { type Context, resolveEventSessionId } from '../core/context.js';
import type { ContextWindowBudgetSnapshot } from '../utils/context-budget.js';
import { truncateDigest } from './compaction-reporting-support.js';
import type { PressureLevel } from './compaction-thresholds.js';

export interface CompactionReportingHost {
  events: import('@wrongstack/contracts/kernel/events').EventBus | undefined;
  onCompact:
    | ((report: import('@wrongstack/contracts/types/compactor').CompactReport) => void)
    | undefined;
  sessionBridge: import('../storage/session-event-bridge.js').SessionEventBridge | undefined;
}

export async function reportCompaction(
  this: CompactionReportingHost,
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
  const note = (err: unknown): void => {
    const error = err instanceof Error ? err : new Error(String(err));
    try {
      this.events?.emit('compaction.failed', {
        sessionId: resolveEventSessionId(ctx),
        err: error,
        aggressive,
        level: pressure.level,
        tokens: pressure.tokens,
        maxContext: pressure.budget.maxContext,
        budget: pressure.budget,
        signals: pressure.signals,
        load: pressure.load,
        fatal: false,
      });
    } catch {
      // A listener failure must not hide the hard ceiling.
    }
  };
  try {
    this.onCompact?.(report);
  } catch (err) {
    if (ctx.signal?.aborted) return;
    note(err);
  }
  try {
    this.events?.emit('compaction.fired', {
      sessionId: resolveEventSessionId(ctx),
      level: pressure.level,
      tokens: pressure.tokens,
      load: pressure.load,
      maxContext: pressure.budget.maxContext,
      budget: pressure.budget,
      signals: pressure.signals,
      report,
      aggressive,
    });
  } catch (err) {
    if (ctx.signal?.aborted) return;
    note(err);
  }
  try {
    await this.sessionBridge?.append({
      type: 'compaction',
      ts: new Date().toISOString(),
      before: report.before,
      after: report.after,
      fullRequestTokensBefore: report.fullRequestTokensBefore,
      fullRequestTokensAfter: report.fullRequestTokensAfter,
      level: pressure.level,
      aggressive,
      reductions: report.reductions?.map((r) => ({ phase: r.phase, saved: r.saved })),
      budget: pressure.budget,
      signals: pressure.signals,
      ...(report.collapsedDigest ? { digest: truncateDigest(report.collapsedDigest) } : {}),
    });
  } catch (err) {
    if (ctx.signal?.aborted) return;
    note(err);
  }
}
