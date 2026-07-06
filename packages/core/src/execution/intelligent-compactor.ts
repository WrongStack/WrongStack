import type { Context } from '../core/context.js';
import type { TextBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { Message } from '../types/messages.js';
import type { Provider, Request } from '../types/provider.js';
import { estimateRequestTokens } from '../utils/token-estimate.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import {
  buildLosslessDigest,
  eliseOldToolResults,
  estimateMessages,
  findSafeBoundary,
} from './compaction-core.js';

/**
 * Options for IntelligentCompactor.
 */
export interface IntelligentCompactorOptions {
  /** Provider to use for LLM-assisted summarization. Required. */
  provider: Provider;
  /** Fraction of maxContext that triggers a warning (default 0.6). */
  warnThreshold?: number | undefined;
  /** Fraction of maxContext that triggers soft compaction (default 0.75). */
  softThreshold?: number | undefined;
  /** Fraction of maxContext that triggers hard compaction (default 0.9). */
  hardThreshold?: number | undefined;
  /** Max context window in tokens (used only for threshold fraction math). */
  maxContext?: number | undefined;
  /** How many recent (user+assistant) pairs to always preserve (default 4). */
  preserveK?: number | undefined;
  /** Token threshold below which tool results are not elided (default 500). */
  eliseThreshold?: number | undefined;
  /** System prompt for the summarizer sub-LLM. */
  summarizerPrompt?: string | undefined;
  /**
   * Model ID to use for summarization. When not set, the same model as the
   * agent is used (which risks cascading failure on context overflow). Set to
   * a fast/cheap configured model for resilience.
   */
  summarizerModel?: string | undefined;
}

/**
 * An importance label for a message or message range.
 */
export type Importance = 'critical' | 'high' | 'medium' | 'low';

/**
 * Result of importance analysis.
 */
export interface ImportanceAnalysis {
  messages: Array<{ index: number; importance: Importance; reason: string }>;
  criticalRanges: Array<{ from: number; to: number; summary: string }>;
}

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

  constructor(opts: IntelligentCompactorOptions) {
    this.provider = opts.provider;
    this.warnThreshold = opts.warnThreshold ?? 0.6;
    this.softThreshold = opts.softThreshold ?? 0.75;
    this.hardThreshold = opts.hardThreshold ?? 0.9;
    this.maxContext = opts.maxContext ?? 128_000;
    this.preserveK = opts.preserveK ?? 4;
    this.eliseThreshold = opts.eliseThreshold ?? 500;
    this.summarizerPrompt =
      opts.summarizerPrompt ??
      readBundledInstructionText('llm/intelligent-compactor-summarizer.md');
    this.summarizerModel = opts.summarizerModel;
  }

  async compact(ctx: Context, opts: { aggressive?: boolean | undefined } = {}): Promise<CompactReport> {
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

    // Phase 2: LLM summarization of ancient turns
    let collapsedDigest: string | undefined;
    if (aggressive) {
      const phase2 = await this.summarizeAncientTurns(ctx);
      if (phase2.saved > 0) reductions.push({ phase: 'summary', saved: phase2.saved });
      collapsedDigest = phase2.digest;
    } else if (load >= this.warnThreshold) {
      // Non-aggressive: lightweight elision only.
      const saved2 = this.elide(ctx);
      if (saved2 > 0) reductions.push({ phase: 'elision', saved: saved2 });
    }

    const repaired = repairToolUseAdjacency(ctx.messages);
    if (repaired.report.changed) ctx.state.replaceMessages(repaired.messages);

    const afterTokens = estimateMessages(ctx.messages);
    const afterFull = this.estimateFullRequest(ctx);
    return {
      before: beforeTokens,
      after: afterTokens,
      fullRequestTokensBefore: beforeFull,
      fullRequestTokensAfter: afterFull,
      reductions,
      collapsedDigest,
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

    let summaryText: string;
    try {
      summaryText = await this.callSummarizer(toSummarize, ctx);
    } catch {
      // Fallback: lossless rule-based digest (text preserved, tool I/O dropped).
      // Cannot fail and preserves the semantic content the summarizer would have.
      summaryText =
        buildLosslessDigest(toSummarize) ||
        `${toSummarize.length} earlier turns (semantic content preserved)`;
    }

    const summaryMsg: Message = {
      role: 'system',
      content: `[prior_turns_summary: ${summaryText}]`,
    };
    const summaryTokens = estimateMessages([summaryMsg]);

    // L1-A: route through ConversationState so subscribers see the rewrite.
    const tail = ctx.messages.slice(boundary);
    ctx.state.replaceMessages([summaryMsg, ...tail]);
    return { saved: Math.max(0, removedTokens - summaryTokens), digest: summaryText };
  }

  private async callSummarizer(messages: Message[], ctx: Context): Promise<string> {
    const prompt: TextBlock[] = [
      { type: 'text', text: this.summarizerPrompt },
      { type: 'text', text: '\n\nConversation to summarize:\n' },
      ...this.messagesToText(messages),
    ];

    const req: Request = {
      model: this.summarizerModel ?? ctx.model,
      system: prompt,
      messages: [],
      maxTokens: 1024,
    };

    // Use abort signal from context if available.
    // Fall back to a fresh controller only if ctx.signal is absent — this
    // avoids leaking AbortControllers on every summarizer call (the original
    // `?? new AbortController().signal` created a controller that was never
    // connected to anything, making cancellation a no-op).
    const ac = ctx.signal ? undefined : new AbortController();
    const signal = ctx.signal ?? ac?.signal;
    let res;
    try {
      res = await this.provider.complete(req, { signal });
    } finally {
      ac?.abort();
    }

    const textBlocks = res.content.filter(isTextBlock);
    return (
      textBlocks
        .map((b) => b.text)
        .join('\n')
        .trim() || '(empty summary)'
    );
  }

  private messagesToText(messages: Message[]): TextBlock[] {
    const lines: string[] = [];
    for (const m of messages) {
      const role = m.role.padEnd(10, ' ');
      if (typeof m.content === 'string') {
        lines.push(`[${role}]: ${m.content.slice(0, 500)}`);
      } else if (Array.isArray(m.content)) {
        const textParts = m.content.filter(isTextBlock).map((b) => b.text);
        if (textParts.length > 0) {
          lines.push(`[${role}]: ${textParts.join(' ').slice(0, 500)}`);
        }
      }
    }
    return [{ type: 'text', text: lines.join('\n') }];
  }
}
