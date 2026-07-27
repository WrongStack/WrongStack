// ---------------------------------------------------------------------------
// Shared review type definitions.
//
// These interfaces are consumed by chimera-plugin.ts (which owns the review
// orchestration) and its helper modules (review-claim-registry.ts,
// review-context-builder.ts). They live in this leaf module so the helpers can
// import the types without creating an import cycle back into chimera-plugin.ts,
// which imports the helpers' *values*. chimera-plugin.ts re-exports these names
// so existing importers keep resolving them from './chimera-plugin.js'.
// ---------------------------------------------------------------------------

export interface ResolvedChimeraConfig {
  enabled: boolean;
  provider: string;
  model: string;
  maxFiles: number;
  autoFix: 'off' | 'ask' | 'auto';
  cascadeOn: 'off' | 'critical' | 'high';
  maxCascadeDepth: number;
}

/**
 * A single changed file with its content and, for modified files, a
 * unified diff against HEAD so the reviewer can focus on what changed.
 */
export interface ReviewFileEntry {
  path: string;
  status: 'added' | 'modified';
  content: string;
  /**
   * Unified diff against HEAD for modified files.
   * For added files, this is undefined (content is the full file).
   * Capped at a reasonable size to avoid bloating the subagent task.
   */
  diff?: string | undefined;
}

/**
 * Context bundle that enriches a review beyond "here are N files."
 * Collects the *story*: what task motivated the change, what else
 * changed alongside it, and what the recent commit history looks like.
 *
 * The review subagent receives this so it can:
 * - Focus on the diff (what changed) rather than re-reviewing unchanged code
 * - Understand the task intent (todos, narrative) to judge correctness
 * - See sibling changes for cross-file consistency
 * - Avoid re-reporting known issues (commit history context)
 */
export interface ReviewContextBundle {
  /** Resolved chimera config */
  config: ResolvedChimeraConfig;
  /** Project root for git operations */
  cwd: string;
  /** Changed files with their contents and diffs */
  files: ReviewFileEntry[];
  /**
   * Auto-review-specific fallback chain, already resolved to provider/model refs.
   * Absent for ordinary Chimera and manual review triggers.
   */
  reviewFallbackModels?: string[] | undefined;
  /**
   * Cascade severity threshold from the auto-review plugin config.
   * When the review subagent finds findings at or above this level, a
   * follow-up agent (security-scanner, bug-hunter) is spawned to
   * investigate. Set by the auto-review plugin when it builds the
   * bundle; absent for chimera-plugin and /review triggers (no cascade).
   *
   * `'off'` disables cascading; `'high'` cascades on High+; `'critical'`
   * cascades only on Critical.
   */
  cascadeOn?: 'off' | 'critical' | 'high' | undefined;
  /**
   * Current cascade iteration depth (0 for the initial review, 1 after
   * the first fix+re-review cycle, etc.). The cascade handler increments
   * this on each re-review emission and stops when it reaches
   * `maxCascadeDepth`. Absent (treated as 0) for non-cascade triggers.
   */
  cascadeDepth?: number | undefined;
  /**
   * Maximum cascade iterations before the self-correcting loop stops.
   * Prevents infinite fix → re-review → fix cycles. Default 2. Set by
   * the auto-review plugin; absent for non-cascade triggers.
   */
  maxCascadeDepth?: number | undefined;

  // ── Sibling awareness ──
  /**
   * All files changed in the working tree, including ones not in the
   * current review batch. Lets the reviewer understand the broader
   * change set without expanding its review scope.
   */
  allChangedFiles?: Array<{ path: string; status: string }> | undefined;

  // ── Commit history ──
  /**
   * Recent commit messages (oneline), newest first.
   * Helps the reviewer understand what was already committed vs.
   * what's still uncommitted working-tree changes.
   */
  recentCommits?: string[] | undefined;

  // ── Task & intent context (P1) ──
  /**
   * Active todo items from the session Context at review-trigger time.
   * Lets the reviewer understand what task motivated the file changes
   * so it can judge correctness against intent, not just code shape.
   */
  activeTodos?: Array<{ id: string; content: string; status: string }> | undefined;

  /**
   * The active kanban card, if the session uses a kanban board.
   * Provides title, description, and success criteria so the
   * reviewer can verify the change satisfies the stated requirements.
   */
  kanbanCard?:
    | {
        id: string;
        title: string;
        description?: string | undefined;
        successCriteria?: string[] | undefined;
      }
    | undefined;

  /**
   * File provenance from the Chronicle journal: which agent/session/task
   * last touched each file and when. Helps the reviewer attribute
   * changes and understand the broader edit chain.
   */
  fileProvenance?:
    | Array<{
        path: string;
        agentId?: string | undefined;
        taskId?: string | undefined;
        eventType?: string | undefined;
        observedAt?: string | undefined;
      }>
    | undefined;
}

/** Legacy alias for the bundle emitted when a Chimera review is requested. */
export type ChimeraReviewNeededPayload = ReviewContextBundle;

export interface ChimeraReviewCompletePayload {
  bundle: ReviewContextBundle;
  reviewText: string;
  status: string;
  cwd: string;
  /**
   * Active session ID at review-complete time. Set by execution.ts when
   * emitting the event. Consumed by finding/report integration to stamp
   * findings with the correct session identifier instead of the working
   * directory path (which was the previous broken behaviour).
   */
  sessionId?: string | undefined;
}

export type CascadeAgentKind = 'security-scanner' | 'bug-hunter';

export interface ChimeraCascadeNeededPayload {
  bundle: ReviewContextBundle;
  reviewText: string;
  severities: { critical: number; high: number; medium: number };
  threshold: 'high' | 'critical';
  agents: CascadeAgentKind[];
}
