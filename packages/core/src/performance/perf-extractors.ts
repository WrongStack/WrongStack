/**
 * Turning a benchmark's output into one number.
 *
 * A ratchet round is only as trustworthy as the extraction step: if the number
 * comes from a different line each run, every verdict is noise. Extractors are
 * therefore explicit, named, and total — they return `undefined` rather than
 * guessing, and a run whose extractor returned `undefined` is a failed run, not
 * a zero.
 *
 * @module performance/perf-extractors
 */

/** Everything one completed run produced. */
export interface PerfRunOutput {
  stdout: string;
  stderr: string;
  /** Wall-clock duration of the run, in milliseconds. */
  wallMs: number;
  exitCode: number | null;
}

/**
 * Pull the metric value out of one run.
 *
 * Return `undefined` when the output does not contain the metric — the runner
 * treats that as a failed run and says so, instead of averaging in a fabricated
 * value.
 */
export type MetricExtractor = (output: PerfRunOutput) => number | undefined;

/** Wall-clock time of the process itself. The default for `wall-ms`. */
export const wallTimeExtractor: MetricExtractor = (output) => output.wallMs;

/**
 * First capture group of `pattern`, parsed as a float and optionally scaled.
 *
 * The pattern is applied to stdout then stderr — benchmark harnesses are split
 * on which stream they consider "results", and the difference is never the
 * user's problem to remember.
 */
export function regexExtractor(
  pattern: RegExp,
  options: { group?: number; scale?: number } = {},
): MetricExtractor {
  const group = options.group ?? 1;
  const scale = options.scale ?? 1;
  return (output) => {
    for (const stream of [output.stdout, output.stderr]) {
      // Fresh regex per attempt: a caller-supplied /g pattern would otherwise
      // carry `lastIndex` between runs and silently skip later matches.
      const re = new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ''));
      const match = re.exec(stream);
      const raw = match?.[group];
      if (raw === undefined) continue;
      const value = Number.parseFloat(raw.replace(/[,_]/g, ''));
      if (Number.isFinite(value)) return value * scale;
    }
    return undefined;
  };
}

/**
 * Dotted path into JSON printed on stdout.
 *
 * Accepts either a whole-stdout JSON document or the last JSON object/array on
 * a line of its own, which is how most harnesses interleave progress logs with
 * a machine-readable summary.
 */
export function jsonPathExtractor(dottedPath: string): MetricExtractor {
  const segments = dottedPath.split('.').filter((segment) => segment.length > 0);
  return (output) => {
    const parsed = parseTrailingJson(output.stdout);
    if (parsed === undefined) return undefined;
    let cursor: unknown = parsed;
    for (const segment of segments) {
      if (cursor === null || typeof cursor !== 'object') return undefined;
      const index = Number.parseInt(segment, 10);
      cursor = Array.isArray(cursor)
        ? Number.isNaN(index)
          ? undefined
          : cursor[index]
        : (cursor as Record<string, unknown>)[segment];
    }
    return typeof cursor === 'number' && Number.isFinite(cursor) ? cursor : undefined;
  };
}

function parseTrailingJson(stdout: string): unknown {
  const trimmed = stdout.trim();
  if (trimmed.length === 0) return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* fall through to the line scan */
  }
  const lines = trimmed.split(/\r?\n/);
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = (lines[index] ?? '').trim();
    if (!line.startsWith('{') && !line.startsWith('[')) continue;
    try {
      return JSON.parse(line);
    } catch {
      /* keep scanning upward */
    }
  }
  return undefined;
}

/**
 * Peak RSS from GNU `/usr/bin/time -v`, converted from KB to bytes.
 *
 * Named separately from a bare regex because the KB→bytes conversion is the
 * part everyone gets wrong, and a metric that is 1024x off is worse than one
 * that is missing.
 */
export const gnuTimeMaxRssExtractor: MetricExtractor = regexExtractor(
  /Maximum resident set size \(kbytes\):\s*(\d+)/,
  { scale: 1024 },
);

/** `hyperfine --style basic` mean time, converted to milliseconds. */
export const hyperfineMeanExtractor: MetricExtractor = (output) => {
  const seconds = regexExtractor(/Time \(mean ± σ\):\s*([\d.]+)\s*s/)(output);
  if (seconds !== undefined) return seconds * 1000;
  return regexExtractor(/Time \(mean ± σ\):\s*([\d.]+)\s*ms/)(output);
};

/** The named extractors `/perf` and the guard config can refer to by string. */
export const PERF_EXTRACTORS = {
  wall: wallTimeExtractor,
  'gnu-time-rss': gnuTimeMaxRssExtractor,
  hyperfine: hyperfineMeanExtractor,
} as const;

export type PerfExtractorName = keyof typeof PERF_EXTRACTORS;

export function isPerfExtractorName(value: string): value is PerfExtractorName {
  return Object.hasOwn(PERF_EXTRACTORS, value);
}

/**
 * Resolve an extractor spec into a function.
 *
 * Spec forms: a registry name (`wall`), `re:<pattern>` for a capture-group
 * regex, or `json:<dotted.path>` for a JSON field. Unknown specs throw — a
 * typo'd extractor must fail loudly, not fall back to wall time and quietly
 * measure the wrong thing.
 */
export function resolveExtractor(spec: string): MetricExtractor {
  if (isPerfExtractorName(spec)) return PERF_EXTRACTORS[spec];
  if (spec.startsWith('re:')) return regexExtractor(new RegExp(spec.slice(3)));
  if (spec.startsWith('json:')) return jsonPathExtractor(spec.slice(5));
  throw new Error(
    `unknown metric extractor "${spec}"; expected one of ${Object.keys(PERF_EXTRACTORS).join(', ')}, "re:<pattern>", or "json:<path>"`,
  );
}
