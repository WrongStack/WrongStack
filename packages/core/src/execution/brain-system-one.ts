/**
 * System One tier for the Brain ladder.
 *
 * The single-LLM tier answers an option-bearing request by asking a chat model
 * for `{"optionId": ...}` and parsing it. The option list is a closed set, so
 * that is exactly a TypeSafe `Choice` — one that cannot return an id that was
 * not offered, cannot be truncated mid-JSON by a reasoning budget, and returns
 * a real distribution instead of a self-reported `confidence` field.
 *
 * It sits BEFORE the LLM tier and only settles what it is sure of:
 *
 *   - option-bearing requests only (Jev does not generate free text);
 *   - below the council floor (a high-risk request gets the panel, not a
 *     gut check);
 *   - the Choice must be concentrated AND a separate Noul must agree the
 *     state is enough to decide. Anything short of that returns `null` and
 *     the ladder continues exactly as it did before this tier existed.
 *
 * A thrown error (host resting, credential rejected, timeout) is also `null`.
 * The tier can make the ladder faster; it can never make it answer less.
 */

import type { BrainDecision, BrainDecisionRequest } from '../brain/brain.js';
import type { TypeSafeJudge, TypeSafeQuestion } from '../typesafe/index.js';

const WHICH = 'which';
const DECIDABLE = 'decidable';

/** State budget. Jev's limit is 32k tokens for state + longest question. */
const MAX_CONTEXT_CHARS = 12_000;
const MAX_DIGEST_CHARS = 3_000;

export interface SystemOneBrainTierOptions {
  getJudge: () => TypeSafeJudge | undefined;
  /** Minimum Choice confidence to settle. Default 0.75. */
  minConfidence?: number | undefined;
  /** Minimum probability of the chosen option. Default 0.7. */
  minProbability?: number | undefined;
  /** Minimum "the state is enough to decide" Noul. Default 0.4. */
  minDecidable?: number | undefined;
  timeoutMs?: number | undefined;
  getDecisionDigest?: ((request: BrainDecisionRequest) => string | undefined) | undefined;
}

export interface SystemOneBrainTier {
  /** A decision, or `null` to let the ladder continue. Never throws. */
  decide(request: BrainDecisionRequest): Promise<BrainDecision | null>;
}

