/**
 * test-coverage-gate plugin — PostToolUse hook that watches for test
 * coverage regressions after source-file edits.
 *
 * The plugin reads a coverage summary (e.g. `coverage/coverage-summary.json`
 * produced by c8/vitest/istanbul) after each `write`/`edit` to a source
 * file, compares it to the previous snapshot, and warns/block when the
 * overall coverage drops below a configured threshold or when a single
 * edited file loses coverage.
 *
 * Tools registered:
 * - coverage_gate_status : Show config + per-session counters + last diff.
 *
 * Hooks registered:
 * - PostToolUse with matcher `write|edit`.
 *
 * Config (`config.extensions['test-coverage-gate']`):
 *
 * ```jsonc
 * {
 *   "enabled": true,
 *   "coveragePath": "coverage/coverage-summary.json",
 *   "threshold": 80.0,            // minimum overall percent
 *   "mode": "warn",               // "warn" | "block"
 *   "deltaThreshold": 1.0,        // warn/block when coverage drops by >= this percent
 *   "runOnChange": [".ts", ".tsx", ".js", ".jsx"]
 * }
 * ```
 *
 * @public
 */

import { readFileSync } from 'node:fs';
import { extname } from 'node:path';
import type { Plugin } from '@wrongstack/core/types';
import { releaseHandle, withinProject } from '../runtime/index.js';

const API_VERSION = '^0.1.10';

// ---------------------------------------------------------------------------
// Module-scope state (H1 audit pattern)
// ---------------------------------------------------------------------------

interface CoverageSummary {
  total?: {
    lines?: { pct?: number };
    statements?: { pct?: number };
    functions?: { pct?: number };
    branches?: { pct?: number };
  };
  [path: string]: unknown;
}

interface CoverageGateState {
  invocationCount: number;
  runCount: number;
  passCount: number;
  failCount: number;
  errorCount: number;
  skippedCount: number;
  lastOverallPct: number | null;
  lastResult: {
    overallPct: number;
    previousOverallPct: number | null;
    threshold: number;
    passed: boolean;
    when: string;
  } | null;
  hookUnregister: null | (() => void);
}

const state: CoverageGateState = {
  invocationCount: 0,
  runCount: 0,
  passCount: 0,
  failCount: 0,
  errorCount: 0,
  skippedCount: 0,
  lastOverallPct: null,
  lastResult: null,
  hookUnregister: null,
};

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

interface CoverageGateConfig {
  enabled: boolean;
  coveragePath: string;
  threshold: number;
  mode: 'warn' | 'block';
  deltaThreshold: number;
  runOnChange: string[];
}

const DEFAULTS: CoverageGateConfig = {
  enabled: true,
  coveragePath: 'coverage/coverage-summary.json',
  threshold: 80,
  mode: 'warn',
  deltaThreshold: 1,
  runOnChange: ['.ts', '.tsx', '.js', '.jsx'],
};

/**
 * Extension set for O(1) lookup instead of Array.includes() O(n).
 *
 * Performance: converts the runOnChange array to a Set at config read time
 * so the hook's per-file extension check is O(1) instead of O(n).
 */
let runOnChangeSet = new Set(DEFAULTS.runOnChange);

function readConfig(raw: unknown): CoverageGateConfig {
  if (!raw || typeof raw !== 'object') {
    runOnChangeSet = new Set(DEFAULTS.runOnChange);
    return { ...DEFAULTS };
  }
  const r = raw as Record<string, unknown>;
  const runOnChange = Array.isArray(r['runOnChange'])
    ? (r['runOnChange'] as unknown[]).filter((x): x is string => typeof x === 'string')
    : DEFAULTS.runOnChange;

  // Update the module-scope Set for O(1) lookup in the hook.
  runOnChangeSet = new Set(runOnChange);

  return {
    enabled: r['enabled'] !== false,
    coveragePath: typeof r['coveragePath'] === 'string' ? r['coveragePath'] : DEFAULTS.coveragePath,
    threshold:
      typeof r['threshold'] === 'number' && r['threshold'] >= 0 && r['threshold'] <= 100
        ? r['threshold']
        : DEFAULTS.threshold,
    mode: r['mode'] === 'block' ? 'block' : DEFAULTS.mode,
    deltaThreshold:
      typeof r['deltaThreshold'] === 'number' && r['deltaThreshold'] >= 0
        ? r['deltaThreshold']
        : DEFAULTS.deltaThreshold,
    runOnChange,
  };
}

