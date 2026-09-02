/**
 * The one-click modes and the builtin prompt each of them launches.
 *
 * One place decides what "performance mode" means, so the CLI (`/perf io`), the
 * WebUI card, and the prompt dataset cannot drift into three different ideas of
 * the same word.
 *
 * @module performance/perf-modes
 */

export type PerfModeId =
  | 'ratchet'
  | 'audit'
  | 'triage'
  | 'memory'
  | 'io'
  | 'cpu'
  | 'guard'
  | 'contract';

export interface PerfMode {
  id: PerfModeId;
  label: string;
  /** Slug of the builtin prompt this mode sends. */
  slug: string;
  /** One line for `/perf help` and the WebUI picker. */
  summary: string;
  /** True when the mode may change production code. */
  mutating: boolean;
}

export const PERF_MODES: Record<PerfModeId, PerfMode> = {
  ratchet: {
    id: 'ratchet',
    label: 'Ratchet loop',
    slug: 'elite-performance-ratchet',
    summary: 'Measure, change one thing, re-measure, keep or revert. The default round.',
    mutating: true,
  },
  audit: {
    id: 'audit',
    label: 'Baseline audit',
    slug: 'performance-baseline-audit',
    summary: 'Read-only: find and rank the cost centres, and say how to prove each one.',
    mutating: false,
  },
  triage: {
    id: 'triage',
    label: 'Quick triage',
    slug: 'performance-quick-triage',
    summary: 'Three highest-leverage problems with the command that would prove each.',
    mutating: false,
  },
  memory: {
    id: 'memory',
    label: 'Memory & retention',
    slug: 'performance-memory-hunt',
    summary: 'Unbounded growth, lifetime mismatch, subscription and resource leaks.',
    mutating: false,
  },
  io: {
    id: 'io',
    label: 'I/O & concurrency',
    slug: 'performance-io-concurrency',
    summary: 'N+1 boundaries, blocking calls, timeouts, pools, serialisation points.',
    mutating: false,
  },
  cpu: {
    id: 'cpu',
    label: 'CPU hot path',
    slug: 'performance-cpu-hot-path',
    summary: 'Profile-first reduction of a named hot path, cheapest wins first.',
    mutating: true,
  },
  guard: {
    id: 'guard',
    label: 'Regression guard',
    slug: 'performance-regression-guard',
    summary: 'Pick the metrics that matter, baseline them, and wire a failing check.',
    mutating: true,
  },
  contract: {
    id: 'contract',
    label: 'Performance contract',
    slug: 'performance-contract',
    summary: 'The standing rules every performance change in this repo must follow.',
    mutating: false,
  },
};

export const PERF_MODE_IDS: readonly PerfModeId[] = Object.keys(PERF_MODES) as PerfModeId[];

/** The mode a bare `/perf` or a WebUI click with no choice resolves to. */
export const DEFAULT_PERF_MODE: PerfModeId = 'ratchet';

export function isPerfModeId(value: string): value is PerfModeId {
  return Object.hasOwn(PERF_MODES, value);
}

/** Every builtin prompt slug the performance system depends on existing. */
export const PERF_PROMPT_SLUGS: readonly string[] = PERF_MODE_IDS.map((id) => PERF_MODES[id].slug);
