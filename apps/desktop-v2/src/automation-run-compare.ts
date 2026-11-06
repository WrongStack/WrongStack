import type { AutomationRunRecord } from '@wrongstack/webui-protocol';
import { displayDecimal, displayLocale } from './display-dates';

/** The recorded facts, in display order, with their English labels. */
const FACTS = {
  status: 'Status',
  trigger: 'Trigger',
  created: 'Created',
  duration: 'Duration',
  agentStatus: 'Agent status',
  verification: 'Verification',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  iterations: 'Iterations',
  cost: 'Cost (catalog estimate)',
  exitCode: 'Exit code',
  changedFiles: 'Changed files',
  error: 'Error',
} as const;
export type RunFactId = keyof typeof FACTS;

export interface RunFact {
  /** Stable id for the fact, independent of the display language. */
  id: RunFactId;
  label: string;
  left: string;
  right: string;
  /** The two runs recorded different values. */
  differs: boolean;
}

/** Words written into fact values; English by default. */
export interface RunFactWords {
  notRecorded: string;
  truncated: string;
}
const englishWords: RunFactWords = {
  notRecorded: 'Not recorded',
  truncated: '+ (list truncated)',
};

/** Recorded facts of two runs side by side; missing values stay "Not recorded". */
export function runFacts(
  left: AutomationRunRecord,
  right: AutomationRunRecord,
  words: RunFactWords = englishWords,
): RunFact[] {
  const unknown = words.notRecorded;
  const tokens = (value: number | null | undefined) =>
    value === null || value === undefined ? unknown : value.toLocaleString(displayLocale());
  const read = (run: AutomationRunRecord): Record<RunFactId, string> => {
    const result = run.result;
    return {
      status: run.status,
      trigger: run.trigger,
      created: new Date(run.createdAt).toISOString(),
      duration: result ? `${displayDecimal(result.durationMs / 1000, 1)} s` : unknown,
      agentStatus: result?.agentStatus ?? unknown,
      verification: result?.validation.status ?? unknown,
      inputTokens: tokens(result?.usage.inputTokens),
      outputTokens: tokens(result?.usage.outputTokens),
      iterations: tokens(result?.usage.iterations),
      cost:
        result?.usage.costUsd === null || result?.usage.costUsd === undefined
          ? unknown
          : `$${displayDecimal(result.usage.costUsd, 4)}`,
      exitCode: run.exitCode === undefined ? unknown : String(run.exitCode),
      changedFiles: result
        ? `${result.changedFiles.length}${result.changedFilesTruncated ? words.truncated : ''}`
        : unknown,
      error: run.error ?? '—',
    };
  };
  const a = read(left),
    b = read(right);
  return (Object.keys(FACTS) as RunFactId[]).map((id) => ({
    id,
    label: FACTS[id],
    left: a[id],
    right: b[id],
    differs: a[id] !== b[id],
  }));
}

/** Changed files only one run touched, and those both touched. */
export function changedFileOverlap(left: AutomationRunRecord, right: AutomationRunRecord) {
  const a = new Set(left.result?.changedFiles ?? []),
    b = new Set(right.result?.changedFiles ?? []);
  return {
    onlyLeft: [...a].filter((path) => !b.has(path)).sort(),
    onlyRight: [...b].filter((path) => !a.has(path)).sort(),
    both: [...a].filter((path) => b.has(path)).sort(),
    /** A truncated list cannot prove a file is absent from that run. */
    partial: !!left.result?.changedFilesTruncated || !!right.result?.changedFilesTruncated,
  };
}
