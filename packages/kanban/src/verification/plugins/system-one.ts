/**
 * Escalation plugin: System One criterion check.
 *
 * An `agent` check is a criterion no deterministic verifier can decide, and
 * the agent escalation it asks for is a placeholder that reports "not yet
 * dispatched". Many such criteria are a narrow question over evidence that
 * is already on disk — "does this change do X?" — which is the citation-check
 * shape: does the evidence support the claim?
 *
 * When a host has installed a criterion judge (a TypeSafe System One Noul,
 * see `setKanbanCriterionJudge`), this plugin answers `agent` checks from the
 * current diff:
 *
 *   - probability ≥ `passAt` with changed files to cite  → passed
 *   - probability ≤ `failAt`                              → failed
 *   - anything else, no evidence, or no judge / failure   → skipped, exactly
 *     the result the agent placeholder gives, so the escalation stays open.
 *
 * Kanban does not depend on the TypeSafe client; the judge is a plain
 * function the host builds, so nothing here knows about accounts, rests or
 * credentials. Without an installed judge `canHandle` is false and the
 * registry behaves as if this plugin did not exist.
 */
import type { KanbanBackingRef, KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

export interface KanbanCriterionJudgeInput {
  criterion: string;
  /** Unified diff of the changed files, bounded. */
  diff: string;
  changedFiles: string[];
}

export interface KanbanCriterionJudgeResult {
  /** Probability the evidence shows the criterion is met, 0..1. */
  probability: number;
  /** Model that answered, for the report. */
  model?: string | undefined;
}

/** Returns `undefined` when no judgment is available (host resting, failure). */
export type KanbanCriterionJudge = (
  input: KanbanCriterionJudgeInput,
) => Promise<KanbanCriterionJudgeResult | undefined>;

let installed: (() => KanbanCriterionJudge | undefined) | undefined;

/**
 * Install (or clear, with `undefined`) the process-wide criterion judge.
 * A getter, so a host can resolve its account per check.
 */
export function setKanbanCriterionJudge(
  getJudge: (() => KanbanCriterionJudge | undefined) | undefined,
): void {
  installed = getJudge;
}

const MAX_DIFF_CHARS = 24_000;
const MAX_FILES = 40;

export interface SystemOneVerifierOptions {
  passAt?: number | undefined;
  failAt?: number | undefined;
}

export class SystemOneVerifierPlugin implements VerifierPlugin {
  readonly id = 'system-one';
  readonly kind = 'escalation' as const;
  private readonly passAt: number;
  private readonly failAt: number;

  constructor(opts: SystemOneVerifierOptions = {}) {
    this.passAt = opts.passAt ?? 0.92;
    this.failAt = opts.failAt ?? 0.08;
  }

  canHandle(checkType: string): boolean {
    return checkType === 'agent' && installed !== undefined;
  }

  /** Human-set status is not re-judged; automated outcomes must be refreshed. */
  accepts(check: KanbanCheck): boolean {
    return (
      (check.status !== 'passed' && check.status !== 'failed') ||
      check.checkedBy === 'agent' ||
      check.checkedBy === 'system'
    );
  }

  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    const undecided = (message: string): KanbanVerificationCheckResult => ({
      checkId: check.id,
      description: check.description,
      type: check.type,
      status: 'skipped',
      evidence: { escalation: 'agent', message },
      error: 'Agent escalation not yet dispatched.',
    });

    const judge = installed?.();
    if (!judge) return undecided('No System One judge available; dispatch an agent.');

    const [diffEntries, status] = await Promise.all([context.diffSince(), context.gitStatus()]);
    const changedFiles = [...new Set([...diffEntries.map((d) => d.path), ...status.files])].slice(
      0,
      MAX_FILES,
    );
    if (changedFiles.length === 0) {
      return undecided('No changed files to judge the criterion against.');
    }
    const diff = (await context.gitDiffForFiles(changedFiles)).slice(0, MAX_DIFF_CHARS);

    let verdict: KanbanCriterionJudgeResult | undefined;
    try {
      verdict = await judge({ criterion: check.description, diff, changedFiles });
    } catch {
      verdict = undefined;
    }
    if (!verdict) return undecided('System One gave no judgment; dispatch an agent.');

    const p = verdict.probability;
    if (typeof p !== 'number' || !Number.isFinite(p) || p < 0 || p > 1) {
      return undecided('System One returned an invalid probability; dispatch an agent.');
    }
    const backingRefs: KanbanBackingRef[] = changedFiles.slice(0, 10).map((path) => ({
      kind: 'diff',
      path,
      summary: `Changed file judged against the criterion (System One p=${p.toFixed(2)})`,
    }));
    const evidence = {
      verifier: 'system-one',
      probability: p,
      ...(verdict.model ? { model: verdict.model } : {}),
      changedFiles: changedFiles.length,
    };
    if (p >= this.passAt) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'passed',
        evidence,
        backingRefs,
      };
    }
    if (p <= this.failAt) {
      return {
        checkId: check.id,
        description: check.description,
        type: check.type,
        status: 'failed',
        evidence,
        backingRefs,
        error: 'The current diff does not show this criterion being met.',
      };
    }
    return undecided(
      `System One was not decisive (p=${p.toFixed(2)}); dispatch an agent for this criterion.`,
    );
  }
}
