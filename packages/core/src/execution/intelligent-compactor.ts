import type { Context } from '../core/context.js';
import type { TextBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { Message } from '../types/messages.js';
import type { Provider, Request } from '../types/provider.js';
import type { Logger } from '../types/logger.js';
import { noOpLogger } from '../infrastructure/logger.js';
import {
  type CompactionSummaryCache,
  compactionSummaryKey,
  defaultCompactionSummaryCache,
  isPlaceholderSummary,
} from './compaction-summary-cache.js';
import type { OneShotOrchestrator } from './one-shot-llm.js';
import { estimateRequestTokens } from '../utils/token-estimate.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import {
  buildContextEvidenceDigest,
  checkCompactionQuality,
  injectEvidenceFloor,
} from '../utils/context-evidence.js';
import {
  buildLosslessDigest,
  buildSmartDigest,
  dedupStaleReads,
  eliseOldToolResults,
  estimateMessages,
  findSafeBoundary,
  setCompactionDebugLogger,
} from './compaction-core.js';

/**
 * Options for IntelligentCompactor.
 */
export interface IntelligentCompactorOptions {
  /** Provider to use for LLM-assisted summarization. Required. */
  provider: Provider;
  /** Fraction of maxContext that triggers a warning (default 0.5). */
  warnThreshold?: number | undefined;
  /** Fraction of maxContext that triggers soft compaction (default 0.65). */
  softThreshold?: number | undefined;
  /** Fraction of maxContext that triggers hard compaction (default 0.8). */
  hardThreshold?: number | undefined;
  /** Max context window in tokens (used only for threshold fraction math). */
  maxContext?: number | undefined;
  /** How many recent (user+assistant) pairs to always preserve (default 4). */
  preserveK?: number | undefined;
  /** Token threshold below which tool results are not elided (default 300). */
  eliseThreshold?: number | undefined;
  /** System prompt for the summarizer sub-LLM. */
  summarizerPrompt?: string | undefined;
  /**
   * Model ID to use for summarization. When not set, falls back to
   * "deepseek-chat" when a OneShotOrchestrator is wired, or the agent's
   * own model otherwise. Set to a fast/cheap configured model for
   * resilience and cost efficiency.
   */
  summarizerModel?: string | undefined;
  /**
   * OneShotOrchestrator for LLM-assisted summarization. When set,
   * `callSummarizer` uses it instead of the direct provider.complete()
   * call, gaining fallback chain support and a cheap default model.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
  /**
   * Shared cache for successful semantic summaries. By default uses the process-wide
   * cache; pass `summaryCache` to inject a private instance for tests or isolation.
   */
  summaryCache?: CompactionSummaryCache | undefined;
  /** Structured logger. Defaults to noOpLogger (silent). */
  logger?: Logger | undefined;
}

/**
 * An importance label for a message or message range.
 */
/**
 * IntelligentCompactor uses an LLM to:
 *  - Analyze message importance and preserve critical context
 *  - Generate semantic summaries for old message ranges
 *  - Make intelligent decisions about what to compact
 *
 * It builds on the shared `compaction-core` elision/boundary primitives and
 * adds LLM-assisted summarization on top. When the summarizer call fails it
 * falls back to the same lossless rule-based digest used by HybridCompactor.
 */
export class IntelligentCompactor implements Compactor {
  private readonly provider: Provider;
  private readonly warnThreshold: number;
  private readonly softThreshold: number;
  private readonly hardThreshold: number;
  private readonly maxContext: number;
  private readonly preserveK: number;
  private readonly eliseThreshold: number;
  private readonly summarizerPrompt: string;
  private readonly summarizerModel?: string | undefined;
  private readonly oneShotOrchestrator?: OneShotOrchestrator | undefined;
  private readonly summaryCache: CompactionSummaryCache;
  private readonly logger: Logger;

  constructor(opts: IntelligentCompactorOptions) {
    this.provider = opts.provider;
    this.warnThreshold = opts.warnThreshold ?? 0.5;
    this.softThreshold = opts.softThreshold ?? 0.65;
    this.hardThreshold = opts.hardThreshold ?? 0.8;
    this.maxContext = opts.maxContext ?? 128_000;
    this.preserveK = opts.preserveK ?? 4;
    this.eliseThreshold = opts.eliseThreshold ?? 300;
    this.summarizerPrompt =
      opts.summarizerPrompt ??
      readBundledInstructionText('llm/intelligent-compactor-summarizer.md');
    this.summarizerModel = opts.summarizerModel;
    this.oneShotOrchestrator = opts.oneShotOrchestrator;
    this.summaryCache = opts.summaryCache ?? defaultCompactionSummaryCache;
    this.logger = opts.logger ?? noOpLogger;
    setCompactionDebugLogger(this.logger);
  }

