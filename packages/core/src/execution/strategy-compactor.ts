import type {
  CompactionObserver,
  CompactOptions,
  Compactor,
  CompactReport,
} from '@wrongstack/contracts/types/compactor';
import type { ContextWindowPolicy } from '@wrongstack/contracts/types/context-window';
import type { Message } from '@wrongstack/contracts/types/messages';
import { keepsOwnContext } from '../core/agent-owned-context.js';
import type { Context } from '../core/context.js';
import { LLMSelector } from '../models/llm-selector.js';
import { SystemOneSelector } from '../models/system-one-selector.js';
import type { TypeSafeJudge } from '../typesafe/judgments.js';
import { toErrorMessage } from '../utils/index.js';
import { compactAgentOwnedContext } from './agent-context-compaction.js';
import {
  compactionReportStillCurrent,
  markStaleCompactionReport,
} from './compaction-result-state.js';
import { HybridCompactor } from './compactor.js';
import { IntelligentCompactor } from './intelligent-compactor.js';
import type { OneShotOrchestrator } from './one-shot-llm.js';
import { SelectiveCompactor } from './selective-compactor.js';

export type CompactorStrategy = 'hybrid' | 'intelligent' | 'selective';

export interface StrategyCompactorOptions {
  /** Which compactor to use. Defaults to 'hybrid' (lossless, no LLM). */
  strategy?: CompactorStrategy | string | undefined;
  /** Recent user/assistant pairs to always preserve. */
  preserveK?: number | undefined;
  /** Token threshold below which tool results are not elided. */
  eliseThreshold?: number | undefined;
  /**
   * Enable content-aware smart digest for 'hybrid' strategy. When true,
   * collapsed ancient turns use buildSmartDigest: critical content (errors,
   * corrections, decisions) stays verbatim; normal exchanges get first-sentence
   * summaries; noise (repeated failures, large tool outputs) is aggressively
   * compressed. Defaults to false (lossless digest).
   */
  smart?: boolean | undefined;
  /** Model used by the LLM-backed strategies for summarization/selection. */
  summarizerModel?: string | undefined;
  /** Max output tokens for the selector LLM call in 'selective' strategy (default: 1024). */
  selectorMaxOutputTokens?: number | undefined;
  /**
   * Legacy shortcut for `strategy: 'selective'`. When `strategy` is unset (or
   * 'hybrid') and this is true, the selective (LLM-driven) compactor is used.
   * An explicit `strategy` always wins.
   */
  llmSelector?: boolean | undefined;
  /**
   * OneShotOrchestrator for LLM-backed compaction summarization. When set,
   * the intelligent/selective compactor uses it instead of direct provider
   * calls, gaining fallback chain support and a cheap default model.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
  /**
   * TypeSafe judge for the 'selective' strategy's selector, read per
   * compaction. When it resolves, turns are rated by System One and packed
   * into the budget in code; otherwise (or on any failure) the LLM selector
   * decides exactly as before.
   */
  getSystemOneJudge?: (() => TypeSafeJudge | undefined) | undefined;
}

/**
 * Build the compactor named by `config.context.strategy`.
 *
 * - `hybrid` (default): lossless rule-based — no provider needed.
 * - `intelligent` / `selective`: LLM-backed. These need a `provider`, which is
 *   only known per-run, so we return a thin wrapper that resolves the concrete
 *   compactor from `ctx` at `compact()`-time. This deliberately avoids the
 *   container/provider construction-ordering problem: `TOKENS.Compactor` is
 *   resolved (and memoized) before `context.provider` exists, but `ctx.provider`
 *   is always present once a run is actually compacting. If no provider is
 *   available at compact-time the wrapper degrades to the lossless hybrid rules
 *   rather than failing.
 */
