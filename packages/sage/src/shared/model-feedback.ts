import type { MemoryFeedbackInput, Sage } from '../memory-model.js';

const VERDICTS = new Set(['useful', 'outdated', 'incorrect', 'irrelevant', 'uncertain']);
const MAX_FEEDBACK = 8;

/** Usefulness/irrelevance do not resolve a factual challenge to unchanged content. */
export function currentModelChallenge(memory: Sage) {
  return memory.feedback
    ?.filter(
      (item) =>
        item.observedRevision === memory.revision &&
        (item.verdict === 'outdated' || item.verdict === 'incorrect'),
    )
    .at(-1);
}

/** Preserve judgments as attributed evidence, never as automatic truth or ranking credit. */
export function appendModelFeedback(memory: Sage, input: MemoryFeedbackInput, at: string): Sage {
  if (!input || !VERDICTS.has(input.verdict)) throw new Error('Invalid SAGE feedback verdict.');
  if (!Number.isSafeInteger(input.observedRevision) || input.observedRevision < 1) {
    throw new Error('SAGE feedback requires a positive observedRevision.');
  }
  if (input.observedRevision !== memory.revision) {
    throw new Error(
      'SAGE revision changed; read the current memory and reassess before submitting feedback.',
    );
  }
  if (
    typeof input.evidence !== 'string' ||
    !input.evidence.trim() ||
    input.evidence.length > 2000
  ) {
    throw new Error('SAGE feedback evidence must contain 1–2000 characters.');
  }
  if (
    input.sessionId !== undefined &&
    (typeof input.sessionId !== 'string' || !input.sessionId.trim() || input.sessionId.length > 200)
  ) {
    throw new Error('Invalid SAGE feedback sessionId.');
  }
  const feedback = {
    verdict: input.verdict,
    observedRevision: input.observedRevision,
    evidence: input.evidence.trim(),
    sessionId: input.sessionId?.trim(),
    at,
  };
  const history = memory.feedback ?? [];
  if (
    history.some(
      (item) =>
        item.observedRevision === feedback.observedRevision &&
        item.verdict === feedback.verdict &&
        item.evidence === feedback.evidence &&
        item.sessionId === feedback.sessionId,
    )
  )
    return memory;
  return { ...memory, feedback: [...history, feedback].slice(-MAX_FEEDBACK) };
}