  async compact(
    ctx: Context,
    opts: { aggressive?: boolean | undefined } = {},
  ): Promise<CompactReport> {
    const beforeTokens = estimateMessages(ctx.messages);
    const beforeFull = this.estimateFullRequest(ctx);
    const reductions: CompactReport['reductions'] = [];

    // Use full request tokens for threshold decisions — messages alone are inaccurate.
    const load = beforeFull / this.maxContext;
    // Past hardThreshold, force aggressive regardless of caller preference —
    // the alternative (lightweight elision) is unlikely to recover enough.
    const aggressive =
      load >= this.hardThreshold ? true : (opts.aggressive ?? load >= this.softThreshold);

    // Phase 1: always run elision (preserves recent K pairs)
    const saved1 = this.elide(ctx);
    if (saved1 > 0) reductions.push({ phase: 'elision', saved: saved1 });

    // Phase 1b: collapse superseded repeated reads under the elise threshold.
    const dedup = dedupStaleReads(ctx.messages, ctx.contextEvidence?.repeatedReads ?? [], {
      preserveK: this.preserveK,
    });
    if (dedup.changed) ctx.state.replaceMessages(dedup.messages);
    if (dedup.saved > 0) reductions.push({ phase: 'elision', saved: dedup.saved });

    // Phase 2: LLM summarization of ancient turns
    let collapsedDigest: string | undefined;
    if (aggressive) {
      const phase2 = await this.summarizeAncientTurns(ctx);
      if (phase2.digest !== undefined) {
        // Record completed summaries even with 0 token savings because the
        // enrichment preserves critical content across compaction.
        reductions.push({ phase: 'summary', saved: Math.max(0, phase2.saved) });
        collapsedDigest = phase2.digest;
      }
    } else if (load >= this.warnThreshold) {
      // Non-aggressive: lightweight elision only.
      const saved2 = this.elide(ctx);
      if (saved2 > 0) reductions.push({ phase: 'elision', saved: saved2 });
    }

    const repaired = repairToolUseAdjacency(ctx.messages);
    if (repaired.report.changed) ctx.state.replaceMessages(repaired.messages);

    let afterTokens = estimateMessages(ctx.messages);
    let afterFull = this.estimateFullRequest(ctx);
    const evidenceDigest = buildContextEvidenceDigest(ctx) || undefined;
    const quality = checkCompactionQuality(ctx, {
      collapsedDigest,
      evidenceDigest,
      reduced: beforeTokens > afterTokens || beforeFull > afterFull,
    });
    if (injectEvidenceFloor(ctx, quality)) {
      afterTokens = estimateMessages(ctx.messages);
      afterFull = this.estimateFullRequest(ctx);
    }
    return {
      before: beforeTokens,
      after: afterTokens,
      fullRequestTokensBefore: beforeFull,
      fullRequestTokensAfter: afterFull,
      reductions,
      collapsedDigest,
      evidenceDigest,
      quality,
      repaired: repaired.report.changed
        ? {
            removedToolUses: repaired.report.removedToolUses,
            removedToolResults: repaired.report.removedToolResults,
            removedMessages: repaired.report.removedMessages,
          }
        : undefined,
    };
  }

  /**
   * Estimate the full API request token count: messages + systemPrompt + toolDefs.
   * This is the accurate figure for context-window pressure monitoring.
   */
  private estimateFullRequest(ctx: Context): number {
    return estimateRequestTokens(ctx.messages, ctx.systemPrompt, ctx.tools ?? []).total;
  }

  /** Run shared tool-result elision and commit through ConversationState. */
  private elide(ctx: Context): number {
    const result = eliseOldToolResults(ctx.messages, {
      preserveK: this.preserveK,
      eliseThreshold: this.eliseThreshold,
    });
    if (result.changed) ctx.state.replaceMessages(result.messages);
    return result.saved;
  }

