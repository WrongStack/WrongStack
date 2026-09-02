/**
 * performance-regression-gate plugin — compares benchmark results to detect
 * performance regressions.
 *
 * Tool registered:
 * - perf_regression_status : Reads `bench-results.json` in the project root
 *   (or a supplied path) and reports benchmarks whose execution time (`mean`)
 *   increased beyond the configured threshold.
 *
 * The tool supports two comparison modes:
 * 1. Internal pairing: when only `resultsPath` is supplied, benchmarks named
 *    with `(old)` and `(new)` suffixes are paired. This matches Vitest bench
 *    output comparing an old implementation against a new one.
 * 2. Cross-file comparison: when `baselinePath` is also supplied, benchmarks
 *    are matched by name across the two files.
 *
 * Config (`config.extensions['performance-regression-gate']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "thresholdPercent": 10
 * }
 * ```
 *
 * @public
 */

import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface PerformanceRegressionGateState {
  invocationCount: number;
  comparisonCount: number;
  regressionCount: number;
  missingResultsCount: number;
  errorCount: number;
  lastResult: {
    comparisons: number;
    regressions: number;
    thresholdPercent: number;
    when: string;
  } | null;
}

const state: PerformanceRegressionGateState = {
  invocationCount: 0,
  comparisonCount: 0,
  regressionCount: 0,
  missingResultsCount: 0,
  errorCount: 0,
  lastResult: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface PerformanceRegressionGateConfig {
  enabled: boolean;
  thresholdPercent: number;
}

const DEFAULTS: PerformanceRegressionGateConfig = {
  enabled: true,
  thresholdPercent: 10,
};

function readConfig(raw: unknown): PerformanceRegressionGateConfig {
  if (!raw || typeof raw !== 'object') return { ...DEFAULTS };
  const r = raw as Record<string, unknown>;
  const threshold =
    typeof r['thresholdPercent'] === 'number' &&
    r['thresholdPercent'] >= 0 &&
    r['thresholdPercent'] <= 1000
      ? r['thresholdPercent']
      : DEFAULTS.thresholdPercent;
  return {
    enabled: r['enabled'] !== false,
    thresholdPercent: threshold,
  };
}

// ---------------------------------------------------------------------------
// Bench result parsing
// ---------------------------------------------------------------------------

interface BenchBenchmark {
  id: string;
  name: string;
  mean?: number;
  hz?: number;
  period?: number;
}

interface BenchGroup {
  fullName: string;
  benchmarks: BenchBenchmark[];
}

interface BenchFile {
  filepath: string;
  groups: BenchGroup[];
}

interface BenchResults {
  files?: BenchFile[];
}

interface FlatBenchmark {
  key: string;
  file: string;
  group: string;
  name: string;
  mean: number;
  hz: number | null;
}

function withinProject(p: string, cwd = process.cwd()): boolean {
  if (typeof p !== 'string' || p.length === 0 || p.length > 4096) return false;
  const root = resolve(cwd);
  const resolved = isAbsolute(p) ? resolve(p) : resolve(root, p);
  const rel = relative(root, resolved);
  if (rel === '' || rel === '.') return true;
  if (rel.startsWith('..')) return false;
  if (isAbsolute(rel)) return false;
  return true;
}

function resolveProjectPath(rawPath: string, cwd = process.cwd()): string | null {
  if (typeof rawPath !== 'string' || rawPath.length === 0) return null;
  const root = resolve(cwd);
  const resolved = isAbsolute(rawPath) ? resolve(rawPath) : resolve(root, rawPath);
  if (!withinProject(resolved, cwd)) return null;
  return resolved;
}

function isValidNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n) && n > 0;
}

function flattenResults(results: BenchResults): FlatBenchmark[] {
  const flat: FlatBenchmark[] = [];
  for (const file of results.files ?? []) {
    for (const group of file.groups ?? []) {
      for (const bench of group.benchmarks ?? []) {
        if (!bench || typeof bench.name !== 'string') continue;
        const mean = isValidNumber(bench.mean)
          ? bench.mean
          : isValidNumber(bench.period)
            ? bench.period
            : null;
        if (mean === null) continue;
        flat.push({
          key: `${group.fullName} > ${bench.name}`,
          file: file.filepath ?? '',
          group: group.fullName ?? '',
          name: bench.name,
          mean,
          hz: isValidNumber(bench.hz) ? bench.hz : null,
        });
      }
    }
  }
  return flat;
}

function loadResults(path: string): BenchResults | null {
  if (!path || !existsSync(path)) return null;
  try {
    const raw = JSON.parse(readFileSync(path, 'utf-8')) as BenchResults;
    return raw;
  } catch {
    return null;
  }
}

interface Regression {
  benchmark: string;
  metric: 'mean';
  oldValue: number;
  newValue: number;
  increasePercent: number;
}

