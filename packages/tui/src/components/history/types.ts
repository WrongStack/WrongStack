import type { TodoItem } from '@wrongstack/core/agent';
import type { Lang } from '../../highlight.js';
import type { HistoryEntry } from '../../history-entry.js';
export type {
  AutonomyAgentStatus,
  HistoryEntry,
  MemoryActivationItem,
} from '../../history-entry.js';

// ============================================
// Shared types for history components
// ============================================

export interface HistoryProps {
  entries: HistoryEntry[];
  /**
   * Store parsed next steps in the shared suggestion store so /next 1 works.
   * Called by the Entry component after parsing each assistant message.
   */
  setSuggestions?: ((steps: string[]) => void) | undefined;
  /**
   * Current autonomy mode. When 'auto', a marker is shown next to the first
   * next-step suggestion indicating it will be auto-submitted.
   */
  autonomyMode?: string | undefined;
  /**
   * Generation counter for wholesale history replacements (session resume).
   * Keys the internal <Static> so a replacement remounts it — Ink's Static
   * tracks written items by index and would otherwise skip replayed entries
   * whenever the new array is shorter than what it already printed.
   */
  generation?: number | undefined;
  /**
   * Optional live tail of the currently streaming tool. Rendered below the
   * assistant tail so the user sees both at once: model thinking and tool
   * output. Cleared automatically when the tool's `tool.executed` event
   * fires and the final entry lands in `entries`.
   */
  toolStream?: { toolUseId: string; name: string; text: string; startedAt: number } | null;
  /**
   * Optional live assistant streaming text. Rendered at the bottom of
   * history during LLM generation and cleared on response completion.
   */
  streamingText?: string | undefined;
  /**
   * Minimum number of files before the per-tool multi-file diff summary
   * footer is rendered. `0` suppresses the footer entirely; any positive
   * number sets the cutoff. When `undefined`, the code-block module's
   * default (`MULTI_DIFF_SUMMARY_THRESHOLD`) is used.
   */
  multiDiffSummaryThreshold?: number | undefined;
  /**
   * Live todo list. When it has any `pending`/`in_progress` items, the
   * `💡 NEXT STEPS` panel is hidden and the suggestion store is not
   * written from the render path — mirrors the host callback's
   * `hasOpenTodos` gate (b0970387) so the two paths can't disagree about
   * whether suggestions are available.
   */
  todos?: readonly TodoItem[] | undefined;
  /**
   * Show the "Model Reasoning" blocks in chat history. When false,
   * `kind: 'thinking'` entries are hidden. Default: true.
   */
  showModelReasoning?: boolean | undefined;
  /**
   * Show SAGE Memory Inject blocks in tool results. When false,
   * the `SageMemoryBlock` panel is hidden even when memory was injected.
   * Default: false.
   */
  showSageMemoryInject?: boolean | undefined;
}

export interface BodySegment {
  type: 'prose' | 'code';
  text: string;
  lang?: Lang | undefined;
}
