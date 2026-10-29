import type { AutomationRunRecord } from '@wrongstack/webui-protocol';

export interface RunFact {
  label: string;
  left: string;
  right: string;
  /** The two runs recorded different values. */
  differs: boolean;
}

const unknown = 'Not recorded';
const tokens = (value: number | null | undefined) =>
  value === null || value === undefined ? unknown : value.toLocaleString();

/** Recorded facts of two runs side by side; missing values stay "Not recorded". */
export function runFacts(left: AutomationRunRecord, right: AutomationRunRecord): RunFact[] {
  const read = (run: AutomationRunRecord): Record<string, string> => {
    const result = run.result;
    return {
      Status: run.status,
      Trigger: run.trigger,
      Created: new Date(run.createdAt).toISOString(),
      Duration: result ? `${(result.durationMs / 1000).toFixed(1)} s` : unknown,
      'Agent status': result?.agentStatus ?? unknown,
      Verification: result?.validation.status ?? unknown,
      'Input tokens': tokens(result?.usage.inputTokens),
      'Output tokens': tokens(result?.usage.outputTokens),
      Iterations: tokens(result?.usage.iterations),
      'Cost (catalog estimate)':
        result?.usage.costUsd === null || result?.usage.costUsd === undefined
          ? unknown
          : `$${result.usage.costUsd.toFixed(4)}`,
      'Exit code': run.exitCode === undefined ? unknown : String(run.exitCode),
      'Changed files': result
        ? `${result.changedFiles.length}${result.changedFilesTruncated ? '+ (list truncated)' : ''}`
        : unknown,
      Error: run.error ?? '—',
    };
  };
  const a = read(left),
    b = read(right);
  return Object.keys(a).map((label) => ({
    label,
    left: a[label]!,
    right: b[label]!,
    differs: a[label] !== b[label],
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
