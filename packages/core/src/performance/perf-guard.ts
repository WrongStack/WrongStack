/**
 * The regression guard — what stops the ratchet from slipping backwards.
 *
 * A ratchet that only tightens in one direction needs a pawl. This is the pawl:
 * a checked-in baseline per metric, a threshold, and a decision that is a pure
 * function of (baseline, current, threshold). Improvements ratchet the baseline
 * down; regressions beyond the threshold fail; everything between is noise and
 * changes nothing, including the baseline — silently re-recording a slightly
 * worse number every run is how a "guarded" project drifts 40% slower without a
 * single failing check.
 *
 * @module performance/perf-guard
 */
import { rawDeltaPct } from './perf-stats.js';
import { isPerfMetricId, PERF_METRICS, type PerfMetricId, type PerfVerdict } from './perf-types.js';

export const PERF_BASELINE_SCHEMA_VERSION = 1;

/** Default guard threshold. Looser than the ratchet's keep gate on purpose:
 * CI machines are noisier than a developer's, and a guard that cries wolf gets
 * disabled, which is strictly worse than a guard that only catches the big ones.
 * 15 matches the documented default in docs/performance-ratchet.md (Guard) —
 * the shipped baseline pins it per file as well, so hand-authored baselines
 * without an explicit thresholdPct behave identically (Chimera review). */
export const DEFAULT_GUARD_THRESHOLD_PCT = 15;

export interface PerfBaselineEntry {
  /** Stable key. Must match the key the measurement step produces. */
  id: string;
  label: string;
  metric: PerfMetricId;
  /**
   * The recorded baseline, or `null` when the probe has been declared but never
   * measured. A hand-authored baseline file starts as a list of `null`s; the
   * first `--write` run fills them in. Treating an unrecorded probe as `0`
   * would report every first run as an infinite regression.
   */
  value: number | null;
  /** Human-readable provenance: what this number describes. */
  source: string;
  recordedAt: string;
  commit?: string;
  machine?: string;
  /** Per-entry override of the file-level threshold. */
  thresholdPct?: number;
  /**
   * Command the guard runs to re-measure this entry.
   *
   * Entries without one are expected to be supplied from an external results
   * file — that is how a project keeps using a benchmark harness the guard does
   * not know how to drive.
   */
  command?: string;
  /** Extractor spec (`wall`, `re:<pattern>`, `json:<path>`). Defaults to `wall`. */
  extract?: string;
  /** Per-entry override of the file-level repeat count. */
  runs?: number;
  /** Per-entry timeout in milliseconds. */
  timeoutMs?: number;
}

export interface PerfBaselineFile {
  schemaVersion: number;
  thresholdPct: number;
  /** Default repeat count for probe entries. */
  runs?: number;
  /** Discarded runs before measurement. */
  warmup?: number;
  entries: PerfBaselineEntry[];
}

export interface GuardResult {
  id: string;
  label: string;
  metric: PerfMetricId;
  /**
   * `machine-drift` means the baseline was recorded somewhere else, so the
   * comparison is not evidence in either direction — it neither fails the gate
   * nor moves the baseline.
   */
  verdict: PerfVerdict | 'missing' | 'unbaselined' | 'machine-drift';
  baseline: number | undefined;
  current: number | undefined;
  /** Signed percentage where positive means better. `0` when not comparable. */
  deltaPct: number;
  thresholdPct: number;
  message: string;
}

export interface EvaluateGuardOptions {
  /** File-level default when an entry does not override it. */
  thresholdPct?: number;
  /**
   * Fail when the current run did not produce a value for a baselined entry.
   * On by default: a benchmark that silently stopped running is the most
   * common way a green guard stops meaning anything.
   */
  failOnMissing?: boolean;
  /**
   * The machine this run happened on, as {@link describeMachine} reports it.
   *
   * When supplied, any entry whose recorded `machine` differs is reported as
   * `machine-drift` instead of being compared. Comparing across machines is the
   * most common way a ratchet lies: a slower box invents regressions that were
   * never written, and a faster one ratchets the baseline down to a number the
   * original machine can never reach again.
   *
   * Omit it to compare regardless — the pre-machine-aware behaviour.
   */
  currentMachine?: string;
}

