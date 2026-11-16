/**
 * System One front for triage Phases 3 and 4.
 *
 * Both phases ask a chat model for a label and read it back with a regex:
 * Phase 3 a 1-5 value rating ("SCORE | reason", first digit wins), Phase 4 a
 * YES / NO / OVERLAP merge verdict. Both answers are points on an ordered,
 * closed scale — a TypeSafe `Score` — and both run hundreds of times per
 * `/memory triage`, where Jev's per-input-token price and latency matter.
 *
 * This is a cascade, not a replacement: a judgment returns `undefined`
 * whenever it is not concentrated enough to act on, or the host is resting,
 * or the call fails, and the caller then asks the LLM exactly as before. The
 * rating the LLM would have produced is never overridden by a weak judgment.
 */

import type { TypeSafeJudge, TypeSafeQuestion } from '@wrongstack/core/typesafe';
import type { Sage } from '../types.js';
import type { ValueScoreBreakdown } from './value-score.js';

/**
 * The verdict on a merge pair. Lives here, not in `merge-detection.ts`, so this
 * module stays a leaf: merge detection and the evaluator both import it.
 */
export type MergeVerdict = 'YES' | 'NO' | 'OVERLAP';

export interface SystemOneRating {
  score: 1 | 2 | 3 | 4 | 5;
  reason: string;
}

export interface SystemOneTriage {
  rateMemory(memory: Sage, valueScore: ValueScoreBreakdown): Promise<SystemOneRating | undefined>;
  judgeMerge(a: Sage, b: Sage): Promise<MergeVerdict | undefined>;
}

export interface SystemOneTriageOptions {
  judge: TypeSafeJudge;
  /** Minimum distribution concentration to act without the LLM. Default 0.55. */
  minConfidence?: number | undefined;
  /** Minimum probability on the winning level. Default 0.5. */
  minProbability?: number | undefined;
  timeoutMs?: number | undefined;
}

const VALUE_LEVELS = [
  'Noise: a one-off observation, a restatement of something obvious, or text with no reusable project knowledge.',
  'Transient: true for a moment in the work (current task status, a temporary workaround, churn), or a log of work already done — what was changed, fixed, added or completed — that states no rule, fact or pitfall a future session must follow.',
  'Niche: correct and durable but relevant only to a rare situation or a single small corner of the project.',
  'Useful: a durable fact, convention, decision or pitfall about how the project works now, which a future session would otherwise have to rediscover.',
  'Essential: an invariant, directive or hard-won root cause that prevents real mistakes whenever this area is touched.',
];

const VALUE_REASONS = ['noise', 'transient', 'niche', 'useful', 'essential'];

const MERGE_LEVELS = [
  'Distinct: the two memories are about different facts; neither would make the other redundant.',
  'Related but distinct: they share a topic or file but each states something the other does not; keep both.',
  'Same fact: they state the same fact or rule, so keeping one loses nothing the other says.',
];

