/**
 * Escalation plugin: council.
 *
 * Delegates a criterion that no deterministic verifier can settle to a
 * multi-perspective Council panel — but the panel only ever supplies the
 * VERDICT. The proof comes from the deterministic side: the plugin reads the
 * real worktree diff out of the VerificationContext, hands it to the panel as
 * quoted evidence, and turns the same diff into `backingRefs`. That keeps the
 * "proof, not opinion" contract intact: a panel that says "passed" over an
 * empty diff certifies nothing and is rejected here, not by luck downstream.
 *
 * Dispatch is INJECTED. The VerificationContext is deliberately LLM-free, so
 * the host (the Kanban tool / Director integration layer) supplies a runner
 * built on the core CouncilOrchestrator. Constructed without one, the plugin
 * keeps its original behaviour and reports the check as un-dispatched rather
 * than inventing a verdict.
 */
import type { KanbanBackingRef, KanbanCheck, KanbanVerificationCheckResult } from '../../types.js';
import type { VerificationContext } from '../verification-context.js';
import type { VerifierPlugin } from '../verifier-plugin.js';

/** Option ids the panel votes between. Stable — the mapping below keys on them. */
export const COUNCIL_CHECK_PASS_OPTION = 'criterion_met';
export const COUNCIL_CHECK_FAIL_OPTION = 'criterion_not_met';

/** Files quoted to the panel and turned into backing refs. */
export const MAX_COUNCIL_EVIDENCE_FILES = 40;

/** The subset of a core `CouncilResult` this plugin consumes. */
export interface CouncilCheckOutcome {
  status: 'decided' | 'denied' | 'abstained' | 'failed' | 'cancelled';
  optionId?: string | undefined;
  reason?: string | undefined;
  resolution?: string | undefined;
  configuredSeatCount?: number | undefined;
  validVoteCount?: number | undefined;
  distinctTargetCount?: number | undefined;
  judgeUsed?: boolean | undefined;
  warnings?: readonly string[] | undefined;
  votes?:
    | ReadonlyArray<{
        seatId: string;
        persona: string;
        status: string;
        optionId?: string | undefined;
        rationale?: string | undefined;
        model?: string | undefined;
      }>
    | undefined;
}

/**
 * Host-supplied Council dispatch. Structurally a narrowed
 * `CouncilOrchestrator.ask`, so the kanban package needs no dependency on
 * core's execution layer.
 */
export interface CouncilCheckRunner {
  ask(input: {
    question: string;
    context?: string | undefined;
    options: ReadonlyArray<{ id: string; label: string; consequence?: string | undefined }>;
    profile?: string | undefined;
  }): Promise<CouncilCheckOutcome>;
}

export interface CouncilVerifierOptions {
  /** Dispatch. Absent = the check reports as un-dispatched, as it always did. */
  runner?: CouncilCheckRunner | undefined;
  /** Council profile id for verification panels. Defaults to the host default. */
  profile?: string | undefined;
}

export class CouncilVerifierPlugin implements VerifierPlugin {
  readonly id = 'council';
  readonly kind = 'escalation' as const;

  private readonly runner: CouncilCheckRunner | undefined;
  private readonly profile: string | undefined;

  constructor(opts: CouncilVerifierOptions = {}) {
    this.runner = opts.runner;
    this.profile = opts.profile;
  }

  canHandle(checkType: string): boolean {
    return checkType === 'council';
  }