function stripVariantSuffix(name: string): { base: string; variant: 'old' | 'new' | null } {
  const trimmed = name.trim();
  const oldMatch = /\(old\)\s*$/i.exec(trimmed);
  if (oldMatch) {
    return { base: trimmed.slice(0, oldMatch.index).trim(), variant: 'old' };
  }
  const newMatch = /\(new\)\s*$/i.exec(trimmed);
  if (newMatch) {
    return { base: trimmed.slice(0, newMatch.index).trim(), variant: 'new' };
  }
  return { base: trimmed, variant: null };
}

function pairInternal(benchmarks: FlatBenchmark[]): { old: FlatBenchmark; new: FlatBenchmark }[] {
  const byBase = new Map<string, { old?: FlatBenchmark; new?: FlatBenchmark }>();
  for (const bench of benchmarks) {
    const { base, variant } = stripVariantSuffix(bench.name);
    if (!variant) continue;
    const groupBase = `${bench.group} > ${base}`;
    const entry = byBase.get(groupBase) ?? {};
    if (variant === 'old') entry.old = bench;
    if (variant === 'new') entry.new = bench;
    byBase.set(groupBase, entry);
  }
  const pairs: { old: FlatBenchmark; new: FlatBenchmark }[] = [];
  for (const entry of byBase.values()) {
    if (entry.old && entry.new) {
      pairs.push({ old: entry.old, new: entry.new });
    }
  }
  return pairs;
}

function pairCrossFile(
  baseline: FlatBenchmark[],
  current: FlatBenchmark[],
): { old: FlatBenchmark; new: FlatBenchmark }[] {
  const byKey = new Map<string, FlatBenchmark>();
  for (const bench of baseline) {
    byKey.set(bench.key, bench);
    const base = stripVariantSuffix(bench.name).base;
    byKey.set(`${bench.group} > ${base}`, bench);
  }
  const pairs: { old: FlatBenchmark; new: FlatBenchmark }[] = [];
  for (const bench of current) {
    const base = stripVariantSuffix(bench.name).base;
    const lookupKey = `${bench.group} > ${base}`;
    const old = byKey.get(lookupKey) ?? byKey.get(bench.key);
    if (old) {
      pairs.push({ old, new: bench });
    }
  }
  return pairs;
}