  private async summarizeAncientTurns(
    ctx: Context,
  ): Promise<{ saved: number; digest?: string | undefined }> {
    const messages = ctx.messages;
    const cutoff = Math.max(0, messages.length - this.preserveK * 2);
    if (cutoff <= 2) return { saved: 0 };

    // Find the best boundary in the ancient region
    const boundary = findSafeBoundary(messages, 0, cutoff);
    if (boundary <= 1) return { saved: 0 };

    const toSummarize = messages.slice(0, boundary);
    const removedTokens = estimateMessages(toSummarize);

    const summaryModel =
      this.summarizerModel ?? (this.oneShotOrchestrator ? 'deepseek-chat' : ctx.model);
    // Cache only the LLM request/result. The context-sensitive smart digest
    // below is rebuilt from this invocation's full messages on every hit, so
    // its deterministic evidence is never inherited from another session.
    const summaryInput = this.messagesToSummary(toSummarize);
    let summaryText: string;
    try {
      // Empty/placeholder results bypass the cache so a later compaction can retry.
      summaryText = await this.callSummarizer(ctx, summaryModel, summaryInput);
    } catch (err) {
      this.logger.warn('Summarizer failed; falling back to lossless digest', { err });
      // Fallback: lossless rule-based digest (text preserved, tool I/O dropped).
      summaryText =
        buildLosslessDigest(toSummarize) ||
        `${toSummarize.length} earlier turns (semantic content preserved)`;
    }

    // ── Type-aware enrichment ──────────────────────────────────────
    // Run buildSmartDigest on the same messages to extract critical
    // content (score-5: decisions, errors, corrections) verbatim.
    // Merge it with the LLM summary so important facts survive compaction.
    const smartDigest = buildSmartDigest(toSummarize);
    const enriched = smartDigest
      ? `[CRITICAL]\n${smartDigest}\n\n[SUMMARY]\n${summaryText}`
      : summaryText;

    const summaryMsg: Message = {
      role: 'system',
      content: `[prior_turns_summary: ${enriched}]`,
    };
    const summaryTokens = estimateMessages([summaryMsg]);

    // L1-A: route through ConversationState so subscribers see the rewrite.
    const tail = ctx.messages.slice(boundary);
    ctx.state.replaceMessages([summaryMsg, ...tail]);
    return { saved: Math.max(0, removedTokens - summaryTokens), digest: summaryText };
  }

  private async callSummarizer(
    ctx: Context,
    summaryModel: string,
    summaryInput: string,
  ): Promise<string> {
    // Cache the semantic summarization request independently of the transport path.
    // Both OneShot and direct provider calls use this model, instruction, and bounded input.
    const messages: Message[] = [{ role: 'user', content: summaryInput }];
    const summaryKey = compactionSummaryKey(summaryModel, this.summarizerPrompt, messages);

    // When a OneShotOrchestrator is wired, use it with a cheap default model
    // and fallback support. Otherwise fall back to direct provider.complete().
    const oneShotOrchestrator = this.oneShotOrchestrator;
    if (oneShotOrchestrator) {
      return this.summaryCache.getOrCreate(summaryKey, async () => {
        const result = await oneShotOrchestrator.call({
          system: this.summarizerPrompt,
          messages,
          model: summaryModel,
          timeoutMs: 30_000,
          maxTokens: 1024,
          signal: ctx.signal,
        });
        if (result.error || isPlaceholderSummary(result.text)) {
          throw new Error(result.error || 'Summarizer returned an empty result');
        }
        return result.text;
      });
    }

    // Legacy path: direct provider.complete().
    const prompt: TextBlock[] = [
      { type: 'text', text: this.summarizerPrompt },
      { type: 'text', text: '\n\nConversation to summarize:\n' },
      { type: 'text', text: summaryInput },
    ];
    const req: Request = {
      model: summaryModel,
      system: prompt,
      messages: [],
      maxTokens: 1024,
    };

    return this.summaryCache.getOrCreate(summaryKey, async () => {
      const timeoutSignal = AbortSignal.timeout(30_000);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, timeoutSignal]) : timeoutSignal;
      const res = await this.provider.complete(req, { signal });
      const summary = res.content
        .filter(isTextBlock)
        .map((block) => block.text)
        .join('\n')
        .trim();
      if (isPlaceholderSummary(summary)) {
        throw new Error('Summarizer returned an empty result');
      }
      return summary;
    });
  }

  /** Compact string summary of messages (no TextBlock wrapper). */
  private messagesToSummary(messages: Message[]): string {
    const lines: string[] = [];
    for (const message of messages) {
      const text = this.boundedMessageText(message);
      if (text.length > 0) {
        lines.push(`[${message.role.padEnd(10, ' ')}]: ${text}`);
      }
    }
    return lines.join('\n');
  }

  /** Match the summarizer's 500-character limit without joining full block payloads first. */
  private boundedMessageText(message: Message): string {
    if (typeof message.content === 'string') return message.content.slice(0, 500);

    let text = '';
    for (const block of message.content) {
      if (!isTextBlock(block)) continue;
      const separator = text.length > 0 ? ' ' : '';
      const remaining = 500 - text.length - separator.length;
      if (remaining <= 0) break;
      text += separator + block.text.slice(0, remaining);
      if (text.length === 500) break;
    }
    return text;
  }
}