  async verify(
    check: KanbanCheck,
    context: VerificationContext,
  ): Promise<KanbanVerificationCheckResult> {
    const base = {
      checkId: check.id,
      description: check.description,
      type: check.type,
    } as const;

    if (!this.runner) {
      return {
        ...base,
        status: 'skipped',
        evidence: {
          escalation: 'council',
          message:
            'This check requires council escalation. Dispatch a multi-perspective ' +
            'Council with the check description and collect a verdict with concrete ' +
            'backing evidence.',
        },
        error: 'Council escalation not yet dispatched.',
      };
    }

    const changed = await this.collectEvidence(context);

    let outcome: CouncilCheckOutcome;
    try {
      outcome = await this.runner.ask({
        question: `Does the completed work satisfy this acceptance criterion? ${check.description}`,
        context: buildEvidenceBlock(check, context, changed),
        options: [
          {
            id: COUNCIL_CHECK_PASS_OPTION,
            label: 'The criterion is met by the observed changes',
            consequence: 'The task advances as verified.',
          },
          {
            id: COUNCIL_CHECK_FAIL_OPTION,
            label: 'The criterion is not met by the observed changes',
            consequence: 'The task is sent back for more work.',
          },
        ],
        ...(this.profile ? { profile: this.profile } : {}),
      });
    } catch (error) {
      // A dispatch failure is an ERROR, not a skip: the escalation ran and
      // could not produce a verdict, which is materially different from a
      // check nobody dispatched.
      return {
        ...base,
        status: 'error',
        evidence: { escalation: 'council', dispatched: true },
        error: `Council dispatch failed: ${error instanceof Error ? error.message : String(error)}`,
      };
    }

    const evidence: Record<string, unknown> = {
      escalation: 'council',
      dispatched: true,
      resolution: outcome.resolution,
      councilStatus: outcome.status,
      configuredSeatCount: outcome.configuredSeatCount,
      validVoteCount: outcome.validVoteCount,
      distinctTargetCount: outcome.distinctTargetCount,
      judgeUsed: outcome.judgeUsed,
      changedFileCount: changed.length,
      ...(outcome.warnings?.length ? { warnings: [...outcome.warnings] } : {}),
      ...(outcome.votes?.length ? { votes: outcome.votes.map((vote) => ({ ...vote })) } : {}),
    };
    const backingRefs = toBackingRefs(changed);

    if (
      outcome.status === 'abstained' ||
      outcome.status === 'failed' ||
      outcome.status === 'cancelled'
    ) {
      return {
        ...base,
        status: 'error',
        evidence,
        backingRefs,
        error: `Council did not reach a verdict (${outcome.status}): ${outcome.reason ?? 'no reason given'}`,
      };
    }

    const passed = outcome.status === 'decided' && outcome.optionId === COUNCIL_CHECK_PASS_OPTION;
    if (passed && backingRefs.length === 0) {
      // "Proof, not opinion": the panel is allowed to judge evidence, never to
      // substitute for it. With nothing changed there is nothing to cite, and a
      // pass here would be exactly the bare verdict this subsystem exists to
      // reject.
      return {
        ...base,
        status: 'failed',
        evidence,
        error:
          'Council judged the criterion met, but no file changes back the verdict. ' +
          'An escalation verdict without concrete evidence is not accepted.',
      };
    }

    return {
      ...base,
      status: passed ? 'passed' : 'failed',
      evidence,
      backingRefs,
      ...(passed
        ? {}
        : {
            error:
              outcome.reason ??
              (outcome.status === 'denied'
                ? 'Council denied the criterion.'
                : 'Council judged the criterion not met.'),
          }),
    };
  }

  /** Real worktree changes since the run's snapshot — the plugin's only proof. */
  private async collectEvidence(
    context: VerificationContext,
  ): Promise<Array<{ path: string; operation: string; linesAdded: number; linesRemoved: number }>> {
    try {
      const diff = await context.diffSince();
      return diff.slice(0, MAX_COUNCIL_EVIDENCE_FILES);
    } catch {
      // A diff failure must not take the check down — it becomes a panel with
      // no evidence, which the pass path above already refuses to certify.
      return [];
    }
  }
}

/**
 * Quoted, untrusted evidence for the panel.
 *
 * The Council prompts already treat `context` as data rather than
 * instructions, so the criterion text and diff go in verbatim.
 */
function buildEvidenceBlock(
  check: KanbanCheck,
  context: VerificationContext,
  changed: ReadonlyArray<{
    path: string;
    operation: string;
    linesAdded: number;
    linesRemoved: number;
  }>,
): string {
  const parts: string[] = [`Task: ${context.task.title}`];
  const trimmedNotes = check.notes?.trim();
  if (trimmedNotes) parts.push(`Check notes: ${trimmedNotes}`);
  parts.push(
    changed.length > 0
      ? `Changed files (${changed.length}):`
      : 'Changed files: none observed since the verification snapshot.',
  );
  for (const file of changed) {
    parts.push(`- ${file.path} (${file.operation}, +${file.linesAdded}/-${file.linesRemoved})`);
  }
  parts.push(
    'Judge the criterion against these observed changes only. Do not assume work',
    'that the diff does not show.',
  );
  // Use \n (not \n\n) so we get exactly one blank line between sections.
  // The previous array-of-empty-strings + `.join('\n')` produced double
  // blank lines whenever check.notes was empty or absent.
  return parts.join('\n');
}

function toBackingRefs(
  changed: ReadonlyArray<{
    path: string;
    operation: string;
    linesAdded: number;
    linesRemoved: number;
  }>,
): KanbanBackingRef[] {
  return changed.map((file) => ({
    kind: 'diff' as const,
    path: file.path,
    // Deliberately specific: the EvidenceValidator rejects vague summaries,
    // and "modified" alone tells a reviewer nothing.
    summary: `${file.operation} with +${file.linesAdded}/-${file.linesRemoved} lines`,
  }));
}