function clamp(text: string | undefined, max: number): string | undefined {
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max)}\n…[truncated]` : text;
}

/** The raw judgment behind a tier decision, before thresholds. */
export interface SystemOneBrainProbe {
  optionId: string;
  /** Probability of the chosen option. */
  probability: number;
  /** Choice concentration. */
  confidence: number;
  /** "The state is enough to decide" Noul. */
  decidable: number;
  /** Every option's probability. */
  probabilities: Record<string, number>;
  model: string | undefined;
}

/**
 * Ask the tier's questions and return the raw answer, no thresholds applied.
 * Throws on transport failure; `undefined` for a request it cannot ask about
 * or a malformed answer. Exported for calibration (ledger replay).
 */
export async function probeSystemOneBrain(
  judge: TypeSafeJudge,
  request: BrainDecisionRequest,
  opts: { digest?: string | undefined; timeoutMs?: number | undefined } = {},
): Promise<SystemOneBrainProbe | undefined> {
  const options = request.options;
  if (!options || options.length < 2) return undefined;

  const criteria: Record<string, string> = {};
  for (const option of options) {
    criteria[option.id] =
      option.label +
      (option.consequence ? ` — consequence: ${option.consequence}` : '') +
      (option.recommended ? ' (marked as the recommended option)' : '');
  }

  const questions: Record<string, TypeSafeQuestion> = {
    [WHICH]: {
      type: 'choice',
      instructions:
        'An autonomous coding agent must answer `question` without a human. Which option is ' +
        'better supported by the evidence in `context` (and by how similar past decisions in ' +
        '`history` turned out)? The wording of `question` may suggest an answer; judge the ' +
        'evidence, not the wording.',
      criteria,
    },
    [DECIDABLE]: {
      type: 'noul',
      instructions:
        'Does `context` contain concrete evidence (error text, output, a stated fact) that ' +
        'shows which of the `options` is right — more than the counts or thresholds that ' +
        'raised `question`?',
      criteria: {
        true: 'The context shows what is actually happening, and it clearly favours one option.',
        false:
          'The context only says that a signal fired, or the right option depends on a ' +
          'preference, intent or fact it does not contain.',
      },
    },
  };

  const result = await judge.client.systemOne(
    {
      activityFeature: judge.feature,
      state: {
        question: request.question,
        risk: request.risk,
        context: clamp(request.context, MAX_CONTEXT_CHARS),
        options: criteria,
        history: clamp(opts.digest, MAX_DIGEST_CHARS),
      },
      questions,
      model: judge.model,
    },
    AbortSignal.timeout(opts.timeoutMs ?? 4_000),
  );
  const which = result.answers[WHICH];
  const decidable = result.answers[DECIDABLE];
  if (which?.type !== 'choice' || decidable?.type !== 'noul') return undefined;
  if (!options.some((o) => o.id === which.choice)) return undefined;
  return {
    optionId: which.choice,
    probability: which.probabilities[which.choice] ?? 0,
    confidence: which.confidence,
    decidable: decidable.noul,
    probabilities: which.probabilities,
    model: result.model ?? judge.model,
  };
}

/** Whether a probe clears the tier's thresholds. */
export function systemOneBrainSettles(
  probe: SystemOneBrainProbe,
  thresholds: { minConfidence?: number; minProbability?: number; minDecidable?: number } = {},
): boolean {
  return (
    probe.confidence >= (thresholds.minConfidence ?? DEFAULT_MIN_CONFIDENCE) &&
    probe.probability >= (thresholds.minProbability ?? DEFAULT_MIN_PROBABILITY) &&
    probe.decidable >= (thresholds.minDecidable ?? DEFAULT_MIN_DECIDABLE)
  );
}

export const DEFAULT_MIN_CONFIDENCE = 0.75;
export const DEFAULT_MIN_PROBABILITY = 0.7;
/**
 * Calibrated 2026-09-19 on jev-1.13.0 (`wstack typesafe replay-brain-ledger`
 * + `check-judgments`): requests whose context carries concrete evidence scored
 * ~0.56; signal-only BrainMonitor questions 0.05–0.13 (90 ledger decisions,
 * where the council itself split 65/35 and Jev picked "steer" every time);
 * preference questions ~0.02. 0.4 sits in that gap.
 */
export const DEFAULT_MIN_DECIDABLE = 0.4;

export function createSystemOneBrainTier(opts: SystemOneBrainTierOptions): SystemOneBrainTier {
  const thresholds = {
    minConfidence: opts.minConfidence ?? DEFAULT_MIN_CONFIDENCE,
    minProbability: opts.minProbability ?? DEFAULT_MIN_PROBABILITY,
    minDecidable: opts.minDecidable ?? DEFAULT_MIN_DECIDABLE,
  };

  return {
    async decide(request) {
      try {
        const judge = opts.getJudge();
        if (!judge) return null;
        const probe = await probeSystemOneBrain(judge, request, {
          digest: opts.getDecisionDigest?.(request),
          timeoutMs: opts.timeoutMs,
        });
        if (!probe || !systemOneBrainSettles(probe, thresholds)) return null;
        const option = request.options?.find((o) => o.id === probe.optionId);
        if (!option) return null;
        return {
          type: 'answer',
          optionId: option.id,
          text: option.label,
          rationale:
            `System One (${probe.model}) chose [${option.id}] ` +
            `p=${probe.probability.toFixed(2)}, confidence ${probe.confidence.toFixed(2)}, ` +
            `decidable ${probe.decidable.toFixed(2)}.`,
        };
      } catch {
        return null;
      }
    },
  };
}