export function createStrategyCompactor(opts: StrategyCompactorOptions = {}): Compactor {
  const configured = (opts.strategy ??
    (opts.llmSelector ? 'selective' : 'hybrid')) as CompactorStrategy;
  const built = new Map<CompactorStrategy, Compactor>();
  const forStrategy = (strategy: CompactorStrategy): Compactor => {
    const existing = built.get(strategy);
    if (existing) return existing;
    const inner: Compactor =
      strategy === 'intelligent' || strategy === 'selective'
        ? new ProviderBackedCompactor(strategy, opts)
        : new HybridCompactor({
            preserveK: opts.preserveK,
            eliseThreshold: opts.eliseThreshold,
            smart: opts.smart,
          });
    built.set(strategy, inner);
    return inner;
  };
  // Resolve the strategy from the CONVERSATION being compacted, not from the
  // process. One compactor instance serves every tab, and the strategy used to
  // be frozen at construction from the boot config — so a strategy chosen in
  // one tab was written to that tab's meta, where nothing read it, and the
  // compaction every tab actually got stayed whatever the process booted with.
  // The provider is already resolved from `ctx` at compact time for the same
  // reason; this is the same seam, one level up.
  const journaled = new JournaledCompactor({
    compact: (ctx, compactOpts) =>
      forStrategy(strategyForContext(ctx, configured)).compact(ctx, compactOpts),
  });
  // An agent keeping its own context compacts it itself; the transcript is
  // left as it is, so there is no snapshot to journal.
  return {
    compact: (ctx, compactOpts) =>
      keepsOwnContext(ctx.provider)
        ? compactAgentOwnedContext(ctx)
        : journaled.compact(ctx, compactOpts),
    observe: (observer) => journaled.observe(observer),
  };
}

/** The compaction strategy this conversation asked for, or the project's. */
function strategyForContext(
  ctx: Parameters<Compactor['compact']>[0],
  fallback: CompactorStrategy,
): CompactorStrategy {
  const scoped = (ctx as { meta?: Record<string, unknown> }).meta?.['contextStrategy'];
  return scoped === 'hybrid' || scoped === 'intelligent' || scoped === 'selective'
    ? scoped
    : fallback;
}

/**
 * Persists the exact post-compaction message array as a reconstruct event.
 * Every production compaction entry point resolves its compactor through
 * createStrategyCompactor(), so manual, automatic, recovery, WebUI and
 * eternal-engine compactions all share this one durability boundary.
 */
class JournaledCompactor implements Compactor {
  private readonly observers = new Set<CompactionObserver>();

  constructor(private readonly inner: Compactor) {}

  /**
   * Every compaction path funnels through here, so this is where lifecycle
   * observers (PreCompact/PostCompact hooks) attach — one seam instead of
   * one per caller.
   */
  observe(observer: CompactionObserver): () => void {
    this.observers.add(observer);
    return () => {
      this.observers.delete(observer);
    };
  }

  async compact(ctx: Context, compactOpts: CompactOptions = {}): Promise<CompactReport> {
    await this.notify((observer) => observer.before?.(ctx, compactOpts));
    const report = await this.compactJournaled(ctx, compactOpts);
    if (ctx.signal?.aborted || !compactionReportStillCurrent(report, ctx)) return report;
    await this.notify((observer) => observer.after?.(ctx, compactOpts, report));
    if (!compactionReportStillCurrent(report, ctx)) return markStaleCompactionReport(report);
    return report;
  }

  /** Observers are advisory: one that throws never fails or skips the pass. */
  private async notify(
    call: (observer: CompactionObserver) => void | Promise<void>,
  ): Promise<void> {
    for (const observer of [...this.observers]) {
      try {
        await call(observer);
      } catch (err) {
        console.error(
          JSON.stringify({
            level: 'warn',
            event: 'compaction.observer_failed',
            message: toErrorMessage(err),
            timestamp: new Date().toISOString(),
          }),
        );
      }
    }
  }

