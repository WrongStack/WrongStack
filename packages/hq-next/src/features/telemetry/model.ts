/**
 * Telemetry rules as pure functions: time windows, honest re-bucketing and the
 * spend roll-ups. Only types come from the HQ protocol.
 */
import type {
  HqProjectRecord,
  HqSessionSnapshotPayload,
  HqTimeseriesBreakdownEntry,
  HqTimeseriesSample,
} from '@wrongstack/hq';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

export interface TrendRange {
  id: '1h' | '6h' | '24h' | '7d';
  label: string;
  ms: number;
  /** Width of one drawn column: few enough columns to read, fine enough to place a spike. */
  bucketMs: number;
  bucketLabel: string;
}

export const TREND_RANGES: readonly TrendRange[] = [
  { id: '1h', label: 'Last hour', ms: HOUR, bucketMs: 5 * MINUTE, bucketLabel: '5 minutes' },
  {
    id: '6h',
    label: 'Last 6 hours',
    ms: 6 * HOUR,
    bucketMs: 15 * MINUTE,
    bucketLabel: '15 minutes',
  },
  { id: '24h', label: 'Last 24 hours', ms: 24 * HOUR, bucketMs: HOUR, bucketLabel: 'hour' },
  { id: '7d', label: 'Last 7 days', ms: 7 * 24 * HOUR, bucketMs: 6 * HOUR, bucketLabel: '6 hours' },
];

export interface Column {
  /** Column start, epoch ms. */
  ts: number;
  costUsd: number;
  tokens: number;
  toolCalls: number;
}

export interface TrendWindow {
  range: TrendRange;
  start: number;
  end: number;
  /** Every column of the window, empty ones included, so the time axis never lies. */
  columns: Column[];
  /** Samples inside the window, for the totals and breakdowns. */
  samples: HqTimeseriesSample[];
  /** Newest sample overall, so an empty window can say when activity last happened. */
  lastActivity: number | undefined;
}

export function trendWindow(
  samples: readonly HqTimeseriesSample[],
  range: TrendRange,
  now: number,
): TrendWindow {
  const end = Math.floor(now / range.bucketMs) * range.bucketMs + range.bucketMs;
  const start = end - Math.ceil(range.ms / range.bucketMs) * range.bucketMs;
  const columns: Column[] = [];
  for (let ts = start; ts < end; ts += range.bucketMs) {
    columns.push({ ts, costUsd: 0, tokens: 0, toolCalls: 0 });
  }
  const inside: HqTimeseriesSample[] = [];
  let lastActivity: number | undefined;
  for (const sample of samples) {
    if (lastActivity === undefined || sample.ts > lastActivity) lastActivity = sample.ts;
    if (sample.ts < start || sample.ts >= end) continue;
    inside.push(sample);
    const column = columns[Math.floor((sample.ts - start) / range.bucketMs)];
    if (column === undefined) continue;
    column.costUsd += sample.costUsd;
    column.tokens += sample.inputTokens + sample.outputTokens;
    column.toolCalls += sample.toolCalls;
  }
  return { range, start, end, columns, samples: inside, lastActivity };
}

export interface TrendTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  toolCalls: number;
  /** Cache reads over prompt tokens, when the providers report cache reads at all. */
  cacheShare: number | null;
}

export function trendTotals(samples: readonly HqTimeseriesSample[]): TrendTotals {
  let costUsd = 0;
  let inputTokens = 0;
  let outputTokens = 0;
  let toolCalls = 0;
  let cacheRead = 0;
  for (const sample of samples) {
    costUsd += sample.costUsd;
    inputTokens += sample.inputTokens;
    outputTokens += sample.outputTokens;
    toolCalls += sample.toolCalls;
    for (const entry of Object.values(sample.byModel ?? {})) cacheRead += entry.cacheRead ?? 0;
  }
  return {
    costUsd,
    inputTokens,
    outputTokens,
    toolCalls,
    cacheShare: inputTokens > 0 && cacheRead > 0 ? Math.min(1, cacheRead / inputTokens) : null,
  };
}

