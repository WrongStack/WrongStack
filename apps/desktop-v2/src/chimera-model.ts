import { record } from './engine-values';

export const reviewReportTransitions: Record<string, readonly string[]> = {
  open: ['actioned', 'completed', 'skipped'],
  actioned: ['completed', 'skipped'],
  completed: ['open'],
  skipped: ['open'],
};
export const reviewFindingTransitions: Record<string, readonly string[]> = {
  active: ['triaged', 'ignored', 'resolved'],
  triaged: ['in_progress', 'ignored', 'resolved'],
  in_progress: ['resolved', 'active'],
  resolved: ['active'],
  ignored: ['active'],
};
export const reviewOutcomes = ['fixed', 'wontfix', 'duplicate', 'false_positive', 'stale'] as const;
export const reviewLabel = (value: unknown) =>
  typeof value === 'string' && value ? value.replaceAll('_', ' ') : 'Not reported';
export function reviewFollowup(report: Record<string, unknown>): string {
  return `Review Chimera report ${String(report['id'])} for recorded session ${String(report['sessionId'])}. Read its current findings, citation verification and activity before proposing changes. Validate each finding against current code, follow the normal permission flow, and record outcomes after the work is verified.\n\nThe recorded review used ${String(report['reviewerModel'] ?? 'an unreported model')} and reported ${String(report['totalFindings'] ?? 0)} findings.`;
}
export function reviewFilteredReports(
  reports: Record<string, unknown>[],
  query: string,
  session: string,
) {
  return reports.filter(
    (item) =>
      (!session || item['sessionId'] === session) &&
      `${item['reportId']} ${item['sessionId']} ${item['reviewerModel'] ?? ''} ${item['agentId'] ?? ''} ${item['source'] ?? ''} ${item['headSha'] ?? ''}`
        .toLowerCase()
        .includes(query.trim().toLowerCase()),
  );
}

export function reviewTokensCompact(n: unknown): string {
  const val = Number(n);
  if (!Number.isFinite(val) || val <= 0) return '0';
  if (val >= 1_000_000) return `${(val / 1_000_000).toFixed(2)}M`;
  if (val >= 10_000) return `${Math.round(val / 1000)}k`;
  if (val >= 1_000) return `${(val / 1000).toFixed(1)}k`;
  return String(Math.round(val));
}

export function reviewUsdCost(usd: unknown): string {
  const val = Number(usd);
  if (!Number.isFinite(val) || val <= 0) return '';
  return val < 0.01 ? `$${val.toFixed(4)}` : `$${val.toFixed(3)}`;
}
export function reviewFindingCounts(findings: Record<string, unknown>[]) {
  const values = findings.map((item) => record(item['finding']));
  return {
    open: values.filter((item) => !['resolved', 'ignored'].includes(String(item['status']))).length,
    resolved: values.filter((item) => item['status'] === 'resolved').length,
    ignored: values.filter((item) => item['status'] === 'ignored').length,
  };
}