  private async compactJournaled(
    ctx: Context,
    compactOpts: CompactOptions,
  ): Promise<CompactReport> {
    const state = ctx.state;
    const revisionBefore = state.revision;
    const sessionBefore = ctx.session;
    const writer = ctx.activeRunSessionWriter ?? sessionBefore;
    const report = await this.inner.compact(ctx, compactOpts);
    // Session selection may change while a selector/summarizer is pending.
    // Never journal the old operation into the newly selected transcript.
    if (ctx.session !== sessionBefore || !compactionReportStillCurrent(report, ctx))
      return markStaleCompactionReport(report);
    const changed =
      state.revision !== revisionBefore ||
      report.reductions.some((reduction) => reduction.saved > 0) ||
      report.repaired !== undefined;
    if (!changed || !writer) return report;

    const messages = ctx.messages.map(stripTransientMessageFields);
    try {
      await writer.append({
        type: 'context_snapshot',
        ts: new Date().toISOString(),
        reason: 'compaction',
        messages,
      });
      // A snapshot is a reconstruct boundary: do not return from compaction
      // while it exists only in the writer's in-memory batch.
      await writer.flush();
    } catch (err) {
      // Session logging remains best-effort by contract. Keep the compacted
      // live state usable, but make the lost exact-replay boundary explicit.
      console.error(
        JSON.stringify({
          level: 'error',
          event: 'session.context_snapshot_write_failed',
          sessionId: writer.id,
          message: toErrorMessage(err),
          timestamp: new Date().toISOString(),
        }),
      );
    }
    if (ctx.session !== sessionBefore || !compactionReportStillCurrent(report, ctx))
      return markStaleCompactionReport(report);
    return report;
  }
}

function stripTransientMessageFields(message: Message): Message {
  const { _estTokens: _ignored, ...persisted } = message;
  return persisted;
}

class ProviderBackedCompactor implements Compactor {
  constructor(
    private readonly strategy: 'intelligent' | 'selective',
    private readonly opts: StrategyCompactorOptions,
  ) {}

  async compact(
    ctx: Context,
    compactOpts: { aggressive?: boolean | undefined } = {},
  ): Promise<CompactReport> {
    return this.resolveInner(ctx).compact(ctx, compactOpts);
  }

  /**
   * Construct the concrete compactor for this run. Rebuilt per call (cheap, no
   * I/O) so a model switch — which changes `ctx.provider.capabilities.maxContext`
   * — is always reflected. Reads the active ContextWindowPolicy from `ctx.meta`
   * so the LLM compactors honor the same thresholds/preserveK as the policy.
   */
  private resolveInner(ctx: Context): Compactor {
    const provider = ctx.provider;
    if (!provider) {
      // No provider on ctx → cannot run an LLM compactor. Degrade to lossless rules.
      return new HybridCompactor({
        preserveK: this.opts.preserveK,
        eliseThreshold: this.opts.eliseThreshold,
      });
    }

    const policy = readPolicy(ctx);
    const learnedMax = ctx.meta?.['effectiveMaxContext'];
    const maxContext =
      typeof learnedMax === 'number' && Number.isFinite(learnedMax) && learnedMax > 0
        ? Math.floor(learnedMax)
        : provider.capabilities?.maxContext || undefined;
    const thresholds = policy?.thresholds;
    const common = {
      provider,
      maxContext,
      preserveK: this.opts.preserveK ?? policy?.preserveK,
      eliseThreshold: this.opts.eliseThreshold ?? policy?.eliseThreshold,
      ...(thresholds
        ? {
            warnThreshold: thresholds.warn,
            softThreshold: thresholds.soft,
            hardThreshold: thresholds.hard,
          }
        : {}),
    };

    if (this.strategy === 'selective') {
      const getJudge = this.opts.getSystemOneJudge;
      return new SelectiveCompactor({
        ...common,
        selector: getJudge
          ? new SystemOneSelector({
              getJudge,
              fallback: new LLMSelector({
                provider,
                model: this.opts.summarizerModel,
                maxOutputTokens: this.opts.selectorMaxOutputTokens,
              }),
            })
          : undefined,
        selectorModel: this.opts.summarizerModel,
        selectorMaxOutputTokens: this.opts.selectorMaxOutputTokens,
        summarizerModel: this.opts.summarizerModel,
      });
    }
    return new IntelligentCompactor({
      ...common,
      summarizerModel: this.opts.summarizerModel,
      oneShotOrchestrator: this.opts.oneShotOrchestrator,
    });
  }
}

function readPolicy(ctx: Context): ContextWindowPolicy | null {
  const policy = ctx.meta?.['contextWindowPolicy'];
  if (!policy || typeof policy !== 'object') return null;
  const candidate = policy as Partial<ContextWindowPolicy>;
  if (typeof candidate.preserveK !== 'number' || !candidate.thresholds) return null;
  return candidate as ContextWindowPolicy;
}