/** Parse and validate a baseline file body, throwing with a usable message. */
export function parseBaselineFile(text: string): PerfBaselineFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new Error(`perf baseline is not valid JSON: ${(error as Error).message}`);
  }
  if (raw === null || typeof raw !== 'object') {
    throw new Error('perf baseline must be a JSON object');
  }
  const candidate = raw as Partial<PerfBaselineFile>;
  const entries = Array.isArray(candidate.entries) ? candidate.entries : [];
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry || typeof entry.id !== 'string' || entry.id.length === 0) {
      throw new Error('perf baseline entry is missing an id');
    }
    if (seen.has(entry.id)) throw new Error(`perf baseline has duplicate id "${entry.id}"`);
    seen.add(entry.id);
    if (typeof entry.metric !== 'string' || !isPerfMetricId(entry.metric)) {
      throw new Error(`perf baseline entry "${entry.id}" has unknown metric "${entry.metric}"`);
    }
    if (entry.value === undefined) entry.value = null;
    if (
      entry.value !== null &&
      (typeof entry.value !== 'number' || !Number.isFinite(entry.value))
    ) {
      throw new Error(`perf baseline entry "${entry.id}" has a non-numeric value`);
    }
  }
  return {
    schemaVersion: candidate.schemaVersion ?? PERF_BASELINE_SCHEMA_VERSION,
    thresholdPct: candidate.thresholdPct ?? DEFAULT_GUARD_THRESHOLD_PCT,
    ...(candidate.runs === undefined ? {} : { runs: candidate.runs }),
    ...(candidate.warmup === undefined ? {} : { warmup: candidate.warmup }),
    entries,
  };
}

/**
 * Compare a run's measurements against the baseline.
 *
 * `current` maps entry id → measured value. Ids present in the run but not the
 * baseline come back as `unbaselined` (informational, never a failure) so a
 * newly added benchmark shows up in the report rather than disappearing.
 */
export function evaluateGuard(
  baseline: PerfBaselineFile,
  current: Readonly<Record<string, number>>,
  options: EvaluateGuardOptions = {},
): GuardResult[] {
  const fileThreshold = options.thresholdPct ?? baseline.thresholdPct;
  const failOnMissing = options.failOnMissing ?? true;
  const results: GuardResult[] = [];
  const round = (value: number) => Math.round(value * 10) / 10;

  for (const entry of baseline.entries) {
    const thresholdPct = entry.thresholdPct ?? fileThreshold;
    const measured = current[entry.id];
    if (entry.value === null) {
      // Declared but never recorded. There is nothing to compare against, so
      // this is informational in both directions — it must not fail the guard,
      // and it must not be silently dropped either.
      results.push({
        id: entry.id,
        label: entry.label,
        metric: entry.metric,
        verdict: 'unbaselined',
        baseline: undefined,
        current: measured,
        deltaPct: 0,
        thresholdPct,
        message:
          measured === undefined
            ? 'declared but not measured yet — no baseline to compare against'
            : 'first measurement — run the guard with --write to record it as the baseline',
      });
      continue;
    }
    if (
      options.currentMachine !== undefined &&
      entry.machine !== undefined &&
      entry.machine !== options.currentMachine
    ) {
      results.push({
        id: entry.id,
        label: entry.label,
        metric: entry.metric,
        verdict: 'machine-drift',
        baseline: entry.value,
        current: measured,
        deltaPct:
          measured === undefined
            ? 0
            : round(
                (PERF_METRICS[entry.metric].better === 'lower' ? -1 : 1) *
                  rawDeltaPct(entry.value, measured),
              ),
        thresholdPct,
        message: `baseline was recorded on a different machine (${entry.machine}) — not comparable`,
      });
      continue;
    }
    if (measured === undefined || !Number.isFinite(measured)) {
      results.push({
        id: entry.id,
        label: entry.label,
        metric: entry.metric,
        verdict: failOnMissing ? 'missing' : 'noise',
        baseline: entry.value,
        current: undefined,
        deltaPct: 0,
        thresholdPct,
        message: failOnMissing
          ? 'no measurement in this run — the benchmark did not report a value'
          : 'not measured in this run (ignored)',
      });
      continue;
    }
    const signed = rawDeltaPct(entry.value, measured);
    const deltaPct = PERF_METRICS[entry.metric].better === 'lower' ? -signed : signed;
    const verdict: PerfVerdict =
      Math.abs(deltaPct) < thresholdPct ? 'noise' : deltaPct > 0 ? 'improved' : 'regressed';
    results.push({
      id: entry.id,
      label: entry.label,
      metric: entry.metric,
      verdict,
      baseline: entry.value,
      current: measured,
      deltaPct: round(deltaPct),
      thresholdPct,
      message:
        verdict === 'noise'
          ? `${round(deltaPct)}% — inside the ${thresholdPct}% band`
          : verdict === 'improved'
            ? `${round(deltaPct)}% better than baseline`
            : `${round(Math.abs(deltaPct))}% worse than baseline (limit ${thresholdPct}%)`,
    });
  }

  const baselined = new Set(baseline.entries.map((entry) => entry.id));
  for (const [id, value] of Object.entries(current)) {
    if (baselined.has(id)) continue;
    results.push({
      id,
      label: id,
      metric: 'wall-ms',
      verdict: 'unbaselined',
      baseline: undefined,
      current: value,
      deltaPct: 0,
      thresholdPct: fileThreshold,
      message: 'measured but not in the baseline — run the guard with --write to adopt it',
    });
  }

  return results;
}