export interface BreakdownRow {
  key: string;
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  cacheTokens: number;
  share: number;
}

/** Sum per-model or per-provider entries across the samples, ranked by cost. */
export function breakdown(
  samples: readonly HqTimeseriesSample[],
  dimension: 'byModel' | 'byProvider',
): BreakdownRow[] {
  const totals = new Map<string, HqTimeseriesBreakdownEntry>();
  for (const sample of samples) {
    for (const [key, entry] of Object.entries(sample[dimension] ?? {})) {
      const sum = totals.get(key);
      if (sum === undefined) {
        totals.set(key, { ...entry });
        continue;
      }
      sum.costUsd += entry.costUsd;
      sum.inputTokens += entry.inputTokens;
      sum.outputTokens += entry.outputTokens;
      sum.cacheRead = (sum.cacheRead ?? 0) + (entry.cacheRead ?? 0);
      sum.cacheWrite = (sum.cacheWrite ?? 0) + (entry.cacheWrite ?? 0);
    }
  }
  const total = [...totals.values()].reduce((sum, entry) => sum + entry.costUsd, 0);
  return [...totals.entries()]
    .map(([key, entry]) => ({
      key,
      costUsd: entry.costUsd,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheTokens: (entry.cacheRead ?? 0) + (entry.cacheWrite ?? 0),
      share: total > 0 ? entry.costUsd / total : 0,
    }))
    .sort((left, right) => right.costUsd - left.costUsd || left.key.localeCompare(right.key));
}

export interface ProjectSpend {
  projectId: string;
  name: string;
  costUsd: number;
  share: number;
  sessions: number;
}

export function projectSpend(projects: readonly HqProjectRecord[]): ProjectSpend[] {
  const total = projects.reduce((sum, project) => sum + project.totalCostUsd, 0);
  return projects
    .map((project) => ({
      projectId: project.projectId,
      name: project.projectName,
      costUsd: project.totalCostUsd,
      share: total > 0 ? project.totalCostUsd / total : 0,
      sessions: project.activeSessions,
    }))
    .sort((left, right) => right.costUsd - left.costUsd || left.name.localeCompare(right.name));
}

/** A single project past this share of the fleet's spend is worth a look. */
export const CONCENTRATION_SHARE = 0.6;

export interface SessionSpend {
  sessionId: string;
  projectName: string;
  machine: string;
  costUsd: number;
  tokens: number;
  agents: number;
  models: string[];
}

export function sessionSpend(sessions: readonly HqSessionSnapshotPayload[]): SessionSpend[] {
  return sessions
    .map((session) => {
      let costUsd = 0;
      let tokens = 0;
      const models = new Set<string>();
      for (const agent of session.agents) {
        costUsd += agent.costUsd ?? 0;
        tokens += (agent.tokensIn ?? 0) + (agent.tokensOut ?? 0);
        if (agent.model !== undefined) models.add(agent.model);
      }
      return {
        sessionId: session.sessionId,
        projectName: session.projectName,
        machine: session.hostname ?? session.machineId,
        costUsd,
        tokens,
        agents: session.agents.length,
        models: [...models].sort(),
      };
    })
    .filter((row) => row.costUsd > 0 || row.tokens > 0)
    .sort((left, right) => right.costUsd - left.costUsd);
}

/**
 * "$12.40", "$0.42", and two significant digits below a dime ("$0.042",
 * "$0.0042") — a single turn often costs fractions of a cent, and rounding
 * those to "$0.00" hides the signal.
 */
/**
 * The axis top for a peak: the next round number at or above it (1, 2, 2.5, 5
 * times a power of ten), so the half-way gridline reads $0.10, not $0.098.
 */
export function niceCeiling(value: number): number {
  if (!(value > 0) || !Number.isFinite(value)) return 0;
  const magnitude = 10 ** Math.floor(Math.log10(value));
  for (const step of [1, 2, 2.5, 5, 10]) {
    const top = step * magnitude;
    // Float noise (0.1 * 3) must not push a round peak to the next step.
    if (top >= value * (1 - 1e-9)) return top;
  }
  return 10 * magnitude;
}

