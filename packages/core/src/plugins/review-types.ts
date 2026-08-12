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

import type { ParsedReviewReport } from './review-finding-parser.js';
import type { ChimeraFinding } from './review-finding-types.js';

export interface ResolvedChimeraConfig {
  enabled: boolean;
  provider: string;
  model: string;
  maxFiles: number;
  autoFix: 'off' | 'ask' | 'auto';
  cascadeOn: 'off' | 'critical' | 'high';
  maxCascadeDepth: number;
  /**
   * Chimera-specific fallback model chain (`provider/model` refs), resolved
   * from `extensions["wstack-chimera"].fallbackModels`. Empty when unset —
   * the reviewer then inherits the session-level fallback profile chain.
   */
  fallbackModels: string[];
  /**
   * Named fallback profile to use for Chimera reviews, resolved from
   * `extensions["wstack-chimera"].fallbackProfile`. When set, the reviewer
   * spawn resolves the profile chain from config and prepends it to
   * `fallbackModels`.
   */
  fallbackProfile: string | undefined;
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
  /** Selection policy for the resolved auto-review profile pool. */
  reviewModelSelection?: 'round-robin' | 'random' | undefined;
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

  /**
   * P0-3: machine-evidence verification status of the cascade fix step that
   * preceded this (re-)review. Set by the cascade handler after re-running
   * the fix agents' claimed verification commands against the working tree:
   * - `verified` — every claimed typecheck/lint/test check re-ran and passed.
   * - `failed`   — at least one check failed, mismatched, timed out, or was
   *                refused (unsafe command).
   * - `missing`  — the fix agent returned no evidence block at all.
   * Absent on initial reviews (no cascade step yet).
   */
  evidenceStatus?: CascadeEvidenceStatus | undefined;

  /**
   * Per-check comparison results from the cascade evidence verification.
   * Carried so the persisted report can record exactly which commands were
   * claimed, what the orchestrator observed, and which checks matched.
   */
  evidenceChecks?: CascadeEvidenceCheckResult[] | undefined;
}

/**
 * Aggregate verdict on a cascade fix agent's machine evidence (P0-3).
 * See {@link ReviewContextBundle.evidenceStatus} for the semantics of each
 * value. Shared across the cli cascade handler (which produces it), the
 * core bundle type, and the report store (which persists it) so the shape
 * cannot drift between producer and consumers.
 */
export type CascadeEvidenceStatus = 'verified' | 'failed' | 'missing';

/**
 * One check's comparison: the command a cascade fix agent claimed to run,
 * the exit code it claimed, the exit code the orchestrator observed when it
 * re-ran the command against the working tree, and whether the check counts
 * as passed (observed exit code 0 matching a claimed 0).
 */
export interface CascadeEvidenceCheckResult {
  name: 'typecheck' | 'lint' | 'tests';
  command: string;
  /** Exit code the agent claimed (null when the block omitted the key). */
  claimedExitCode: number | null;
  /** Exit code observed by the orchestrator's re-run. */
  actualExitCode: number | null;
  /** True when the check ran and actual matches a passing (0) claim. */
  ok: boolean;
}

/** Legacy alias for the bundle emitted when a Chimera review is requested. */
export type ChimeraReviewNeededPayload = ReviewContextBundle;

export interface ChimeraReviewCompletePayload {
  bundle: ReviewContextBundle;
  reviewText: string;
  status: string;
  cwd: string;
  /**
   * Stable report identifier allocated by the execution owner before the
   * completion event is published. This keeps the durable report, parsed
   * findings, mailbox follow-up, and any cascade consumers on one identity.
   */
  reportId?: string | undefined;
  /**
   * Active session ID at review-complete time. Set by execution.ts when
   * emitting the event. Consumed by finding/report integration to stamp
   * findings with the correct session identifier instead of the working
   * directory path (which was the previous broken behaviour).
   */
  sessionId?: string | undefined;
  /**
   * Findings parsed ONCE by the execution owner (P0-1) and verified against
   * the working tree (P0-2) before persistence. Threaded through so
   * `persistReviewReport`, `integrateFindings`, and the cascade gate never
   * re-parse the report with divergent contexts. Absent for failed reviews
   * and legacy emitters that do not pre-parse — consumers fall back to
   * parsing `reviewText` themselves in that case.
   */
  parsedReport?: ParsedReviewReport | undefined;
}

export type CascadeAgentKind = 'security-scanner' | 'bug-hunter';

export interface ChimeraCascadeNeededPayload {
  bundle: ReviewContextBundle;
  /** Source review whose findings triggered this cascade. */
  reportId?: string | undefined;
  reviewText: string;
  severities: { critical: number; high: number; medium: number };
  threshold: 'high' | 'critical';
  agents: CascadeAgentKind[];
  /**
   * Findings that passed the P0-2 disk-verification pass (file exists, line
   * in range, code anchor present). Only these findings may gate a cascade
   * when the execution owner threaded a parsed report. Absent for legacy
   * emitters that skip pre-parsing.
   */
  verifiedFindings?: ChimeraFinding[] | undefined;
}