/** True when any result is a regression or a missing measurement. */
export function guardFailed(results: readonly GuardResult[]): boolean {
  return results.some((r) => r.verdict === 'regressed' || r.verdict === 'missing');
}

export interface RatchetOptions {
  commit?: string;
  machine?: string;
  now?: () => Date;
  /**
   * Adopt `unbaselined` measurements as new entries. Off by default so a
   * routine guard run cannot silently expand what is being guarded.
   */
  adoptNew?: boolean;
}

/**
 * Tighten the baseline for every measured improvement.
 *
 * Returns a new file object; the input is not mutated. Regressions and noise
 * leave their entries exactly as they were — the baseline only ever moves in
 * the improving direction, which is the whole meaning of "ratchet".
 */
export function applyRatchet(
  baseline: PerfBaselineFile,
  results: readonly GuardResult[],
  options: RatchetOptions = {},
): { file: PerfBaselineFile; tightened: string[]; recorded: string[]; adopted: string[] } {
  const now = (options.now ?? (() => new Date()))().toISOString();
  const byId = new Map(results.map((result) => [result.id, result]));
  const tightened: string[] = [];
  const recorded: string[] = [];
  const adopted: string[] = [];

  const entries = baseline.entries.map((entry) => {
    const result = byId.get(entry.id);
    if (!result || result.current === undefined) return entry;
    // An entry that has never been recorded takes its first number regardless
    // of direction — there is no direction yet. An already-recorded entry moves
    // only when it improved, and never on a machine that is not the one the
    // baseline came from: ratcheting to a faster box's number would leave a
    // target the original machine can never hit again.
    const firstRecording = entry.value === null;
    if (!firstRecording && result.verdict !== 'improved') return entry;
    (firstRecording ? recorded : tightened).push(entry.id);
    return {
      ...entry,
      value: result.current,
      recordedAt: now,
      ...(options.commit === undefined ? {} : { commit: options.commit }),
      ...(options.machine === undefined ? {} : { machine: options.machine }),
    };
  });

  if (options.adoptNew) {
    const known = new Set(baseline.entries.map((entry) => entry.id));
    for (const result of results) {
      if (result.verdict !== 'unbaselined' || result.current === undefined) continue;
      // `unbaselined` also covers declared-but-unrecorded entries, which the
      // map above already filled in. Only genuinely new ids are adopted here.
      if (known.has(result.id)) continue;
      adopted.push(result.id);
      entries.push({
        id: result.id,
        label: result.label,
        metric: result.metric,
        value: result.current,
        source: 'adopted by --write',
        recordedAt: now,
        ...(options.commit === undefined ? {} : { commit: options.commit }),
        ...(options.machine === undefined ? {} : { machine: options.machine }),
      });
    }
  }

  return { file: { ...baseline, entries }, tightened, recorded, adopted };
}

/** Human-readable guard report, one line per entry, worst first. */
export function formatGuardReport(results: readonly GuardResult[]): string[] {
  const rank: Record<GuardResult['verdict'], number> = {
    regressed: 0,
    missing: 1,
    'machine-drift': 2,
    noise: 3,
    improved: 4,
    unbaselined: 5,
  };
  // Uniform width so the labels form a column the eye can scan.
  const icon: Record<GuardResult['verdict'], string> = {
    regressed: 'FAIL ',
    missing: 'GONE ',
    'machine-drift': 'DRIFT',
    noise: '     ',
    improved: 'GAIN ',
    unbaselined: 'NEW  ',
  };
  return [...results]
    .sort((a, b) => rank[a.verdict] - rank[b.verdict] || a.id.localeCompare(b.id))
    .map((result) => `${icon[result.verdict]}  ${result.label} — ${result.message}`);
}
