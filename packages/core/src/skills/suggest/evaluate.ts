/**
 * Scoring for the skill suggester, and a threshold sweep built on it.
 *
 * ## What this measures, and what it does not
 *
 * This scores the SUGGESTER against labels: given a request whose covering
 * skill you have named, did the suggester name the same one? TypeSafe's
 * cookbook reports a different pair of numbers — whether the AGENT went on to
 * load the right skill — which needs a full agent turn per case per arm and a
 * pinned model to be comparable.
 *
 * The two are related but not interchangeable, and the gap matters: an agent
 * ignores some suggestions (which is the point — the block tells it to) and
 * gets some turns right on its own that a confident wrong suggestion then
 * breaks. A perfect suggester score is an upper bound on the improvement, not
 * the improvement. Do not report these numbers as the cookbook's.
 *
 * What they are good for is choosing thresholds, because moving a threshold
 * moves these numbers directly and moves the agent's numbers only through them.
 *
 * ## The two error rates
 *
 * They are deliberately kept apart rather than averaged into one score,
 * because they trade against each other and which one costs you more is a
 * judgment about your roster, not a property of the data:
 *
 *   wrongSuggestion — of the requests a skill covers, the share where the
 *     suggester named a DIFFERENT skill. An actively misleading pointer.
 *   missed          — of those same requests, the share where it named nothing.
 *     A missed opportunity: the agent is back to deciding on its own, which is
 *     the behavior without this feature at all.
 *   needless        — of the requests nothing covers, the share where it named
 *     something anyway.
 *
 * `wrongSuggestion` and `missed` are reported separately because they are not
 * equally bad. Silence leaves the agent where it started; a wrong name actively
 * pushes it somewhere.
 */

import { redecide, type SkillSuggestionTrace } from './skill-suggester.js';

export interface LabeledRequest {
  /** The user request, as they would type it. */
  text: string;
  /**
   * The skill that covers this request, or `null`/absent when none does.
   * "Covered" is a claim about the roster, not about difficulty: label a
   * request uncovered when no skill you have would help, even if one is close.
   */
  gold?: string | null | undefined;
}

export interface SuggestionScore {
  /** Requests labeled with a covering skill. */
  covered: number;
  /** Requests labeled as covered by nothing. */
  uncovered: number;
  /** Of `covered`: named a different skill. 0..1, lower is better. */
  wrongSuggestion: number;
  /** Of `covered`: named nothing. 0..1, lower is better. */
  missed: number;
  /** Of `covered`: named the right one. 0..1, higher is better. */
  correct: number;
  /** Of `uncovered`: named something anyway. 0..1, lower is better. */
  needless: number;
}

/** One request and what the suggester said about it. */
export interface ScoredCase {
  request: LabeledRequest;
  suggested: string | undefined;
  outcome: 'correct' | 'wrong' | 'missed' | 'needless' | 'correctly-silent';
}

export function classifyCase(
  request: LabeledRequest,
  suggested: string | undefined,
): ScoredCase['outcome'] {
  const gold = request.gold ?? undefined;
  if (gold) {
    if (!suggested) return 'missed';
    return suggested === gold ? 'correct' : 'wrong';
  }
  return suggested ? 'needless' : 'correctly-silent';
}

/**
 * Score a set of decisions. `decide` maps a labeled request to whatever the
 * suggester named for it, so the same function serves a live run and a sweep
 * over already-collected traces.
 */
