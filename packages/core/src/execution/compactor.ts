import type { Context } from '../core/context.js';
import type { CompactReport, Compactor } from '../types/compactor.js';
import type { ContextWindowPolicy } from '../types/context-window.js';
import type { Message } from '../types/messages.js';
import type { Logger } from '../types/logger.js';
import { noOpLogger } from '../infrastructure/logger.js';
import { estimateRequestTokens } from '../utils/token-estimate.js';
import { repairToolUseAdjacency } from '../utils/message-invariants.js';
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
  hasTextContent,
  setCompactionDebugLogger,
} from './compaction-core.js';

export interface CompactorOptions {
  preserveK?: number | undefined;
  eliseThreshold?: number | undefined;
  /**
   * Enable content-aware digest mode. When true, `collapseAncientTurns` uses
   * `buildSmartDigest` which scores messages by importance: critical content
   * (errors, corrections, decisions) is kept verbatim; normal exchanges get
   * first-sentence summaries; large tool outputs and repeated failures are
   * aggressively compressed. Defaults to false (lossless digest).
   */
  smart?: boolean | undefined;
  /**
   * @deprecated Ignored. Token estimation is centralized in
   * `compaction-core`/`token-estimate` so all compactors and the context-pressure
   * monitor agree on one number. Kept only for backward-compatible call sites.
   */
  estimator?: ((text: string) => number) | undefined;
  /** Structured logger. Defaults to noOpLogger (silent). */
  logger?: Logger | undefined;
}

/**
 * Default tools config values shared across CLI and WebUI.
 * Import this instead of hardcoding to avoid cross-surface inconsistencies.
 * These mirror the values in CONFIG_BEHAVIOR_DEFAULTS (config-loader.ts).
 *
 * @deprecated Import from '../types/default-config.js' instead.
 *             This re-export exists for backward compatibility.
 */
export {
  DEFAULT_TOOLS_CONFIG,
  DEFAULT_CONTEXT_CONFIG,
  DEFAULT_AUTONOMY_CONFIG,
} from '../types/default-config.js';

export class HybridCompactor implements Compactor {
  private readonly preserveK: number;
  private readonly eliseThreshold: number;
  private readonly smart: boolean;
  private readonly logger: Logger;

  constructor(opts: CompactorOptions = {}) {
    this.preserveK = opts.preserveK ?? 5;
    this.eliseThreshold = opts.eliseThreshold ?? 2000;
    this.smart = opts.smart ?? false;
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
    const policy = readContextWindowPolicy(ctx);
    const preserveK = policy?.preserveK ?? this.preserveK;
    const eliseThreshold = policy?.eliseThreshold ?? this.eliseThreshold;

    // Phase 1: elision (shared core handles tool_use/tool_result pair preservation).
    const elide = eliseOldToolResults(ctx.messages, { preserveK, eliseThreshold });
    if (elide.changed) ctx.state.replaceMessages(elide.messages);
    if (elide.saved > 0) reductions.push({ phase: 'elision', saved: elide.saved });

    // Phase 1b: collapse superseded repeated reads that slipped under eliseThreshold.
    const dedup = dedupStaleReads(ctx.messages, ctx.contextEvidence?.repeatedReads ?? [], {
      preserveK,
    });
    if (dedup.changed) ctx.state.replaceMessages(dedup.messages);
    if (dedup.saved > 0) reductions.push({ phase: 'elision', saved: dedup.saved });

    // Phase 2: lossless collapse of ancient turns into a single digest.
    // Preserves ALL textual content (instructions, decisions, conclusions);
    // only raw tool I/O is dropped (it remains in the session log). No sub-LLM call.
    let collapsedDigest: string | undefined;
    let evidenceDigest: string | undefined;
    if (opts.aggressive) {
      const phase2 = this.collapseAncientTurns(ctx, preserveK);
      if (phase2.saved > 0) reductions.push({ phase: 'summary', saved: phase2.saved });
      collapsedDigest = phase2.digest;
      evidenceDigest = phase2.evidenceDigest;
    }

    const repaired = repairToolUseAdjacency(ctx.messages);
    if (repaired.report.changed) {
      ctx.state.replaceMessages(repaired.messages);
    }

    let afterTokens = estimateMessages(ctx.messages);
    let afterFull = this.estimateFullRequest(ctx);
    const quality = checkCompactionQuality(ctx, {
      collapsedDigest,
      evidenceDigest,
      reduced: beforeTokens > afterTokens || beforeFull > afterFull,
    });
    // Enforce the evidence floor: if quality flags a dropped intent/path anchor,
    // re-inject a compact [context_state] block so the goal survives (not advisory).
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

  /**
   * Lossless rule-based collapse of ancient turns into a single digest message.
   *
   * Preserves ALL textual content of the collapsed range — user instructions,
   * assistant decisions/conclusions, and any prior digests (chained forward so
   * the digest stays lossless across repeated compactions). Only `tool_use` /
   * `tool_result` protocol blocks are dropped and replaced with a count marker;
   * their full payload already lives in the session log. No sub-LLM call.
   *
   * Returns the token savings and the digest text (for audit logging).
   */
  private collapseAncientTurns(
    ctx: Context,
    preserveK = this.preserveK,
  ): { saved: number; digest?: string | undefined; evidenceDigest?: string | undefined } {
    const messages = ctx.messages;
    const cutTarget = Math.max(0, messages.length - preserveK * 2);
    if (cutTarget <= 0) return { saved: 0 };

    // Find a safe boundary: nearest user-message-with-text at or after cutTarget.
    let boundary = -1;
    for (let i = cutTarget; i < messages.length; i++) {
      const m = messages[i];
      if (!m) continue;
      if (m.role === 'user' && hasTextContent(m)) {
        boundary = i;
        break;
      }
    }
    if (boundary <= 0) return { saved: 0 };

    const removed = messages.slice(0, boundary);
    const removedTokens = estimateMessages(removed);

    const historyDigest = this.smart
      ? buildSmartDigest(removed) ||
        `${removed.length} earlier turns (no textual content; tool I/O omitted; see session log)`
      : buildLosslessDigest(removed) ||
        `${removed.length} earlier turns (no textual content; tool I/O omitted; see session log)`;

    const evidenceDigest = buildContextEvidenceDigest(ctx);
    const digest = evidenceDigest
      ? `[context_state]\n${evidenceDigest}\n\n[prior_history]\n${historyDigest}`
      : historyDigest;

    const summaryMsg: Message = {
      role: 'system',
      content: `[prior_turns_digest: ${digest}]`,
    };

    // L1-A: route through ConversationState so subscribers see the rewrite.
    const tail = ctx.messages.slice(boundary);
    ctx.state.replaceMessages([summaryMsg, ...tail]);
    return {
      saved: Math.max(0, removedTokens - estimateMessages([summaryMsg])),
      digest,
      evidenceDigest: evidenceDigest || undefined,
    };
  }
}

function readContextWindowPolicy(ctx: Context): ContextWindowPolicy | null {
  const policy = ctx.meta?.['contextWindowPolicy'];
  if (!policy || typeof policy !== 'object') return null;
  const candidate = policy as Partial<ContextWindowPolicy>;
  if (typeof candidate.preserveK !== 'number' || typeof candidate.eliseThreshold !== 'number') {
    return null;
  }
  return candidate as ContextWindowPolicy;
}