function comparePairs(
  pairs: { old: FlatBenchmark; new: FlatBenchmark }[],
  thresholdPercent: number,
): Regression[] {
  const regressions: Regression[] = [];
  const thresholdFactor = 1 + thresholdPercent / 100;
  for (const { old, new: current } of pairs) {
    if (current.mean > old.mean * thresholdFactor) {
      const increasePercent = ((current.mean - old.mean) / old.mean) * 100;
      regressions.push({
        benchmark: current.key,
        metric: 'mean',
        oldValue: old.mean,
        newValue: current.mean,
        increasePercent: Math.round(increasePercent * 100) / 100,
      });
    }
  }
  return regressions;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'performance-regression-gate',
  version: '0.1.0',
  description:
    'Compares benchmark results to detect performance regressions and reports metrics that increased beyond the configured threshold',
  apiVersion: API_VERSION,
  capabilities: { tools: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch.',
      },
      thresholdPercent: {
        type: 'number',
        minimum: 0,
        maximum: 1000,
        default: 10,
        description: 'Percentage increase in mean execution time that counts as a regression.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 pattern).
    state.invocationCount = 0;
    state.comparisonCount = 0;
    state.regressionCount = 0;
    state.missingResultsCount = 0;
    state.errorCount = 0;
    state.lastResult = null;

    const cfg = readConfig(api.config.extensions?.['performance-regression-gate']);

    // --- perf_regression_status tool ---
    api.tools.register({
      name: 'perf_regression_status',
      description:
        'Reads bench-results.json and reports performance regressions. ' +
        'Without baselinePath, pairs benchmarks named with (old) and (new) suffixes. ' +
        'With baselinePath, compares matching benchmarks across the two files.',
      inputSchema: {
        type: 'object',
        properties: {
          resultsPath: {
            type: 'string',
            default: 'bench-results.json',
            description: 'Path to current benchmark results (JSON).',
          },
          baselinePath: {
            type: 'string',
            description:
              'Optional path to baseline/previous results. If omitted, (old)/(new) pairs within resultsPath are compared.',
          },
          thresholdPercent: {
            type: 'number',
            description: 'Override the configured threshold percentage.',
          },
        },
      },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute(input: {
        resultsPath?: string | undefined;
        baselinePath?: string | undefined;
        thresholdPercent?: number | undefined;
      }) {
        if (!cfg.enabled) {
          return { ok: false, error: 'performance-regression-gate is disabled' };
        }

        state.invocationCount += 1;

        const raw = (input ?? {}) as Record<string, unknown>;
        const rawThreshold =
          input.thresholdPercent ??
          raw['threshold'] ??
          raw['threshold_percent'] ??
          raw['thresholdPercent'] ??
          raw['percent'];
        const threshold =
          typeof rawThreshold === 'number' && rawThreshold >= 0 && rawThreshold <= 1000
            ? rawThreshold
            : cfg.thresholdPercent;

        const rawResultsPath =
          input.resultsPath ??
          raw['results_path'] ??
          raw['file_path'] ??
          raw['path'] ??
          raw['filePath'] ??
          raw['file'] ??
          raw['TargetFile'] ??
          raw['targetFile'] ??
          'bench-results.json';
        const resultsPathStr =
          typeof rawResultsPath === 'string' && rawResultsPath.trim()
            ? rawResultsPath.trim()
            : 'bench-results.json';
        const resultsPath = resolveProjectPath(resultsPathStr) ?? '';
        if (!resultsPath) {
          state.errorCount += 1;
          return { ok: false, error: 'invalid results path (must be inside project)' };
        }

        const results = loadResults(resultsPath);
        if (!results) {
          state.missingResultsCount += 1;
          return {
            ok: true,
            hasResults: false,
            thresholdPercent: threshold,
            comparisons: 0,
            regressions: [],
            message: `No benchmark results found at ${resultsPathStr}.`,
          };
        }

        const current = flattenResults(results);
        if (current.length === 0) {
          state.missingResultsCount += 1;
          return {
            ok: true,
            hasResults: false,
            thresholdPercent: threshold,
            comparisons: 0,
            regressions: [],
            message: 'No benchmarks with valid mean/period values were found.',
          };
        }

        const rawBaselinePath =
          input.baselinePath ??
          raw['baseline_path'] ??
          raw['baseline'] ??
          raw['basePath'] ??
          raw['base_path'];
        const baselinePathStr =
          typeof rawBaselinePath === 'string' && rawBaselinePath.trim()
            ? rawBaselinePath.trim()
            : undefined;

        let pairs: { old: FlatBenchmark; new: FlatBenchmark }[];
        if (baselinePathStr) {
          const baselineResolved = resolveProjectPath(baselinePathStr) ?? '';
          if (!baselineResolved) {
            state.errorCount += 1;
            return { ok: false, error: 'invalid baseline path (must be inside project)' };
          }
          const baselineResults = loadResults(baselineResolved);
          if (!baselineResults) {
            state.errorCount += 1;
            return {
              ok: false,
              error: `Could not read baseline results at ${baselinePathStr}.`,
            };
          }
          const baseline = flattenResults(baselineResults);
          pairs = pairCrossFile(baseline, current);
        } else {
          pairs = pairInternal(current);
        }

        const regressions = comparePairs(pairs, threshold);

        state.comparisonCount += pairs.length;
        state.regressionCount += regressions.length;
        state.lastResult = {
          comparisons: pairs.length,
          regressions: regressions.length,
          thresholdPercent: threshold,
          when: new Date().toISOString(),
        };

        api.metrics.counter('comparisons', pairs.length);
        if (regressions.length > 0) {
          api.metrics.counter('regressions', regressions.length);
        }

        const regression = regressions.length > 0;
        return {
          ok: true,
          hasResults: true,
          regression,
          thresholdPercent: threshold,
          comparisons: pairs.length,
          regressions,
          message: regression
            ? `Detected ${regressions.length} regression(s) above ${threshold}% threshold.`
            : `No regressions detected across ${pairs.length} benchmark comparison(s) (threshold ${threshold}%).`,
        };
      },
    });

    api.log.info('performance-regression-gate plugin loaded', {
      version: '0.1.0',
      thresholdPercent: cfg.thresholdPercent,
    });
  },

  teardown(api) {
    const final = {
      invocations: state.invocationCount,
      comparisons: state.comparisonCount,
      regressions: state.regressionCount,
      missingResults: state.missingResultsCount,
      errors: state.errorCount,
    };
    state.invocationCount = 0;
    state.comparisonCount = 0;
    state.regressionCount = 0;
    state.missingResultsCount = 0;
    state.errorCount = 0;
    state.lastResult = null;
    api.log.info('performance-regression-gate: teardown complete', { final });
  },

  async health() {
    return {
      ok: state.errorCount === 0,
      message: state.lastResult
        ? `performance-regression-gate: ${state.lastResult.regressions} regression(s) across ${state.lastResult.comparisons} comparison(s) (threshold ${state.lastResult.thresholdPercent}%)`
        : `performance-regression-gate: ${state.invocationCount} invocation(s), ${state.comparisonCount} comparison(s)`,
      counters: {
        invocations: state.invocationCount,
        comparisons: state.comparisonCount,
        regressions: state.regressionCount,
        missingResults: state.missingResultsCount,
        errors: state.errorCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