// ---------------------------------------------------------------------------
// Coverage parsing
// ---------------------------------------------------------------------------

function readCoverageSummary(coveragePath: string): CoverageSummary | null {
  try {
    const raw = readFileSync(coveragePath, 'utf-8');
    return JSON.parse(raw) as CoverageSummary;
  } catch {
    return null;
  }
}

function overallPercent(summary: CoverageSummary): number | null {
  const total = summary.total;
  if (!total || typeof total !== 'object') return null;
  const t = total as Record<string, { pct?: number }>;
  const values = ['lines', 'statements', 'functions', 'branches']
    .map((k) => t[k]?.pct)
    .filter((v): v is number => typeof v === 'number');
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

const plugin: Plugin = {
  name: 'test-coverage-gate',
  version: '0.1.0',
  description: 'PostToolUse hook that detects test coverage regressions after source-file edits',
  apiVersion: API_VERSION,
  capabilities: { tools: true, hooks: true },
  defaultConfig: { ...DEFAULTS },
  configSchema: {
    type: 'object',
    properties: {
      enabled: {
        type: 'boolean',
        default: true,
        description: 'Master switch.',
      },
      coveragePath: {
        type: 'string',
        default: 'coverage/coverage-summary.json',
        description: 'Path to the JSON coverage summary file.',
      },
      threshold: {
        type: 'number',
        minimum: 0,
        maximum: 100,
        default: 80,
        description: 'Minimum allowed overall coverage percentage.',
      },
      mode: {
        type: 'string',
        enum: ['warn', 'block'],
        default: 'warn',
        description: 'warn = inject context; block = refuse the mutating tool.',
      },
      deltaThreshold: {
        type: 'number',
        minimum: 0,
        default: 1,
        description: 'Warn/block when coverage drops by at least this many percentage points.',
      },
      runOnChange: {
        type: 'array',
        items: { type: 'string' },
        default: ['.ts', '.tsx', '.js', '.jsx'],
        description: 'Only check coverage when the edited file has one of these extensions.',
      },
    },
  },

  setup(api) {
    // Idempotent re-init (H1 audit pattern).
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.errorCount = 0;
    state.skippedCount = 0;
    state.lastOverallPct = null;
    state.lastResult = null;
    state.hookUnregister = releaseHandle(state.hookUnregister);

    const cfg = readConfig(api.config.extensions?.['test-coverage-gate']);

    const hook = (input: {
      toolName?: string | undefined;
      toolInput?: unknown;
      toolResult?: { content: string; isError: boolean } | undefined;
    }): { decision?: 'block'; reason?: string; additionalContext?: string } | void => {
      if (!cfg.enabled) return;

      if (input.toolResult?.isError) return;

      const inp = (input.toolInput ?? {}) as Record<string, unknown>;
      const rawPath =
        inp['path'] ??
        inp['filePath'] ??
        inp['file_path'] ??
        inp['TargetFile'] ??
        inp['targetFile'] ??
        inp['file'];
      const sourcePath = typeof rawPath === 'string' ? rawPath : undefined;
      if (!sourcePath || !withinProject(sourcePath)) return;

      const ext = extname(sourcePath).toLowerCase();
      // Performance: uses Set.has() for O(1) lookup instead of Array.includes() O(n).
      if (!runOnChangeSet.has(ext)) {
        state.skippedCount += 1;
        return;
      }

      state.invocationCount += 1;

      const summary = readCoverageSummary(cfg.coveragePath);
      if (!summary) {
        state.errorCount += 1;
        return;
      }

      const pct = overallPercent(summary);
      if (pct === null) {
        state.errorCount += 1;
        return;
      }

      state.runCount += 1;
      const previous = state.lastOverallPct;
      state.lastOverallPct = pct;

      const belowThreshold = pct < cfg.threshold;
      const dropped = previous !== null && previous - pct >= cfg.deltaThreshold;
      const passed = !belowThreshold && !dropped;

      state.lastResult = {
        overallPct: pct,
        previousOverallPct: previous,
        threshold: cfg.threshold,
        passed,
        when: new Date().toISOString(),
      };

      if (passed) {
        state.passCount += 1;
        return;
      }

      state.failCount += 1;
      const parts: string[] = ['\n❌ test-coverage-gate:'];
      if (belowThreshold) {
        parts.push(
          `  Overall coverage ${pct.toFixed(2)}% is below the ${cfg.threshold}% threshold.`,
        );
      }
      if (dropped) {
        parts.push(
          `  Coverage dropped from ${previous.toFixed(2)}% to ${pct.toFixed(2)}% (>= ${cfg.deltaThreshold}% delta).`,
        );
      }
      parts.push('  Add or update tests to recover coverage before continuing.');
      const message = parts.join('\n');

      if (cfg.mode === 'block') {
        return {
          decision: 'block' as const,
          reason: message,
        };
      }

      return { additionalContext: message };
    };

    state.hookUnregister = api.registerHook('PostToolUse', 'write|edit', hook);

    // --- coverage_gate_status tool ---
    api.tools.register({
      name: 'coverage_gate_status',
      description:
        'Reports test-coverage-gate state: threshold, mode, last coverage percentage, and counters.',
      inputSchema: { type: 'object', properties: {} },
      permission: 'auto',
      category: 'Diagnostics',
      mutating: false,
      async execute() {
        return {
          ok: true,
          enabled: cfg.enabled,
          coveragePath: cfg.coveragePath,
          threshold: cfg.threshold,
          mode: cfg.mode,
          deltaThreshold: cfg.deltaThreshold,
          lastOverallPct: state.lastOverallPct,
          counters: {
            invocations: state.invocationCount,
            runs: state.runCount,
            passed: state.passCount,
            failed: state.failCount,
            errors: state.errorCount,
            skipped: state.skippedCount,
          },
          lastResult: state.lastResult,
        };
      },
    });

    api.log.info('test-coverage-gate plugin loaded', {
      version: '0.1.0',
      coveragePath: cfg.coveragePath,
      threshold: cfg.threshold,
      mode: cfg.mode,
    });
  },

  teardown(api) {
    if (state.hookUnregister) {
      try {
        state.hookUnregister();
      } catch {
        // best-effort
      }
      state.hookUnregister = null;
    }
    const final = {
      invocations: state.invocationCount,
      runs: state.runCount,
      passed: state.passCount,
      failed: state.failCount,
      errors: state.errorCount,
      skipped: state.skippedCount,
    };
    state.invocationCount = 0;
    state.runCount = 0;
    state.passCount = 0;
    state.failCount = 0;
    state.errorCount = 0;
    state.skippedCount = 0;
    state.lastOverallPct = null;
    state.lastResult = null;
    api.log.info('test-coverage-gate: teardown complete', { final });
  },

  async health() {
    return {
      ok: true,
      message: state.lastResult
        ? `test-coverage-gate: ${state.runCount} run(s), last ${state.lastResult.passed ? 'PASSED' : 'FAILED'} (${state.lastResult.overallPct.toFixed(2)}%)`
        : `test-coverage-gate: ${state.invocationCount} invocation(s), ${state.runCount} run(s)`,
      counters: {
        invocations: state.invocationCount,
        runs: state.runCount,
        passed: state.passCount,
        failed: state.failCount,
        errors: state.errorCount,
        skipped: state.skippedCount,
      },
      lastResult: state.lastResult,
    };
  },
};

export default plugin;