export function scoreSuggestions(
  requests: readonly LabeledRequest[],
  decide: (request: LabeledRequest) => string | undefined,
): { score: SuggestionScore; cases: ScoredCase[] } {
  const cases: ScoredCase[] = requests.map((request) => {
    const suggested = decide(request);
    return { request, suggested, outcome: classifyCase(request, suggested) };
  });
  // Same emptiness convention as classifyCase (an empty-string gold is not a
  // covering skill), so the covered denominator and the outcome buckets agree.
  const covered = cases.filter((c) => Boolean(c.request.gold)).length;
  const uncovered = cases.length - covered;
  const count = (outcome: ScoredCase['outcome']): number =>
    cases.filter((c) => c.outcome === outcome).length;

  // Rates over an empty denominator are 0, not NaN: a sweep table with NaN in
  // it is unreadable, and "no covered requests" is a labeling problem the
  // caller can see from the counts.
  const over = (value: number, total: number): number => (total > 0 ? value / total : 0);
  return {
    score: {
      covered,
      uncovered,
      correct: over(count('correct'), covered),
      wrongSuggestion: over(count('wrong'), covered),
      missed: over(count('missed'), covered),
      needless: over(count('needless'), uncovered),
    },
    cases,
  };
}

export interface SweepRow {
  gateThreshold: number;
  fitsThreshold: number;
  score: SuggestionScore;
}

/**
 * Re-decide every trace at each threshold pair. No API calls: the answers do
 * not change when a threshold moves, which is the whole reason traces are
 * collected once and swept offline.
 *
 * The traces MUST have been collected with `alwaysRerank`, or every row below
 * the collection gate reads as "suggested nothing" — not because the shortlist
 * was rejected but because it was never fetched. `sweepThresholds` cannot
 * detect that from a trace alone, so the collecting surface is responsible for
 * the flag; `runSuggestionEval` below sets it.
 */
export function sweepThresholds(
  rows: ReadonlyArray<{ request: LabeledRequest; trace: SkillSuggestionTrace }>,
  gateThresholds: readonly number[],
  fitsThresholds: readonly number[],
): SweepRow[] {
  const byText = new Map(rows.map((row) => [row.request.text, row.trace]));
  const requests = rows.map((row) => row.request);
  const sweep: SweepRow[] = [];
  for (const gateThreshold of gateThresholds) {
    for (const fitsThreshold of fitsThresholds) {
      const { score } = scoreSuggestions(requests, (request) => {
        const trace = byText.get(request.text);
        return trace ? redecide(trace, gateThreshold, fitsThreshold) : undefined;
      });
      sweep.push({ gateThreshold, fitsThreshold, score });
    }
  }
  return sweep;
}

/**
 * Parse a JSONL eval file: one `{"text": "...", "gold": "skill-name"}` per
 * line, `gold` omitted or null for a request nothing covers.
 *
 * Malformed lines are REPORTED, not skipped silently — a typo'd label that
 * vanishes would quietly change the denominator the rates are computed over.
 */
export function parseEvalJsonl(source: string): {
  requests: LabeledRequest[];
  errors: Array<{ line: number; reason: string }>;
} {
  const requests: LabeledRequest[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  const lines = source.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i]?.trim() ?? '';
    if (!raw || raw.startsWith('//')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      errors.push({ line: i + 1, reason: 'not valid JSON' });
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      errors.push({ line: i + 1, reason: 'not a JSON object' });
      continue;
    }
    const record = parsed as Record<string, unknown>;
    const text = record['text'];
    if (typeof text !== 'string' || !text.trim()) {
      errors.push({ line: i + 1, reason: 'missing or empty "text"' });
      continue;
    }
    const gold = record['gold'];
    if (gold !== undefined && gold !== null && typeof gold !== 'string') {
      errors.push({ line: i + 1, reason: '"gold" must be a skill name, null, or absent' });
      continue;
    }
    requests.push({ text: text.trim(), gold: typeof gold === 'string' ? gold : null });
  }
  return { requests, errors };
}

/**
 * Check every `gold` label names a skill that actually exists.
 *
 * A label naming a renamed or removed skill can never be matched, so it counts
 * as a wrong suggestion on every run and drags the rate down for a reason that
 * has nothing to do with the suggester.
 */
export function unknownGoldLabels(
  requests: readonly LabeledRequest[],
  rosterNames: readonly string[],
): string[] {
  const known = new Set(rosterNames);
  const unknown = new Set<string>();
  for (const request of requests) {
    const gold = request.gold ?? undefined;
    if (gold && !known.has(gold)) unknown.add(gold);
  }
  return [...unknown].sort();
}
