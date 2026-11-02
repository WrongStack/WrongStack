import type { SessionSummary } from '@wrongstack/contracts/types/session';

export interface SessionFilterCriteria {
  since?: string | undefined;
  until?: string | undefined;
  provider?: string | undefined;
  model?: string | undefined;
  minTokens?: number | undefined;
  titleContains?: string | undefined;
}

export function compareSessionSummaries(a: SessionSummary, b: SessionSummary): number {
  const aActivity = a.lastActivityAt ?? a.endedAt ?? a.startedAt;
  const bActivity = b.lastActivityAt ?? b.endedAt ?? b.startedAt;
  if (aActivity < bActivity) return 1;
  if (aActivity > bActivity) return -1;
  if (a.startedAt < b.startedAt) return 1;
  if (a.startedAt > b.startedAt) return -1;
  return a.id.localeCompare(b.id);
}

export function matchesSessionFilter(
  summary: SessionSummary,
  criteria: SessionFilterCriteria,
): boolean {
  if (criteria.since && summary.startedAt < criteria.since) return false;
  if (criteria.until && summary.startedAt > criteria.until) return false;
  if (criteria.provider && summary.provider !== criteria.provider) return false;
  if (criteria.model && summary.model !== criteria.model) return false;
  if (criteria.minTokens !== undefined) {
    // Mirror the catalog's `COALESCE(tokenTotal, 0)` (store-maintenance.ts
    // readCatalogRecords). These rows are parsed from on-disk `summary.json` /
    // stored `summary_json`, so a legacy or damaged summary can omit the field.
    // `undefined < n` is FALSE, which INCLUDED a row the catalog backend
    // excluded: the same filtered list returned different sessions depending on
    // whether the catalog daemon was running.
    const tokens = Number.isFinite(summary.tokenTotal) ? summary.tokenTotal : 0;
    if (tokens < criteria.minTokens) return false;
  }
  if (criteria.titleContains) {
    const needle = criteria.titleContains.toLocaleLowerCase();
    if (!summary.title.toLocaleLowerCase().includes(needle)) return false;
  }
  return true;
}