export function usd(value: number): string {
  if (!Number.isFinite(value) || value === 0) return '$0';
  if (Math.abs(value) >= 0.1) return `$${value.toFixed(2)}`;
  return `$${Number(value.toPrecision(2))}`;
}

/** 1234 → "1.2k", 3_400_000 → "3.4M". */
export function count(value: number): string {
  if (!Number.isFinite(value)) return '0';
  const magnitude = Math.abs(value);
  // One decimal, but never a trailing `.0`: axis tops are round (100k, 2M).
  const short = (scaled: number): string => scaled.toFixed(1).replace(/\.0$/, '');
  if (magnitude >= 999_950) return `${short(value / 1_000_000)}M`;
  if (magnitude >= 1_000) return `${short(value / 1_000)}k`;
  return String(Math.round(value));
}

export function percent(fraction: number, digits = 0): string {
  return Number.isFinite(fraction) ? `${(fraction * 100).toFixed(digits)}%` : '0%';
}

/**
 * The fleet series narrowed to a set of machines (a label scope): each
 * bucket's totals become the sum of those machines' breakdown entries. The
 * server does the same for one machine; a label is a set, so it is summed
 * here from the per-machine breakdown it already sends.
 */
export function samplesForMachines(
  samples: readonly HqTimeseriesSample[],
  machineKeys: ReadonlySet<string>,
): HqTimeseriesSample[] {
  return samples.map((sample) => {
    let costUsd = 0;
    let inputTokens = 0;
    let outputTokens = 0;
    let toolCalls = 0;
    for (const [key, entry] of Object.entries(sample.byMachine ?? {})) {
      if (!machineKeys.has(key)) continue;
      costUsd += entry.costUsd;
      inputTokens += entry.inputTokens;
      outputTokens += entry.outputTokens;
      toolCalls += entry.toolCalls ?? 0;
    }
    return { ts: sample.ts, costUsd, inputTokens, outputTokens, toolCalls };
  });
}

/** The name the "By label" table gives machines without one. */
const UNLABELLED = 'no label';

/**
 * Spend per operator label across the samples, ranked by cost. A machine with
 * two labels counts in both, so shares are each label's part of the whole
 * fleet's spend and can add up to more than 100%. Machines without a label are
 * one row, so the table always accounts for every dollar.
 */
export function labelSpend(
  samples: readonly HqTimeseriesSample[],
  machineLabels: Readonly<Record<string, readonly string[]>>,
): BreakdownRow[] {
  const totals = new Map<string, HqTimeseriesBreakdownEntry>();
  let fleet = 0;
  for (const sample of samples) {
    for (const [key, entry] of Object.entries(sample.byMachine ?? {})) {
      fleet += entry.costUsd;
      const labels = Object.hasOwn(machineLabels, key) ? (machineLabels[key] ?? []) : [];
      for (const label of labels.length > 0 ? labels : [UNLABELLED]) {
        const sum = totals.get(label) ?? { costUsd: 0, inputTokens: 0, outputTokens: 0 };
        sum.costUsd += entry.costUsd;
        sum.inputTokens += entry.inputTokens;
        sum.outputTokens += entry.outputTokens;
        sum.cacheRead = (sum.cacheRead ?? 0) + (entry.cacheRead ?? 0);
        sum.cacheWrite = (sum.cacheWrite ?? 0) + (entry.cacheWrite ?? 0);
        totals.set(label, sum);
      }
    }
  }
  return [...totals.entries()]
    .map(([key, entry]) => ({
      key,
      costUsd: entry.costUsd,
      inputTokens: entry.inputTokens,
      outputTokens: entry.outputTokens,
      cacheTokens: (entry.cacheRead ?? 0) + (entry.cacheWrite ?? 0),
      share: fleet > 0 ? entry.costUsd / fleet : 0,
    }))
    .sort(
      (left, right) =>
        Number(left.key === UNLABELLED) - Number(right.key === UNLABELLED) ||
        right.costUsd - left.costUsd ||
        left.key.localeCompare(right.key),
    );
}