const MERGE_VERDICTS: MergeVerdict[] = ['NO', 'OVERLAP', 'YES'];

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 3)}...` : text;
}

/** The winning level index of a Score answer, or `undefined` when not concentrated. */
function decisiveLevel(
  answer: unknown,
  levels: number,
  minConfidence: number,
  minProbability: number,
): number | undefined {
  if (!answer || typeof answer !== 'object') return undefined;
  const a = answer as {
    type?: string;
    score?: number;
    confidence?: number;
    probabilities?: Record<string, number>;
  };
  if (a.type !== 'score' || typeof a.confidence !== 'number') return undefined;
  if (a.confidence < minConfidence) return undefined;
  let best = -1;
  let bestP = -1;
  for (const [key, p] of Object.entries(a.probabilities ?? {})) {
    const index = Number(key);
    if (Number.isInteger(index) && index >= 0 && index < levels && p > bestP) {
      best = index;
      bestP = p;
    }
  }
  if (best < 0) {
    // Older response shape without probabilities: only a position.
    if (typeof a.score !== 'number') return undefined;
    best = Math.min(levels - 1, Math.max(0, Math.round(a.score)));
    bestP = a.confidence;
  }
  return bestP >= minProbability ? best : undefined;
}

/** State and question for a value rating — shared by the feature and calibration. */
function valueQuestion(memory: Sage): { state: unknown; question: TypeSafeQuestion } {
  return {
    state: {
      memory: truncate(memory.text, 1_200),
      kind: memory.kind,
      anchors: memory.anchors.map((a) => a.path ?? a.symbol ?? a.command ?? a.type).slice(0, 5),
      // Numbers are context, not the judgment: the rule-based score and
      // usage counts already fed Phase 2; Jev is asked about the TEXT.
      timesInjected: memory.injectionCount ?? 0,
      timesUsed: memory.useCount ?? 0,
    },
    question: {
      type: 'score',
      instructions:
        'How valuable is `memory` as long-term knowledge for future coding sessions on ' +
        'this project? Judge the text itself.',
      criteria: VALUE_LEVELS,
    },
  };
}

export interface MemoryValueProbe {
  /** Winning level as a 1-5 rating. */
  score: 1 | 2 | 3 | 4 | 5;
  /** Probability of the winning level. */
  probability: number;
  confidence: number;
  /** Probability per 1-5 rating. */
  probabilities: Record<number, number>;
  model: string | undefined;
}

/**
 * Raw value rating, no thresholds. Throws on transport failure; `undefined`
 * for a malformed answer. Exported for calibration (`replay-memory-triage`).
 */
export async function probeMemoryValue(
  judge: TypeSafeJudge,
  memory: Sage,
  timeoutMs = 10_000,
): Promise<MemoryValueProbe | undefined> {
  const { state, question } = valueQuestion(memory);
  const result = await judge.client.systemOne(
    { activityFeature: judge.feature, state, questions: { q: question }, model: judge.model },
    AbortSignal.timeout(timeoutMs),
  );
  const answer = result.answers['q'];
  if (answer?.type !== 'score') return undefined;
  const probabilities: Record<number, number> = {};
  let best = -1;
  let bestP = -1;
  for (const [key, p] of Object.entries(answer.probabilities ?? {})) {
    const idx = Number(key);
    if (!Number.isInteger(idx) || idx < 0 || idx >= VALUE_LEVELS.length) continue;
    probabilities[idx + 1] = p;
    if (p > bestP) {
      best = idx;
      bestP = p;
    }
  }
  if (best < 0) return undefined;
  return {
    score: (best + 1) as MemoryValueProbe['score'],
    probability: bestP,
    confidence: answer.confidence,
    probabilities,
    model: result.model ?? judge.model,
  };
}

export function createSystemOneTriage(opts: SystemOneTriageOptions): SystemOneTriage {
  const minConfidence = opts.minConfidence ?? 0.55;
  const minProbability = opts.minProbability ?? 0.5;
  const timeoutMs = opts.timeoutMs ?? 6_000;
  const { judge } = opts;

  const ask = async (state: unknown, question: TypeSafeQuestion): Promise<unknown> => {
    try {
      const result = await judge.client.systemOne(
        { activityFeature: judge.feature, state, questions: { q: question }, model: judge.model },
        AbortSignal.timeout(timeoutMs),
      );
      return result.answers['q'];
    } catch {
      return undefined;
    }
  };

  return {
    async rateMemory(memory, vs) {
      const { state, question } = valueQuestion(memory);
      const answer = await ask(state, question);
      const level = decisiveLevel(answer, VALUE_LEVELS.length, minConfidence, minProbability);
      if (level === undefined) return undefined;
      return {
        score: (level + 1) as SystemOneRating['score'],
        reason: `System One: ${VALUE_REASONS[level]} (Phase 2 ${vs.total}/100)`,
      };
    },

    async judgeMerge(a, b) {
      const answer = await ask(
        { memoryA: truncate(a.text, 1_200), memoryB: truncate(b.text, 1_200) },
        {
          type: 'score',
          instructions:
            'How much of what `memoryA` states does `memoryB` also state (and vice versa)? ' +
            'Compare the facts, not the wording.',
          criteria: MERGE_LEVELS,
        },
      );
      // Merging is destructive (the loser is superseded), so the bar to say
      // YES without the LLM is higher than the bar to say NO.
      const level = decisiveLevel(answer, MERGE_LEVELS.length, minConfidence, minProbability);
      if (level === undefined) return undefined;
      if (level === 2) {
        const p = (answer as { probabilities?: Record<string, number> }).probabilities?.['2'];
        if (p === undefined || p < 0.8) return undefined;
      }
      return MERGE_VERDICTS[level];
    },
  };
}
