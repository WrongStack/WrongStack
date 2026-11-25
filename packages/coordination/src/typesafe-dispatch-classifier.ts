/**
 * TypeSafe-backed classifier for the smart agent dispatcher.
 *
 * Drop-in alternative to {@link makeLLMClassifier}: same `DispatchClassifier`
 * seam, same call sites, different machinery underneath.
 *
 * ## Why this seam in particular
 *
 * The classifier only runs when the keyword heuristic is AMBIGUOUS — which the
 * dispatcher's own comment already identifies as "exactly when two siblings
 * share vocabulary and a summary alone cannot separate them". That is a
 * bounded choice among a handful of named options where the hard part is
 * reading what each one actually does. It is the same shape as the skill
 * shortlist, and the same primitive answers it.
 *
 * ## What changes
 *
 * The existing classifier renders a prompt, asks a model for prose, pulls the
 * first `{...}` out with a regex, `safeParse`s it, checks `role` is a string,
 * and checks the string is one of the candidates. Five places to fail, and a
 * malformed reply is indistinguishable from "I don't know". A `Choice` over
 * the candidate roles cannot return a role that was not offered, so all five
 * collapse into one typed answer.
 *
 * Two things the prompt-and-parse path could not do at all:
 *
 * 1. **Decline honestly.** The contract lets a classifier return `null`, but a
 *    model asked to pick one of six always picks one of six. Today the only
 *    way to decline is to emit something unparseable. A `Noul` asks whether
 *    ANY candidate genuinely suits the task rather than merely being closest,
 *    so declining becomes a first-class answer and the dispatcher falls back
 *    to its own heuristic instead of inheriting a guess.
 *
 * 2. **Report real confidence.** `dispatchAgent` records `confidence: 1` for
 *    every LLM pick, because a parsed JSON blob carries no certainty. A Choice
 *    returns a distribution, so a near-tie between two siblings can be
 *    reported as the near-tie it is.
 */

import type { TypeSafeClient, TypeSafeQuestion } from '@wrongstack/core/typesafe';
import type { DispatchClassifier } from './dispatcher.js';

/** Question ids. Not sent to the model; they key the answers. */
const WHICH = 'which';
const ANY_FITS = 'any_fits';

export interface TypeSafeDispatchClassifierOptions {
  client: TypeSafeClient;
  /** TypeSafe model id. Defaults to the client's. */
  model?: string | undefined;
  /**
   * Decline when "does any of these genuinely fit" lands below this. Default
   * 0.35.
   *
   * Declining is not a failure: the dispatcher's own fallback (best heuristic
   * guess, else the generalist) is a reasonable answer for a task no
   * specialist covers, and better than a specialist chosen because it was
   * nearest.
   */
  fitThreshold?: number | undefined;
  /**
   * Decline when the Choice's own confidence is below this. Default 0.2.
   *
   * This is deliberately low. A flat distribution between two roles that would
   * both do the job is not a reason to refuse — several acceptable answers
   * spread probability the same way genuine confusion does. It only catches
   * the case where the distribution says nothing at all.
   */
  minConfidence?: number | undefined;
  /** Per-request timeout hint passed as an abort signal. Default 4000ms. */
  timeoutMs?: number | undefined;
}

/**
 * Build a `DispatchClassifier` backed by TypeSafe.
 *
 * Wire it exactly where `makeLLMClassifier` goes:
 * `dispatchAgent(task, { classifier: makeTypeSafeDispatchClassifier({ client }) })`
 */
export function makeTypeSafeDispatchClassifier(
  opts: TypeSafeDispatchClassifierOptions,
): DispatchClassifier {
  const fitThreshold =
    typeof opts.fitThreshold === 'number' && Number.isFinite(opts.fitThreshold)
      ? opts.fitThreshold
      : 0.35;
  const minConfidence =
    typeof opts.minConfidence === 'number' && Number.isFinite(opts.minConfidence)
      ? opts.minConfidence
      : 0.2;
  const timeoutMs =
    typeof opts.timeoutMs === 'number' && Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0
      ? opts.timeoutMs
      : 4_000;

  return async (task, candidates) => {
    if (candidates.length === 0) return null;
    // One candidate is not a choice. The dispatcher would take this role
    // anyway via its heuristic path, so spending a request to "decide" it
    // would buy nothing.
    if (candidates.length === 1) return null;

    const criteria: Record<string, string | null> = {};
    for (const candidate of candidates) {
      // The contrast line is the most useful evidence here for the same reason
      // the prompt version includes it: the classifier only runs on tasks
      // where summaries alone did not separate siblings.
      criteria[candidate.role] = candidate.differentiatesFrom
        ? `${candidate.summary} — distinct from its siblings in that it ${candidate.differentiatesFrom}`
        : candidate.summary;
    }

    const questions: Record<string, TypeSafeQuestion> = {
      [WHICH]: {
        type: 'choice',
        instructions:
          'Which of these specialist agents should take on this task? Read what each ' +
          'one actually does, not just its name.',
        criteria,
      },
      [ANY_FITS]: {
        type: 'noul',
        instructions:
          'Is at least one of these agents genuinely suited to this task, rather than ' +
          'merely being the closest available match?',
        criteria: {
          true: 'A listed agent covers what the task actually asks for.',
          false:
            'The task falls outside all of them; a generalist would serve it as well or better.',
        },
      },
    };

    let result: Awaited<ReturnType<TypeSafeClient['systemOne']>>;
    try {
      result = await opts.client.systemOne(
        // Each question sees only its own rubric and the shared state. The
        // fit Noul needs the candidates here, not only in the Choice rubric.
        {
          activityFeature: 'fleetDispatch',
          state: { task, candidates: criteria },
          questions,
          model: opts.model,
        },
        AbortSignal.timeout(timeoutMs),
      );
    } catch {
      // The dispatcher already treats a throwing classifier as "no answer",
      // but returning null keeps that contract explicit rather than relying on
      // its catch.
      return null;
    }

    const which = result.answers[WHICH];
    const anyFits = result.answers[ANY_FITS];
    if (which?.type !== 'choice') return null;
    // A missing fit answer is not permission to proceed: without it there is
    // nothing standing between a task no agent covers and the nearest one.
    if (anyFits?.type !== 'noul') return null;

    if (anyFits.noul < fitThreshold) return null;
    if (which.confidence < minConfidence) return null;
    // Defence in depth: the distribution is echoed back from criteria we sent,
    // but it arrives over the network and names an agent we would then run.
    if (!candidates.some((candidate) => candidate.role === which.choice)) return null;

    return {
      role: which.choice,
      confidence: which.confidence,
      reason:
        `TypeSafe: ${(which.probabilities[which.choice] ?? which.confidence).toFixed(2)} ` +
        `(fit ${anyFits.noul.toFixed(2)})`,
    };
  };
}
