import type { Message } from './messages.js';

/**
 * Result of LLM-driven message importance analysis.
 * The selector marks each message range with an importance tier,
 * and optionally provides a natural-language summary for collapsed ranges.
 */
export interface SelectorResult {
  /**
   * Ordered list of kept message ranges. Each entry describes a
   * message range that should be preserved verbatim in the context.
   */
  kept: Array<{ from: number; to: number; importance: 'critical' | 'high' | 'medium' }>;
  /**
   * Collapsed ranges — either replaced by the compactor or omitted.
   * Each entry may carry a summary text produced by the LLM.
   */
  collapsed: Array<{ from: number; to: number; summary?: string | undefined }>;
  /**
   * Raw reasoning from the selector LLM (for debugging / audit).
   */
  reasoning: string;
}

/**
 * Message selector that uses an LLM to decide which message ranges
 * to keep vs collapse/summarize. The selector runs as a separate API
 * call before compaction, making it more surgical than fixed-window
 * or rules-based approaches.
 */
export interface MessageSelector {
  /**
   * Analyze `messages` and return a structured plan for what to keep
   * vs collapse. May modify the messages array in-place if needed,
   * or return a plan that the caller (Compactor) executes.
   *
   * @param messages  Current message history (may be modified in-place)
   * @param maxToKeep Token budget — selector should aim to keep total
   *                  retained message content under this threshold
   */
  select(messages: Message[], maxToKeep: number): Promise<SelectorResult>;
}
