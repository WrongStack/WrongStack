import type { Context } from '../core/context.js';
import type { TextBlock } from '../types/blocks.js';
import { isTextBlock } from '../types/blocks.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { Message } from '../types/messages.js';
import type { Provider, Request } from '../types/provider.js';
import type { OneShotOrchestrator } from './one-shot-llm.js';
import { estimateRequestTokens } from '../utils/token-estimate.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
import { readBundledInstructionText } from '../utils/instruction-file.js';
import {
  buildLosslessDigest,
  buildSmartDigest,
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
   * path, gaining fallback chain support and cheap-model defaulting.
   */
  oneShotOrchestrator?: OneShotOrchestrator | undefined;
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
  private readonly oneShotOrchestrator?: OneShotOrchestrator | undefined;

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
      // Always record summary phase — even with 0 token savings the
      // enrichment (buildSmartDigest critical-content preservation) is
      // valuable for maintaining decision continuity across compaction.
      reductions.push({ phase: 'summary', saved: Math.max(0, phase2.saved) });
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

  private async callSummarizer(messages: Message[], ctx: Context): Promise<string> {
    // When a OneShotOrchestrator is wired, use it with a cheap default model
    // and fallback support. Otherwise fall back to direct provider.complete().
    if (this.oneShotOrchestrator) {
      const result = await this.oneShotOrchestrator.call({
        system: this.summarizerPrompt,
        messages: [{ role: 'user', content: this.messagesToSummary(messages) }],
        model: this.summarizerModel ?? 'deepseek-chat',
        timeoutMs: 30_000,
        maxTokens: 1024,
        signal: ctx.signal,
        fallbackProfile: 'summary',
      });
      if (result.text && !result.error) return result.text;
      // OneShotLLM failed — fall through to lossless digest below.
    } else {
      // Legacy path: direct provider.complete().
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

    return '(empty summary)';
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

  /** Compact string summary of messages (no TextBlock wrapper). */
  private messagesToSummary(messages: Message[]): string {
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
    return lines.join('\n');
  }
}
