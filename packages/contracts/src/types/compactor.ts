import type { AgentContext } from './context.js';

export interface CompactRepairReport {
  removedToolUses: string[];
  removedToolResults: string[];
  removedMessages: number;
}

export interface CompactReport {
  /**
   * Token count of messages only (pre-compaction).
   * Use `fullRequestTokensBefore` for accurate context-window load calculations.
   */
  before: number;
  /**
   * Token count of messages only (post-compaction).
   * Use `fullRequestTokensAfter` for accurate context-window load calculations.
   */
  after: number;
  /**
   * Full API request token count before compaction: messages + systemPrompt + toolDefs.
   * This is the accurate figure for context-window pressure monitoring.
   */
  fullRequestTokensBefore: number;
  /**
   * Full API request token count after compaction: messages + systemPrompt + toolDefs.
   * This is the accurate figure for context-window pressure monitoring.
   */
  fullRequestTokensAfter: number;
  reductions: { phase: 'elision' | 'summary' | 'selective'; saved: number }[];
  repaired?: CompactRepairReport | undefined;
  /**
   * When a compactor collapses a range of ancient turns into a single digest,
   * this carries the digest text so callers (e.g. the audit/session log) can
   * record exactly what was collapsed. Lossless compactors preserve all
   * textual content here; only raw tool I/O is dropped (it stays in the
   * session log). Undefined when no range was collapsed this pass.
   */
  collapsedDigest?: string | undefined;
  /**
   * Compact state digest derived from tool-output instrumentation. It carries
   * intent, path integrity, referenced tool results, active errors and implicit
   * facts without copying full tool outputs back into the context window.
   */
  evidenceDigest?: string | undefined;
  /**
   * Deterministic post-compaction sanity check. This is deliberately local and
   * cheap; LLM self-verification can be layered on top, but the compactor still
   * records whether the compacted context retained an intent anchor and path
   * trail.
   */
  quality?:
    | {
        ok: boolean;
        hasIntent: boolean;
        hasPathTrail: boolean;
        issues: string[];
      }
    | undefined;
}

/**
 * Why a compaction pass ran: `auto` (context-window pressure), `manual`
 * (`/compact`, a UI button), `overflow` (recovering from a provider
 * context-length error) or `tool` (the model's context_manager tool).
 */
export type CompactionTrigger = 'auto' | 'manual' | 'overflow' | 'tool';

export interface CompactOptions {
  aggressive?: boolean | undefined;
  /** Defaults to `auto` for observers when omitted. */
  trigger?: CompactionTrigger | undefined;
}

/** Awaited around every compaction pass; a throwing observer never blocks it. */
export interface CompactionObserver {
  before?(ctx: AgentContext, opts: CompactOptions): void | Promise<void>;
  after?(ctx: AgentContext, opts: CompactOptions, report: CompactReport): void | Promise<void>;
}

export interface Compactor {
  compact(ctx: AgentContext, opts?: CompactOptions): Promise<CompactReport>;
  /**
   * Observe every pass through this compactor. Optional: only the journaled
   * production compactor implements it. Returns an unsubscribe function.
   */
  observe?(observer: CompactionObserver): () => void;
}
